/**
 * OCR behaviour on genuinely image-only documents.
 *
 * The fixtures here are real scanned PDFs: text painted onto a bitmap with no
 * text layer behind it. A test built on a PDF that merely claims to be scanned
 * would pass while the pipeline was broken.
 *
 * Real OCR is slow, so this suite is deliberately small and separate.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { closeTestPool, getTestPool, testConfig, truncateAll } from '../helpers/database.js';
import { createHarness, type TestHarness } from '../helpers/fixtures.js';
import { SeededRandom } from '../../src/utils/random.js';
import { businessExpensePolicy } from '../../src/modules/corpus/blueprints/finance.js';
import { composeDocument } from '../../src/modules/corpus/document-composer.js';
import { renderDocumentToPdf } from '../../src/modules/corpus/renderers/pdf-renderer.js';
import { renderDocumentToScannedPdf } from '../../src/modules/corpus/renderers/scanned-pdf-renderer.js';
import { createParserRegistry } from '../../src/modules/parsing/index.js';
import { NoopOCRProvider, TesseractOCRProvider } from '../../src/modules/ocr/index.js';
import { documentToText } from '../../src/modules/parsing/types.js';

describe('OCR', () => {
  let pool: pg.Pool;
  let harness: TestHarness;
  let scannedPdf: Buffer;
  let mixedPdf: Buffer;
  let facts: Record<string, string>;

  beforeAll(async () => {
    pool = await getTestPool();
    await truncateAll();
    harness = await createHarness(testConfig(), pool, { ocr: 'tesseract' });

    const composed = composeDocument({
      blueprint: businessExpensePolicy,
      documentCode: 'FIN-POL-001',
      title: businessExpensePolicy.title,
      owner: businessExpensePolicy.ownerRole,
      revisionNumber: 1,
      effectiveDate: '2025-03-01',
      rng: new SeededRandom(2024),
      revisionHistory: [{ revision: 1, date: '2025-03-01', summary: 'Initial issue.' }],
      includeWorkflow: false,
    });

    facts = Object.fromEntries(composed.content.facts.map((fact) => [fact.id, fact.value]));

    scannedPdf = await renderDocumentToScannedPdf(composed.content, { rng: new SeededRandom(11) });
    // Page 2 rasterised, the rest native: the mixed case a scanned appendix
    // produces in a real repository.
    mixedPdf = await renderDocumentToPdf(composed.content, { scannedPageIndices: new Set([1]) });
  }, 180_000);

  afterAll(async () => {
    await harness.cleanup();
    await closeTestPool();
  });

  it('produces a scanned PDF with no usable text layer', async () => {
    const parsers = createParserRegistry(harness.config, new NoopOCRProvider());

    await expect(
      parsers.parse(scannedPdf, { key: 'scanned.pdf', mimeType: 'application/pdf', ocrEnabled: false }),
    ).rejects.toThrow(/no extractable text/i);
  });

  it('recovers the text of a scanned document through OCR', async () => {
    const ocr = new TesseractOCRProvider('eng', 2);
    try {
      expect(await ocr.isAvailable()).toBe(true);

      const parsers = createParserRegistry(harness.config, ocr);
      const parsed = await parsers.parse(scannedPdf, {
        key: 'scanned.pdf',
        mimeType: 'application/pdf',
      });

      expect(parsed.ocrPageCount).toBeGreaterThan(0);
      expect(parsed.extractionMethod).toBe('OCR');

      const text = documentToText(parsed);
      expect(text.length).toBeGreaterThan(1000);
      expect(text).toContain('Business Expense Policy');
      expect(text).toContain('Finance Director');
      // The specific threshold must survive OCR, or answers built on it would
      // be wrong in exactly the way that matters.
      expect(text).toContain(facts.financeDirectorThreshold as string);
    } finally {
      await ocr.dispose();
    }
  }, 180_000);

  it('OCRs only the scanned pages of a mixed document', async () => {
    const ocr = new TesseractOCRProvider('eng', 2);
    try {
      const parsers = createParserRegistry(harness.config, ocr);
      const parsed = await parsers.parse(mixedPdf, { key: 'mixed.pdf', mimeType: 'application/pdf' });

      expect(parsed.extractionMethod).toBe('MIXED');
      expect(parsed.ocrPageCount).toBe(1);

      const methods = parsed.pages.map((page) => page.extractionMethod);
      expect(methods).toContain('NATIVE_TEXT');
      expect(methods).toContain('OCR');
      // OCR must not have been spent on pages that already had text.
      expect(methods.filter((method) => method === 'OCR')).toHaveLength(1);
    } finally {
      await ocr.dispose();
    }
  }, 180_000);

  it('does not OCR a document whose text layer is sufficient', async () => {
    const ocr = new TesseractOCRProvider('eng', 2);
    try {
      const composed = composeDocument({
        blueprint: businessExpensePolicy,
        documentCode: 'FIN-POL-002',
        title: businessExpensePolicy.title,
        owner: businessExpensePolicy.ownerRole,
        revisionNumber: 1,
        effectiveDate: '2025-03-01',
        rng: new SeededRandom(77),
        revisionHistory: [],
        includeWorkflow: false,
      });

      const native = await renderDocumentToPdf(composed.content);
      const parsers = createParserRegistry(harness.config, ocr);
      const parsed = await parsers.parse(native, { key: 'native.pdf', mimeType: 'application/pdf' });

      expect(parsed.ocrPageCount).toBe(0);
      expect(parsed.extractionMethod).toBe('NATIVE_TEXT');
      expect(parsed.pages.every((page) => !page.requiredOcr)).toBe(true);
    } finally {
      await ocr.dispose();
    }
  }, 180_000);

  it('ingests a scanned document and records OCR provenance on its chunks', async () => {
    const document = await harness.documents.upsert({
      documentCode: 'SCAN-POL-001',
      title: 'Scanned Expense Policy',
      documentType: 'POLICY',
      department: 'Finance',
      metadata: { synthetic: true, format: 'pdf-scanned' },
    });

    const key = 'SCAN-POL-001/rev-001/scanned-expense-policy.pdf';
    await harness.storage.write(key, scannedPdf);

    const { sha256 } = await import('../../src/utils/hash.js');
    await harness.revisions.create({
      documentId: document.id,
      revisionNumber: 1,
      filePath: key,
      fileName: 'scanned-expense-policy.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: scannedPdf.length,
      fileHash: sha256(scannedPdf),
    });

    const run = await harness.ingestion.run({ trigger: 'TEST' });

    expect(run.failed).toBe(0);
    expect(run.ocrPages).toBeGreaterThan(0);

    const { rows } = await pool.query<{ extraction_method: string; count: number }>(
      `SELECT extraction_method, count(*)::int AS count
         FROM document_chunks
        WHERE document_code = 'SCAN-POL-001'
        GROUP BY extraction_method`,
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.extraction_method === 'OCR')).toBe(true);

    // And the OCR'd content is retrievable like any other content.
    const result = await harness.retrieval.retrieve({
      query: 'Finance Director approval threshold',
      filters: { documentCode: 'SCAN-POL-001' },
      log: false,
    });
    expect(result.selected.length).toBeGreaterThan(0);
  }, 180_000);
});
