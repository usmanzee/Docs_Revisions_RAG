import { describe, expect, it } from 'vitest';
import {
  buildContext,
  deduplicateCandidates,
  mergeAdjacentCandidates,
} from '../../src/modules/retrieval/context-builder.js';
import {
  cleanRewrittenQuery,
  extractDocumentCodes,
  extractErrorCodes,
  needsRewrite,
} from '../../src/modules/retrieval/query-analysis.js';
import { classifyAnswer, selectUsedCitations } from '../../src/modules/chat/rag-service.js';
import type { RetrievalCandidate } from '../../src/modules/retrieval/types.js';
import type { Citation } from '@docs-rag/shared';

function candidate(overrides: Partial<RetrievalCandidate> = {}): RetrievalCandidate {
  return {
    chunkId: overrides.chunkId ?? 'chunk-1',
    documentId: 'doc-1',
    revisionId: overrides.revisionId ?? 'rev-1',
    documentCode: overrides.documentCode ?? 'FIN-POL-001',
    documentTitle: 'Business Expense Policy',
    revisionNumber: overrides.revisionNumber ?? 2,
    chunkIndex: overrides.chunkIndex ?? 0,
    parentChunkId: null,
    sectionTitle: overrides.sectionTitle ?? 'Approval Requirements',
    subsectionTitle: null,
    headingPath: overrides.headingPath ?? 'Approval Requirements',
    pageStart: overrides.pageStart ?? 1,
    pageEnd: overrides.pageEnd ?? 1,
    effectiveDate: '2025-01-01',
    content: overrides.content ?? 'Expenditure above $25,000 requires Finance Director approval.',
    tokenCount: overrides.tokenCount ?? 20,
    extractionMethod: overrides.extractionMethod ?? 'NATIVE_TEXT',
    isCurrent: overrides.isCurrent ?? true,
    department: 'Finance',
    documentType: 'POLICY',
    sectionRole: overrides.sectionRole ?? 'CONTENT',
    score: overrides.score ?? 0.5,
    ranks: {},
    sourceScores: {},
  };
}

describe('query analysis', () => {
  it('extracts document codes', () => {
    expect(extractDocumentCodes('What does ORA-GUIDE-003 say?')).toEqual(['ORA-GUIDE-003']);
    expect(extractDocumentCodes('compare FIN-POL-001 and HR-POL-002')).toEqual(['FIN-POL-001', 'HR-POL-002']);
    expect(extractDocumentCodes('what is the leave entitlement?')).toEqual([]);
  });

  it('is case-insensitive for document codes', () => {
    expect(extractDocumentCodes('what does ora-guide-003 recommend?')).toEqual(['ORA-GUIDE-003']);
  });

  it('extracts Oracle error numbers', () => {
    expect(extractErrorCodes('I am seeing ORA-01555 in the alert log')).toEqual(['ORA-01555']);
  });

  it('detects follow-up questions that need rewriting', () => {
    expect(needsRewrite('What about contractors?', true)).toBe(true);
    expect(needsRewrite('And what is the limit for them?', true)).toBe(true);
    expect(needsRewrite('Does it apply to interns?', true)).toBe(true);
  });

  it('leaves standalone questions alone', () => {
    expect(
      needsRewrite('What is the annual leave entitlement for permanent employees in the UK?', true),
    ).toBe(false);
  });

  it('never rewrites the first question in a conversation', () => {
    expect(needsRewrite('What about contractors?', false)).toBe(false);
  });

  it('strips model framing from a rewritten query', () => {
    expect(cleanRewrittenQuery('"What is the contractor expense limit?"', 'fallback')).toBe(
      'What is the contractor expense limit?',
    );
    expect(cleanRewrittenQuery('Standalone question: What is the limit?', 'fallback')).toBe(
      'What is the limit?',
    );
  });

  it('falls back when a rewrite is empty or runaway', () => {
    expect(cleanRewrittenQuery('', 'original')).toBe('original');
    expect(cleanRewrittenQuery('x'.repeat(500), 'original')).toBe('original');
  });
});

