/**
 * Persistence for retrieval chunks.
 *
 * Writes happen only during ingestion, inside the same transaction that
 * activates the revision. Newly inserted chunks start with `is_current = false`
 * so they are invisible to retrieval until activation flips them - which is what
 * lets a new revision be built while the old one keeps serving traffic.
 */

import type { ChunkDetail, ChunkType, ExtractionMethod } from '@docs-rag/shared';
import type pg from 'pg';
import { getPool, queryOne, queryRows, type Queryable } from '../db/pool.js';
import { toVectorLiteral } from '../db/vector.js';
import { toIso, type DocumentChunkRow } from './types.js';

export interface ChunkInsertInput {
  documentId: string;
  documentRevisionId: string;
  chunkIndex: number;
  chunkType: ChunkType;
  /** Index of the parent within the same batch; resolved to a UUID on insert. */
  parentChunkIndex: number | null;
  pageStart: number | null;
  pageEnd: number | null;
  sectionTitle: string | null;
  subsectionTitle: string | null;
  headingPath: string | null;
  content: string;
  contentHash: string;
  tokenCount: number;
  extractionMethod: ExtractionMethod;
  documentCode: string;
  revisionNumber: number;
  department: string | null;
  documentType: string | null;
  category: string | null;
  embedding: number[] | null;
  embeddingModel: string | null;
  metadata: Record<string, unknown>;
}

export interface ChunkWithDocument extends DocumentChunkRow {
  document_title: string;
  effective_date: Date | null;
  revision_is_current: boolean;
}

const CHUNK_WITH_DOCUMENT = `
  SELECT c.*,
         d.title           AS document_title,
         r.effective_date  AS effective_date,
         r.is_current      AS revision_is_current
    FROM document_chunks c
    JOIN documents d          ON d.id = c.document_id
    JOIN document_revisions r ON r.id = c.document_revision_id`;

/**
 * Number of chunks inserted per multi-row INSERT. Chosen to stay well under
 * PostgreSQL's 65535 bound parameter limit: each chunk binds 22 parameters, so
 * 200 rows is ~4400 parameters with plenty of headroom.
 */
const INSERT_BATCH_SIZE = 200;

export class ChunkRepository {
  constructor(private readonly db: Queryable = getPool()) {}

  withExecutor(executor: Queryable): ChunkRepository {
    return new ChunkRepository(executor);
  }

  /**
   * Insert a revision's chunks in dependency order (parents first, so a child
   * can reference its parent's generated UUID) using batched multi-row INSERTs.
   *
   * Returns the inserted ids keyed by chunk_index.
   */
  async insertMany(client: pg.PoolClient, chunks: readonly ChunkInsertInput[]): Promise<Map<number, string>> {
    const idsByIndex = new Map<number, string>();
    if (chunks.length === 0) return idsByIndex;

    // Parents must exist before children reference them.
    const parents = chunks.filter((chunk) => chunk.chunkType === 'PARENT');
    const children = chunks.filter((chunk) => chunk.chunkType !== 'PARENT');

    for (const group of [parents, children]) {
      for (let offset = 0; offset < group.length; offset += INSERT_BATCH_SIZE) {
        const batch = group.slice(offset, offset + INSERT_BATCH_SIZE);
        const values: unknown[] = [];
        const tuples: string[] = [];

        for (const chunk of batch) {
          const parentId =
            chunk.parentChunkIndex === null ? null : (idsByIndex.get(chunk.parentChunkIndex) ?? null);
          const base = values.length;
          values.push(
            chunk.documentId,
            chunk.documentRevisionId,
            chunk.chunkIndex,
            chunk.chunkType,
            parentId,
            chunk.pageStart,
            chunk.pageEnd,
            chunk.sectionTitle,
            chunk.subsectionTitle,
            chunk.headingPath,
            chunk.content,
            chunk.contentHash,
            chunk.tokenCount,
            chunk.extractionMethod,
            chunk.documentCode,
            chunk.revisionNumber,
            chunk.department,
            chunk.documentType,
            chunk.category,
            chunk.embedding ? toVectorLiteral(chunk.embedding) : null,
            chunk.embeddingModel,
            JSON.stringify(chunk.metadata),
          );
          const p = (index: number) => `$${base + index}`;
          tuples.push(
            `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)}, ` +
              `${p(11)}, ${p(12)}, ${p(13)}, ${p(14)}, ${p(15)}, ${p(16)}, ${p(17)}, ${p(18)}, ${p(19)}, ` +
              `${p(20)}::vector, ${p(21)}, ${p(22)}::jsonb, FALSE)`,
          );
        }

        const result = await client.query<{ id: string; chunk_index: number }>(
          `INSERT INTO document_chunks (
             document_id, document_revision_id, chunk_index, chunk_type, parent_chunk_id,
             page_start, page_end, section_title, subsection_title, heading_path,
             content, content_hash, token_count, extraction_method,
             document_code, revision_number, department, document_type, category,
             embedding, embedding_model, metadata, is_current
           ) VALUES ${tuples.join(', ')}
           RETURNING id, chunk_index`,
          values,
        );

        for (const row of result.rows) idsByIndex.set(row.chunk_index, row.id);
      }
    }

    return idsByIndex;
  }

