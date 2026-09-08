/**
 * Request validation schemas.
 *
 * Every body, query string and path parameter that reaches a handler has been
 * through one of these. Two things follow: handlers can trust their inputs, and
 * a client can never smuggle an unexpected field into a database query - most
 * importantly, never a filesystem path.
 */

import { z } from 'zod';
import { DOCUMENT_TYPES, CORPUS_PROFILES } from '@docs-rag/shared';

export const uuidSchema = z.string().uuid('must be a UUID');

export const idParamSchema = z.object({ id: uuidSchema });

/** Document codes are matched against a strict pattern, never used as a path. */
export const documentCodeSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'invalid document code');

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export const retrievalFiltersSchema = z
  .object({
    department: z.string().max(120).nullish(),
    documentType: z.enum(DOCUMENT_TYPES).nullish(),
    category: z.string().max(120).nullish(),
    documentCode: documentCodeSchema.nullish(),
    includeHistorical: z.boolean().optional(),
  })
  .strict()
  .default({});

export const chatRequestSchema = z
  .object({
    conversationId: uuidSchema.nullish(),
    message: z.string().trim().min(1, 'message cannot be empty').max(4000),
    filters: retrievalFiltersSchema.optional(),
  })
  .strict();

export const createConversationSchema = z
  .object({
    title: z.string().trim().max(120).nullish(),
    filters: retrievalFiltersSchema.optional(),
  })
  .strict();

export const documentListQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(200).optional(),
  department: z.string().max(120).optional(),
  documentType: z.enum(DOCUMENT_TYPES).optional(),
  category: z.string().max(120).optional(),
  isActive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  processingStatus: z.enum(['PENDING', 'PROCESSING', 'READY', 'FAILED', 'SUPERSEDED']).optional(),
  sort: z.string().max(40).optional(),
});

export const revisionContentQuerySchema = z.object({
  maxPages: z.coerce.number().int().min(1).max(200).default(50),
});

export const chunkListQuerySchema = paginationSchema.extend({
  revisionId: uuidSchema.optional(),
});

export const debugRetrievalSchema = z
  .object({
    query: z.string().trim().min(1).max(2000),
    filters: retrievalFiltersSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    conversationId: uuidSchema.nullish(),
  })
  .strict();

export const generateCorpusSchema = z
  .object({
    profile: z.enum(CORPUS_PROFILES).default('smoke'),
    count: z.coerce.number().int().min(1).max(1000).optional(),
    seed: z.coerce.number().int().optional(),
    reset: z.boolean().default(true),
  })
  .strict();

export const createRevisionSchema = z
  .object({
    /** Force a specific mutation shape; otherwise one is chosen at random. */
    mutationType: z
      .enum([
        'NUMERIC_THRESHOLD',
        'EFFECTIVE_DATE',
        'RESPONSIBILITY',
        'PROCESS_STEP_ADDED',
        'PROCESS_STEP_REMOVED',
        'PARAGRAPH_REPLACED',
        'ORACLE_RECOMMENDATION',
        'RETENTION_DURATION',
        'APPROVAL_ROLE',
      ])
      .optional(),
    /** Write an unreadable file, to exercise the failure path. */
    corrupt: z.boolean().default(false),
  })
  .strict();

export const runIngestionSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(5000).optional(),
    skipDiscovery: z.boolean().default(false),
  })
  .strict();

export const ingestionJobListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const retrievalLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  source: z.enum(['CHAT', 'DEBUG', 'EVALUATION', 'BENCHMARK']).optional(),
});

/** Parse and throw a ZodError the error handler converts into a 400. */
export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  return schema.parse(input);
}
