/**
 * Composition root.
 *
 * Everything is constructed once, here, and passed to the routes. Modules take
 * their dependencies through constructors rather than importing singletons, so
 * a test can build a container against a test database with a stub model and
 * exercise the same code the server runs.
 */

import type pg from 'pg';
import { getConfig, type AppConfig } from './config/index.js';
import { getPool } from './db/pool.js';
import { AdminController } from './controllers/admin-controller.js';
import { ChatController } from './controllers/chat-controller.js';
import { DebugController } from './controllers/debug-controller.js';
import { DocumentController } from './controllers/document-controller.js';
import { ChunkRepository } from './repositories/chunk-repository.js';
import { ConversationRepository } from './repositories/conversation-repository.js';
import { DocumentRepository } from './repositories/document-repository.js';
import { IngestionRepository } from './repositories/ingestion-repository.js';
import { RetrievalLogRepository } from './repositories/retrieval-log-repository.js';
import { RetrievalRepository } from './repositories/retrieval-repository.js';
import { RevisionRepository } from './repositories/revision-repository.js';
import { StatsRepository } from './repositories/stats-repository.js';
import { getChatModelProvider, type ChatModelProvider } from './modules/chat/chat-model.js';
import { RagService } from './modules/chat/rag-service.js';
import { CorpusGenerator } from './modules/corpus/corpus-generator.js';
import { RevisionSimulator } from './modules/corpus/revision-simulator.js';
import { getEmbeddingProvider, type EmbeddingProvider } from './modules/embeddings/index.js';
import { getHcmClient, type HcmClient } from './modules/hcm/index.js';
import { createLeaveTools } from './modules/chat/tools/leave-tools.js';
import { DocumentIngestionService } from './modules/ingestion/ingestion-service.js';
import { createIngestionScheduler, type IngestionScheduler } from './modules/ingestion/scheduler.js';
import { getOCRProvider, type OCRProvider } from './modules/ocr/index.js';
import { createParserRegistry, type ParserRegistry } from './modules/parsing/index.js';
import { createReranker } from './modules/retrieval/reranker.js';
import { RetrievalService } from './modules/retrieval/retrieval-service.js';
import { LocalDocumentStorage, type DocumentStorage } from './modules/storage/index.js';
import { createVisionEnricher, type VisionDocumentEnricher } from './modules/vision/index.js';

export interface AppContainer {
  config: AppConfig;
  pool: pg.Pool;

  storage: DocumentStorage;
  parsers: ParserRegistry;
  ocr: OCRProvider;
  vision: VisionDocumentEnricher;
  embeddings: EmbeddingProvider;
  chatModel: ChatModelProvider;
  hcm: HcmClient;

  retrieval: RetrievalService;
  rag: RagService;
  ingestion: DocumentIngestionService;
  scheduler: IngestionScheduler | null;

  documents: DocumentController;
  chat: ChatController;
  admin: AdminController;
  debug: DebugController;
}

export interface ContainerOverrides {
  config?: AppConfig;
  pool?: pg.Pool;
  storage?: DocumentStorage;
  embeddings?: EmbeddingProvider;
  chatModel?: ChatModelProvider;
  hcm?: HcmClient;
  ocr?: OCRProvider;
  /** Skip scheduler construction; tests never want a cron job running. */
  withScheduler?: boolean;
}

export function createContainer(overrides: ContainerOverrides = {}): AppContainer {
  const config = overrides.config ?? getConfig();
  const pool = overrides.pool ?? getPool();

  const storage = overrides.storage ?? new LocalDocumentStorage(config.storage.root);
  const ocr = overrides.ocr ?? getOCRProvider();
  const parsers = createParserRegistry(config, ocr);
  const vision = createVisionEnricher(config);
  const embeddings = overrides.embeddings ?? getEmbeddingProvider();
  const chatModel = overrides.chatModel ?? getChatModelProvider();
  const hcm = overrides.hcm ?? getHcmClient();

  const documentRepository = new DocumentRepository(pool);
  const revisionRepository = new RevisionRepository(pool);
  const chunkRepository = new ChunkRepository(pool);
  const retrievalRepository = new RetrievalRepository(pool);
  const retrievalLogRepository = new RetrievalLogRepository(pool);
  const ingestionRepository = new IngestionRepository(pool);
  const conversationRepository = new ConversationRepository(pool);
  const statsRepository = new StatsRepository(pool);

  const retrieval = new RetrievalService({
    repository: retrievalRepository,
    embeddings,
    reranker: createReranker(config.retrieval.reranker),
    logs: retrievalLogRepository,
    config,
  });

  // Leave tools are offered only when an HCM is actually configured. An
  // assistant that advertises a capability it cannot deliver is worse than one
  // that never mentions it.
  const tools = config.hcm.toolsEnabled && hcm.isConfigured() ? createLeaveTools(hcm) : [];

  const rag = new RagService({
    retrieval,
    chatModel,
    conversations: conversationRepository,
    tools,
    config,
  });

  const ingestion = new DocumentIngestionService({
    storage,
    parsers,
    embeddings,
    vision,
    documents: documentRepository,
    revisions: revisionRepository,
    chunks: chunkRepository,
    jobs: ingestionRepository,
    config,
    pool,
  });

  const simulator = new RevisionSimulator(storage, documentRepository, revisionRepository);

  const corpus = new CorpusGenerator({
    storage,
    documents: documentRepository,
    revisions: revisionRepository,
    config,
  });

  const scheduler = overrides.withScheduler === false ? null : createIngestionScheduler(ingestion, config);

  return {
    config,
    pool,
    storage,
    parsers,
    ocr,
    vision,
    embeddings,
    chatModel,
    hcm,
    retrieval,
    rag,
    ingestion,
    scheduler,
    documents: new DocumentController({
      documents: documentRepository,
      revisions: revisionRepository,
      chunks: chunkRepository,
      storage,
      parsers,
    }),
    chat: new ChatController({ conversations: conversationRepository, rag }),
    admin: new AdminController({
      stats: statsRepository,
      jobs: ingestionRepository,
      conversations: conversationRepository,
      revisions: revisionRepository,
      ingestion,
      simulator,
      corpus,
      embeddings,
      storage,
      scheduler,
      config,
    }),
    debug: new DebugController({ rag, embeddings, logs: retrievalLogRepository, config }),
  };
}
