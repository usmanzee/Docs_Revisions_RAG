/**
 * Bearer token authentication.
 *
 * A real HCM API is behind a credential, so the mock is too - otherwise the
 * client gets built without an auth path and acquires one late, which is
 * exactly when auth bugs are introduced.
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { HcmError } from '../domain/leave-service.js';

function matches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createAuthGuard(apiKey: string) {
  return async function requireApiKey(request: FastifyRequest): Promise<void> {
    // Health and the OpenAPI-ish descriptor stay open, as they would in a real
    // deployment behind a load balancer.
    if (request.url === '/health' || request.url === '/') return;

    const header = request.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : undefined;

    if (!token || !matches(token, apiKey)) {
      throw new HcmError(
        'VALIDATION_ERROR',
        'Missing or invalid bearer token. Send "Authorization: Bearer <HCM_MOCK_API_KEY>".',
        401,
      );
    }
  };
}
