/**
 * Typed application errors.
 *
 * Every error that can reach an HTTP boundary carries a stable machine code and
 * a status, so route handlers never have to guess how to respond and clients
 * can branch on `error.code` instead of on message text.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'CONFIGURATION_ERROR'
  | 'STORAGE_ERROR'
  | 'PARSE_ERROR'
  | 'OCR_ERROR'
  | 'EMBEDDING_ERROR'
  | 'LLM_ERROR'
  | 'INGESTION_ERROR'
  | 'DATABASE_ERROR'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: unknown;
  /** False for programmer errors that should page someone. */
  readonly expected: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { statusCode?: number; details?: unknown; cause?: unknown; expected?: boolean } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = options.statusCode ?? defaultStatusFor(code);
    this.details = options.details;
    this.expected = options.expected ?? true;
    Error.captureStackTrace?.(this, new.target);
  }
}

function defaultStatusFor(code: ErrorCode): number {
  switch (code) {
    case 'VALIDATION_ERROR':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    case 'CONFIGURATION_ERROR':
      return 500;
    default:
      return 500;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION_ERROR', message, { details });
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, identifier?: string) {
    super('NOT_FOUND', identifier ? `${resource} '${identifier}' was not found` : `${resource} was not found`);
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('CONFIGURATION_ERROR', message, { details, expected: false });
  }
}

export class StorageError extends AppError {
  constructor(message: string, options: { details?: unknown; cause?: unknown } = {}) {
    super('STORAGE_ERROR', message, options);
  }
}

export class ParseError extends AppError {
  constructor(message: string, options: { details?: unknown; cause?: unknown } = {}) {
    super('PARSE_ERROR', message, options);
  }
}

export class EmbeddingError extends AppError {
  constructor(message: string, options: { details?: unknown; cause?: unknown } = {}) {
    super('EMBEDDING_ERROR', message, options);
  }
}

export class LlmError extends AppError {
  constructor(message: string, options: { details?: unknown; cause?: unknown } = {}) {
    super('LLM_ERROR', message, options);
  }
}

export class IngestionError extends AppError {
  /** Pipeline stage that failed, recorded on the ingestion job item. */
  readonly stage: string;

  constructor(stage: string, message: string, options: { details?: unknown; cause?: unknown } = {}) {
    super('INGESTION_ERROR', message, options);
    this.stage = stage;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Never throw while turning an unknown thrown value into a message. */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function toErrorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}
