/**
 * API entry point.
 *
 * Boot order matters: configuration is validated, the database is reached and
 * its schema checked against the configured embedding dimension, and only then
 * does the server begin accepting traffic. Starting up and failing on the first
 * request is worse than refusing to start.
 */

import { assertSupportedNodeVersion } from './utils/runtime.js';
import { buildApp } from './app.js';
import { collectConfigWarnings, getConfig } from './config/index.js';
import { createContainer } from './container.js';
import { assertDatabaseReachable, assertSchemaCompatibility, closePool } from './db/pool.js';
import { disposeOCRProvider } from './modules/ocr/index.js';
import { toErrorMessage } from './utils/errors.js';
import { childLogger } from './utils/logger.js';

async function main(): Promise<void> {
  // Before anything else: an unsupported runtime fails here, clearly, rather
  // than as dozens of confusing parse errors during the first ingestion run.
  assertSupportedNodeVersion();

  const config = getConfig();
  const logger = childLogger({ component: 'server' });

  for (const warning of collectConfigWarnings(config)) logger.warn(warning);

  const container = createContainer();

  await assertDatabaseReachable(container.pool);
  await assertSchemaCompatibility(config, container.pool);

  const app = await buildApp({ container });

  await app.listen({ host: config.server.host, port: config.server.port });

  logger.info(
    {
      port: config.server.port,
      env: config.env,
      embeddingProvider: config.embedding.provider,
      chatModel: config.openai.chatModel,
      debugEndpoints: config.server.debugEndpointsEnabled,
    },
    'API listening',
  );

  if (container.scheduler) {
    container.scheduler.start();
    if (config.ingestion.runOnBoot) {
      // Fire and forget: a slow first ingestion must not delay readiness.
      void container.ingestion
        .run({ trigger: 'SCHEDULED' })
        .catch((error: unknown) =>
          logger.error({ err: { message: toErrorMessage(error) } }, 'boot ingestion failed'),
        );
    }
  }

  /**
   * Graceful shutdown: stop the scheduler, let in-flight requests finish, then
   * release the OCR workers and the connection pool. Without the OCR step the
   * process would hang on exit holding its database session - and with it the
   * ingestion advisory lock.
   */
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    try {
      container.scheduler?.stop();
      await app.close();
      await disposeOCRProvider();
      await closePool();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: { message: toErrorMessage(error) } }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: { message: toErrorMessage(reason) } }, 'unhandled promise rejection');
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: { message: error.message, stack: error.stack } }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- the logger may not exist yet
  console.error('Failed to start the API:', error instanceof Error ? error.stack : error);
  process.exit(1);
});
