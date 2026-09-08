/**
 * Persistence for ingestion jobs and their per-revision items.
 *
 * Job counters are updated incrementally as work completes rather than only at
 * the end, so a long-running job is observable while it is still running and a
 * crashed job leaves behind an accurate partial record.
 */

import type {
  IngestionItemOutcome,
  IngestionJobDetail,
  IngestionJobStatus,
  IngestionJobSummary,
  IngestionTrigger,
} from '@docs-rag/shared';
import { getPool, queryOne, queryRows, type Queryable } from '../db/pool.js';
import { toIso, type IngestionJobItemRow, type IngestionJobRow } from './types.js';

export interface JobCounters {
  documentsDiscovered?: number;
  documentsProcessed?: number;
  documentsSkipped?: number;
  documentsFailed?: number;
  chunksCreated?: number;
  ocrPages?: number;
  visionImages?: number;
  embeddingBatches?: number;
  embeddingTokens?: number;
}

export interface JobItemInput {
  ingestionJobId: string;
  documentId?: string | null;
  documentRevisionId?: string | null;
  documentCode?: string | null;
  revisionNumber?: number | null;
  outcome: IngestionItemOutcome;
  skipReason?: string | null;
  errorMessage?: string | null;
  errorStage?: string | null;
  chunksCreated?: number;
  pages?: number;
  ocrPages?: number;
  durationMs?: number | null;
  parseMs?: number | null;
  ocrMs?: number | null;
  chunkMs?: number | null;
  embedMs?: number | null;
  persistMs?: number | null;
  metadata?: Record<string, unknown>;
}

export class IngestionRepository {
  constructor(private readonly db: Queryable = getPool()) {}

  async createJob(
    trigger: IngestionTrigger,
    context: { embeddingProvider: string; embeddingModel: string; metadata?: Record<string, unknown> },
  ): Promise<IngestionJobRow> {
    const row = await queryOne<IngestionJobRow>(
      `INSERT INTO ingestion_jobs (trigger, status, embedding_provider, embedding_model, metadata)
       VALUES ($1, 'RUNNING', $2, $3, $4)
       RETURNING *`,
      [trigger, context.embeddingProvider, context.embeddingModel, JSON.stringify(context.metadata ?? {})],
      this.db,
    );
    return row as IngestionJobRow;
  }

  /** Add to the running totals. Called after each revision completes. */
  async incrementCounters(jobId: string, counters: JobCounters): Promise<void> {
    const columns: Record<keyof JobCounters, string> = {
      documentsDiscovered: 'documents_discovered',
      documentsProcessed: 'documents_processed',
      documentsSkipped: 'documents_skipped',
      documentsFailed: 'documents_failed',
      chunksCreated: 'chunks_created',
      ocrPages: 'ocr_pages',
      visionImages: 'vision_images',
      embeddingBatches: 'embedding_batches',
      embeddingTokens: 'embedding_tokens',
    };

    const assignments: string[] = [];
    const values: unknown[] = [jobId];

    for (const [key, column] of Object.entries(columns) as [keyof JobCounters, string][]) {
      const delta = counters[key];
      if (delta === undefined || delta === 0) continue;
      values.push(delta);
      assignments.push(`${column} = ${column} + $${values.length}`);
    }

    if (assignments.length === 0) return;

    await this.db.query(`UPDATE ingestion_jobs SET ${assignments.join(', ')} WHERE id = $1`, values);
  }

  async completeJob(
    jobId: string,
    status: IngestionJobStatus,
    errorSummary: string | null = null,
  ): Promise<IngestionJobRow | null> {
    return queryOne<IngestionJobRow>(
      `UPDATE ingestion_jobs
          SET status        = $2,
              completed_at  = now(),
              duration_ms   = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int,
              error_summary = $3
        WHERE id = $1
       RETURNING *`,
      [jobId, status, errorSummary?.slice(0, 4000) ?? null],
      this.db,
    );
  }

