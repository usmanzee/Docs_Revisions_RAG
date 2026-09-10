/**
 * Mock HCM service entry point.
 *
 * Runs as its own process on its own port. That separation is the whole point:
 * the assistant talks to it over HTTP exactly as it will talk to the real HCM,
 * so swapping systems means changing a base URL and a credential.
 */

import { assertSupportedNodeVersion } from './runtime.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  assertSupportedNodeVersion();

  const config = loadConfig();
  const { app, store } = await buildApp(config);

  await app.listen({ host: config.host, port: config.port });

  app.log.info(
    {
      port: config.port,
      employees: store.listEmployees().length,
      requests: store.allRequests().length,
      persistPath: config.persistPath,
      latencyMs: config.latencyMs,
      errorRate: config.errorRate,
    },
    'mock HCM listening',
  );

  if (config.errorRate > 0) {
    app.log.warn(
      { errorRate: config.errorRate },
      'failure injection is enabled - a share of requests will return 503',
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    store.persist(config.seed);
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error('Failed to start the mock HCM service:', error instanceof Error ? error.stack : error);
  process.exit(1);
});
