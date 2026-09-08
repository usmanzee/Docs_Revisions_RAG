/**
 * Processing for a single document revision.
 *
 * The pipeline is deliberately a sequence of small, named stages rather than
 * one long function: every stage is separately timed, separately attributable
 * in an error, and separately testable.
 *
 *   read -> parse (+OCR) -> enrich (optional vision) -> normalise -> chunk
 *        -> embed -> persist + activate (one transaction)
 *
 * The activation rule is the single most important behaviour in this file: new
 * chunks are inserted with `is_current = false` and only become visible inside
 * the same transaction that demotes the previous revision. Anything that throws
 * before COMMIT leaves the old revision current and searchable.
 */

import type { ExtractionMethod } from '@docs-rag/shared';
import type pg from 'pg';
import type { AppConfig } from '../../config/index.js';
import { getConfig } from '../../config/index.js';
import { getPool, queryOne, withTransaction, type Queryable } from '../../db/pool.js';
import { ChunkRepository, type ChunkInsertInput } from '../../repositories/chunk-repository.js';
import { RevisionRepository, type RevisionWithDocument } from '../../repositories/revision-repository.js';
import { timed } from '../../utils/async.js';
import { contentHash } from '../../utils/hash.js';
import { IngestionError, toErrorMessage } from '../../utils/errors.js';
import { childLogger } from '../../utils/logger.js';
import { createChunker, type DocumentChunker } from '../chunking/index.js';
import type { EmbeddingProvider } from '../embeddings/index.js';
import { documentToText, type ParsedDocument } from '../parsing/types.js';
import type { ParserRegistry } from '../parsing/index.js';
import type { DocumentStorage } from '../storage/index.js';
import type { VisionDocumentEnricher } from '../vision/index.js';
import { toDateString } from '../../repositories/types.js';

export type ProcessOutcome = 'PROCESSED' | 'SKIPPED' | 'FAILED';

export type SkipReason =
  | 'UNCHANGED_CONTENT'
  | 'SUPERSEDED_BY_NEWER_REVISION'
  | 'DOCUMENT_INACTIVE'
  | 'NO_CONTENT';

export interface RevisionProcessResult {
  revisionId: string;
  documentCode: string;
  revisionNumber: number;
  outcome: ProcessOutcome;
  skipReason?: SkipReason;
  activated: boolean;
  chunksCreated: number;
  pages: number;
  ocrPages: number;
  visionImages: number;
  embeddingTokens: number;
  embeddingRequests: number;
  errorMessage?: string;
  errorStage?: string;
  timings: {
    totalMs: number;
    readMs: number;
    parseMs: number;
    visionMs: number;
    chunkMs: number;
    embedMs: number;
    persistMs: number;
  };
}

export interface RevisionProcessorDependencies {
  storage: DocumentStorage;
  parsers: ParserRegistry;
  chunker: DocumentChunker;
  embeddings: EmbeddingProvider;
  vision: VisionDocumentEnricher;
  revisions: RevisionRepository;
  chunks: ChunkRepository;
  config: AppConfig;
  pool?: pg.Pool;
}

export class RevisionProcessor {
  private readonly logger = childLogger({ component: 'revision-processor' });

  constructor(private readonly deps: RevisionProcessorDependencies) {}

  /**
   * Take the per-document activation lock.
   *
   * Two revisions of the same document can be in flight at once - a document
   * that gained three revisions between runs is claimed as three rows and
   * processed concurrently. Without serialisation, both would decide to
   * activate, both would set `is_current`, and the partial unique index would
   * reject the loser with a constraint violation that looks like a bug in the
   * pipeline rather than a race.
   *
   * Locking the `documents` row makes activation strictly ordered per document
   * while leaving different documents fully parallel.
   */
  private async lockDocument(client: pg.PoolClient, documentId: string): Promise<void> {
    await client.query('SELECT id FROM documents WHERE id = $1 FOR UPDATE', [documentId]);
  }

  /**
   * Should this revision become the current one?
   *
   * A revision only takes over if no *newer* revision of the same document has
   * already been successfully processed. Without this, re-processing an old
   * revision would silently roll the document's answers backwards.
   *
   * This must be evaluated *inside* the activation transaction and *after* the
   * document lock: a newer revision may have committed while this one was being
   * parsed and embedded, and a decision made before the lock would be stale.
   */
  private async shouldActivate(
    executor: Queryable,
    revision: RevisionWithDocument,
  ): Promise<boolean> {
    const newer = await queryOne<{ revision_number: number }>(
      `SELECT revision_number
         FROM document_revisions
        WHERE document_id = $1
          AND revision_number > $2
          AND processing_status IN ('READY', 'SUPERSEDED')
        ORDER BY revision_number DESC
        LIMIT 1`,
      [revision.document_id, revision.revision_number],
      executor,
    );
    return newer === null;
  }

