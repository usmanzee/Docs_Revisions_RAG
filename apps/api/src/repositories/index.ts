/**
 * Repository composition root.
 *
 * Services take the repositories they need through their constructor; this
 * container just wires up the default (pool-backed) instances so route handlers
 * and CLI scripts share one set. Tests construct repositories directly against
 * a test pool instead of importing this.
 */

import { getPool, type Queryable } from '../db/pool.js';
import { ChunkRepository } from './chunk-repository.js';
import { ConversationRepository } from './conversation-repository.js';
import { DocumentRepository } from './document-repository.js';
import { IngestionRepository } from './ingestion-repository.js';
import { RetrievalLogRepository } from './retrieval-log-repository.js';
import { RetrievalRepository } from './retrieval-repository.js';
import { RevisionRepository } from './revision-repository.js';
import { StatsRepository } from './stats-repository.js';

export * from './chunk-repository.js';
export * from './conversation-repository.js';
export * from './document-repository.js';
export * from './ingestion-repository.js';
export * from './retrieval-log-repository.js';
export * from './retrieval-repository.js';
export * from './revision-repository.js';
export * from './stats-repository.js';
export * from './types.js';

export interface Repositories {
  documents: DocumentRepository;
  revisions: RevisionRepository;
  chunks: ChunkRepository;
  retrieval: RetrievalRepository;
  ingestion: IngestionRepository;
  conversations: ConversationRepository;
  retrievalLogs: RetrievalLogRepository;
  stats: StatsRepository;
}

export function createRepositories(executor: Queryable = getPool()): Repositories {
  return {
    documents: new DocumentRepository(executor),
    revisions: new RevisionRepository(executor),
    chunks: new ChunkRepository(executor),
    retrieval: new RetrievalRepository(executor),
    ingestion: new IngestionRepository(executor),
    conversations: new ConversationRepository(executor),
    retrievalLogs: new RetrievalLogRepository(executor),
    stats: new StatsRepository(executor),
  };
}
