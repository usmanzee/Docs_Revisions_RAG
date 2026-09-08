/**
 * Persistence for document revisions - including the safe activation
 * transaction that is the heart of the revision lifecycle.
 */

import type { ProcessingStatus, RevisionStatus, RevisionSummary } from '@docs-rag/shared';
import type pg from 'pg';
import { getPool, queryOne, queryRows, type Queryable } from '../db/pool.js';
import { toDateString, toIso, type DocumentRevisionRow } from './types.js';

export interface RevisionCreateInput {
  documentId: string;
  revisionNumber: number;
  filePath: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes?: number | null;
  effectiveDate?: string | null;
  revisionDate?: Date | null;
  changeSummary?: string | null;
  fileHash: string;
  sourceModifiedAt?: Date | null;
  storageDriver?: string;
  status?: RevisionStatus;
  metadata?: Record<string, unknown>;
}

export interface RevisionWithDocument extends DocumentRevisionRow {
  document_code: string;
  document_title: string;
  department: string;
  document_type: string;
  category: string | null;
  document_is_active: boolean;
}

const REVISION_WITH_DOCUMENT = `
  SELECT r.*,
         d.document_code,
         d.title       AS document_title,
         d.department,
         d.document_type,
         d.category,
         d.is_active   AS document_is_active
    FROM document_revisions r
    JOIN documents d ON d.id = r.document_id`;

export class RevisionRepository {
  constructor(private readonly db: Queryable = getPool()) {}

  withExecutor(executor: Queryable): RevisionRepository {
    return new RevisionRepository(executor);
  }

