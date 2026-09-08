/**
 * Development-only debugging endpoints.
 *
 * Disabled in production unless ENABLE_DEBUG_ENDPOINTS is set, and always
 * behind the admin secret: these expose document content and prompt internals.
 */

import type { AppInstance } from '../types/fastify.js';
import type { AppContainer } from '../container.js';
import { createDebugGuard } from '../middleware/admin-auth.js';
import { debugRetrievalSchema, parse, retrievalLogQuerySchema } from './schemas.js';

export async function registerDebugRoutes(app: AppInstance, container: AppContainer): Promise<void> {
  await app.register(async (debug) => {
    debug.addHook('onRequest', createDebugGuard(container.config));

    debug.post('/retrieval', async (request) => {
      const body = parse(debugRetrievalSchema, request.body);
      return container.debug.retrieval({
        query: body.query,
        ...(body.filters ? { filters: body.filters } : {}),
        conversationId: body.conversationId ?? null,
        ...(body.limit !== undefined ? { limit: body.limit } : {}),
      });
    });

    debug.post('/prompt', async (request) => {
      const body = parse(debugRetrievalSchema, request.body);
      return container.debug.prompt({
        query: body.query,
        ...(body.filters ? { filters: body.filters } : {}),
        conversationId: body.conversationId ?? null,
      });
    });

    debug.get('/retrieval-logs', async (request) => {
      const query = parse(retrievalLogQuerySchema, request.query);
      return container.debug.recentLogs(query.limit, query.source);
    });

    /** Effective configuration, with every secret omitted rather than masked. */
    debug.get('/config', async () => ({
      env: container.config.env,
      embedding: container.config.embedding,
      chunking: container.config.chunking,
      retrieval: container.config.retrieval,
      chat: container.config.chat,
      ingestion: container.config.ingestion,
      ocr: container.config.ocr,
      vision: { ...container.config.vision },
      storage: container.config.storage,
      openai: {
        chatModel: container.config.openai.chatModel,
        embeddingModel: container.config.openai.embeddingModel,
        requestConcurrency: container.config.openai.requestConcurrency,
        retryLimit: container.config.openai.retryLimit,
        apiKeyConfigured: container.config.openai.apiKey !== null,
      },
    }));
  }, { prefix: '/debug' });
}
