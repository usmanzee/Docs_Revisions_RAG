/**
 * Ingestion orchestration.
 *
 * One run = one `ingestion_jobs` row. Within it:
 *
 *   release stale claims -> discover -> cost guard -> claim -> process -> report
 *
 * Failure isolation is the defining property. A revision that fails is recorded
 * as a failed job item and leaves its predecessor current and searchable; the
 * run continues and completes as PARTIALLY_COMPLETED. Only a failure of the run
 * itself (the database is unreachable, the storage root is gone) fails the job.
 */

import type { IngestionJobStatus, IngestionTrigger } from '@docs-rag/shared';
import type pg from 'pg';
import { hostname } from 'node:os';
import type { AppConfig } from '../../config/index.js';
import { getConfig } from '../../config/index.js';
import { ADVISORY_LOCKS, getPool, withAdvisoryLock } from '../../db/pool.js';
import { ChunkRepository } from '../../repositories/chunk-repository.js';
import { DocumentRepository } from '../../repositories/document-repository.js';
import { IngestionRepository } from '../../repositories/ingestion-repository.js';
import { RevisionRepository } from '../../repositories/revision-repository.js';
import { mapWithConcurrency } from '../../utils/async.js';
import { toErrorMessage } from '../../utils/errors.js';
import { childLogger } from '../../utils/logger.js';
import { createChunker } from '../chunking/index.js';
import { assertIngestionCostGuard, getEmbeddingProvider, type EmbeddingProvider } from '../embeddings/index.js';
import { getOCRProvider } from '../ocr/index.js';
import { createParserRegistry, type ParserRegistry } from '../parsing/index.js';
import { getDocumentStorage, type DocumentStorage } from '../storage/index.js';
import { createVisionEnricher, type VisionDocumentEnricher } from '../vision/index.js';
import { RevisionDiscoveryService, type DiscoveryResult } from './revision-discovery.js';
import { RevisionProcessor, type RevisionProcessResult } from './revision-processor.js';

/** Revisions left PROCESSING for longer than this are assumed abandoned. */
const STALE_CLAIM_MINUTES = 30;

export interface IngestionRunOptions {
  trigger?: IngestionTrigger;
  /** Overrides MAX_DOCUMENTS_PER_INGESTION_RUN for this run. */
  limit?: number;
  /** Skip the storage scan when the caller knows nothing has changed. */
  skipDiscovery?: boolean;
  /** Process only this revision - used by the admin reprocess endpoint. */
  revisionId?: string;
}

export interface IngestionRunResult {
  jobId: string | null;
  status: IngestionJobStatus;
  discovered: number;
  processed: number;
  skipped: number;
  failed: number;
  chunksCreated: number;
  ocrPages: number;
  visionImages: number;
  embeddingRequests: number;
  embeddingTokens: number;
  durationMs: number;
  discovery: DiscoveryResult | null;
  items: RevisionProcessResult[];
  /** Set when the run could not start because another run holds the lock. */
  skippedReason?: string;
}

export interface IngestionServiceDependencies {
  storage: DocumentStorage;
  parsers: ParserRegistry;
  embeddings: EmbeddingProvider;
  vision: VisionDocumentEnricher;
  documents: DocumentRepository;
  revisions: RevisionRepository;
  chunks: ChunkRepository;
  jobs: IngestionRepository;
  config: AppConfig;
  pool?: pg.Pool;
}

export class DocumentIngestionService {
  private readonly logger = childLogger({ component: 'ingestion' });
  private readonly workerId: string;

  constructor(private readonly deps: IngestionServiceDependencies) {
    this.workerId = `${hostname()}:${process.pid}`;
  }

