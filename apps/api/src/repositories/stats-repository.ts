/**
 * Aggregate statistics for the admin console.
 *
 * Everything here is a read-only roll-up. The heavier numbers (table and index
 * sizes) come from PostgreSQL's own catalog functions, which is what makes the
 * benchmark report able to state real on-disk sizes rather than estimates.
 */

import { getPool, queryOne, type Queryable } from '../db/pool.js';

export interface CorpusCounts {
  documentsTotal: number;
  documentsActive: number;
  documentsInactive: number;
  revisionsTotal: number;
  revisionsCurrent: number;
  revisionsPending: number;
  revisionsProcessing: number;
  revisionsReady: number;
  revisionsFailed: number;
  revisionsSuperseded: number;
  chunksTotal: number;
  chunksCurrent: number;
  chunksHistorical: number;
  chunksWithEmbedding: number;
  chunksParents: number;
  chunksOcrDerived: number;
}

export interface DatabaseSizes {
  databaseBytes: number | null;
  chunkTableBytes: number | null;
  vectorIndexBytes: number | null;
  textIndexBytes: number | null;
}

export class StatsRepository {
  constructor(private readonly db: Queryable = getPool()) {}

  /**
   * One query rather than a dozen: counting the chunk table repeatedly is the
   * expensive part at scale, so all the chunk aggregates share a single pass.
   */
  async corpusCounts(): Promise<CorpusCounts> {
    const row = await queryOne<Record<keyof CorpusCounts, number>>(
      `SELECT
         (SELECT count(*)::int FROM documents)                                            AS "documentsTotal",
         (SELECT count(*)::int FROM documents WHERE is_active)                            AS "documentsActive",
         (SELECT count(*)::int FROM documents WHERE NOT is_active)                        AS "documentsInactive",
         (SELECT count(*)::int FROM document_revisions)                                   AS "revisionsTotal",
         (SELECT count(*)::int FROM document_revisions WHERE is_current)                  AS "revisionsCurrent",
         (SELECT count(*)::int FROM document_revisions WHERE processing_status = 'PENDING')    AS "revisionsPending",
         (SELECT count(*)::int FROM document_revisions WHERE processing_status = 'PROCESSING') AS "revisionsProcessing",
         (SELECT count(*)::int FROM document_revisions WHERE processing_status = 'READY')      AS "revisionsReady",
         (SELECT count(*)::int FROM document_revisions WHERE processing_status = 'FAILED')     AS "revisionsFailed",
         (SELECT count(*)::int FROM document_revisions WHERE processing_status = 'SUPERSEDED') AS "revisionsSuperseded",
         c.total          AS "chunksTotal",
         c.current        AS "chunksCurrent",
         c.historical     AS "chunksHistorical",
         c.with_embedding AS "chunksWithEmbedding",
         c.parents        AS "chunksParents",
         c.ocr_derived    AS "chunksOcrDerived"
       FROM (
         SELECT count(*)::int                                                        AS total,
                count(*) FILTER (WHERE is_current)::int                              AS current,
                count(*) FILTER (WHERE NOT is_current)::int                          AS historical,
                count(*) FILTER (WHERE embedding IS NOT NULL)::int                   AS with_embedding,
                count(*) FILTER (WHERE chunk_type = 'PARENT')::int                   AS parents,
                count(*) FILTER (WHERE extraction_method IN ('OCR', 'MIXED'))::int   AS ocr_derived
           FROM document_chunks
       ) c`,
      [],
      this.db,
    );

    return (
      row ?? {
        documentsTotal: 0,
        documentsActive: 0,
        documentsInactive: 0,
        revisionsTotal: 0,
        revisionsCurrent: 0,
        revisionsPending: 0,
        revisionsProcessing: 0,
        revisionsReady: 0,
        revisionsFailed: 0,
        revisionsSuperseded: 0,
        chunksTotal: 0,
        chunksCurrent: 0,
        chunksHistorical: 0,
        chunksWithEmbedding: 0,
        chunksParents: 0,
        chunksOcrDerived: 0,
      }
    );
  }

  /**
   * On-disk sizes. `to_regclass` returns NULL instead of raising when an index
   * is absent, so this stays safe on a database where `db:indexes` has not run.
   */
  async databaseSizes(): Promise<DatabaseSizes> {
    const row = await queryOne<{
      database_bytes: number | null;
      chunk_table_bytes: number | null;
      vector_index_bytes: number | null;
      text_index_bytes: number | null;
    }>(
      `SELECT pg_database_size(current_database())                          AS database_bytes,
              pg_total_relation_size(to_regclass('document_chunks'))        AS chunk_table_bytes,
              pg_relation_size(to_regclass('document_chunks_embedding_hnsw_idx')) AS vector_index_bytes,
              pg_relation_size(to_regclass('document_chunks_text_search_idx'))    AS text_index_bytes`,
      [],
      this.db,
    );

    return {
      databaseBytes: row?.database_bytes ?? null,
      chunkTableBytes: row?.chunk_table_bytes ?? null,
      vectorIndexBytes: row?.vector_index_bytes ?? null,
      textIndexBytes: row?.text_index_bytes ?? null,
    };
  }
}
