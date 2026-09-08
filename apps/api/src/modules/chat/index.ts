/** Chat module composition. */

import { getConfig, type AppConfig } from '../../config/index.js';
import { getPool } from '../../db/pool.js';
import { ConversationRepository } from '../../repositories/conversation-repository.js';
import { createRetrievalService } from '../retrieval/index.js';
import { getChatModelProvider } from './chat-model.js';
import { RagService } from './rag-service.js';

export * from './chat-model.js';
export * from './rag-service.js';

export function createRagService(config: AppConfig = getConfig()): RagService {
  return new RagService({
    retrieval: createRetrievalService(config),
    chatModel: getChatModelProvider(),
    conversations: new ConversationRepository(getPool()),
    config,
  });
}
