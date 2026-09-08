/**
 * Environment loading and validation.
 *
 * Every configurable value in the system passes through this file exactly once.
 * Nothing else in the codebase reads `process.env` directly, which is what makes
 * "the embedding dimension is configurable" true rather than aspirational.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Walk up from this file until a directory containing the workspace marker is
 * found. Works from `src/` under tsx and from `dist/` after a build.
 */
function findRepoRoot(): string {
  let dir = here;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'migrations'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const REPO_ROOT = findRepoRoot();

// Load .env from the repo root. Existing process env always wins so that
// `EMBEDDING_PROVIDER=mock npm run ...` behaves the way an operator expects.
dotenv.config({ path: path.join(REPO_ROOT, '.env'), override: false, quiet: true });

/** Coerce the usual truthy spellings; empty string means "unset". */
const boolish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    });

const intish = (defaultValue: number, min?: number, max?: number) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === '') return defaultValue;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        ctx.addIssue({ code: 'custom', message: `expected an integer, received "${value}"` });
        return z.NEVER;
      }
      if (min !== undefined && parsed < min) {
        ctx.addIssue({ code: 'custom', message: `must be >= ${min}` });
        return z.NEVER;
      }
      if (max !== undefined && parsed > max) {
        ctx.addIssue({ code: 'custom', message: `must be <= ${max}` });
        return z.NEVER;
      }
      return parsed;
    });

const floatish = (defaultValue: number, min?: number, max?: number) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === '') return defaultValue;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        ctx.addIssue({ code: 'custom', message: `expected a number, received "${value}"` });
        return z.NEVER;
      }
      if (min !== undefined && parsed < min) {
        ctx.addIssue({ code: 'custom', message: `must be >= ${min}` });
        return z.NEVER;
      }
      if (max !== undefined && parsed > max) {
        ctx.addIssue({ code: 'custom', message: `must be <= ${max}` });
        return z.NEVER;
      }
      return parsed;
    });

const stringish = (defaultValue: string) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? defaultValue : value.trim()));