  async process(revision: RevisionWithDocument): Promise<RevisionProcessResult> {
    const started = performance.now();
    const logger = this.logger.child({
      documentId: revision.document_id,
      revisionId: revision.id,
      documentCode: revision.document_code,
      revisionNumber: revision.revision_number,
    });

    const result: RevisionProcessResult = {
      revisionId: revision.id,
      documentCode: revision.document_code,
      revisionNumber: revision.revision_number,
      outcome: 'FAILED',
      activated: false,
      chunksCreated: 0,
      pages: 0,
      ocrPages: 0,
      visionImages: 0,
      embeddingTokens: 0,
      embeddingRequests: 0,
      timings: { totalMs: 0, readMs: 0, parseMs: 0, visionMs: 0, chunkMs: 0, embedMs: 0, persistMs: 0 },
    };

    let stage = 'read';

    try {
      // --- read ----------------------------------------------------------
      const { result: bytes, ms: readMs } = await timed(() =>
        this.deps.storage.read(revision.file_path),
      );
      result.timings.readMs = readMs;

      // --- parse (with OCR where the text layer is insufficient) ----------
      stage = 'parse';
      const { result: parsed, ms: parseMs } = await timed(() =>
        this.deps.parsers.parse(bytes, {
          key: revision.file_path,
          mimeType: revision.mime_type,
        }),
      );
      result.timings.parseMs = parseMs;
      result.pages = parsed.pageCount;
      result.ocrPages = parsed.ocrPageCount;

      // --- optional vision enrichment ------------------------------------
      stage = 'vision';
      const vision = await this.deps.vision.enrich(parsed);
      result.timings.visionMs = vision.durationMs;
      result.visionImages = vision.imagesDescribed;

      // --- normalise and hash --------------------------------------------
      stage = 'normalise';
      const text = documentToText(parsed);
      if (text.trim().length === 0) {
        return this.skip(result, 'NO_CONTENT', started);
      }
      const normalizedHash = contentHash(text);

      // Content-based skip: the file changed (a re-export, a new timestamp) but
      // the text did not, so re-embedding would spend money to produce
      // identical vectors.
      const existingChunkCount = await this.deps.chunks.countByRevision(revision.id);
      if (
        revision.content_hash === normalizedHash &&
        existingChunkCount > 0 &&
        revision.processing_status !== 'FAILED'
      ) {
        logger.info({ chunks: existingChunkCount }, 'content unchanged; skipping re-embedding');

        await withTransaction(async (client) => {
          await this.lockDocument(client, revision.document_id);

          if (await this.shouldActivate(client, revision)) {
            await this.deps.revisions.activateRevision(client, revision.id, revision.document_id);
            result.activated = true;
          } else {
            await client.query(
              `UPDATE document_revisions
                  SET processing_status = 'SUPERSEDED', is_current = FALSE
                WHERE id = $1`,
              [revision.id],
            );
          }
        }, this.deps.pool ?? getPool());

        return this.skip(result, 'UNCHANGED_CONTENT', started);
      }

      // --- chunk ----------------------------------------------------------
      stage = 'chunk';
      const { result: chunked, ms: chunkMs } = await timed(async () =>
        this.deps.chunker.chunk(parsed, {
          documentCode: revision.document_code,
          documentTitle: revision.document_title,
          documentType: revision.document_type,
          department: revision.department,
          category: revision.category,
          revisionNumber: revision.revision_number,
          effectiveDate: toDateString(revision.effective_date),
        }),
      );
      result.timings.chunkMs = chunkMs;

      if (chunked.childCount === 0) {
        return this.skip(result, 'NO_CONTENT', started);
      }

      // --- embed ----------------------------------------------------------
      stage = 'embed';
      const embeddable = chunked.chunks.filter((chunk) => chunk.chunkType === 'CHILD');
      const { result: embedded, ms: embedMs } = await timed(() =>
        this.deps.embeddings.embed(embeddable.map((chunk) => chunk.embeddingText)),
      );
      result.timings.embedMs = embedMs;
      result.embeddingTokens = embedded.tokens;
      result.embeddingRequests = embedded.requests;

      if (embedded.embeddings.length !== embeddable.length) {
        throw new IngestionError(
          'embed',
          `embedding provider returned ${embedded.embeddings.length} vectors for ${embeddable.length} chunks`,
        );
      }

      const vectorsByIndex = new Map<number, number[]>();
      embeddable.forEach((chunk, index) => {
        vectorsByIndex.set(chunk.chunkIndex, embedded.embeddings[index] as number[]);
      });

      const inserts: ChunkInsertInput[] = chunked.chunks.map((chunk) => ({
        documentId: revision.document_id,
        documentRevisionId: revision.id,
        chunkIndex: chunk.chunkIndex,
        chunkType: chunk.chunkType,
        parentChunkIndex: chunk.parentChunkIndex,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        sectionTitle: chunk.sectionTitle,
        subsectionTitle: chunk.subsectionTitle,
        headingPath: chunk.headingPath,
        content: chunk.content,
        contentHash: contentHash(chunk.content),
        tokenCount: chunk.tokenCount,
        extractionMethod: chunk.extractionMethod,
        documentCode: revision.document_code,
        revisionNumber: revision.revision_number,
        department: revision.department,
        documentType: revision.document_type,
        category: revision.category,
        embedding: vectorsByIndex.get(chunk.chunkIndex) ?? null,
        embeddingModel: this.deps.embeddings.model,
        metadata: chunk.metadata,
      }));

      // Two chunks with byte-identical text would violate the unique constraint
      // on (revision, content_hash). Deduplicating here keeps the guarantee and
      // avoids storing the same paragraph twice.
      const deduped = dedupeByContentHash(inserts);

      // --- persist and activate (single transaction) ----------------------
      stage = 'persist';
      const persistStarted = performance.now();
      let activate = false;

      await withTransaction(async (client) => {
        // Serialise activation for this document, then decide. Both steps have
        // to be inside the transaction: a newer revision may have been
        // activated while this one was being parsed and embedded.
        await this.lockDocument(client, revision.document_id);
        activate = await this.shouldActivate(client, revision);

        // Re-processing: remove this revision's previous chunks. Only ever its
        // own - another revision's chunks are never touched here.
        await this.deps.chunks.deleteByRevision(revision.id, client);
        await this.deps.chunks.insertMany(client, deduped);

        await this.deps.revisions.recordProcessingResult(client, revision.id, {
          contentHash: normalizedHash,
          pageCount: parsed.pageCount,
          ocrPageCount: parsed.ocrPageCount,
          chunkCount: deduped.filter((chunk) => chunk.chunkType === 'CHILD').length,
          tokenCount: chunked.totalTokens,
          metadata: {
            extractionMethod: parsed.extractionMethod,
            parser: revision.mime_type,
            visionImages: vision.imagesDescribed,
            embeddingModel: this.deps.embeddings.model,
            embeddingProvider: this.deps.embeddings.name,
          },
        });

        if (activate) {
          await this.deps.revisions.activateRevision(client, revision.id, revision.document_id);
        } else {
          // Processed, but an even newer revision already owns the document.
          await client.query(
            `UPDATE document_revisions
                SET processing_status = 'SUPERSEDED',
                    status            = 'SUPERSEDED',
                    is_current        = FALSE,
                    processed_at      = now(),
                    processing_error  = NULL,
                    claimed_at        = NULL,
                    claimed_by        = NULL
              WHERE id = $1`,
            [revision.id],
          );
        }
      }, this.deps.pool ?? getPool());

      result.timings.persistMs = Math.round(performance.now() - persistStarted);
      result.chunksCreated = deduped.filter((chunk) => chunk.chunkType === 'CHILD').length;
      result.activated = activate;
      result.outcome = 'PROCESSED';
      result.timings.totalMs = Math.round(performance.now() - started);

      logger.info(
        {
          chunks: result.chunksCreated,
          pages: result.pages,
          ocrPages: result.ocrPages,
          activated: activate,
          extractionMethod: parsed.extractionMethod satisfies ExtractionMethod,
          durationMs: result.timings.totalMs,
        },
        'revision processed',
      );

      return result;
    } catch (error) {
      // One failing document must never take down the run - and, critically,
      // must never disturb the revision that is currently serving traffic.
      const message = toErrorMessage(error);
      const errorStage = error instanceof IngestionError ? error.stage : stage;

      await this.deps.revisions.markFailed(revision.id, `[${errorStage}] ${message}`);

      result.outcome = 'FAILED';
      result.errorMessage = message;
      result.errorStage = errorStage;
      result.timings.totalMs = Math.round(performance.now() - started);

      logger.error({ stage: errorStage, err: { message } }, 'revision processing failed');
      return result;
    }
  }

