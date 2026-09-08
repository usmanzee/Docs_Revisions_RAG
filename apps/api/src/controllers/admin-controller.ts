/**
 * Admin and development operations.
 *
 * These endpoints exist to make the document lifecycle visible and drivable
 * from the UI: generate a corpus, create a revision, run ingestion, watch a
 * revision fail and recover. They are guarded by the admin middleware and are
 * not part of the user-facing surface.
 */

import type {
  AdminStats,
  CorpusProfile,
  IngestionJobDetail,
  IngestionJobSummary,
} from '@docs-rag/shared';
import type { AppConfig } from '../config/index.js';
import type { IngestionRepository } from '../repositories/ingestion-repository.js';
import type { ConversationRepository } from '../repositories/conversation-repository.js';
import type { StatsRepository } from '../repositories/stats-repository.js';
import type { RevisionRepository } from '../repositories/revision-repository.js';
import type { DocumentIngestionService, IngestionRunResult } from '../modules/ingestion/index.js';
import type { RevisionSimulator, CreatedRevision } from '../modules/corpus/revision-simulator.js';
import type { CorpusGenerator } from '../modules/corpus/corpus-generator.js';
import { resolveCorpusOptions } from '../modules/corpus/corpus-generator.js';
import { defaultCountForProfile } from '../modules/corpus/corpus-planner.js';
import type { EmbeddingProvider } from '../modules/embeddings/index.js';
import type { DocumentStorage } from '../modules/storage/index.js';
import type { RevisionMutationType } from '../modules/corpus/types.js';
import { NotFoundError } from '../utils/errors.js';
import type { IngestionScheduler } from '../modules/ingestion/scheduler.js';

export interface AdminControllerDependencies {
  stats: StatsRepository;
  jobs: IngestionRepository;
  conversations: ConversationRepository;
  revisions: RevisionRepository;
  ingestion: DocumentIngestionService;
  simulator: RevisionSimulator;
  corpus: CorpusGenerator;
  embeddings: EmbeddingProvider;
  storage: DocumentStorage;
  scheduler: IngestionScheduler | null;
  config: AppConfig;
}

export class AdminController {
  constructor(private readonly deps: AdminControllerDependencies) {}

  async stats(): Promise<AdminStats> {
    const [counts, sizes, latestJob, running, conversations] = await Promise.all([
      this.deps.stats.corpusCounts(),
      this.deps.stats.databaseSizes(),
      this.deps.jobs.latestJob(),
      this.deps.jobs.countRunning(),
      this.deps.conversations.countAll(),
    ]);

    return {
      documents: {
        total: counts.documentsTotal,
        active: counts.documentsActive,
        inactive: counts.documentsInactive,
      },
      revisions: {
        total: counts.revisionsTotal,
        current: counts.revisionsCurrent,
        pending: counts.revisionsPending,
        processing: counts.revisionsProcessing,
        ready: counts.revisionsReady,
        failed: counts.revisionsFailed,
        superseded: counts.revisionsSuperseded,
      },
      chunks: {
        total: counts.chunksTotal,
        current: counts.chunksCurrent,
        historical: counts.chunksHistorical,
        withEmbedding: counts.chunksWithEmbedding,
        parents: counts.chunksParents,
        ocrDerived: counts.chunksOcrDerived,
      },
      storage: {
        driver: this.deps.storage.driver,
        root: this.deps.storage.root,
        documentBytes: null,
      },
      database: {
        sizeBytes: sizes.databaseBytes,
        chunkTableBytes: sizes.chunkTableBytes,
        vectorIndexBytes: sizes.vectorIndexBytes,
      },
      embeddings: {
        provider: this.deps.embeddings.name,
        model: this.deps.embeddings.model,
        dimensions: this.deps.embeddings.dimensions,
      },
      ingestion: {
        latestJob,
        scheduleCron: this.deps.config.ingestion.cron,
        runningJobs: running,
      },
      conversations: {
        total: conversations.conversations,
        messages: conversations.messages,
      },
    };
  }

  async listJobs(limit: number): Promise<IngestionJobSummary[]> {
    return this.deps.jobs.listJobs(limit);
  }

  async jobDetail(id: string): Promise<IngestionJobDetail> {
    const job = await this.deps.jobs.findJobDetail(id);
    if (!job) throw new NotFoundError('Ingestion job', id);
    return job;
  }

  async runIngestion(options: { limit?: number; skipDiscovery?: boolean }): Promise<IngestionRunResult> {
    return this.deps.ingestion.run({
      trigger: 'API',
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.skipDiscovery ? { skipDiscovery: true } : {}),
    });
  }

  /**
   * Reprocess one revision.
   *
   * Used to recover a FAILED revision after the underlying problem is fixed.
   * The revision is put back into PENDING and processed immediately; if it
   * fails again, the currently-current revision is still untouched.
   */
  async reprocessRevision(revisionId: string): Promise<IngestionRunResult> {
    const revision = await this.deps.revisions.findById(revisionId);
    if (!revision) throw new NotFoundError('Revision', revisionId);

    await this.deps.revisions.markPending(revisionId);
    return this.deps.ingestion.run({ trigger: 'API', revisionId, skipDiscovery: true });
  }

  async createRevision(
    documentId: string,
    options: { mutationType?: RevisionMutationType; corrupt?: boolean },
  ): Promise<CreatedRevision> {
    const revisions = await this.deps.revisions.findByDocumentId(documentId);
    const first = revisions[0];
    if (!first) throw new NotFoundError('Document', documentId);

    return this.deps.simulator.createRevision(first.document_code, {
      ...(options.mutationType ? { mutationType: options.mutationType } : {}),
      ...(options.corrupt !== undefined ? { corrupt: options.corrupt } : {}),
    });
  }

  /**
   * Generate a corpus from the UI.
   *
   * Capped well below the CLI's ceiling: a scale corpus takes minutes and would
   * hold an HTTP request open far past any sensible timeout. The admin screen
   * points at the CLI for large runs.
   */
  async generateCorpus(input: { profile: CorpusProfile; count?: number; seed?: number; reset: boolean }) {
    const options = resolveCorpusOptions(this.deps.config, {
      profile: input.profile,
      count: input.count ?? defaultCountForProfile(input.profile),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      reset: input.reset,
    });

    const { result } = await this.deps.corpus.generate(options);
    return result;
  }

  schedulerStatus(): { enabled: boolean; cron: string | null; nextRun: string | null } {
    return {
      enabled: this.deps.scheduler?.isRunning ?? false,
      cron: this.deps.config.ingestion.cron,
      nextRun: this.deps.scheduler?.nextRun?.toISOString() ?? null,
    };
  }
}