const optionalString = () =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? null : value.trim()));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: boolish(false),

  API_HOST: stringish('0.0.0.0'),
  API_PORT: intish(3000, 1, 65535),
  WEB_PORT: intish(5173, 1, 65535),
  CORS_ORIGINS: stringish('http://localhost:5173'),
  ADMIN_API_KEY: stringish('dev-admin-key'),
  RATE_LIMIT_MAX: intish(240, 1),
  RATE_LIMIT_WINDOW: stringish('1 minute'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  TEST_DATABASE_URL: optionalString(),
  PGPOOL_MAX: intish(10, 1, 200),
  PGPOOL_IDLE_TIMEOUT_MS: intish(30_000, 0),
  PGPOOL_CONNECTION_TIMEOUT_MS: intish(10_000, 0),
  PG_STATEMENT_TIMEOUT_MS: intish(60_000, 0),

  OPENAI_API_KEY: optionalString(),
  OPENAI_BASE_URL: optionalString(),
  OPENAI_CHAT_MODEL: stringish('gpt-4.1-mini'),
  OPENAI_EMBEDDING_MODEL: stringish('text-embedding-3-small'),
  OPENAI_REQUEST_TIMEOUT_MS: intish(60_000, 1_000),
  OPENAI_REQUEST_CONCURRENCY: intish(4, 1, 64),
  OPENAI_RETRY_LIMIT: intish(4, 0, 10),
  CHAT_TEMPERATURE: floatish(0.1, 0, 2),
  CHAT_MAX_OUTPUT_TOKENS: intish(1200, 64, 32_000),

  EMBEDDING_PROVIDER: z.enum(['openai', 'mock']).default('openai'),
  EMBEDDING_DIMENSIONS: intish(1536, 8, 8192),
  MAX_EMBEDDING_BATCH_SIZE: intish(96, 1, 2048),
  EMBEDDING_INPUT_MAX_TOKENS: intish(8000, 128),

  DOCUMENT_STORAGE_DRIVER: z.enum(['local']).default('local'),
  DOCUMENT_STORAGE_ROOT: stringish('./storage/documents'),

  CHUNK_TARGET_TOKENS: intish(650, 50),
  CHUNK_MAX_TOKENS: intish(900, 64),
  CHUNK_MIN_TOKENS: intish(80, 1),
  CHUNK_OVERLAP_TOKENS: intish(100, 0),
  PARENT_CHUNKS_ENABLED: boolish(true),
  PARENT_CHUNK_MAX_TOKENS: intish(1800, 200),

  VECTOR_TOP_K: intish(25, 1, 500),
  LEXICAL_TOP_K: intish(25, 1, 500),
  RRF_K: intish(60, 1, 1000),
  FINAL_CONTEXT_CHUNKS: intish(8, 1, 100),
  CONTEXT_TOKEN_BUDGET: intish(6000, 500),
  VECTOR_MAX_DISTANCE: floatish(0.95, 0, 2),
  RERANKER: z.enum(['noop']).default('noop'),
  RETRIEVAL_PARENT_EXPANSION: boolish(true),
  RETRIEVAL_LOGGING_ENABLED: boolish(true),

  CHAT_HISTORY_TURNS: intish(6, 0, 50),
  CHAT_HISTORY_TOKEN_BUDGET: intish(1200, 0),
  QUERY_REWRITE_ENABLED: boolish(true),

  INGESTION_CRON: optionalString(),
  INGESTION_RUN_ON_BOOT: boolish(false),
  MAX_DOCUMENTS_PER_INGESTION_RUN: intish(200, 1, 100_000),
  INGESTION_CONCURRENCY: intish(4, 1, 64),
  ALLOW_LARGE_OPENAI_INGESTION: boolish(false),
  LARGE_OPENAI_INGESTION_THRESHOLD: intish(250, 1),

  OCR_ENABLED: boolish(true),
  OCR_PROVIDER: z.enum(['tesseract', 'none']).default('tesseract'),
  OCR_LANGUAGE: stringish('eng'),
  OCR_MIN_NATIVE_CHARS: intish(180, 0),
  OCR_MIN_CHARS_PER_PAGE_AREA: floatish(0.0004, 0),
  OCR_RENDER_SCALE: floatish(2.0, 0.5, 6),
  OCR_MAX_PAGES_PER_DOCUMENT: intish(40, 1, 2000),
  OCR_CONCURRENCY: intish(2, 1, 16),

  VISION_ENABLED: boolish(false),
  VISION_PROVIDER: z.enum(['openai', 'none']).default('openai'),
  VISION_MODEL: stringish('gpt-4.1-mini'),
  VISION_MAX_IMAGES_PER_DOCUMENT: intish(6, 0, 100),

  ENABLE_DEBUG_ENDPOINTS: boolish(false),

  MOCK_CORPUS_PROFILE: z.enum(['smoke', 'quality', 'scale']).default('quality'),
  MOCK_CORPUS_SIZE: intish(75, 1, 200_000),
  MOCK_CORPUS_SEED: intish(12_345),
  MOCK_SCANNED_RATIO: floatish(0.1, 0, 1),
  MOCK_WORKFLOW_RATIO: floatish(0.05, 0, 1),
  MOCK_MULTI_REVISION_RATIO: floatish(0.2, 0, 1),
  MOCK_CORRUPT_RATIO: floatish(0.01, 0, 1),
  MOCK_INACTIVE_RATIO: floatish(0.04, 0, 1),
  MOCK_DUPLICATE_RATIO: floatish(0.03, 0, 1),
  MOCK_DOCX_RATIO: floatish(0.12, 0, 1),
  MOCK_TEXT_RATIO: floatish(0.08, 0, 1),
  MOCK_TABLE_RATIO: floatish(0.25, 0, 1),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
