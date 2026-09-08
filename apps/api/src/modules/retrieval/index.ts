/** Retrieval module composition. */

import { getConfig, type AppConfig } from '../../config/index.js';
import { getPool } from '../../db/pool.js';
import { RetrievalLogRepository } from '../../repositories/retrieval-log-repository.js';
import { RetrievalRepository } from '../../repositories/retrieval-repository.js';
import { getEmbeddingProvider } from '../embeddings/index.js';
import { createReranker } from './reranker.js';
import { RetrievalService } from './retrieval-service.js';

export * from './types.js';
export * from './rrf.js';
export * from './reranker.js';
export * from './query-analysis.js';
export * from './context-builder.js';
export { RetrievalService } from './retrieval-service.js';

export function createRetrievalService(config: AppConfig = getConfig()): RetrievalService {
  const pool = getPool();
  return new RetrievalService({
    repository: new RetrievalRepository(pool),
    embeddings: getEmbeddingProvider(),
    reranker: createReranker(config.retrieval.reranker),
    logs: new RetrievalLogRepository(pool),
    config,
  });
}