  private skip(
    result: RevisionProcessResult,
    reason: SkipReason,
    started: number,
  ): RevisionProcessResult {
    result.outcome = 'SKIPPED';
    result.skipReason = reason;
    result.timings.totalMs = Math.round(performance.now() - started);
    return result;
  }
}

/** Drop chunks whose text is byte-identical after normalisation. */
function dedupeByContentHash(inserts: readonly ChunkInsertInput[]): ChunkInsertInput[] {
  const seen = new Set<string>();
  const kept: ChunkInsertInput[] = [];

  for (const insert of inserts) {
    const key = `${insert.chunkType}:${insert.contentHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(insert);
  }

  // Parent references are by chunkIndex, and dropping a duplicate never removes
  // a parent that a surviving child points at (parents are emitted first and a
  // duplicate parent would mean two identical sections), so indices stay valid.
  return kept;
}

export function createRevisionProcessor(
  deps: Omit<RevisionProcessorDependencies, 'chunker' | 'config'> &
    Partial<Pick<RevisionProcessorDependencies, 'chunker' | 'config'>>,
): RevisionProcessor {
  const config = deps.config ?? getConfig();
  return new RevisionProcessor({
    ...deps,
    config,
    chunker: deps.chunker ?? createChunker(config.chunking),
  });
}

export type { ParsedDocument };
