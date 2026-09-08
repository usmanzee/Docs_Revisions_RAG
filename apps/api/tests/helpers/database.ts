/**
 * Test database lifecycle.
 *
 * Every integration suite runs against TEST_DATABASE_URL, migrated once and
 * truncated between suites. Truncating rather than recreating keeps the suite
 * fast while still guaranteeing isolation.
 */

import pg from 'pg';
import { buildConfig, resetConfigCache, type AppConfig } from '../../src/config/index.js';
import { parseEnv } from '../../src/config/env.js';
import { migrateUp } from '../../src/db/migrator.js';
import { closePool, setPool } from '../../src/db/pool.js';

let pool: pg.Pool | null = null;
let migrated = false;

export function testConfig(): AppConfig {
  resetConfigCache();
  return buildConfig(parseEnv());
}

export async function getTestPool(): Promise<pg.Pool> {
  if (pool) return pool;

  const config = testConfig();

  // Guard rail: a mistyped TEST_DATABASE_URL must not truncate a development
  // corpus. The name has to look like a test database.
  if (!config.database.url.includes('test')) {
    throw new Error(
      `Refusing to run tests against "${config.database.url}": the database name must contain "test". ` +
        'Set TEST_DATABASE_URL in .env.',
    );
  }

  // Headroom above the ingestion concurrency the harness uses, so a slow test
  // never looks like a deadlock.
  pool = new pg.Pool({ connectionString: config.database.url, max: 10 });
  setPool(pool);

  if (!migrated) {
    await migrateUp(config, pool);
    migrated = true;
  }

  return pool;
}

/** Remove all corpus and run data, preserving the schema. */
export async function truncateAll(): Promise<void> {
  const instance = await getTestPool();
  await instance.query(`
    TRUNCATE TABLE
      document_chunks,
      document_assets,
      document_revisions,
      documents,
      ingestion_job_items,
      ingestion_jobs,
      retrieval_logs,
      messages,
      conversations,
      evaluation_results,
      evaluation_runs,
      evaluation_questions
    RESTART IDENTITY CASCADE
  `);
}

export async function closeTestPool(): Promise<void> {
  if (pool) {
    pool = null;
    await closePool();
  }
}
