import { describe, expect, it } from 'vitest';
import { StructureAwareChunker } from '../../src/modules/chunking/structure-chunker.js';
import type { ChunkingConfig } from '../../src/config/index.js';
import type { ChunkDocumentContext } from '../../src/modules/chunking/types.js';
import type { ParsedDocument, ParsedElement } from '../../src/modules/parsing/types.js';

const config: ChunkingConfig = {
  targetTokens: 200,
  maxTokens: 300,
  minTokens: 40,
  overlapTokens: 20,
  parentChunksEnabled: true,
  parentMaxTokens: 900,
};

const context: ChunkDocumentContext = {
  documentCode: 'FIN-POL-001',
  documentTitle: 'Business Expense Policy',
  documentType: 'POLICY',
  department: 'Finance',
  category: 'Expenses',
  revisionNumber: 2,
  effectiveDate: '2025-01-01',
};

function documentOf(elements: ParsedElement[]): ParsedDocument {
  return {
    pages: [
      {
        pageNumber: 1,
        elements,
        extractionMethod: 'NATIVE_TEXT',
        nativeCharCount: 1000,
        requiredOcr: false,
      },
    ],
    images: [],
    sourceMetadata: {},
    pageCount: 1,
    ocrPageCount: 0,
    extractionMethod: 'NATIVE_TEXT',
  };
}

const sentence = (n: number) =>
  `Sentence number ${n} states a requirement that applies to all employees and contractors of the organisation.`;

const paragraph = (count: number, from = 0): ParsedElement => ({
  type: 'paragraph',
  text: Array.from({ length: count }, (_value, index) => sentence(from + index)).join(' '),
});

