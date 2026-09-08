/**
 * Corpus generator.
 *
 * Turns a plan into real files on the storage driver plus the matching rows in
 * PostgreSQL. Every revision is written as PENDING - the generator never
 * pretends a document has been processed. Ingestion is what makes a revision
 * searchable, and keeping that boundary honest is what lets the ingestion tests
 * mean anything.
 */

import { mkdir, rm } from 'node:fs/promises';
import type { CorpusProfile } from '@docs-rag/shared';
import { getConfig, type AppConfig } from '../../config/index.js';
import { getPool, withTransaction } from '../../db/pool.js';
import { DocumentRepository } from '../../repositories/document-repository.js';
import { RevisionRepository } from '../../repositories/revision-repository.js';
import { sha256 } from '../../utils/hash.js';
import { childLogger } from '../../utils/logger.js';
import { SeededRandom } from '../../utils/random.js';
import { LocalDocumentStorage, type DocumentStorage } from '../storage/index.js';
import { findBlueprint, type Blueprint, type GoldQuestionSeed } from './blueprints/index.js';
import { planCorpus, type PlannedCorpus } from './corpus-planner.js';
import { composeDocument, documentToMarkdown } from './document-composer.js';
import { generateEvaluationDataset, type EvaluationRecord } from './evaluation-generator.js';
import { renderDocumentToDocx } from './renderers/docx-renderer.js';
import { renderDocumentToPdf } from './renderers/pdf-renderer.js';
import { renderDocumentToScannedPdf } from './renderers/scanned-pdf-renderer.js';
import { planMutation } from './revision-mutations.js';
import type { SyntheticSection } from './types.js';
import type {
  CorpusGenerationOptions,
  CorpusGenerationResult,
  DocumentFact,
  GeneratedDocument,
  GeneratedRevision,
  SyntheticDocumentPlan,
  SyntheticFormat,
} from './types.js';

type SectionTransform = (sections: SyntheticSection[], rng: SeededRandom) => SyntheticSection[];

const MIME_TYPES: Record<SyntheticFormat, string> = {
  pdf: 'application/pdf',
  'pdf-scanned': 'application/pdf',
  'pdf-mixed': 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
};

const EXTENSIONS: Record<SyntheticFormat, string> = {
  pdf: 'pdf',
  'pdf-scanned': 'pdf',
  'pdf-mixed': 'pdf',
  docx: 'docx',
  txt: 'txt',
  md: 'md',
};

/** File name derived from the title, in the style of a real network drive. */
function fileNameFor(plan: SyntheticDocumentPlan): string {
  const slug = plan.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${slug}.${EXTENSIONS[plan.format]}`;
}

/**
 * Bytes that are not a valid document of the declared type.
 *
 * A truncated PDF header is used rather than random noise: it is the realistic
 * failure (a file damaged in transfer), it is unambiguously a PDF by extension
 * and mime type, and it fails inside the parser rather than being rejected
 * before the pipeline is exercised.
 */
function corruptBytes(documentCode: string, revisionNumber: number): Buffer {
  const header = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1');
  const truncated = Buffer.from(
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n% ${documentCode} rev ${revisionNumber} - transfer interrupted\n`,
    'latin1',
  );
  return Buffer.concat([header, truncated]);
}

export interface CorpusGeneratorDependencies {
  storage: DocumentStorage;
  documents: DocumentRepository;
  revisions: RevisionRepository;
  config: AppConfig;
}

export class CorpusGenerator {
  private readonly logger = childLogger({ component: 'corpus-generator' });

  constructor(private readonly deps: CorpusGeneratorDependencies) {}