  async create(input: RevisionCreateInput): Promise<DocumentRevisionRow> {
    const row = await queryOne<DocumentRevisionRow>(
      `INSERT INTO document_revisions (
         document_id, revision_number, file_path, file_name, storage_driver, mime_type,
         file_size_bytes, effective_date, revision_date, change_summary, status,
         file_hash, source_modified_at, processing_status, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, now()), $10, $11, $12, $13, 'PENDING', $14)
       RETURNING *`,
      [
        input.documentId,
        input.revisionNumber,
        input.filePath,
        input.fileName,
        input.storageDriver ?? 'local',
        input.mimeType,
        input.fileSizeBytes ?? null,
        input.effectiveDate ?? null,
        input.revisionDate ?? null,
        input.changeSummary ?? null,
        input.status ?? 'ACTIVE',
        input.fileHash,
        input.sourceModifiedAt ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
      this.db,
    );
    return row as DocumentRevisionRow;
  }

  async findById(id: string): Promise<RevisionWithDocument | null> {
    return queryOne<RevisionWithDocument>(`${REVISION_WITH_DOCUMENT} WHERE r.id = $1`, [id], this.db);
  }

  async findByDocumentId(documentId: string): Promise<RevisionWithDocument[]> {
    return queryRows<RevisionWithDocument>(
      `${REVISION_WITH_DOCUMENT} WHERE r.document_id = $1 ORDER BY r.revision_number DESC`,
      [documentId],
      this.db,
    );
  }

  async findByDocumentCode(documentCode: string): Promise<RevisionWithDocument[]> {
    return queryRows<RevisionWithDocument>(
      `${REVISION_WITH_DOCUMENT} WHERE d.document_code = $1 ORDER BY r.revision_number DESC`,
      [documentCode],
      this.db,
    );
  }

  async findCurrent(documentId: string): Promise<RevisionWithDocument | null> {
    return queryOne<RevisionWithDocument>(
      `${REVISION_WITH_DOCUMENT} WHERE r.document_id = $1 AND r.is_current`,
      [documentId],
      this.db,
    );
  }

  async findByDocumentAndNumber(
    documentId: string,
    revisionNumber: number,
  ): Promise<DocumentRevisionRow | null> {
    return queryOne<DocumentRevisionRow>(
      'SELECT * FROM document_revisions WHERE document_id = $1 AND revision_number = $2',
      [documentId, revisionNumber],
      this.db,
    );
  }

  async nextRevisionNumber(documentId: string): Promise<number> {
    const row = await queryOne<{ next: number }>(
      'SELECT COALESCE(max(revision_number), 0) + 1 AS next FROM document_revisions WHERE document_id = $1',
      [documentId],
      this.db,
    );
    return row?.next ?? 1;
  }

  /**
   * Claim a batch of PENDING revisions for one ingestion run.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes concurrent ingestion workers safe:
   * two runs claim disjoint sets instead of fighting over the same rows, and a
   * crashed worker's rows return to PENDING via `releaseStaleClaims`.
   */
  async claimPending(limit: number, claimedBy: string, executor?: Queryable): Promise<RevisionWithDocument[]> {
    const db = executor ?? this.db;
    return queryRows<RevisionWithDocument>(
      `WITH claimed AS (
         SELECT r.id
           FROM document_revisions r
          WHERE r.processing_status = 'PENDING'
          ORDER BY r.created_at ASC
          LIMIT $1
            FOR UPDATE SKIP LOCKED
       )
       UPDATE document_revisions r
          SET processing_status   = 'PROCESSING',
              claimed_at          = now(),
              claimed_by          = $2,
              processing_attempts = r.processing_attempts + 1
         FROM claimed c, documents d
        WHERE r.id = c.id AND d.id = r.document_id
       RETURNING r.*, d.document_code, d.title AS document_title, d.department,
                 d.document_type, d.category, d.is_active AS document_is_active`,
      [limit, claimedBy],
      db,
    );
  }

  /**
   * Return revisions stuck in PROCESSING to PENDING.
   * Covers the "worker died mid-run" case; without it those revisions would
   * never be retried and the document would silently stop updating.
   */
  async releaseStaleClaims(olderThanMinutes: number): Promise<number> {
    const result = await this.db.query(
      `UPDATE document_revisions
          SET processing_status = 'PENDING', claimed_at = NULL, claimed_by = NULL
        WHERE processing_status = 'PROCESSING'
          AND claimed_at < now() - make_interval(mins => $1)`,
      [olderThanMinutes],
    );
    return result.rowCount ?? 0;
  }

  async countPending(): Promise<number> {
    const row = await queryOne<{ total: number }>(
      "SELECT count(*)::int AS total FROM document_revisions WHERE processing_status = 'PENDING'",
      [],
      this.db,
    );
    return row?.total ?? 0;
  }

  async markFailed(revisionId: string, message: string, executor?: Queryable): Promise<void> {
    const db = executor ?? this.db;
    await db.query(
      `UPDATE document_revisions
          SET processing_status = 'FAILED',
              processing_error  = $2,
              claimed_at        = NULL,
              claimed_by        = NULL
        WHERE id = $1`,
      // Keep the stored error bounded - a stack trace from a corrupt PDF can be
      // enormous and the full detail is already in the structured logs.
      [revisionId, message.slice(0, 4000)],
    );
  }

  async markPending(revisionId: string): Promise<void> {
    await this.db.query(
      `UPDATE document_revisions
          SET processing_status = 'PENDING',
              processing_error  = NULL,
              claimed_at        = NULL,
              claimed_by        = NULL
        WHERE id = $1`,
      [revisionId],
    );
  }

  async setProcessingStatus(revisionId: string, status: ProcessingStatus): Promise<void> {
    await this.db.query('UPDATE document_revisions SET processing_status = $2 WHERE id = $1', [
      revisionId,
      status,
    ]);
  }

  /**
   * Promote a freshly processed revision to current, inside one transaction.
   *
   * Ordering matters and is deliberate:
   *   1. demote the previous current revision (is_current = false, SUPERSEDED)
   *   2. flip its chunks' denormalised is_current flag to false
   *   3. promote the new revision and its chunks
   *
   * Because it is a single transaction, a failure at any point leaves the old
   * revision current and searchable. Superseded chunks are retained - they are
   * what makes "what did revision 3 say?" answerable later.
   *
   * The caller must have already inserted the new revision's chunks; this only
   * flips visibility.
   */
  async activateRevision(client: pg.PoolClient, revisionId: string, documentId: string): Promise<void> {
    await client.query(
      `UPDATE document_revisions
          SET is_current        = FALSE,
              status            = 'SUPERSEDED',
              processing_status = CASE WHEN processing_status = 'READY' THEN 'SUPERSEDED' ELSE processing_status END
        WHERE document_id = $1 AND id <> $2 AND is_current`,
      [documentId, revisionId],
    );

    await client.query(
      `UPDATE document_chunks
          SET is_current = FALSE
        WHERE document_id = $1 AND document_revision_id <> $2 AND is_current`,
      [documentId, revisionId],
    );

    await client.query(
      `UPDATE document_revisions
          SET is_current        = TRUE,
              status            = 'ACTIVE',
              processing_status = 'READY',
              processing_error  = NULL,
              processed_at      = now(),
              claimed_at        = NULL,
              claimed_by        = NULL
        WHERE id = $1`,
      [revisionId],
    );

    await client.query('UPDATE document_chunks SET is_current = TRUE WHERE document_revision_id = $1', [
      revisionId,
    ]);
  }

  /** Processing statistics written after a successful parse/chunk/embed. */
  async recordProcessingResult(
    client: pg.PoolClient,
    revisionId: string,
    stats: {
      contentHash: string;
      pageCount: number;
      ocrPageCount: number;
      chunkCount: number;
      tokenCount: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `UPDATE document_revisions
          SET content_hash   = $2,
              page_count     = $3,
              ocr_page_count = $4,
              chunk_count    = $5,
              token_count    = $6,
              metadata       = metadata || $7::jsonb
        WHERE id = $1`,
      [
        revisionId,
        stats.contentHash,
        stats.pageCount,
        stats.ocrPageCount,
        stats.chunkCount,
        stats.tokenCount,
        JSON.stringify(stats.metadata ?? {}),
      ],
    );
  }

  async countByProcessingStatus(): Promise<Record<string, number>> {
    const rows = await queryRows<{ processing_status: string; total: number }>(
      'SELECT processing_status, count(*)::int AS total FROM document_revisions GROUP BY processing_status',
      [],
      this.db,
    );
    return Object.fromEntries(rows.map((row) => [row.processing_status, row.total]));
  }
}

export function mapRevisionSummary(row: RevisionWithDocument): RevisionSummary {
  return {
    id: row.id,
    documentId: row.document_id,
    documentCode: row.document_code,
    documentTitle: row.document_title,
    revisionNumber: row.revision_number,
    filePath: row.file_path,
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileSizeBytes: row.file_size_bytes,
    effectiveDate: toDateString(row.effective_date),
    revisionDate: toIso(row.revision_date) as string,
    status: row.status,
    isCurrent: row.is_current,
    fileHash: row.file_hash,
    contentHash: row.content_hash,
    processingStatus: row.processing_status,
    processingError: row.processing_error,
    processingAttempts: row.processing_attempts,
    processedAt: toIso(row.processed_at),
    pageCount: row.page_count,
    ocrPageCount: row.ocr_page_count,
    chunkCount: row.chunk_count,
    tokenCount: row.token_count,
    changeSummary: row.change_summary,
    createdAt: toIso(row.created_at) as string,
    updatedAt: toIso(row.updated_at) as string,
  };
}
