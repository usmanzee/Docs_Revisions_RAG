/**
 * Error handling for the mock HCM API.
 *
 * A vendor API's error envelope is part of its contract - a client branches on
 * it - so this is shaped deliberately and consistently rather than left to
 * whatever the framework emits.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { HcmErrorBody } from '@docs-rag/hcm-contract';
import { HcmError } from '../domain/leave-service.js';

export function correlationIdOf(request: FastifyRequest): string {
  const header = request.headers['x-correlation-id'];
  const provided = Array.isArray(header) ? header[0] : header;
  return provided && provided.length <= 128 ? provided : request.id;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const correlationId = correlationIdOf(request);

    if (error instanceof ZodError) {
      const body: HcmErrorBody = {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request payload failed validation.',
          details: error.issues.map((issue) => ({
            field: issue.path.join('.') || '(root)',
            message: issue.message,
            code: issue.code,
          })),
          correlationId,
        },
      };
      return reply.status(400).send(body);
    }

    if (error instanceof HcmError) {
      const body: HcmErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
          correlationId,
        },
      };
      return reply.status(error.statusCode).send(body);
    }

    // Anything else: Fastify's own errors carry a usable status; the rest are
    // genuinely unexpected and must not leak their detail to the caller.
    const fallback = error as { statusCode?: number; message?: string; stack?: string };
    const status = fallback.statusCode ?? 500;

    if (status >= 500) {
      request.log.error(
        { correlationId, err: { message: fallback.message, stack: fallback.stack } },
        'unhandled error',
      );
    }

    const body: HcmErrorBody = {
      error: {
        code: status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR',
        message: status >= 500 ? 'An unexpected error occurred.' : (fallback.message ?? 'Request failed.'),
        correlationId,
      },
    };
    return reply.status(status).send(body);
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const body: HcmErrorBody = {
      error: {
        code: 'NOT_FOUND',
        message: `No route matches ${request.method} ${request.url}.`,
        correlationId: correlationIdOf(request),
      },
    };
    return reply.status(404).send(body);
  });
}
