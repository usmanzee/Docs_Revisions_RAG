/**
 * Ingestion behaviour: idempotency, discovery, hashing and job accounting.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { closeTestPool, getTestPool, testConfig, truncateAll } from '../helpers/database.js';
import { createHarness, generateFixtureCorpus, type TestHarness } from '../helpers/fixtures.js';
import { parseStorageKey } from '../../src/modules/ingestion/revision-discovery.js';

describe('document ingestion', () => {
  let pool: pg.Pool;
  let harness: TestHarness;

  beforeAll(async () => {
    pool = await getTestPool();
    await truncateAll();
    harness = await createHarness(testConfig(), pool);
    await generateFixtureCorpus(harness, { count: 5 });
  });

  afterAll(async () => {
    await harness.cleanup();
    await closeTestPool();
  });

  it('processes every pending revision on the first run', async () => {
    const run = await harness.ingestion.run({ trigger: 'TEST' });

    expect(run.discovered).toBe(5);
    expect(run.processed).toBe(5);
    expect(run.failed).toBe(0);
    expect(run.chunksCreated).toBeGreaterThan(0);
    expect(run.status).toBe('COMPLETED');
  });

  it('makes every processed revision current, READY and embedded', async () => {
    const { rows } = await pool.query<{ total: number; ready: number; current: number; embedded: number }>(
      `SELECT (SELECT count(*)::int FROM document_revisions) AS total,
              (SELECT count(*)::int FROM document_revisions WHERE processing_status = 'READY') AS ready,
              (SELECT count(*)::int FROM document_revisions WHERE is_current) AS current,
              (SELECT count(*)::int FROM document_chunks WHERE embedding IS NULL AND chunk_type = 'CHILD') AS embedded`,
    );

    expect(rows[0]?.ready).toBe(rows[0]?.total);
    expect(rows[0]?.current).toBe(rows[0]?.total);
    // Every retrieval chunk must have a vector, or it is unreachable.
    expect(rows[0]?.embedded).toBe(0);
  });

  it('records content and file hashes', async () => {
    const { rows } = await pool.query<{ file_hash: string; content_hash: string }>(
      'SELECT file_hash, content_hash FROM document_revisions',
    );

    for (const row of rows) {
      expect(row.file_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('is idempotent: a second run finds nothing to do', async () => {
    const run = await harness.ingestion.run({ trigger: 'TEST' });

    expect(run.discovered).toBe(0);
    expect(run.processed).toBe(0);
    expect(run.status).toBe('COMPLETED');
  });

  it('does not re-embed a revision whose content is unchanged', async () => {
    const revisions = await harness.revisions.findByDocumentCode('FIN-POL-001');
    const current = revisions[0];
    const chunksBefore = await harness.chunks.countByRevision(current?.id as string);

    // Re-queue it as an operator might, without changing the file.
    await harness.revisions.markPending(current?.id as string);
    const run = await harness.ingestion.run({ trigger: 'TEST', skipDiscovery: true });

    expect(run.skipped).toBe(1);
    expect(run.items[0]?.skipReason).toBe('UNCHANGED_CONTENT');
    expect(await harness.chunks.countByRevision(current?.id as string)).toBe(chunksBefore);

    const after = await harness.revisions.findById(current?.id as string);
    expect(after?.is_current).toBe(true);
  });

  it('re-queues a revision whose file changed in place', async () => {
    const revisions = await harness.revisions.findByDocumentCode('HR-POL-001');
    const current = revisions[0];
    const original = await harness.storage.read(current?.file_path as string);

    // Same key, different bytes: a document replaced on the share.
    const other = await harness.revisions.findByDocumentCode('FIN-POL-001');
    const replacement = await harness.storage.read(other[0]?.file_path as string);
    await harness.storage.write(current?.file_path as string, replacement);

    const run = await harness.ingestion.run({ trigger: 'TEST' });

    expect(run.discovery?.revisionsRequeued).toBe(1);
    expect(run.processed).toBe(1);

    const after = await harness.revisions.findById(current?.id as string);
    expect(after?.file_hash).not.toBe(current?.file_hash);
    expect(after?.processing_status).toBe('READY');

    // Restore, so later assertions see the original corpus.
    await harness.storage.write(current?.file_path as string, original);
    await harness.ingestion.run({ trigger: 'TEST' });
  });

  it('registers a revision discovered on the storage driver alone', async () => {
    const revisions = await harness.revisions.findByDocumentCode('FIN-POL-001');
    const source = revisions[0];
    const bytes = await harness.storage.read(source?.file_path as string);

    // Drop a rev-002 folder onto the share without touching the database.
    await harness.storage.write('FIN-POL-001/rev-002/business-expense-policy.pdf', bytes);

    const run = await harness.ingestion.run({ trigger: 'TEST' });

    expect(run.discovery?.revisionsRegistered).toBe(1);

    const after = await harness.revisions.findByDocumentCode('FIN-POL-001');
    const second = after.find((revision) => revision.revision_number === 2);
    expect(second).toBeDefined();
    expect(second?.is_current).toBe(true);
  });

  it('creates a document for a code that is not in the register', async () => {
    const revisions = await harness.revisions.findByDocumentCode('FIN-POL-001');
    const bytes = await harness.storage.read(revisions[0]?.file_path as string);

    await harness.storage.write('NEW-POL-042/rev-001/newly-added-policy.pdf', bytes);
    await harness.ingestion.run({ trigger: 'TEST' });

    const document = await harness.documents.findByCode('NEW-POL-042');
    expect(document).not.toBeNull();
    expect(document?.title).toBe('Newly Added Policy');
    expect(document?.document_type).toBe('POLICY');
    expect(document?.metadata).toMatchObject({ discovered: true });
  });

  it('reports revisions whose file has vanished without deleting them', async () => {
    const revisions = await harness.revisions.findByDocumentCode('NEW-POL-042');
    const target = revisions[0];

    await harness.storage.delete(target?.file_path as string);
    const run = await harness.ingestion.run({ trigger: 'TEST' });

    expect(run.discovery?.missingFiles).toContain(target?.file_path);

    // Still present, still current: losing a file is an operational problem,
    // not a reason to silently drop the organisation's policy.
    const after = await harness.revisions.findById(target?.id as string);
    expect(after).not.toBeNull();
    expect(await harness.chunks.countByRevision(target?.id as string)).toBeGreaterThan(0);
  });

  it('never inserts duplicate chunks for a revision', async () => {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM (
         SELECT document_revision_id, content_hash
           FROM document_chunks
          GROUP BY 1, 2
         HAVING count(*) > 1
       ) duplicates`,
    );
    expect(rows[0]?.count).toBe(0);
  });

  it('writes a job item for every revision it touched', async () => {
    const jobs = await harness.jobs.listJobs(50);
    expect(jobs.length).toBeGreaterThan(0);

    const first = await harness.jobs.findJobDetail(jobs[jobs.length - 1]?.id as string);
    expect(first?.items.length).toBe(first?.documentsDiscovered);
    expect(first?.items.every((item) => ['PROCESSED', 'SKIPPED', 'FAILED'].includes(item.outcome))).toBe(true);
  });

  it('serialises concurrent runs with an advisory lock', async () => {
    const [a, b] = await Promise.all([
      harness.ingestion.run({ trigger: 'TEST' }),
      harness.ingestion.run({ trigger: 'TEST' }),
    ]);

    // One of the two must have been turned away rather than both processing.
    const skipped = [a, b].filter((run) => run.skippedReason !== undefined);
    expect(skipped).toHaveLength(1);
  });
});

describe('storage key parsing', () => {
  it('parses the canonical layout', () => {
    expect(parseStorageKey('FIN-POL-0001/rev-002/expense-policy.pdf')).toEqual({
      documentCode: 'FIN-POL-0001',
      revisionNumber: 2,
      fileName: 'expense-policy.pdf',
    });
  });

  it('rejects anything outside the layout', () => {
    expect(parseStorageKey('loose-file.pdf')).toBeNull();
    expect(parseStorageKey('FIN-POL-001/draft/file.pdf')).toBeNull();
    expect(parseStorageKey('FIN-POL-001/rev-000/file.pdf')).toBeNull();
  });
});
