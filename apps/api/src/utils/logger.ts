/**
 * Structured JSON logging.
 *
 * Redaction is configured centrally so a stray `logger.info({ config })` can
 * never leak an API key, a database password or an authorization header.
 */

import pino, { type Logger, type LoggerOptions } from 'pino';
import { getConfig } from '../config/index.js';

/** Paths scrubbed from every log record, at any of the usual nesting depths. */
const REDACTED_PATHS = [
  'apiKey',
  'password',
  'authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-admin-key"]',
  'headers.authorization',
  'headers["x-admin-key"]',
  '*.apiKey',
  '*.password',
  '*.OPENAI_API_KEY',
  'OPENAI_API_KEY',
  'DATABASE_URL',
  'config.openai.apiKey',
  'config.database.url',
];

function buildOptions(): LoggerOptions {
  const config = getConfig();
  const options: LoggerOptions = {
    level: config.log.level,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    base: { service: 'docs-rag-api', env: config.env },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (config.log.pretty) {
    options.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service,env' },
    };
  }

  return options;
}

let rootLogger: Logger | null = null;

export function getLogger(): Logger {
  rootLogger ??= pino(buildOptions());
  return rootLogger;
}

/**
 * Child logger carrying stable correlation fields.
 * Conventional keys: requestId, conversationId, documentId, revisionId,
 * ingestionJobId, component.
 */
export function childLogger(bindings: Record<string, unknown>): Logger {
  return getLogger().child(bindings);
}

/** Test helper - drop the memoised logger so config changes take effect. */
export function resetLogger(): void {
  rootLogger = null;
}