  /**
   * Remove a revision's chunks. Used when reprocessing a revision that already
   * has chunks - never as part of activating a *different* revision, because
   * superseded chunks are retained on purpose.
   */
  async deleteByRevision(revisionId: string, executor?: Queryable): Promise<number> {
    const db = executor ?? this.db;
    const result = await db.query('DELETE FROM document_chunks WHERE document_revision_id = $1', [revisionId]);
    return result.rowCount ?? 0;
  }

  async findById(id: string): Promise<ChunkWithDocument | null> {
    return queryOne<ChunkWithDocument>(`${CHUNK_WITH_DOCUMENT} WHERE c.id = $1`, [id], this.db);
  }

  async findByIds(ids: readonly string[]): Promise<ChunkWithDocument[]> {
    if (ids.length === 0) return [];
    return queryRows<ChunkWithDocument>(`${CHUNK_WITH_DOCUMENT} WHERE c.id = ANY($1::uuid[])`, [ids], this.db);
  }

  async findByRevision(revisionId: string, limit = 500): Promise<ChunkWithDocument[]> {
    return queryRows<ChunkWithDocument>(
      `${CHUNK_WITH_DOCUMENT} WHERE c.document_revision_id = $1 ORDER BY c.chunk_index LIMIT $2`,
      [revisionId, limit],
      this.db,
    );
  }

  async countByRevision(revisionId: string): Promise<number> {
    const row = await queryOne<{ total: number }>(
      'SELECT count(*)::int AS total FROM document_chunks WHERE document_revision_id = $1',
      [revisionId],
      this.db,
    );
    return row?.total ?? 0;
  }

  /** Neighbouring chunks of the same revision, for context expansion. */
  async findNeighbours(chunkId: string, radius = 1): Promise<ChunkWithDocument[]> {
    return queryRows<ChunkWithDocument>(
      `${CHUNK_WITH_DOCUMENT}
        WHERE c.document_revision_id = (SELECT document_revision_id FROM document_chunks WHERE id = $1)
          AND c.chunk_type = 'CHILD'
          AND c.chunk_index BETWEEN
              (SELECT chunk_index FROM document_chunks WHERE id = $1) - $2
          AND (SELECT chunk_index FROM document_chunks WHERE id = $1) + $2
        ORDER BY c.chunk_index`,
      [chunkId, radius],
      this.db,
    );
  }
}

export function mapChunkDetail(row: ChunkWithDocument & { has_embedding?: boolean }): ChunkDetail {
  return {
    id: row.id,
    documentId: row.document_id,
    documentRevisionId: row.document_revision_id,
    documentCode: row.document_code,
    documentTitle: row.document_title,
    revisionNumber: row.revision_number,
    chunkIndex: row.chunk_index,
    chunkType: row.chunk_type,
    parentChunkId: row.parent_chunk_id,
    pageStart: row.page_start,
    pageEnd: row.page_end,
    sectionTitle: row.section_title,
    subsectionTitle: row.subsection_title,
    headingPath: row.heading_path,
    content: row.content,
    tokenCount: row.token_count,
    extractionMethod: row.extraction_method,
    isCurrent: row.is_current,
    hasEmbedding: row.has_embedding ?? row.embedding_model !== null,
    createdAt: toIso(row.created_at) as string,
  };
}