  /** Render one revision's bytes in the plan's format. */
  private async renderRevision(
    plan: SyntheticDocumentPlan,
    revision: GeneratedRevision,
    rng: SeededRandom,
  ): Promise<Buffer> {
    const { content } = revision;

    switch (plan.format) {
      case 'pdf':
        return renderDocumentToPdf(content);

      case 'pdf-scanned':
        return renderDocumentToScannedPdf(content, { rng });

      case 'pdf-mixed': {
        // Scan a contiguous run of pages in the middle of the document, which
        // is what an appendix inserted from a paper original looks like.
        const scanned = new Set<number>();
        const first = rng.int(1, 2);
        for (let offset = 0; offset < rng.int(1, 2); offset += 1) scanned.add(first + offset);
        return renderDocumentToPdf(content, { scannedPageIndices: scanned });
      }

      case 'docx':
        return renderDocumentToDocx(content);

      case 'md':
      case 'txt':
        return Buffer.from(documentToMarkdown(content), 'utf8');
    }
  }

  /**
   * Compose every revision of one document.
   *
   * Revision N is revision N-1 with one described mutation applied, so the
   * difference between two revisions is a specific, explainable change rather
   * than a fresh roll of the dice.
   */
  private composeRevisions(
    plan: SyntheticDocumentPlan,
    blueprint: Blueprint,
  ): { revisions: GeneratedRevision[]; questions: GoldQuestionSeed[] } {
    const history: { revision: number; date: string; summary: string }[] = [];
    const revisions: GeneratedRevision[] = [];
    let overrides: Record<string, DocumentFact> = {};
    let questions: GoldQuestionSeed[] = [];

    // Structural changes accumulate: a step added in revision 2 is still there
    // in revision 3, which is how a document actually evolves.
    const transforms: SectionTransform[] = [];

    for (const revisionPlan of plan.revisions) {
      history.push({
        revision: revisionPlan.revisionNumber,
        date: revisionPlan.effectiveDate,
        summary: revisionPlan.changeSummary,
      });

      // Each revision composes from its own RNG stream so a change to how many
      // revisions a document has cannot alter revision 1's content.
      const rng = new SeededRandom(plan.seed + revisionPlan.revisionNumber * 7919);

      const composed = composeDocument({
        blueprint,
        documentCode: plan.documentCode,
        title: plan.title,
        owner: plan.owner,
        revisionNumber: revisionPlan.revisionNumber,
        effectiveDate: revisionPlan.effectiveDate,
        rng,
        factOverrides: overrides,
        revisionHistory: [...history],
        includeWorkflow: plan.includeWorkflow,
      });

      questions = composed.questions;

      // Apply every structural mutation accumulated up to this revision.
      let sections = composed.content.sections;
      for (const [transformIndex, transform] of transforms.entries()) {
        sections = transform(sections, new SeededRandom(plan.seed + transformIndex * 31_337));
      }
      const content = { ...composed.content, sections };

      const mutation = revisionPlan.mutation;

      revisions.push({
        revisionNumber: revisionPlan.revisionNumber,
        storageKey: '',
        fileName: fileNameFor(plan),
        mimeType: MIME_TYPES[plan.format],
        fileHash: '',
        fileSizeBytes: 0,
        effectiveDate: revisionPlan.effectiveDate,
        changeSummary: revisionPlan.changeSummary,
        content,
        corrupt: revisionPlan.corrupt ?? false,
        ...(mutation ? { mutation } : {}),
      });

      // Plan the mutation that will produce the *next* revision.
      const mutationRng = new SeededRandom(plan.seed + revisionPlan.revisionNumber * 104_729);
      const next = planMutation(blueprint, composed.facts, mutationRng);
      overrides = { ...overrides, ...next.factOverrides };
      if (next.transform) transforms.push(next.transform);

      const following = plan.revisions.find((entry) => entry.revisionNumber === revisionPlan.revisionNumber + 1);
      if (following) {
        following.mutation = next.mutation;
        following.changeSummary = next.mutation.description;
        // Keep the history table in step with the summary that will be written.
        const historyEntry = history.find((entry) => entry.revision === revisionPlan.revisionNumber + 1);
        if (historyEntry) historyEntry.summary = next.mutation.description;
      }
    }

    return { revisions, questions };
  }

