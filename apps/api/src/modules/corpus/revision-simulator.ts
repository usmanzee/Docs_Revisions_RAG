/**
 * Revision simulator.
 *
 * Creates a genuine new revision of an existing document: a new file on the
 * storage driver, a new `document_revisions` row in PENDING, an incremented
 * revision number and a described change. It never touches the previous
 * revision's file or row - that is the whole point of the demonstration.
 *
 * Fact continuity is what makes the change meaningful. The previous revision's
 * fact values were recorded in its metadata when it was generated, so the new
 * revision is composed from exactly those values with one mutation applied.
 * Everything except the mutated fact reads identically, and the answer to one
 * specific question changes.
 */

import type { AppConfig } from '../../config/index.js';
import { getConfig } from '../../config/index.js';
import { getPool } from '../../db/pool.js';
import { DocumentRepository } from '../../repositories/document-repository.js';
import { RevisionRepository } from '../../repositories/revision-repository.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import { sha256 } from '../../utils/hash.js';
import { childLogger } from '../../utils/logger.js';
import { SeededRandom, seedFromString } from '../../utils/random.js';
import { LocalDocumentStorage, type DocumentStorage } from '../storage/index.js';
import { findBlueprint, type Blueprint } from './blueprints/index.js';
import { composeDocument } from './document-composer.js';
import { renderDocumentToDocx } from './renderers/docx-renderer.js';
import { renderDocumentToPdf } from './renderers/pdf-renderer.js';
import { renderDocumentToScannedPdf } from './renderers/scanned-pdf-renderer.js';
import { documentToMarkdown } from './document-composer.js';
import { planMutation } from './revision-mutations.js';
import type {
  DocumentFact,
  RevisionMutation,
  RevisionMutationType,
  SyntheticFormat,
} from './types.js';

export interface CreateRevisionOptions {
  /** Force a specific mutation shape. Otherwise one is chosen deterministically. */
  mutationType?: RevisionMutationType;
  /** Write an unreadable file so ingestion fails for this revision only. */
  corrupt?: boolean;
  /** Seed override, for tests that need a specific mutation. */
  seed?: number;
  /** Prefer a mutation that changes a numeric fact (the demo default). */
  preferFactChange?: boolean;
  /** Change this specific fact, so a known question's answer provably changes. */
  factId?: string;
}

export interface CreatedRevision {
  documentId: string;
  documentCode: string;
  revisionId: string;
  revisionNumber: number;
  previousRevisionNumber: number;
  storageKey: string;
  effectiveDate: string;
  changeSummary: string;
  mutation: RevisionMutation;
  corrupt: boolean;
  fileSizeBytes: number;
}

/**
 * Rebuild typed facts from the values recorded on the previous revision.
 *
 * The blueprint supplies the label, section and shape; the stored metadata
 * supplies the value that was actually published. A fact the blueprint has
 * since gained, but the stored revision never had, is simply absent - the
 * composer will generate it fresh.
 */
function reconstructFacts(blueprint: Blueprint, stored: Record<string, unknown>): Record<string, DocumentFact> {
  const facts: Record<string, DocumentFact> = {};

  for (const spec of blueprint.facts) {
    const value = stored[spec.id];
    if (typeof value !== 'string') continue;

    // Recover the numeric component so a threshold can be scaled again.
    const numericMatch = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);

    facts[spec.id] = {
      id: spec.id,
      label: spec.label,
      sectionKey: spec.sectionKey,
      value,
      ...(numericMatch ? { numericValue: Number(numericMatch[0]) } : {}),
    };
  }

  return facts;
}

function corruptBytes(documentCode: string, revisionNumber: number): Buffer {
  return Buffer.concat([
    Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1'),
    Buffer.from(
      `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n% ${documentCode} rev ${revisionNumber} - transfer interrupted\n`,
      'latin1',
    ),
  ]);
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  result.setMonth(result.getMonth() + months);
  return result;
}

export class RevisionSimulator {
  private readonly logger = childLogger({ component: 'revision-simulator' });

  constructor(
    private readonly storage: DocumentStorage,
    private readonly documents: DocumentRepository,
    private readonly revisions: RevisionRepository,
  ) {}

