/**
 * Vitest global setup.
 *
 * Forces NODE_ENV=test before any application module is imported, which makes
 * the configuration resolve TEST_DATABASE_URL. Without this a stray test run
 * would truncate a development corpus.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
process.env.LOG_PRETTY = 'false';

// Tests must never call a paid API, whatever the developer's .env says.
process.env.EMBEDDING_PROVIDER = 'mock';
process.env.RETRIEVAL_LOGGING_ENABLED = 'false';
process.env.INGESTION_CRON = '';