  /** Write one document's revisions to storage and register them in PostgreSQL. */
  private async materialiseDocument(
    plan: SyntheticDocumentPlan,
    blueprint: Blueprint,
  ): Promise<{ document: GeneratedDocument; questions: GoldQuestionSeed[]; bytes: number }> {
    const { revisions, questions } = this.composeRevisions(plan, blueprint);
    const renderRng = new SeededRandom(plan.seed ^ 0x5f3759df);

    let bytes = 0;

    const documentRow = await this.deps.documents.upsert({
      documentCode: plan.documentCode,
      title: plan.title,
      documentType: plan.documentType,
      department: plan.department,
      category: plan.category,
      owner: plan.owner,
      description: plan.description,
      isActive: plan.isActive,
      tags: plan.tags,
      metadata: {
        synthetic: true,
        blueprint: plan.blueprintKey,
        format: plan.format,
        ...(plan.duplicateOf ? { nearDuplicateOf: plan.duplicateOf } : {}),
      },
    });

    for (const revision of revisions) {
      const data = revision.corrupt
        ? corruptBytes(plan.documentCode, revision.revisionNumber)
        : await this.renderRevision(plan, revision, renderRng);

      revision.storageKey = LocalDocumentStorage.buildKey(
        plan.documentCode,
        revision.revisionNumber,
        revision.fileName,
      );
      revision.fileHash = sha256(data);
      revision.fileSizeBytes = data.length;
      bytes += data.length;

      const stored = await this.deps.storage.write(revision.storageKey, data, {
        contentType: revision.mimeType,
      });

      await this.deps.revisions.create({
        documentId: documentRow.id,
        revisionNumber: revision.revisionNumber,
        filePath: revision.storageKey,
        fileName: revision.fileName,
        mimeType: revision.mimeType,
        fileSizeBytes: revision.fileSizeBytes,
        effectiveDate: revision.effectiveDate,
        changeSummary: revision.changeSummary,
        fileHash: revision.fileHash,
        // The file's real modification time, not its business effective date.
        // Discovery compares this against the storage listing to decide whether
        // a file needs re-hashing, so it has to be the same clock.
        sourceModifiedAt: stored.modifiedAt,
        storageDriver: this.deps.storage.driver,
        metadata: {
          synthetic: true,
          format: plan.format,
          ...(revision.mutation ? { mutation: revision.mutation } : {}),
          ...(revision.corrupt ? { corrupt: true } : {}),
          ...(revision.content.workflow
            ? { expectedWorkflowText: revision.content.workflow.expectedText }
            : {}),
          facts: Object.fromEntries(revision.content.facts.map((fact) => [fact.id, fact.value])),
        },
      });
    }

    return { document: { plan, revisions }, questions, bytes };
  }

  /** Remove every generated document and its storage. Development only. */
  private async resetCorpus(): Promise<void> {
    if (this.deps.config.isProduction) {
      throw new Error('refusing to reset the corpus while NODE_ENV=production');
    }

    this.logger.warn('resetting corpus: deleting all documents and generated files');

    await withTransaction(async (client) => {
      // Cascades remove revisions and chunks.
      await client.query('DELETE FROM documents');
      await client.query('DELETE FROM ingestion_job_items');
      await client.query('DELETE FROM ingestion_jobs');
      await client.query('DELETE FROM evaluation_questions');
    });

    const root = this.deps.config.storage.root;
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
  }

