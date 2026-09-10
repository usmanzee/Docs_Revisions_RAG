/**
 * Liveness and readiness.
 *
 * `/health` answers "is the process up?" and must never touch the database -
 * an orchestrator uses it to decide whether to restart the container.
 * `/ready` answers "can it serve traffic?" and does check dependencies.
 */

import type { AppInstance } from '../types/fastify.js';
import type { AppContainer } from '../container.js';
import { assertDatabaseReachable } from '../db/pool.js';
import { toErrorMessage } from '../utils/errors.js';

export async function registerHealthRoutes(app: AppInstance, container: AppContainer): Promise<void> {
  app.get('/health', async () => ({
    status: 'ok',
    service: 'docs-rag-api',
    env: container.config.env,
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.get('/ready', async (_request, reply) => {
    try {
      await assertDatabaseReachable(container.pool);
    } catch (error) {
      return reply.status(503).send({
        status: 'unavailable',
        database: 'unreachable',
        message: toErrorMessage(error),
      });
    }

    // The HCM is a soft dependency: chat still answers document questions
    // without it, so an outage there degrades capability rather than readiness.
    const hcmConfigured = container.hcm.isConfigured();
    const hcmReachable = hcmConfigured ? await container.hcm.ping() : false;

    return {
      status: 'ready',
      database: 'reachable',
      embeddingProvider: container.embeddings.name,
      embeddingModel: container.embeddings.model,
      chatModelConfigured: container.chatModel.isAvailable(),
      ingestionCron: container.config.ingestion.cron,
      hcm: {
        configured: hcmConfigured,
        reachable: hcmReachable,
        leaveToolsEnabled: container.config.hcm.toolsEnabled && hcmConfigured,
      },
    };
  });
}
