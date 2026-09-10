/**
 * Mock HCM application assembly.
 *
 * Exported separately from the server entry point so tests can build an
 * instance and use Fastify's `inject` without binding a port.
 */

import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import type { MockConfig } from './config.js';
import { LeaveService } from './domain/leave-service.js';
import { seedStore } from './domain/seed.js';
import { HcmStore } from './domain/store.js';
import { createAuthGuard } from './middleware/auth.js';
import { registerErrorHandler } from './middleware/errors.js';
import { createSimulationHook } from './middleware/simulation.js';
import { registerRoutes } from './routes/index.js';

export interface BuiltApp {
  app: FastifyInstance;
  store: HcmStore;
  service: LeaveService;
}

export async function buildApp(config: MockConfig): Promise<BuiltApp> {
  const store = new HcmStore(config.persistPath);

  // Restore a previous session if one was snapshotted, otherwise seed fresh.
  // A snapshot from a different seed is discarded: mixing the two would give a
  // population that matches neither, which is worse than either.
  const persisted = store.readPersisted();
  if (persisted && persisted.seed === config.seed) {
    store.load(persisted);
  } else {
    seedStore(store, config.rules, config.seed);
    store.persist(config.seed);
  }

  const service = new LeaveService(store, config.rules, () => store.persist(config.seed));

  const app = Fastify({
    // Cast: pino's Logger satisfies FastifyBaseLogger structurally, but naming
    // the concrete type would specialise FastifyInstance and make every
    // encapsulated plugin scope a different, incompatible type.
    loggerInstance: pino({
      level: config.logLevel,
      base: { service: 'hcm-mock' },
      ...(config.logPretty
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' },
            },
          }
        : {}),
    }) as FastifyBaseLogger,
    genReqId: (request) => {
      const header = request.headers['x-correlation-id'];
      const provided = Array.isArray(header) ? header[0] : header;
      return provided && provided.length <= 128 ? provided : randomUUID();
    },
    bodyLimit: 262_144,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      callback(null, config.corsOrigins.includes(origin));
    },
    allowedHeaders: ['content-type', 'authorization', 'x-correlation-id'],
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  // Order matters: simulate failures before doing any work, then authenticate.
  if (config.latencyMs > 0 || config.errorRate > 0) {
    app.addHook('onRequest', createSimulationHook(config.latencyMs, config.errorRate));
  }
  app.addHook('onRequest', createAuthGuard(config.apiKey));

  registerErrorHandler(app);
  await registerRoutes(app, { service });

  return { app, store, service };
}