  async addItem(input: JobItemInput): Promise<void> {
    await this.db.query(
      `INSERT INTO ingestion_job_items (
         ingestion_job_id, document_id, document_revision_id, document_code, revision_number,
         outcome, skip_reason, error_message, error_stage,
         chunks_created, pages, ocr_pages,
         duration_ms, parse_ms, ocr_ms, chunk_ms, embed_ms, persist_ms, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        input.ingestionJobId,
        input.documentId ?? null,
        input.documentRevisionId ?? null,
        input.documentCode ?? null,
        input.revisionNumber ?? null,
        input.outcome,
        input.skipReason ?? null,
        input.errorMessage?.slice(0, 4000) ?? null,
        input.errorStage ?? null,
        input.chunksCreated ?? 0,
        input.pages ?? 0,
        input.ocrPages ?? 0,
        input.durationMs ?? null,
        input.parseMs ?? null,
        input.ocrMs ?? null,
        input.chunkMs ?? null,
        input.embedMs ?? null,
        input.persistMs ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }

  async findJob(jobId: string): Promise<IngestionJobRow | null> {
    return queryOne<IngestionJobRow>('SELECT * FROM ingestion_jobs WHERE id = $1', [jobId], this.db);
  }

  async findJobDetail(jobId: string): Promise<IngestionJobDetail | null> {
    const job = await this.findJob(jobId);
    if (!job) return null;
    const items = await queryRows<IngestionJobItemRow>(
      'SELECT * FROM ingestion_job_items WHERE ingestion_job_id = $1 ORDER BY created_at',
      [jobId],
      this.db,
    );
    return {
      ...mapJobSummary(job),
      items: items.map((item) => ({
        id: item.id,
        documentCode: item.document_code,
        revisionNumber: item.revision_number,
        documentRevisionId: item.document_revision_id,
        outcome: item.outcome,
        skipReason: item.skip_reason,
        errorMessage: item.error_message,
        errorStage: item.error_stage,
        chunksCreated: item.chunks_created,
        pages: item.pages,
        ocrPages: item.ocr_pages,
        durationMs: item.duration_ms,
      })),
    };
  }

  async listJobs(limit = 25): Promise<IngestionJobSummary[]> {
    const rows = await queryRows<IngestionJobRow>(
      'SELECT * FROM ingestion_jobs ORDER BY started_at DESC LIMIT $1',
      [limit],
      this.db,
    );
    return rows.map(mapJobSummary);
  }

  async latestJob(): Promise<IngestionJobSummary | null> {
    const row = await queryOne<IngestionJobRow>(
      'SELECT * FROM ingestion_jobs ORDER BY started_at DESC LIMIT 1',
      [],
      this.db,
    );
    return row ? mapJobSummary(row) : null;
  }

  async countRunning(): Promise<number> {
    const row = await queryOne<{ total: number }>(
      "SELECT count(*)::int AS total FROM ingestion_jobs WHERE status = 'RUNNING'",
      [],
      this.db,
    );
    return row?.total ?? 0;
  }

  /**
   * Mark jobs left RUNNING by a crashed process as failed.
   * Called at boot so the admin view never shows a phantom running job.
   */
  async failAbandonedJobs(olderThanMinutes: number): Promise<number> {
    const result = await this.db.query(
      `UPDATE ingestion_jobs
          SET status        = 'FAILED',
              completed_at  = now(),
              error_summary = COALESCE(error_summary, 'Job abandoned - the process exited before completion.')
        WHERE status = 'RUNNING'
          AND started_at < now() - make_interval(mins => $1)`,
      [olderThanMinutes],
    );
    return result.rowCount ?? 0;
  }
}

export function mapJobSummary(row: IngestionJobRow): IngestionJobSummary {
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    startedAt: toIso(row.started_at) as string,
    completedAt: toIso(row.completed_at),
    durationMs: row.duration_ms,
    documentsDiscovered: row.documents_discovered,
    documentsProcessed: row.documents_processed,
    documentsSkipped: row.documents_skipped,
    documentsFailed: row.documents_failed,
    chunksCreated: row.chunks_created,
    ocrPages: row.ocr_pages,
    visionImages: row.vision_images,
    embeddingBatches: row.embedding_batches,
    embeddingProvider: row.embedding_provider,
    embeddingModel: row.embedding_model,
    errorSummary: row.error_summary,
  };
}