describe('StructureAwareChunker', () => {
  const chunker = new StructureAwareChunker(config);

  it('never merges content across section boundaries', async () => {
    const result = await chunker.chunk(
      documentOf([
        { type: 'heading', level: 2, text: 'Approval Requirements' },
        paragraph(8),
        { type: 'heading', level: 2, text: 'Documentation' },
        paragraph(8, 100),
      ]),
      context,
    );

    for (const chunk of result.chunks) {
      const mentionsApproval = chunk.content.includes('number 0');
      const mentionsDocumentation = chunk.content.includes('number 100');
      expect(mentionsApproval && mentionsDocumentation).toBe(false);
    }
  });

  it('attributes each chunk to its section and builds a heading path', async () => {
    const result = await chunker.chunk(
      documentOf([
        { type: 'heading', level: 2, text: 'Approval Requirements' },
        paragraph(6),
        { type: 'heading', level: 3, text: 'International Travel' },
        paragraph(6, 50),
      ]),
      context,
    );

    const subsection = result.chunks.find((chunk) => chunk.subsectionTitle === 'International Travel');
    expect(subsection).toBeDefined();
    expect(subsection?.sectionTitle).toBe('Approval Requirements');
    expect(subsection?.headingPath).toBe('Approval Requirements > International Travel');
  });

  it('keeps a numbered procedure in one chunk when it fits', async () => {
    const steps = Array.from({ length: 6 }, (_value, index) => `Step ${index + 1}: perform the required action.`);

    const result = await chunker.chunk(
      documentOf([
        { type: 'heading', level: 2, text: 'Procedure' },
        paragraph(4),
        { type: 'list', ordered: true, items: steps },
      ]),
      context,
    );

    const withSteps = result.chunks.filter((chunk) => chunk.content.includes('Step 1:'));
    expect(withSteps).toHaveLength(1);
    // Every step must be in that same chunk - a procedure split down the middle
    // reads as a complete process but is not.
    for (let step = 1; step <= 6; step += 1) {
      expect(withSteps[0]?.content).toContain(`Step ${step}:`);
    }
  });

  it('keeps a small table whole', async () => {
    const result = await chunker.chunk(
      documentOf([
        { type: 'heading', level: 2, text: 'Approval Requirements' },
        {
          type: 'table',
          caption: 'Expense approval authority',
          rows: [
            ['Value', 'Approver'],
            ['Up to $5,000', 'Manager'],
            ['Above $5,000', 'Finance Director'],
          ],
        },
      ]),
      context,
    );

    const tableChunk = result.chunks.find((chunk) => chunk.content.includes('Up to $5,000'));
    expect(tableChunk?.content).toContain('Above $5,000');
    expect(tableChunk?.content).toContain('| Value | Approver |');
  });

  it('repeats the header row when a table must be split', async () => {
    const rows = [['Code', 'Description', 'Owner']];
    for (let i = 0; i < 60; i += 1) {
      rows.push([`ROW-${i}`, `A reasonably long description of requirement number ${i} here.`, 'Finance']);
    }

    const result = await chunker.chunk(
      documentOf([{ type: 'heading', level: 2, text: 'Schedule' }, { type: 'table', rows }]),
      context,
    );

    // Children only: the parent chunk holds the whole section by design.
    const pieces = result.chunks.filter(
      (chunk) => chunk.chunkType === 'CHILD' && chunk.content.includes('| Code | Description | Owner |'),
    );
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.tokenCount).toBeLessThanOrEqual(config.maxTokens * 1.35);
    }
  });

  it('respects the maximum token size', async () => {
    const result = await chunker.chunk(
      documentOf([{ type: 'heading', level: 2, text: 'Long Section' }, paragraph(80)]),
      context,
    );

    for (const chunk of result.chunks.filter((entry) => entry.chunkType === 'CHILD')) {
      // Overlap is added on top of the packing budget, so allow modest headroom.
      expect(chunk.tokenCount).toBeLessThanOrEqual(config.maxTokens + config.overlapTokens + 40);
    }
  });

  it('prefixes the embedding text with document and section context', async () => {
    const result = await chunker.chunk(
      documentOf([{ type: 'heading', level: 2, text: 'Approval Requirements' }, paragraph(6)]),
      context,
    );

    const chunk = result.chunks.find((entry) => entry.chunkType === 'CHILD');
    expect(chunk?.embeddingText).toContain('Document: FIN-POL-001 Business Expense Policy');
    expect(chunk?.embeddingText).toContain('Section: Approval Requirements');
    // The stored content stays clean, so citations do not show the header.
    expect(chunk?.content.startsWith('Document:')).toBe(false);
  });

  it('creates a parent chunk for a section larger than the target', async () => {
    const result = await chunker.chunk(
      documentOf([{ type: 'heading', level: 2, text: 'Long Section' }, paragraph(40)]),
      context,
    );

    const parents = result.chunks.filter((chunk) => chunk.chunkType === 'PARENT');
    expect(parents).toHaveLength(1);
    expect(parents[0]?.embeddingText).toBe(''); // parents are not embedded

    const children = result.chunks.filter((chunk) => chunk.chunkType === 'CHILD');
    expect(children.length).toBeGreaterThan(1);
    expect(children.every((child) => child.parentChunkIndex === parents[0]?.chunkIndex)).toBe(true);
  });

  it('does not create a parent for a small section', async () => {
    const result = await chunker.chunk(
      documentOf([{ type: 'heading', level: 2, text: 'Purpose' }, paragraph(3)]),
      context,
    );
    expect(result.parentCount).toBe(0);
  });

  it('merges trivially small adjacent sections but keeps substantial ones separate', async () => {
    const result = await chunker.chunk(
      documentOf([
        { type: 'heading', level: 2, text: 'Purpose' },
        { type: 'paragraph', text: 'This policy sets out expense rules.' },
        { type: 'heading', level: 2, text: 'Scope' },
        { type: 'paragraph', text: 'It applies to all employees.' },
        { type: 'heading', level: 2, text: 'Approval Requirements' },
        paragraph(6),
      ]),
      context,
    );

    const merged = result.chunks.find((chunk) => chunk.content.includes('This policy sets out'));
    expect(merged?.content).toContain('It applies to all employees');

    // The substantial section keeps its own identity for citations.
    const approval = result.chunks.find((chunk) => chunk.sectionTitle === 'Approval Requirements');
    expect(approval).toBeDefined();
    expect(approval?.content).not.toContain('This policy sets out');
  });

  it('marks revision history as administrative', async () => {
    const result = await chunker.chunk(
      documentOf([
        { type: 'heading', level: 2, text: 'Revision History' },
        {
          type: 'table',
          rows: [
            ['Revision', 'Date', 'Summary'],
            ['1', '2024-01-01', 'Initial issue.'],
            ['2', '2025-01-01', 'Threshold changed from $5,000 to $7,500.'],
          ],
        },
      ]),
      context,
    );

    const chunk = result.chunks.find((entry) => entry.sectionTitle === 'Revision History');
    expect(chunk?.metadata.sectionRole).toBe('ADMINISTRATIVE');
  });

  it('does not mark policy sections as administrative', async () => {
    const result = await chunker.chunk(
      documentOf([{ type: 'heading', level: 2, text: 'Approval Requirements' }, paragraph(6)]),
      context,
    );
    const chunk = result.chunks.find((entry) => entry.sectionTitle === 'Approval Requirements');
    expect(chunk?.metadata.sectionRole).toBeUndefined();
  });

  it('produces no chunks for an empty document', async () => {
    expect((await chunker.chunk(documentOf([]), context)).chunks).toHaveLength(0);
  });
});