describe('context builder', () => {
  it('removes duplicate chunk ids', () => {
    const result = deduplicateCandidates([candidate(), candidate()]);
    expect(result).toHaveLength(1);
  });

  it('removes a near-duplicate from a different document', () => {
    const original = candidate({ chunkId: 'a', content: 'Expenditure above $25,000 requires Finance Director approval before commitment.' });
    const nearCopy = candidate({
      chunkId: 'b',
      revisionId: 'rev-2',
      documentCode: 'FIN-POL-009',
      content: 'Expenditure above $25,000 requires Finance Director approval before commitment.',
    });

    expect(deduplicateCandidates([original, nearCopy])).toHaveLength(1);
  });

  it('keeps genuinely different chunks', () => {
    const a = candidate({ chunkId: 'a', content: 'Managers may approve expenses up to $5,000.' });
    const b = candidate({
      chunkId: 'b',
      content: 'Claims must be submitted within 60 calendar days of the expense date.',
    });

    expect(deduplicateCandidates([a, b])).toHaveLength(2);
  });

  it('merges adjacent chunks from the same section', () => {
    const first = candidate({ chunkId: 'a', chunkIndex: 4, content: 'First part of the section.' });
    const second = candidate({ chunkId: 'b', chunkIndex: 5, content: 'Second part of the section.' });

    const merged = mergeAdjacentCandidates([first, second], 1000);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.content).toContain('First part');
    expect(merged[0]?.content).toContain('Second part');
  });

  it('does not merge non-adjacent chunks', () => {
    const first = candidate({ chunkId: 'a', chunkIndex: 1 });
    const second = candidate({ chunkId: 'b', chunkIndex: 7, content: 'Something else entirely here.' });

    expect(mergeAdjacentCandidates([first, second], 1000)).toHaveLength(2);
  });

  it('does not merge across sections', () => {
    const first = candidate({ chunkId: 'a', chunkIndex: 1, sectionTitle: 'Approval Requirements' });
    const second = candidate({
      chunkId: 'b',
      chunkIndex: 2,
      sectionTitle: 'Documentation',
      content: 'Receipts are required above $50.',
    });

    expect(mergeAdjacentCandidates([first, second], 1000)).toHaveLength(2);
  });

  it('enforces the token budget and numbers citations from one', () => {
    const candidates = Array.from({ length: 10 }, (_value, index) =>
      candidate({
        chunkId: `chunk-${index}`,
        chunkIndex: index * 5,
        tokenCount: 100,
        content: `Distinct content for chunk number ${index} about a separate requirement entirely.`,
      }),
    );

    const built = buildContext(candidates, { tokenBudget: 300, maxChunks: 8 });

    expect(built.included.length).toBeLessThan(candidates.length);
    expect(built.citations.map((citation) => citation.index)).toEqual(
      built.included.map((_value, index) => index + 1),
    );
  });

  it('writes provenance into each source header', () => {
    const built = buildContext([candidate({ isCurrent: false, extractionMethod: 'OCR' })], {
      tokenBudget: 4000,
      maxChunks: 8,
    });

    expect(built.text).toContain('FIN-POL-001 - Business Expense Policy');
    expect(built.text).toContain('Revision 2');
    expect(built.text).toContain('Section: Approval Requirements');
    expect(built.text).toContain('SUPERSEDED REVISION');
    expect(built.text).toContain('recovered by OCR');
  });

  it('builds citations only from chunk data', () => {
    const built = buildContext([candidate()], { tokenBudget: 4000, maxChunks: 8 });
    const citation = built.citations[0] as Citation;

    expect(citation.documentCode).toBe('FIN-POL-001');
    expect(citation.revision).toBe(2);
    expect(citation.page).toBe(1);
    expect(citation.chunkId).toBe('chunk-1');
    expect(citation.excerpt).toContain('Finance Director');
  });

  it('returns empty context for no candidates', () => {
    const built = buildContext([], { tokenBudget: 4000, maxChunks: 8 });
    expect(built.text).toBe('');
    expect(built.citations).toHaveLength(0);
  });
});

describe('answer post-processing', () => {
  const citations: Citation[] = [1, 2, 3].map((index) => ({
    index,
    chunkId: `chunk-${index}`,
    documentId: 'doc',
    revisionId: 'rev',
    documentCode: `DOC-${index}`,
    documentTitle: 'Title',
    revision: 1,
    page: 1,
    section: 'Section',
    subsection: null,
    effectiveDate: null,
    excerpt: 'excerpt',
    extractionMethod: 'NATIVE_TEXT',
    score: 0.5,
  }));

  it('keeps only the citations the answer referenced', () => {
    const used = selectUsedCitations('The limit is $25,000 [2].', citations);
    expect(used.map((citation) => citation.index)).toEqual([2]);
  });

  it('keeps all citations when the answer referenced none', () => {
    expect(selectUsedCitations('The limit is $25,000.', citations)).toHaveLength(3);
  });

  it('ignores bracket numbers that match no citation', () => {
    // The model must not be able to invent a source by writing [9].
    const used = selectUsedCitations('See [9].', citations);
    expect(used).toHaveLength(3);
  });

  it('classifies a refusal as insufficient context', () => {
    expect(
      classifyAnswer('I could not find enough information in the available documents.', true, citations),
    ).toBe('INSUFFICIENT_CONTEXT');
  });

  it('classifies an answer with no context as insufficient', () => {
    expect(classifyAnswer('The limit is $25,000.', false, [])).toBe('INSUFFICIENT_CONTEXT');
  });

  it('classifies a grounded answer as answered', () => {
    expect(classifyAnswer('The limit is $25,000 [1].', true, citations)).toBe('ANSWERED');
  });
});
