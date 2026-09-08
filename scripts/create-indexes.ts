#!/usr/bin/env tsx
/**
 * Rebuild or tune the approximate-nearest-neighbour index.
 *
 *   npm run db:indexes
 *   npm run db:indexes -- --m=32 --ef-construction=128
 *   npm run db:indexes -- --analyze-only
 *
 * The index is created by migration 0004 with pgvector's defaults. This script
 * exists for the case the migration cannot serve: rebuilding with different
 * parameters once there is a real corpus and a real latency target, without
 * editing an applied migration.
 *
 * CONCURRENTLY is used so the rebuild does not block retrieval, at the cost of
 * a slower build and needing a retry if it fails.
 */

import { getConfig } from '../apps/api/src/config/index.js';
import { closePool, getPool, queryOne } from '../apps/api/src/db/pool.js';
import { getNumber, getBoolean, parseArgs } from '../apps/api/src/cli/args.js';
import { formatBytes, formatDuration, heading, printKeyValues } from '../apps/api/src/cli/format.js';
import { assertSupportedNodeVersion } from '../apps/api/src/utils/runtime.js';

assertSupportedNodeVersion();

const INDEX_NAME = 'document_chunks_embedding_hnsw_idx';

async function main(): Promise<void> {
  const args = parseArgs();
  const config = getConfig();
  const pool = getPool();

  const m = getNumber(args, 'm', 16);
  const efConstruction = getNumber(args, 'ef-construction', 64);
  const maintenanceWorkMem = String(args.values.get('maintenance-work-mem') ?? '256MB');
  const analyzeOnly = getBoolean(args, 'analyze-only', false);

  const before = await queryOne<{ chunks: number; embedded: number; index_bytes: number | null }>(
    `SELECT count(*)::int AS chunks,
            count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded,
            pg_relation_size(to_regclass($1)) AS index_bytes
       FROM document_chunks`,
    [INDEX_NAME],
  );

  heading('Vector index');
  printKeyValues([
    ['dimensions', config.embedding.dimensions],
    ['chunks', before?.chunks ?? 0],
    ['embedded chunks', before?.embedded ?? 0],
    ['current index size', formatBytes(before?.index_bytes ?? null)],
    ['m', m],
    ['ef_construction', efConstruction],
  ]);

  if (analyzeOnly) {
    const started = performance.now();
    await pool.query('ANALYZE document_chunks');
    console.log(`\nANALYZE complete in ${formatDuration(performance.now() - started)}.\n`);
    return;
  }

  // Reject values outside pgvector's documented range before spending minutes
  // on a build that will be rejected.
  if (m < 2 || m > 100) throw new Error('--m must be between 2 and 100');
  if (efConstruction < 4 || efConstruction > 1000) throw new Error('--ef-construction must be between 4 and 1000');
  if (efConstruction < 2 * m) {
    throw new Error(`--ef-construction must be at least 2 * m (${2 * m})`);
  }
  if (!/^\d+(MB|GB)$/.test(maintenanceWorkMem)) {
    throw new Error('--maintenance-work-mem must look like 256MB or 2GB');
  }

  console.log('\nRebuilding the HNSW index. This does not block retrieval, but it is not fast.\n');

  const started = performance.now();

  // A larger maintenance_work_mem keeps the graph in memory during the build;
  // spilling to disk is the difference between minutes and tens of minutes.
  await pool.query(`SET maintenance_work_mem = '${maintenanceWorkMem}'`);

  const temporary = `${INDEX_NAME}_new`;
  await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${temporary}`);

  await pool.query(
    `CREATE INDEX CONCURRENTLY ${temporary}
       ON document_chunks USING hnsw (embedding vector_cosine_ops)
       WITH (m = ${m}, ef_construction = ${efConstruction})
       WHERE is_current AND embedding IS NOT NULL`,
  );

  // Swap atomically so retrieval is never without an index.
  await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`);
  await pool.query(`ALTER INDEX ${temporary} RENAME TO ${INDEX_NAME}`);

  await pool.query('ANALYZE document_chunks');

  const after = await queryOne<{ index_bytes: number | null }>(
    'SELECT pg_relation_size(to_regclass($1)) AS index_bytes',
    [INDEX_NAME],
  );

  await pool.query(
    `INSERT INTO system_settings (key, value, description)
     VALUES ('vector_index_params', $1, 'HNSW parameters applied by npm run db:indexes')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({ m, efConstruction, rebuiltAt: new Date().toISOString() })],
  );

  heading('Rebuilt');
  printKeyValues([
    ['index size', formatBytes(after?.index_bytes ?? null)],
    ['duration', formatDuration(performance.now() - started)],
  ]);

  console.log(
    '\nTuning notes: raising m and ef_construction improves recall and increases build time and index\n' +
      'size. Query-time recall is governed by hnsw.ef_search, which can be set per session. Measure with\n' +
      '`npm run eval:retrieval` before and after - do not tune blind.\n',
  );
}

main()
  .catch((error: unknown) => {
    console.error(`\nIndex rebuild failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