  /**
   * Run one synchronisation.
   *
   * An advisory lock serialises runs so the scheduler and a manual trigger
   * cannot process the same revisions concurrently. When the lock is held, the
   * run is skipped rather than queued - the next scheduled tick will pick up
   * whatever is still pending.
   */
  async run(options: IngestionRunOptions = {}): Promise<IngestionRunResult> {
    const pool = this.deps.pool ?? getPool();

    const outcome = await withAdvisoryLock(
      ADVISORY_LOCKS.ingestionRun,
      () => this.executeRun(options),
      pool,
    );

    if (outcome === null) {
      this.logger.warn('another ingestion run is in progress; skipping this run');
      return {
        jobId: null,
        status: 'COMPLETED',
        discovered: 0,
        processed: 0,
        skipped: 0,
        failed: 0,
        chunksCreated: 0,
        ocrPages: 0,
        visionImages: 0,
        embeddingRequests: 0,
        embeddingTokens: 0,
        durationMs: 0,
        discovery: null,
        items: [],
        skippedReason: 'another ingestion run is already in progress',
      };
    }

    return outcome;
  }

  private async executeRun(options: IngestionRunOptions): Promise<IngestionRunResult> {
    const started = performance.now();
    const trigger = options.trigger ?? 'MANUAL';
    const pool = this.deps.pool ?? getPool();

    const job = await this.deps.jobs.createJob(trigger, {
      embeddingProvider: this.deps.embeddings.name,
      embeddingModel: this.deps.embeddings.model,
      metadata: { workerId: this.workerId, ...(options.revisionId ? { revisionId: options.revisionId } : {}) },
    });

    const logger = this.logger.child({ ingestionJobId: job.id, trigger });
    logger.info('ingestion run started');

    const result: IngestionRunResult = {
      jobId: job.id,
      status: 'RUNNING',
      discovered: 0,
      processed: 0,
      skipped: 0,
      failed: 0,
      chunksCreated: 0,
      ocrPages: 0,
      visionImages: 0,
      embeddingRequests: 0,
      embeddingTokens: 0,
      durationMs: 0,
      discovery: null,
      items: [],
    };

    try {
      // Revisions abandoned by a crashed worker return to PENDING; without this
      // they would sit in PROCESSING forever and never be retried.
      const released = await this.deps.revisions.releaseStaleClaims(STALE_CLAIM_MINUTES);
      if (released > 0) logger.warn({ released }, 'released stale PROCESSING claims');

      if (!options.skipDiscovery && !options.revisionId) {
        const discovery = new RevisionDiscoveryService(
          this.deps.storage,
          this.deps.documents,
          this.deps.revisions,
          pool,
        );
        result.discovery = await discovery.discover();
        logger.info(
          {
            filesScanned: result.discovery.filesScanned,
            registered: result.discovery.revisionsRegistered,
            requeued: result.discovery.revisionsRequeued,
          },
          'discovery complete',
        );
      }

      const limit = options.limit ?? this.deps.config.ingestion.maxDocumentsPerRun;

      const claimed = options.revisionId
        ? await this.claimSingleRevision(options.revisionId)
        : await this.deps.revisions.claimPending(limit, this.workerId, pool);

      result.discovered = claimed.length;
      await this.deps.jobs.incrementCounters(job.id, { documentsDiscovered: claimed.length });

      if (claimed.length === 0) {
        logger.info('nothing pending');
        const completed = await this.deps.jobs.completeJob(job.id, 'COMPLETED');
        result.status = completed?.status ?? 'COMPLETED';
        result.durationMs = Math.round(performance.now() - started);
        return result;
      }

      // Refuse to spend real money on a corpus that was generated for
      // infrastructure testing. Claimed revisions are returned to PENDING so the
      // run is a no-op rather than a partial, confusing state.
      try {
        assertIngestionCostGuard(claimed.length, this.deps.embeddings, this.deps.config);
      } catch (error) {
        for (const revision of claimed) await this.deps.revisions.markPending(revision.id);
        await this.deps.jobs.completeJob(job.id, 'FAILED', toErrorMessage(error));
        throw error;
      }

      logger.info({ revisions: claimed.length }, 'processing claimed revisions');

      const processor = new RevisionProcessor({
        storage: this.deps.storage,
        parsers: this.deps.parsers,
        chunker: createChunker(this.deps.config.chunking),
        embeddings: this.deps.embeddings,
        vision: this.deps.vision,
        revisions: this.deps.revisions,
        chunks: this.deps.chunks,
        config: this.deps.config,
        ...(this.deps.pool ? { pool: this.deps.pool } : {}),
      });

      const items = await mapWithConcurrency(
        claimed,
        this.deps.config.ingestion.concurrency,
        async (revision) => {
          const processed = await processor.process(revision);

          // Recorded per revision as it completes, so a long run is observable
          // while it is still running.
          await this.deps.jobs.addItem({
            ingestionJobId: job.id,
            documentId: revision.document_id,
            documentRevisionId: revision.id,
            documentCode: revision.document_code,
            revisionNumber: revision.revision_number,
            outcome: processed.outcome,
            skipReason: processed.skipReason ?? null,
            errorMessage: processed.errorMessage ?? null,
            errorStage: processed.errorStage ?? null,
            chunksCreated: processed.chunksCreated,
            pages: processed.pages,
            ocrPages: processed.ocrPages,
            durationMs: processed.timings.totalMs,
            parseMs: processed.timings.parseMs,
            ocrMs: null,
            chunkMs: processed.timings.chunkMs,
            embedMs: processed.timings.embedMs,
            persistMs: processed.timings.persistMs,
            metadata: { activated: processed.activated, visionImages: processed.visionImages },
          });

          await this.deps.jobs.incrementCounters(job.id, {
            documentsProcessed: processed.outcome === 'PROCESSED' ? 1 : 0,
            documentsSkipped: processed.outcome === 'SKIPPED' ? 1 : 0,
            documentsFailed: processed.outcome === 'FAILED' ? 1 : 0,
            chunksCreated: processed.chunksCreated,
            ocrPages: processed.ocrPages,
            visionImages: processed.visionImages,
            embeddingBatches: processed.embeddingRequests,
            embeddingTokens: processed.embeddingTokens,
          });

          return processed;
        },
      );

      result.items = items;
      for (const item of items) {
        if (item.outcome === 'PROCESSED') result.processed += 1;
        else if (item.outcome === 'SKIPPED') result.skipped += 1;
        else result.failed += 1;

        result.chunksCreated += item.chunksCreated;
        result.ocrPages += item.ocrPages;
        result.visionImages += item.visionImages;
        result.embeddingRequests += item.embeddingRequests;
        result.embeddingTokens += item.embeddingTokens;
      }

      const status: IngestionJobStatus =
        result.failed === 0 ? 'COMPLETED' : result.processed + result.skipped > 0 ? 'PARTIALLY_COMPLETED' : 'FAILED';

      const errorSummary =
        result.failed === 0
          ? null
          : items
              .filter((item) => item.outcome === 'FAILED')
              .slice(0, 10)
              .map((item) => `${item.documentCode} rev ${item.revisionNumber}: [${item.errorStage}] ${item.errorMessage}`)
              .join('\n');

      await this.deps.jobs.completeJob(job.id, status, errorSummary);

      result.status = status;
      result.durationMs = Math.round(performance.now() - started);

      logger.info(
        {
          status,
          processed: result.processed,
          skipped: result.skipped,
          failed: result.failed,
          chunks: result.chunksCreated,
          durationMs: result.durationMs,
        },
        'ingestion run complete',
      );

      return result;
    } catch (error) {
      const message = toErrorMessage(error);
      logger.error({ err: { message } }, 'ingestion run failed');
      await this.deps.jobs.completeJob(job.id, 'FAILED', message).catch(() => undefined);
      throw error;
    }
  }

  /** Claim exactly one revision by id, regardless of its current status. */
  private async claimSingleRevision(revisionId: string) {
    const revision = await this.deps.revisions.findById(revisionId);
    if (!revision) return [];

    await this.deps.revisions.setProcessingStatus(revisionId, 'PROCESSING');
    return [{ ...revision, processing_status: 'PROCESSING' as const }];
  }
}

export function createIngestionService(config: AppConfig = getConfig()): DocumentIngestionService {
  const pool = getPool();
  return new DocumentIngestionService({
    storage: getDocumentStorage(),
    parsers: createParserRegistry(config, getOCRProvider()),
    embeddings: getEmbeddingProvider(),
    vision: createVisionEnricher(config),
    documents: new DocumentRepository(pool),
    revisions: new RevisionRepository(pool),
    chunks: new ChunkRepository(pool),
    jobs: new IngestionRepository(pool),
    config,
  });
}
