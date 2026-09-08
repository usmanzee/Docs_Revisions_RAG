/**
 * Typed application configuration derived from the validated environment.
 *
 * Grouped by concern so call sites can depend on a narrow slice (e.g. a chunker
 * takes `ChunkingConfig`, not the whole world), which keeps unit tests honest.
 */

import path from 'node:path';
import { parseEnv, REPO_ROOT, type Env } from './env.js';

export { REPO_ROOT } from './env.js';
export type { Env } from './env.js';

/**
 * Known embedding dimensions, used only to warn when EMBEDDING_DIMENSIONS
 * disagrees with a well-known model. The configured value always wins - the
 * point is to catch a mistake, not to hardcode a model registry.
 */
export const KNOWN_EMBEDDING_DIMENSIONS: Readonly<Record<string, number>> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

export interface DatabaseConfig {
  url: string;
  testUrl: string | null;
  poolMax: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
}

export interface OpenAIConfig {
  apiKey: string | null;
  baseUrl: string | null;
  chatModel: string;
  embeddingModel: string;
  requestTimeoutMs: number;
  requestConcurrency: number;
  retryLimit: number;
  temperature: number;
  maxOutputTokens: number;
}

export interface EmbeddingConfig {
  provider: 'openai' | 'mock';
  model: string;
  dimensions: number;
  maxBatchSize: number;
  inputMaxTokens: number;
}

export interface StorageConfig {
  driver: 'local';
  root: string;
}

export interface ChunkingConfig {
  targetTokens: number;
  maxTokens: number;
  minTokens: number;
  overlapTokens: number;
  parentChunksEnabled: boolean;
  parentMaxTokens: number;
}

export interface RetrievalConfig {
  vectorTopK: number;
  lexicalTopK: number;
  rrfK: number;
  finalContextChunks: number;
  contextTokenBudget: number;
  vectorMaxDistance: number;
  reranker: 'noop';
  parentExpansion: boolean;
  loggingEnabled: boolean;
}

export interface ChatConfig {
  historyTurns: number;
  historyTokenBudget: number;
  queryRewriteEnabled: boolean;
  temperature: number;
  maxOutputTokens: number;
}

export interface IngestionConfig {
  cron: string | null;
  runOnBoot: boolean;
  maxDocumentsPerRun: number;
  concurrency: number;
  allowLargeOpenAIIngestion: boolean;
  largeOpenAIThreshold: number;
}

export interface OcrConfig {
  enabled: boolean;
  provider: 'tesseract' | 'none';
  language: string;
  minNativeChars: number;
  minCharsPerPageArea: number;
  renderScale: number;
  maxPagesPerDocument: number;
  concurrency: number;
}

export interface VisionConfig {
  enabled: boolean;
  provider: 'openai' | 'none';
  model: string;
  maxImagesPerDocument: number;
}

export interface CorpusConfig {
  profile: 'smoke' | 'quality' | 'scale';
  size: number;
  seed: number;
  scannedRatio: number;
  workflowRatio: number;
  multiRevisionRatio: number;
  corruptRatio: number;
  inactiveRatio: number;
  duplicateRatio: number;
  docxRatio: number;
  textRatio: number;
  tableRatio: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  webPort: number;
  corsOrigins: string[];
  adminApiKey: string;
  rateLimitMax: number;
  rateLimitWindow: string;
  debugEndpointsEnabled: boolean;
}

export interface AppConfig {
  env: Env['NODE_ENV'];
  isProduction: boolean;
  isTest: boolean;
  repoRoot: string;
  log: { level: Env['LOG_LEVEL']; pretty: boolean };
  server: ServerConfig;
  database: DatabaseConfig;
  openai: OpenAIConfig;
  embedding: EmbeddingConfig;
  storage: StorageConfig;
  chunking: ChunkingConfig;
  retrieval: RetrievalConfig;
  chat: ChatConfig;
  ingestion: IngestionConfig;
  ocr: OcrConfig;
  vision: VisionConfig;
  corpus: CorpusConfig;
}

