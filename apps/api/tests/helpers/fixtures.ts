/**
 * Test fixtures.
 *
 * Builds real documents through the real generator into a temporary storage
 * root, so integration tests exercise genuine PDFs, DOCX files and scanned
 * pages rather than hand-written stubs that cannot fail the way real files do.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import type { AppConfig } from '../../src/config/index.js';
import { DocumentRepository } from '../../src/repositories/document-repository.js';
import { RevisionRepository } from '../../src/repositories/revision-repository.js';
import { ChunkRepository } from '../../src/repositories/chunk-repository.js';
import { IngestionRepository } from '../../src/repositories/ingestion-repository.js';
import { LocalDocumentStorage } from '../../src/modules/storage/index.js';
import { createParserRegistry } from '../../src/modules/parsing/index.js';
import { NoopOCRProvider, TesseractOCRProvider, type OCRProvider } from '../../src/modules/ocr/index.js';
import { DeterministicMockEmbeddingProvider } from '../../src/modules/embeddings/index.js';
import { createVisionEnricher } from '../../src/modules/vision/index.js';
import { DocumentIngestionService } from '../../src/modules/ingestion/ingestion-service.js';
import { CorpusGenerator, resolveCorpusOptions } from '../../src/modules/corpus/corpus-generator.js';
import { RevisionSimulator } from '../../src/modules/corpus/revision-simulator.js';
import { RetrievalService } from '../../src/modules/retrieval/retrieval-service.js';
import { RetrievalRepository } from '../../src/repositories/retrieval-repository.js';
import { NoopReranker } from '../../src/modules/retrieval/reranker.js';

export interface TestHarness {
  config: AppConfig;
  storageRoot: string;
  storage: LocalDocumentStorage;
  documents: DocumentRepository;
  revisions: RevisionRepository;
  chunks: ChunkRepository;
  jobs: IngestionRepository;
  embeddings: DeterministicMockEmbeddingProvider;
  ingestion: DocumentIngestionService;
  simulator: RevisionSimulator;
  retrieval: RetrievalService;
  corpus: CorpusGenerator;
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  /** Real OCR is slow; only the OCR suite needs it. */
  ocr?: 'none' | 'tesseract';
}

export async function createHarness(
  baseConfig: AppConfig,
  pool: pg.Pool,
  options: HarnessOptions = {},
): Promise<TestHarness> {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'docs-rag-test-'));

  const config: AppConfig = {
    ...baseConfig,
    storage: { ...baseConfig.storage, root: storageRoot },
    ocr: { ...baseConfig.ocr, enabled: options.ocr === 'tesseract' },
    ingestion: { ...baseConfig.ingestion, concurrency: 2 },
  };

  const ocr: OCRProvider =
    options.ocr === 'tesseract' ? new TesseractOCRProvider(config.ocr.language, 2) : new NoopOCRProvider();

  const storage = new LocalDocumentStorage(storageRoot);
  const documents = new DocumentRepository(pool);
  const revisions = new RevisionRepository(pool);
  const chunks = new ChunkRepository(pool);
  const jobs = new IngestionRepository(pool);
  const embeddings = new DeterministicMockEmbeddingProvider(config.embedding.dimensions);
  const parsers = createParserRegistry(config, ocr);

  const ingestion = new DocumentIngestionService({
    storage,
    parsers,
    embeddings,
    vision: createVisionEnricher(config),
    documents,
    revisions,
    chunks,
    jobs,
    config,
    pool,
  });

  const retrieval = new RetrievalService({
    repository: new RetrievalRepository(pool),
    embeddings,
    reranker: new NoopReranker(),
    config,
  });

  return {
    config,
    storageRoot,
    storage,
    documents,
    revisions,
    chunks,
    jobs,
    embeddings,
    ingestion,
    simulator: new RevisionSimulator(storage, documents, revisions),
    retrieval,
    corpus: new CorpusGenerator({ storage, documents, revisions, config }),
    async cleanup() {
      await ocr.dispose();
      await rm(storageRoot, { recursive: true, force: true });
    },
  };
}

/** Generate a small corpus into the harness's temporary storage. */
export async function generateFixtureCorpus(
  harness: TestHarness,
  overrides: { count?: number; seed?: number; scannedRatio?: number; corruptRatio?: number } = {},
): Promise<void> {
  const options = resolveCorpusOptions(harness.config, {
    profile: 'smoke',
    count: overrides.count ?? 6,
    seed: overrides.seed ?? 4242,
    // Ratios are pinned rather than inherited: fixtures must be deterministic,
    // and a surprise scanned page would make every suite pay for OCR.
    scannedRatio: overrides.scannedRatio ?? 0,
    corruptRatio: overrides.corruptRatio ?? 0,
    multiRevisionRatio: 0,
    inactiveRatio: 0,
    duplicateRatio: 0,
    docxRatio: 0,
    textRatio: 0,
    reset: false,
    writeEvaluation: false,
  });

  await harness.corpus.generate(options);
}