  async createRevision(documentCode: string, options: CreateRevisionOptions = {}): Promise<CreatedRevision> {
    const document = await this.documents.findByCode(documentCode);
    if (!document) throw new NotFoundError('Document', documentCode);

    const existing = await this.revisions.findByDocumentId(document.id);
    const latest = existing[0]; // ordered by revision_number DESC
    if (!latest) {
      throw new AppError('CONFLICT', `${documentCode} has no existing revision to base a new one on`);
    }

    const blueprintKey = (document.metadata as Record<string, unknown>).blueprint;
    if (typeof blueprintKey !== 'string') {
      throw new AppError(
        'CONFLICT',
        `${documentCode} was not produced by the corpus generator, so a new revision cannot be composed from it. ` +
          'The revision simulator only works on synthetic documents.',
      );
    }

    const blueprint = findBlueprint(blueprintKey);
    if (!blueprint) {
      throw new AppError('CONFLICT', `unknown blueprint "${blueprintKey}" for ${documentCode}`);
    }

    const revisionNumber = await this.revisions.nextRevisionNumber(document.id);

    const seed = options.seed ?? seedFromString(`${documentCode}:rev:${revisionNumber}`);
    const rng = new SeededRandom(seed);

    // Facts as published in the latest revision.
    const storedFacts = ((latest.metadata as Record<string, unknown>).facts ?? {}) as Record<string, unknown>;
    const previousFacts = reconstructFacts(blueprint, storedFacts);

    const plan = planMutation(blueprint, previousFacts, rng, {
      preferFactChange: options.preferFactChange ?? true,
      ...(options.mutationType ? { forceType: options.mutationType } : {}),
      ...(options.factId ? { factId: options.factId } : {}),
    });

    // Carry every previous value forward, then apply the mutation on top, so
    // only the mutated fact differs between the two revisions.
    const overrides: Record<string, DocumentFact> = { ...previousFacts, ...plan.factOverrides };

    const effectiveDate = addMonths(latest.effective_date ?? new Date(), rng.int(6, 18))
      .toISOString()
      .slice(0, 10);

    const history = existing
      .slice()
      .reverse()
      .map((revision) => ({
        revision: revision.revision_number,
        date: revision.effective_date ? revision.effective_date.toISOString().slice(0, 10) : '',
        summary: revision.change_summary ?? 'Revised.',
      }));
    history.push({ revision: revisionNumber, date: effectiveDate, summary: plan.mutation.description });

    const composed = composeDocument({
      blueprint,
      documentCode,
      title: document.title,
      owner: document.owner ?? blueprint.ownerRole,
      revisionNumber,
      effectiveDate,
      rng: new SeededRandom(seed ^ 0x1234_5678),
      factOverrides: overrides,
      revisionHistory: history,
      includeWorkflow: Boolean(blueprint.workflow),
    });

    let content = composed.content;
    if (plan.transform) {
      content = { ...content, sections: plan.transform(content.sections, new SeededRandom(seed ^ 0xabcd)) };
    }

    const format = ((latest.metadata as Record<string, unknown>).format as SyntheticFormat) ?? 'pdf';

    const data = options.corrupt
      ? corruptBytes(documentCode, revisionNumber)
      : await this.render(format, content, rng);

    const storageKey = LocalDocumentStorage.buildKey(documentCode, revisionNumber, latest.file_name);
    const stored = await this.storage.write(storageKey, data, { contentType: latest.mime_type });

    const created = await this.revisions.create({
      documentId: document.id,
      revisionNumber,
      filePath: storageKey,
      fileName: latest.file_name,
      mimeType: latest.mime_type,
      fileSizeBytes: data.length,
      effectiveDate,
      changeSummary: plan.mutation.description,
      fileHash: sha256(data),
      // Real file mtime: discovery compares it against the storage listing.
      sourceModifiedAt: stored.modifiedAt,
      storageDriver: this.storage.driver,
      metadata: {
        synthetic: true,
        format,
        simulated: true,
        mutation: plan.mutation,
        ...(options.corrupt ? { corrupt: true } : {}),
        facts: Object.fromEntries(Object.values(overrides).map((fact) => [fact.id, fact.value])),
      },
    });

    this.logger.info(
      {
        documentId: document.id,
        documentCode,
        revisionId: created.id,
        revisionNumber,
        mutation: plan.mutation.type,
        corrupt: options.corrupt ?? false,
      },
      'created new revision (PENDING)',
    );

    return {
      documentId: document.id,
      documentCode,
      revisionId: created.id,
      revisionNumber,
      previousRevisionNumber: latest.revision_number,
      storageKey,
      effectiveDate,
      changeSummary: plan.mutation.description,
      mutation: plan.mutation,
      corrupt: options.corrupt ?? false,
      fileSizeBytes: data.length,
    };
  }

  private async render(
    format: SyntheticFormat,
    content: Parameters<typeof renderDocumentToPdf>[0],
    rng: SeededRandom,
  ): Promise<Buffer> {
    switch (format) {
      case 'pdf-scanned':
        return renderDocumentToScannedPdf(content, { rng });
      case 'pdf-mixed': {
        const scanned = new Set<number>([1]);
        return renderDocumentToPdf(content, { scannedPageIndices: scanned });
      }
      case 'docx':
        return renderDocumentToDocx(content);
      case 'md':
      case 'txt':
        return Buffer.from(documentToMarkdown(content), 'utf8');
      case 'pdf':
      default:
        return renderDocumentToPdf(content);
    }
  }
}

export function createRevisionSimulator(config: AppConfig = getConfig()): RevisionSimulator {
  const pool = getPool();
  return new RevisionSimulator(
    new LocalDocumentStorage(config.storage.root),
    new DocumentRepository(pool),
    new RevisionRepository(pool),
  );
}