export function buildConfig(env: Env = parseEnv()): AppConfig {
  const isTest = env.NODE_ENV === 'test';
  const isProduction = env.NODE_ENV === 'production';

  // In tests, transparently use the dedicated test database so a stray run can
  // never truncate a development corpus.
  const databaseUrl = isTest && env.TEST_DATABASE_URL ? env.TEST_DATABASE_URL : env.DATABASE_URL;

  const storageRoot = path.isAbsolute(env.DOCUMENT_STORAGE_ROOT)
    ? env.DOCUMENT_STORAGE_ROOT
    : path.resolve(REPO_ROOT, env.DOCUMENT_STORAGE_ROOT);

  // chunk sizing must be internally consistent or the chunker silently degrades
  const maxTokens = Math.max(env.CHUNK_MAX_TOKENS, env.CHUNK_TARGET_TOKENS);
  const overlapTokens = Math.min(env.CHUNK_OVERLAP_TOKENS, Math.floor(env.CHUNK_TARGET_TOKENS / 2));

  return {
    env: env.NODE_ENV,
    isProduction,
    isTest,
    repoRoot: REPO_ROOT,
    log: { level: env.LOG_LEVEL, pretty: env.LOG_PRETTY },
    server: {
      host: env.API_HOST,
      port: env.API_PORT,
      webPort: env.WEB_PORT,
      corsOrigins: env.CORS_ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
      adminApiKey: env.ADMIN_API_KEY,
      rateLimitMax: env.RATE_LIMIT_MAX,
      rateLimitWindow: env.RATE_LIMIT_WINDOW,
      // Debug routes are on by default outside production, and require an
      // explicit opt-in inside it.
      debugEndpointsEnabled: isProduction ? env.ENABLE_DEBUG_ENDPOINTS : true,
    },
    database: {
      url: databaseUrl,
      testUrl: env.TEST_DATABASE_URL,
      poolMax: env.PGPOOL_MAX,
      idleTimeoutMs: env.PGPOOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMs: env.PGPOOL_CONNECTION_TIMEOUT_MS,
      statementTimeoutMs: env.PG_STATEMENT_TIMEOUT_MS,
    },
    openai: {
      apiKey: env.OPENAI_API_KEY,
      baseUrl: env.OPENAI_BASE_URL,
      chatModel: env.OPENAI_CHAT_MODEL,
      embeddingModel: env.OPENAI_EMBEDDING_MODEL,
      requestTimeoutMs: env.OPENAI_REQUEST_TIMEOUT_MS,
      requestConcurrency: env.OPENAI_REQUEST_CONCURRENCY,
      retryLimit: env.OPENAI_RETRY_LIMIT,
      temperature: env.CHAT_TEMPERATURE,
      maxOutputTokens: env.CHAT_MAX_OUTPUT_TOKENS,
    },
    embedding: {
      provider: env.EMBEDDING_PROVIDER,
      model: env.EMBEDDING_PROVIDER === 'mock' ? 'deterministic-mock' : env.OPENAI_EMBEDDING_MODEL,
      dimensions: env.EMBEDDING_DIMENSIONS,
      maxBatchSize: env.MAX_EMBEDDING_BATCH_SIZE,
      inputMaxTokens: env.EMBEDDING_INPUT_MAX_TOKENS,
    },
    storage: { driver: env.DOCUMENT_STORAGE_DRIVER, root: storageRoot },
    chunking: {
      targetTokens: env.CHUNK_TARGET_TOKENS,
      maxTokens,
      minTokens: env.CHUNK_MIN_TOKENS,
      overlapTokens,
      parentChunksEnabled: env.PARENT_CHUNKS_ENABLED,
      parentMaxTokens: env.PARENT_CHUNK_MAX_TOKENS,
    },
    retrieval: {
      vectorTopK: env.VECTOR_TOP_K,
      lexicalTopK: env.LEXICAL_TOP_K,
      rrfK: env.RRF_K,
      finalContextChunks: env.FINAL_CONTEXT_CHUNKS,
      contextTokenBudget: env.CONTEXT_TOKEN_BUDGET,
      vectorMaxDistance: env.VECTOR_MAX_DISTANCE,
      reranker: env.RERANKER,
      parentExpansion: env.RETRIEVAL_PARENT_EXPANSION,
      loggingEnabled: env.RETRIEVAL_LOGGING_ENABLED,
    },
    chat: {
      historyTurns: env.CHAT_HISTORY_TURNS,
      historyTokenBudget: env.CHAT_HISTORY_TOKEN_BUDGET,
      queryRewriteEnabled: env.QUERY_REWRITE_ENABLED,
      temperature: env.CHAT_TEMPERATURE,
      maxOutputTokens: env.CHAT_MAX_OUTPUT_TOKENS,
    },
    ingestion: {
      cron: env.INGESTION_CRON,
      runOnBoot: env.INGESTION_RUN_ON_BOOT,
      maxDocumentsPerRun: env.MAX_DOCUMENTS_PER_INGESTION_RUN,
      concurrency: env.INGESTION_CONCURRENCY,
      allowLargeOpenAIIngestion: env.ALLOW_LARGE_OPENAI_INGESTION,
      largeOpenAIThreshold: env.LARGE_OPENAI_INGESTION_THRESHOLD,
    },
    ocr: {
      enabled: env.OCR_ENABLED && env.OCR_PROVIDER !== 'none',
      provider: env.OCR_PROVIDER,
      language: env.OCR_LANGUAGE,
      minNativeChars: env.OCR_MIN_NATIVE_CHARS,
      minCharsPerPageArea: env.OCR_MIN_CHARS_PER_PAGE_AREA,
      renderScale: env.OCR_RENDER_SCALE,
      maxPagesPerDocument: env.OCR_MAX_PAGES_PER_DOCUMENT,
      concurrency: env.OCR_CONCURRENCY,
    },
    vision: {
      enabled: env.VISION_ENABLED && env.VISION_PROVIDER !== 'none',
      provider: env.VISION_PROVIDER,
      model: env.VISION_MODEL,
      maxImagesPerDocument: env.VISION_MAX_IMAGES_PER_DOCUMENT,
    },
    corpus: {
      profile: env.MOCK_CORPUS_PROFILE,
      size: env.MOCK_CORPUS_SIZE,
      seed: env.MOCK_CORPUS_SEED,
      scannedRatio: env.MOCK_SCANNED_RATIO,
      workflowRatio: env.MOCK_WORKFLOW_RATIO,
      multiRevisionRatio: env.MOCK_MULTI_REVISION_RATIO,
      corruptRatio: env.MOCK_CORRUPT_RATIO,
      inactiveRatio: env.MOCK_INACTIVE_RATIO,
      duplicateRatio: env.MOCK_DUPLICATE_RATIO,
      docxRatio: env.MOCK_DOCX_RATIO,
      textRatio: env.MOCK_TEXT_RATIO,
      tableRatio: env.MOCK_TABLE_RATIO,
    },
  };
}

