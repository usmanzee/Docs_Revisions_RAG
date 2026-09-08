/**
 * Application-specific Fastify instance type.
 *
 * Route modules receive both the root instance and encapsulated plugin scopes,
 * and Fastify types those differently once a concrete logger instance is
 * supplied. Naming the default shape once - and adapting the logger at the one
 * place it is injected - keeps every route signature identical.
 */

import type { FastifyInstance } from 'fastify';

export type AppInstance = FastifyInstance;
