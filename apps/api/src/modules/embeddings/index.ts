/**
 * Embedding provider factory and cost guard.
 */

import { getConfig, type AppConfig } from '../../config/index.js';
import { AppError } from '../../utils/errors.js';
import { childLogger } from '../../utils/logger.js';
import { DeterministicMockEmbeddingProvider } from './mock-provider.js';
import { OpenAIEmbeddingProvider } from './openai-provider.js';
import type { EmbeddingProvider } from './types.js';

export * from './types.js';
export { DeterministicMockEmbeddingProvider } from './mock-provider.js';
export { OpenAIEmbeddingProvider } from './openai-provider.js';

let cached: EmbeddingProvider | null = null;

export function createEmbeddingProvider(config: AppConfig = getConfig()): EmbeddingProvider {
  if (config.embedding.provider === 'mock') {
    childLogger({ component: 'embeddings' }).warn(
      'using the deterministic mock embedding provider - vectors are NOT semantically meaningful',
    );
    return new DeterministicMockEmbeddingProvider(config.embedding.dimensions);
  }
  return new OpenAIEmbeddingProvider(config);
}

export function getEmbeddingProvider(): EmbeddingProvider {
  cached ??= createEmbeddingProvider();
  return cached;
}

export function setEmbeddingProvider(provider: EmbeddingProvider | null): void {
  cached = provider;
}

/**
 * Refuse to embed a large corpus through a paid API by accident.
 *
 * The scale profile exists to test infrastructure; running it against OpenAI
 * would mean thousands of requests for vectors nobody intends to evaluate. That
 * has to be an explicit decision, not an oversight, so this throws rather than
 * warns.
 */
export function assertIngestionCostGuard(
  documentCount: number,
  provider: EmbeddingProvider = getEmbeddingProvider(),
  config: AppConfig = getConfig(),
): void {
  if (provider.name !== 'openai') return;
  if (config.ingestion.allowLargeOpenAIIngestion) return;
  if (documentCount <= config.ingestion.largeOpenAIThreshold) return;

  throw new AppError(
    'CONFIGURATION_ERROR',
    `Refusing to embed ${documentCount} revisions through OpenAI: that exceeds ` +
      `LARGE_OPENAI_INGESTION_THRESHOLD=${config.ingestion.largeOpenAIThreshold} and ` +
      'ALLOW_LARGE_OPENAI_INGESTION is false.\n\n' +
      'Either:\n' +
      '  • set EMBEDDING_PROVIDER=mock for infrastructure/scale testing, or\n' +
      '  • set ALLOW_LARGE_OPENAI_INGESTION=true if you intend to pay for this run, or\n' +
      '  • lower MAX_DOCUMENTS_PER_INGESTION_RUN to ingest in smaller batches.',
    { expected: true },
  );
}
