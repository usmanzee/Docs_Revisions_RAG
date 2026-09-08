/**
 * The revision lifecycle scenario, end to end.
 *
 * This is the behaviour the whole system is built around, so it is asserted
 * step by step rather than only at the end: a new revision must be completely
 * invisible until it has been processed successfully, and must take over
 * atomically when it has.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { closeTestPool, getTestPool, testConfig, truncateAll } from '../helpers/database.js';
import { createHarness, generateFixtureCorpus, type TestHarness } from '../helpers/fixtures.js';

const DOCUMENT_CODE = 'FIN-POL-001';
const QUESTION = 'What expense amount requires Finance Director approval?';

describe('revision lifecycle', () => {
  let pool: pg.Pool;
  let harness: TestHarness;

  beforeAll(async () => {
    pool = await getTestPool();
    await truncateAll();
    harness = await createHarness(testConfig(), pool);
    await generateFixtureCorpus(harness, { count: 4 });
    await harness.ingestion.run({ trigger: 'TEST' });
  });

  afterAll(async () => {
    await harness.cleanup();
    await closeTestPool();
  });

  /** The revision that retrieval currently surfaces for the test question. */
  async function retrievedRevision(): Promise<number | null> {
    const result = await harness.retrieval.retrieve({ query: QUESTION, log: false, source: 'EVALUATION' });
    return result.selected.find((candidate) => candidate.documentCode === DOCUMENT_CODE)?.revisionNumber ?? null;
  }

  async function revisionState() {
    const revisions = await harness.revisions.findByDocumentCode(DOCUMENT_CODE);
    return revisions
      .slice()
      .sort((a, b) => a.revision_number - b.revision_number)
      .map((revision) => ({
        number: revision.revision_number,
        isCurrent: revision.is_current,
        status: revision.status,
        processingStatus: revision.processing_status,
      }));
  }

  it('starts with revision 1 current, READY and searchable', async () => {
    expect(await revisionState()).toEqual([
      { number: 1, isCurrent: true, status: 'ACTIVE', processingStatus: 'READY' },
    ]);
    expect(await retrievedRevision()).toBe(1);
  });

  it('leaves revision 1 current after revision 2 is created but not ingested', async () => {
    const created = await harness.simulator.createRevision(DOCUMENT_CODE, {
      factId: 'financeDirectorThreshold',
    });

    expect(created.revisionNumber).toBe(2);
    expect(created.mutation.previousValue).not.toBe(created.mutation.newValue);

    expect(await revisionState()).toEqual([
      { number: 1, isCurrent: true, status: 'ACTIVE', processingStatus: 'READY' },
      { number: 2, isCurrent: false, status: 'ACTIVE', processingStatus: 'PENDING' },
    ]);

    // The critical assertion: an unprocessed revision contributes nothing.
    expect(await retrievedRevision()).toBe(1);

    const chunks = await harness.chunks.countByRevision(created.revisionId);
    expect(chunks).toBe(0);
  });

  it('does not modify the previous revision file', async () => {
    const revisions = await harness.revisions.findByDocumentCode(DOCUMENT_CODE);
    const first = revisions.find((revision) => revision.revision_number === 1);
    const second = revisions.find((revision) => revision.revision_number === 2);

    expect(first?.file_path).not.toBe(second?.file_path);
    expect(await harness.storage.exists(first?.file_path as string)).toBe(true);
    expect(await harness.storage.exists(second?.file_path as string)).toBe(true);
  });

  it('activates revision 2 after successful ingestion and supersedes revision 1', async () => {
    const run = await harness.ingestion.run({ trigger: 'TEST' });

    expect(run.failed).toBe(0);
    expect(run.processed).toBeGreaterThanOrEqual(1);

    expect(await revisionState()).toEqual([
      { number: 1, isCurrent: false, status: 'SUPERSEDED', processingStatus: 'SUPERSEDED' },
      { number: 2, isCurrent: true, status: 'ACTIVE', processingStatus: 'READY' },
    ]);

    expect(await retrievedRevision()).toBe(2);
  });

  it('retains the superseded revision’s chunks for historical questions', async () => {
    const revisions = await harness.revisions.findByDocumentCode(DOCUMENT_CODE);
    const first = revisions.find((revision) => revision.revision_number === 1);

    const retained = await harness.chunks.countByRevision(first?.id as string);
    expect(retained).toBeGreaterThan(0);

    const { rows } = await pool.query<{ is_current: boolean }>(
      'SELECT DISTINCT is_current FROM document_chunks WHERE document_revision_id = $1',
      [first?.id],
    );
    // Retained, but invisible to normal retrieval.
    expect(rows).toEqual([{ is_current: false }]);
  });

  it('surfaces the superseded revision only when history is explicitly requested', async () => {
    const historical = await harness.retrieval.retrieve({
      query: QUESTION,
      filters: { includeHistorical: true, documentCode: DOCUMENT_CODE },
      log: false,
      source: 'EVALUATION',
    });

    const revisions = new Set(historical.selected.map((candidate) => candidate.revisionNumber));
    expect(revisions.has(1)).toBe(true);
    expect(revisions.has(2)).toBe(true);
  });

  it('keeps exactly one current revision per document, enforced by the database', async () => {
    const { rows } = await pool.query<{ document_id: string }>(
      `SELECT document_id FROM document_revisions
        GROUP BY document_id
       HAVING count(*) FILTER (WHERE is_current) <> 1`,
    );
    expect(rows).toEqual([]);

    // And the constraint itself refuses a second current revision.
    const revisions = await harness.revisions.findByDocumentCode(DOCUMENT_CODE);
    const superseded = revisions.find((revision) => !revision.is_current);

    await expect(
      pool.query('UPDATE document_revisions SET is_current = TRUE WHERE id = $1', [superseded?.id]),
    ).rejects.toThrow(/document_revisions_one_current_idx|unique/i);
  });

  it('activates safely when several revisions of one document are processed together', async () => {
    // A document that gained three revisions between runs is claimed as three
    // rows and processed concurrently. Each one independently believes it should
    // become current; without per-document serialisation they race, and the
    // partial unique index rejects the losers with a constraint violation.
    const target = 'HR-POL-001';

    for (let i = 0; i < 3; i += 1) {
      await harness.simulator.createRevision(target, { seed: 1000 + i });
    }

    const pending = await harness.revisions.findByDocumentCode(target);
    expect(pending.filter((revision) => revision.processing_status === 'PENDING')).toHaveLength(3);

    const run = await harness.ingestion.run({ trigger: 'TEST' });

    expect(run.failed).toBe(0);

    const after = await harness.revisions.findByDocumentCode(target);
    const current = after.filter((revision) => revision.is_current);

    // Exactly one current revision, and it is the highest-numbered one.
    expect(current).toHaveLength(1);
    expect(current[0]?.revision_number).toBe(Math.max(...after.map((r) => r.revision_number)));

    // Every other processed revision settled as SUPERSEDED rather than FAILED.
    const statuses = after
      .filter((revision) => !revision.is_current)
      .map((revision) => revision.processing_status);
    expect(statuses.every((status) => status === 'SUPERSEDED')).toBe(true);
  });

  it('answers the same question with the new value after activation', async () => {
    const result = await harness.retrieval.retrieve({ query: QUESTION, log: false, source: 'EVALUATION' });
    const top = result.selected.find((candidate) => candidate.documentCode === DOCUMENT_CODE);

    const revisions = await harness.revisions.findByDocumentCode(DOCUMENT_CODE);
    const current = revisions.find((revision) => revision.is_current);
    const facts = (current?.metadata as { facts?: Record<string, string> }).facts ?? {};

    expect(top?.revisionNumber).toBe(2);
    // The current threshold value must be somewhere in the current revision's chunks.
    const { rows } = await pool.query<{ content: string }>(
      'SELECT content FROM document_chunks WHERE document_revision_id = $1',
      [current?.id],
    );
    const allText = rows.map((row) => row.content).join('\n');
    expect(allText).toContain(facts.financeDirectorThreshold as string);
  });
});
