/**
 * Hybrid retrieval behaviour against a real corpus.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { closeTestPool, getTestPool, testConfig, truncateAll } from '../helpers/database.js';
import { createHarness, generateFixtureCorpus, type TestHarness } from '../helpers/fixtures.js';

describe('hybrid retrieval', () => {
  let pool: pg.Pool;
  let harness: TestHarness;

  beforeAll(async () => {
    pool = await getTestPool();
    await truncateAll();
    // Wide enough to include the Oracle documents the identifier tests need.
    harness = await createHarness(testConfig(), pool);
    await generateFixtureCorpus(harness, { count: 14 });
    await harness.ingestion.run({ trigger: 'TEST' });
  });

  afterAll(async () => {
    await harness.cleanup();
    await closeTestPool();
  });

  it('combines vector and lexical candidates', async () => {
    const result = await harness.retrieval.retrieve({
      query: 'What expenses require Finance Director approval?',
      log: false,
    });

    expect(result.vectorCandidates.length).toBeGreaterThan(0);
    expect(result.lexicalCandidates.length).toBeGreaterThan(0);
    expect(result.selected.length).toBeGreaterThan(0);

    // At least one selected candidate should have been found by both routes -
    // that agreement is what fusion is for.
    expect(result.selected.some((candidate) => Object.keys(candidate.ranks).length > 1)).toBe(true);
  });

  it('finds the expense policy for a natural-language question', async () => {
    const result = await harness.retrieval.retrieve({
      query: 'What expenses require Finance Director approval?',
      log: false,
    });

    expect(result.selected[0]?.documentCode).toBe('FIN-POL-001');
  });

  it('routes an exact document-code question to that document', async () => {
    const result = await harness.retrieval.retrieve({
      query: 'What does ORA-GUIDE-003 recommend regarding tablespace monitoring?',
      log: false,
    });

    expect(result.detectedDocumentCodes).toEqual(['ORA-GUIDE-003']);
    expect(result.identifierCandidates.length).toBeGreaterThan(0);
    expect(result.selected[0]?.documentCode).toBe('ORA-GUIDE-003');
  });

  it('ignores a document code that does not exist', async () => {
    const result = await harness.retrieval.retrieve({
      query: 'What does XYZ-FAKE-999 say about anything?',
      log: false,
    });

    expect(result.detectedDocumentCodes).toEqual([]);
    expect(result.identifierCandidates).toHaveLength(0);
  });

  it('returns only current revisions by default', async () => {
    await harness.simulator.createRevision('FIN-POL-001', { factId: 'financeDirectorThreshold' });
    await harness.ingestion.run({ trigger: 'TEST' });

    const result = await harness.retrieval.retrieve({
      query: 'expense approval threshold Finance Director',
      log: false,
    });

    expect(result.selected.every((candidate) => candidate.isCurrent)).toBe(true);
    const expensePolicy = result.selected.filter((c) => c.documentCode === 'FIN-POL-001');
    expect(expensePolicy.every((candidate) => candidate.revisionNumber === 2)).toBe(true);
  });

  it('includes historical revisions only when asked', async () => {
    const result = await harness.retrieval.retrieve({
      query: 'expense approval threshold Finance Director',
      filters: { includeHistorical: true, documentCode: 'FIN-POL-001' },
      log: false,
    });

    expect(result.selected.some((candidate) => !candidate.isCurrent)).toBe(true);
  });

  it('applies a department filter', async () => {
    const result = await harness.retrieval.retrieve({
      query: 'approval requirements',
      filters: { department: 'Finance' },
      log: false,
    });

    expect(result.selected.length).toBeGreaterThan(0);
    expect(result.selected.every((candidate) => candidate.department === 'Finance')).toBe(true);
  });

  it('applies a document-type filter', async () => {
    const result = await harness.retrieval.retrieve({
      query: 'escalation steps',
      filters: { documentType: 'PROCEDURE' },
      log: false,
    });

    expect(result.selected.every((candidate) => candidate.documentType === 'PROCEDURE')).toBe(true);
  });

  it('excludes inactive documents', async () => {
    const document = await harness.documents.findByCode('HR-POL-001');
    await harness.documents.setActive(document?.id as string, false);

    const result = await harness.retrieval.retrieve({ query: 'annual leave entitlement', log: false });
    expect(result.selected.every((candidate) => candidate.documentCode !== 'HR-POL-001')).toBe(true);

    await harness.documents.setActive(document?.id as string, true);
  });

  it('ranks the policy section above the revision-history table', async () => {
    // The revision history quotes every threshold the document has ever had, so
    // without demotion it out-ranks the section stating the current rule.
    const result = await harness.retrieval.retrieve({
      query: 'What expense amount requires Finance Director approval?',
      filters: { documentCode: 'FIN-POL-001' },
      log: false,
    });

    expect(result.selected[0]?.sectionRole).toBe('CONTENT');
    expect(result.selected[0]?.sectionTitle).toMatch(/Approval/i);
  });

  it('retains administrative sections as retrievable content', async () => {
    // Demotion, not exclusion: the revision history is still indexed and still
    // reachable - it simply must not outrank the policy itself. With a limit
    // wide enough to hold the document, it comes back.
    const result = await harness.retrieval.retrieve({
      query: 'revision history and related documents',
      filters: { documentCode: 'FIN-POL-001' },
      limit: 50,
      log: false,
    });

    expect(result.selected.some((candidate) => candidate.sectionRole === 'ADMINISTRATIVE')).toBe(true);
  });

  it('classifies revision-history content as administrative when chunking', async () => {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM document_chunks
        WHERE document_code = 'FIN-POL-001'
          AND metadata->>'sectionRole' = 'ADMINISTRATIVE'`,
    );
    expect(rows[0]?.count).toBeGreaterThan(0);
  });

  it('returns citable metadata on every candidate', async () => {
    const result = await harness.retrieval.retrieve({ query: 'backup retention period', log: false });

    for (const candidate of result.selected) {
      expect(candidate.chunkId).toMatch(/^[0-9a-f-]{36}$/);
      expect(candidate.documentCode).toBeTruthy();
      expect(candidate.revisionNumber).toBeGreaterThan(0);
      expect(candidate.content.length).toBeGreaterThan(0);
    }
  });

  it('records timings for each stage', async () => {
    const result = await harness.retrieval.retrieve({ query: 'password rotation', log: false });

    expect(result.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.vectorMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.lexicalMs).toBeGreaterThanOrEqual(0);
  });

  it('handles a query that matches nothing lexically', async () => {
    const result = await harness.retrieval.retrieve({
      query: 'zzzzqqq nonexistent terminology xyzzy',
      log: false,
    });

    expect(result.lexicalCandidates).toHaveLength(0);
    // Dense retrieval still returns nearest neighbours; grounding is the
    // generator's job, and the no-answer behaviour is asserted there.
    expect(Array.isArray(result.selected)).toBe(true);
  });

  it('respects the requested limit', async () => {
    const result = await harness.retrieval.retrieve({ query: 'approval', limit: 3, log: false });
    expect(result.selected.length).toBeLessThanOrEqual(3);
  });

  it('has a usable partial HNSW index for the current-revision hot path', async () => {
    const { rows: indexes } = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'document_chunks' AND indexdef LIKE '%hnsw%'`,
    );

    expect(indexes.map((row) => row.indexname)).toContain('document_chunks_embedding_hnsw_idx');
    // Partial on the hot path, and cosine - the two properties retrieval relies on.
    expect(indexes[0]?.indexdef).toContain('vector_cosine_ops');
    expect(indexes[0]?.indexdef).toContain('is_current');
  });
});
