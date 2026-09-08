/**
 * Admin authentication.
 *
 * A shared secret is the right amount of security for a development and demo
 * tool, and the wrong amount for anything real. It is deliberately isolated
 * behind a hook so replacing it with OIDC/SSO means changing this file and
 * nothing else - see docs/security-and-permissions.md.
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/index.js';
import { AppError } from '../utils/errors.js';

export const ADMIN_HEADER = 'x-admin-key';

/** Constant-time comparison, so the header cannot be guessed byte by byte. */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createAdminGuard(config: AppConfig) {
  return async function requireAdmin(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers[ADMIN_HEADER];
    const provided = Array.isArray(header) ? header[0] : header;

    if (!provided || !secretsMatch(provided, config.server.adminApiKey)) {
      request.log.warn({ requestId: request.id, route: request.url }, 'rejected admin request');
      throw new AppError('UNAUTHORIZED', `Missing or invalid ${ADMIN_HEADER} header`);
    }
  };
}

/**
 * Guard for development-only routes. In production they are disabled entirely
 * unless explicitly enabled, and still require the admin secret.
 */
export function createDebugGuard(config: AppConfig) {
  const requireAdmin = createAdminGuard(config);

  return async function requireDebugAccess(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!config.server.debugEndpointsEnabled) {
      throw new AppError('NOT_FOUND', 'Debug endpoints are disabled');
    }
    await requireAdmin(request, reply);
  };
}
