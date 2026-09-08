/**
 * Fastify application assembly.
 *
 * Security plugins are registered before routes so no route can be added later
 * that is accidentally outside CORS, helmet or the rate limiter.
 */

import Fastify, { type FastifyBaseLogger } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import type { AppContainer } from './container.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { registerRoutes } from './routes/index.js';
import { getLogger } from './utils/logger.js';
import type { AppInstance } from './types/fastify.js';

export interface BuildAppOptions {
  container: AppContainer;
}

export async function buildApp({ container }: BuildAppOptions): Promise<AppInstance> {
  const { config } = container;

  const app = Fastify({
    // Cast: pino's Logger satisfies FastifyBaseLogger structurally, but naming
    // the concrete type here would specialise FastifyInstance and make every
    // encapsulated plugin scope a different, incompatible type.
    loggerInstance: getLogger() as FastifyBaseLogger,
    // Correlate every log line for a request. An inbound x-request-id is
    // honoured so a trace can be followed across services.
    genReqId: (request) => {
      const header = request.headers['x-request-id'];
      const provided = Array.isArray(header) ? header[0] : header;
      return provided && provided.length <= 128 ? provided : randomUUID();
    },
    trustProxy: true,
    // A generated corpus request or a long ingestion run legitimately takes a
    // while; the SSE chat stream is exempt because the reply is hijacked.
    requestTimeout: 0,
    bodyLimit: 1_048_576,
  });

  await app.register(helmet, {
    // The API serves JSON and file downloads, never HTML, so a restrictive
    // policy costs nothing and blocks any attempt to render a document inline.
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], sandbox: [] },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      // Same-origin and non-browser callers (curl, the CLI scripts) send no
      // Origin header and are allowed through.
      if (!origin) return callback(null, true);
      if (config.server.corsOrigins.includes(origin)) return callback(null, true);
      callback(null, false);
    },
    credentials: true,
    allowedHeaders: ['content-type', 'x-admin-key', 'x-request-id'],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  });

  await app.register(rateLimit, {
    max: config.server.rateLimitMax,
    timeWindow: config.server.rateLimitWindow,
    // Health checks must never be throttled: an orchestrator polls them.
    allowList: (request) => request.url === '/health' || request.url === '/ready',
    keyGenerator: (request) => request.ip,
  });

  registerErrorHandler(app);
  await registerRoutes(app, container);

  app.addHook('onResponse', async (request, reply) => {
    // One structured completion line per request, with the fields the rest of
    // the system correlates on.
    request.log.info(
      {
        requestId: request.id,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
  });

  return app;
}
