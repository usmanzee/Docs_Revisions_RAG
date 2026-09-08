/**
 * Failure isolation.
 *
 * A revision that cannot be processed must fail alone. The document it belongs
 * to keeps serving its previous revision, the rest of the run completes, and
 * the failure is recorded precisely enough to act on.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { closeTestPool, getTestPool, testConfig, truncateAll } from '../helpers/database.js';
import { createHarness, generateFixtureCorpus, type TestHarness } from '../helpers/fixtures.js';

const DOCUMENT_CODE = 'FIN-POL-001';
const HEALTHY_CODE = 'HR-POL-001';
const QUESTION = 'What expense amount requires Finance Director approval?';

describe('failed revision handling', () => {
  let pool: pg.Pool;
  let harness: TestHarness;
  let corruptRevisionId: string;
  let healthyRevisionId: string;

  beforeAll(async () => {
    pool = await getTestPool();
    await truncateAll();
    harness = await createHarness(testConfig(), pool);
    await generateFixtureCorpus(harness, { count: 4 });
    await harness.ingestion.run({ trigger: 'TEST' });

    const created = await harness.simulator.createRevision(DOCUMENT_CODE, { corrupt: true });
    corruptRevisionId = created.revisionId;

    // A healthy revision of a *different* document goes into the same run, so
    // the test asserts what the spec actually requires: one failing document
    // must not stop the others from being processed.
    const healthy = await harness.simulator.createRevision(HEALTHY_CODE, {});
    healthyRevisionId = healthy.revisionId;
  });

  afterAll(async () => {
    await harness.cleanup();
    await closeTestPool();
  });

  it('marks the corrupt revision FAILED while completing the rest of the run', async () => {
    const run = await harness.ingestion.run({ trigger: 'TEST' });

    expect(run.failed).toBe(1);
    expect(run.processed).toBeGreaterThanOrEqual(1);
    // Some work succeeded and some did not: that is a partial run, not a failed
    // one. A run is only FAILED when nothing at all could be processed.
    expect(run.status).toBe('PARTIALLY_COMPLETED');

    const healthy = await harness.revisions.findById(healthyRevisionId);
    expect(healthy?.processing_status).toBe('READY');
    expect(healthy?.is_current).toBe(true);

    const revisions = await harness.revisions.findByDocumentCode(DOCUMENT_CODE);
    const corrupt = revisions.find((revision) => revision.id === corruptRevisionId);

    expect(corrupt?.processing_status).toBe('FAILED');
    expect(corrupt?.processing_error).toBeTruthy();
    expect(corrupt?.is_current).toBe(false);
  });

  it('leaves the previous revision current and searchable', async () => {
    const revisions = await harness.revisions.findByDocumentCode(DOCUMENT_CODE);
    const current = revisions.find((revision) => revision.is_current);

    expect(current?.revision_number).toBe(1);
    expect(current?.processing_status).toBe('READY');

    const chunks = await harness.chunks.countByRevision(current?.id as string);
    expect(chunks).toBeGreaterThan(0);

    const result = await harness.retrieval.retrieve({ query: QUESTION, log: false, source: 'EVALUATION' });
    const top = result.selected.find((candidate) => candidate.documentCode === DOCUMENT_CODE);
    expect(top?.revisionNumber).toBe(1);
  });

  it('creates no chunks for the failed revision', async () => {
    expect(await harness.chunks.countByRevision(corruptRevisionId)).toBe(0);
  });

  it('records the failing stage on the job item', async () => {
    const jobs = await harness.jobs.listJobs(5);
    const latest = jobs[0];
    const detail = await harness.jobs.findJobDetail(latest?.id as string);

    const failure = detail?.items.find((item) => item.outcome === 'FAILED');
    expect(failure?.documentCode).toBe(DOCUMENT_CODE);
    expect(failure?.errorStage).toBe('parse');
    expect(failure?.errorMessage).toMatch(/PDF|parse|text/i);
  });

  it('summarises the failure on the job', async () => {
    const jobs = await harness.jobs.listJobs(5);
    const latest = jobs[0];
    expect(latest?.documentsFailed).toBe(1);
    expect(latest?.errorSummary).toContain(DOCUMENT_CODE);
  });

  it('does not retry a FAILED revision on the next run', async () => {
    const before = await harness.revisions.findById(corruptRevisionId);
    const run = await harness.ingestion.run({ trigger: 'TEST' });
    const after = await harness.revisions.findById(corruptRevisionId);

    // Discovery re-hashes files, but a FAILED revision whose bytes have not
    // changed must not be picked up again and again.
    expect(run.failed).toBe(0);
    expect(after?.processing_attempts).toBe(before?.processing_attempts);
  });

  it('can be retried explicitly once the file is fixed', async () => {
    const revision = await harness.revisions.findById(corruptRevisionId);

    // Replace the damaged file with a readable one, as an operator would.
    const healthy = await harness.revisions.findByDocumentCode(DOCUMENT_CODE);
    const good = healthy.find((entry) => entry.revision_number === 1);
    const bytes = await harness.storage.read(good?.file_path as string);
    await harness.storage.write(revision?.file_path as string, bytes);

    await harness.revisions.markPending(corruptRevisionId);
    const run = await harness.ingestion.run({ trigger: 'TEST', revisionId: corruptRevisionId, skipDiscovery: true });

    expect(run.failed).toBe(0);
    expect(run.processed).toBe(1);

    const repaired = await harness.revisions.findById(corruptRevisionId);
    expect(repaired?.processing_status).toBe('READY');
    expect(repaired?.is_current).toBe(true);
    expect(repaired?.processing_error).toBeNull();

    // And the previously current revision has stepped down cleanly.
    const revisions = await harness.revisions.findByDocumentCode(DOCUMENT_CODE);
    expect(revisions.filter((entry) => entry.is_current)).toHaveLength(1);
  });
});