let cached: AppConfig | null = null;

/** Process-wide configuration singleton. */
export function getConfig(): AppConfig {
  cached ??= buildConfig();
  return cached;
}

/** Test helper: force the config to be rebuilt from the current environment. */
export function resetConfigCache(): void {
  cached = null;
}

/**
 * Warnings that should be surfaced at boot but must not stop the process.
 * Hard failures (e.g. a dimension mismatch with the database) are raised by
 * `assertSchemaCompatibility` in src/db, which can actually query the schema.
 */
export function collectConfigWarnings(config: AppConfig): string[] {
  const warnings: string[] = [];

  const known = KNOWN_EMBEDDING_DIMENSIONS[config.openai.embeddingModel];
  if (config.embedding.provider === 'openai' && known && known !== config.embedding.dimensions) {
    warnings.push(
      `EMBEDDING_DIMENSIONS=${config.embedding.dimensions} does not match the known dimension ` +
        `(${known}) of OPENAI_EMBEDDING_MODEL=${config.openai.embeddingModel}.`,
    );
  }

  if (config.embedding.provider === 'openai' && !config.openai.apiKey) {
    warnings.push(
      'EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is not set. Ingestion and chat will fail. ' +
        'Set the key, or use EMBEDDING_PROVIDER=mock for infrastructure-only testing.',
    );
  }

  if (config.embedding.provider === 'mock') {
    warnings.push(
      'EMBEDDING_PROVIDER=mock - vectors are deterministic but NOT semantically meaningful. ' +
        'Valid for scale/infrastructure testing only; retrieval-quality numbers from this mode are meaningless.',
    );
  }

  if (config.isProduction && config.server.adminApiKey === 'dev-admin-key') {
    warnings.push('ADMIN_API_KEY is still the development default while NODE_ENV=production.');
  }

  if (config.isProduction && config.server.debugEndpointsEnabled) {
    warnings.push('Debug endpoints are enabled in production (ENABLE_DEBUG_ENDPOINTS=true).');
  }

  return warnings;
}
