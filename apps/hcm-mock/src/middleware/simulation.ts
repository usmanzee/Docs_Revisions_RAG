/**
 * Failure and latency simulation.
 *
 * A client written against an API that is always instant and always succeeds is
 * a client that has never had its timeout or retry path executed. These knobs
 * make those paths reachable on demand:
 *
 *   HCM_MOCK_LATENCY_MS=800   every call takes 800ms
 *   HCM_MOCK_ERROR_RATE=0.2   one call in five returns 503
 *
 * Both default to off, so normal development is not slowed down.
 */

import type { FastifyRequest } from 'fastify';
import type { HcmErrorBody } from '@docs-rag/hcm-contract';
import type { FastifyReply } from 'fastify';
import { correlationIdOf } from './errors.js';

export function createSimulationHook(latencyMs: number, errorRate: number) {
  return async function simulate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (request.url === '/health') return;

    if (latencyMs > 0) {
      // Jittered around the configured value, because a constant delay is not
      // what a real network looks like.
      const jitter = latencyMs * (0.75 + Math.random() * 0.5);
      await new Promise((resolve) => setTimeout(resolve, jitter));
    }

    if (errorRate > 0 && Math.random() < errorRate) {
      const body: HcmErrorBody = {
        error: {
          code: 'UPSTREAM_ERROR',
          message: 'The HCM service is temporarily unavailable. Please retry.',
          correlationId: correlationIdOf(request),
        },
      };
      // Retry-After is what a well-behaved client should honour.
      await reply.status(503).header('retry-after', '2').send(body);
    }
  };
}
