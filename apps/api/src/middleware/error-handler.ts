/**
 * Central error handling.
 *
 * Every route throws typed errors and lets this decide the response, so no
 * handler has to remember the right status code, and no internal detail leaks
 * to a client by accident: expected errors report their message, unexpected
 * ones report a generic message and are logged in full with the request id.
 */

import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { AppInstance } from '../types/fastify.js';
import { ZodError } from 'zod';
import type { ApiErrorBody } from '@docs-rag/shared';
import { AppError, isAppError, toErrorMessage } from '../utils/errors.js';

function zodDetails(error: ZodError): unknown {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

export function registerErrorHandler(app: AppInstance): void {
  app.setErrorHandler((error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;

    if (error instanceof ZodError) {
      const body: ApiErrorBody = {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: zodDetails(error),
          requestId,
        },
      };
      request.log.info({ requestId, issues: body.error.details }, 'request validation failed');
      return reply.status(400).send(body);
    }

    if (isAppError(error)) {
      const body: ApiErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
          requestId,
        },
      };

      if (error.expected) {
        request.log.info({ requestId, code: error.code, message: error.message }, 'request failed');
      } else {
        request.log.error(
          { requestId, code: error.code, err: { message: error.message, stack: error.stack } },
          'request failed',
        );
      }

      return reply.status(error.statusCode).send(body);
    }

    // Fastify's own errors (bad JSON, payload too large, rate limit) carry a
    // usable status; anything else is genuinely unexpected.
    const status = (error as FastifyError).statusCode ?? 500;

    if (status >= 500) {
      request.log.error(
        { requestId, err: { message: toErrorMessage(error), stack: error.stack } },
        'unhandled error',
      );
    }

    const body: ApiErrorBody = {
      error: {
        code: (error as FastifyError).code ?? 'INTERNAL_ERROR',
        message: status >= 500 ? 'An unexpected error occurred' : toErrorMessage(error),
        requestId,
      },
    };

    return reply.status(status).send(body);
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const body: ApiErrorBody = {
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} does not exist`,
        requestId: request.id,
      },
    };
    return reply.status(404).send(body);
  });
}

/** Convert a thrown value into the error body used by the SSE error event. */
export function toErrorEvent(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  return { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' };
}