  async generate(options: CorpusGenerationOptions): Promise<{
    result: CorpusGenerationResult;
    evaluation: EvaluationRecord[];
    documents: GeneratedDocument[];
  }> {
    const started = performance.now();

    if (options.reset) await this.resetCorpus();

    const planned: PlannedCorpus = planCorpus(options);
    const questionSeeds = new Map<string, GoldQuestionSeed[]>();
    const generated: GeneratedDocument[] = [];

    const formatBreakdown: Record<string, number> = {};
    let bytesWritten = 0;
    let filesWritten = 0;
    let revisionsWritten = 0;
    let corruptRevisions = 0;

    for (const [index, plan] of planned.documents.entries()) {
      const blueprint = findBlueprint(plan.blueprintKey);
      if (!blueprint) {
        this.logger.error({ documentCode: plan.documentCode }, 'unknown blueprint; skipping document');
        continue;
      }

      const { document, questions, bytes } = await this.materialiseDocument(plan, blueprint);

      generated.push(document);
      questionSeeds.set(plan.documentCode, questions);

      formatBreakdown[plan.format] = (formatBreakdown[plan.format] ?? 0) + 1;
      bytesWritten += bytes;
      filesWritten += document.revisions.length;
      revisionsWritten += document.revisions.length;
      corruptRevisions += document.revisions.filter((revision) => revision.corrupt).length;

      if ((index + 1) % 100 === 0) {
        this.logger.info(
          { generated: index + 1, total: planned.documents.length },
          'corpus generation progress',
        );
      }
    }

    const evaluation = options.writeEvaluation
      ? generateEvaluationDataset(generated, questionSeeds, new SeededRandom(options.seed ^ 0x9e3779b9), {
          seed: options.seed,
          profile: options.profile,
        })
      : [];

    const result: CorpusGenerationResult = {
      profile: options.profile,
      seed: options.seed,
      documentsPlanned: planned.documents.length,
      documentsWritten: generated.length,
      revisionsWritten,
      filesWritten,
      bytesWritten,
      scannedDocuments: generated.filter((document) =>
        document.plan.format === 'pdf-scanned' || document.plan.format === 'pdf-mixed',
      ).length,
      workflowDocuments: generated.filter((document) => document.plan.includeWorkflow).length,
      corruptRevisions,
      inactiveDocuments: generated.filter((document) => !document.plan.isActive).length,
      duplicateDocuments: generated.filter((document) => document.plan.duplicateOf).length,
      formatBreakdown,
      evaluationQuestions: evaluation.length,
      evaluationPath: null,
      durationMs: Math.round(performance.now() - started),
    };

    return { result, evaluation, documents: generated };
  }
}

export function createCorpusGenerator(config: AppConfig = getConfig()): CorpusGenerator {
  const pool = getPool();
  return new CorpusGenerator({
    storage: new LocalDocumentStorage(config.storage.root),
    documents: new DocumentRepository(pool),
    revisions: new RevisionRepository(pool),
    config,
  });
}

/** Resolve CLI/env inputs into a complete option set. */
export function resolveCorpusOptions(
  config: AppConfig,
  overrides: Partial<CorpusGenerationOptions> & { profile?: CorpusProfile } = {},
): CorpusGenerationOptions {
  const profile = overrides.profile ?? config.corpus.profile;
  return {
    profile,
    count: overrides.count ?? config.corpus.size,
    seed: overrides.seed ?? config.corpus.seed,
    scannedRatio: overrides.scannedRatio ?? config.corpus.scannedRatio,
    workflowRatio: overrides.workflowRatio ?? config.corpus.workflowRatio,
    multiRevisionRatio: overrides.multiRevisionRatio ?? config.corpus.multiRevisionRatio,
    corruptRatio: overrides.corruptRatio ?? config.corpus.corruptRatio,
    inactiveRatio: overrides.inactiveRatio ?? config.corpus.inactiveRatio,
    duplicateRatio: overrides.duplicateRatio ?? config.corpus.duplicateRatio,
    docxRatio: overrides.docxRatio ?? config.corpus.docxRatio,
    textRatio: overrides.textRatio ?? config.corpus.textRatio,
    tableRatio: overrides.tableRatio ?? config.corpus.tableRatio,
    reset: overrides.reset ?? false,
    // The gold dataset is only meaningful for a corpus small enough to embed
    // with a real model; a scale corpus uses mock vectors by design.
    writeEvaluation: overrides.writeEvaluation ?? profile !== 'scale',
  };
}

export { planCorpus } from './corpus-planner.js';
export type { EvaluationRecord } from './evaluation-generator.js';
