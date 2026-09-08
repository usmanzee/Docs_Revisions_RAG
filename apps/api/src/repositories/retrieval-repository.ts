/**
 * Retrieval SQL: dense (pgvector), lexical (PostgreSQL FTS) and exact
 * identifier lookup.
 *
 * This is the one place that knows how candidates are fetched. The retrieval
 * service composes and ranks what comes back but never issues its own vector
 * query, so filtering rules - "current revision only", "active documents only" -
 * cannot be forgotten at a call site.
 *
 * Why raw SQL rather than a LangChain vector store: the hot path needs a
 * weighted tsvector, partial-index-aligned predicates, metadata filters and
 * distance in one round trip. Expressing that through a generic store wrapper
 * would cost clarity and control for no benefit.
 */

import type { RetrievalFilters } from '@docs-rag/shared';
import { getPool, queryRows, type Queryable } from '../db/pool.js';
import { ParamList } from '../db/query-builder.js';
import { toVectorLiteral } from '../db/vector.js';
import type { ExtractionMethod } from '@docs-rag/shared';

/** Shape returned by every candidate source. */
export interface RetrievalCandidateRow {
  id: string;
  document_id: string;
  document_revision_id: string;
  document_code: string;
  document_title: string;
  revision_number: number;
  chunk_index: number;
  parent_chunk_id: string | null;
  section_title: string | null;
  subsection_title: string | null;
  heading_path: string | null;
  page_start: number | null;
  page_end: number | null;
  content: string;
  token_count: number;
  extraction_method: ExtractionMethod;
  effective_date: Date | null;
  is_current: boolean;
  department: string | null;
  document_type: string | null;
  /** CONTENT or ADMINISTRATIVE - see the chunker's section classification. */
  section_role: string;
  score: number;
}

const CANDIDATE_COLUMNS = `
         c.id,
         c.document_id,
         c.document_revision_id,
         c.document_code,
         d.title AS document_title,
         c.revision_number,
         c.chunk_index,
         c.parent_chunk_id,
         c.section_title,
         c.subsection_title,
         c.heading_path,
         c.page_start,
         c.page_end,
         c.content,
         c.token_count,
         c.extraction_method,
         r.effective_date,
         c.is_current,
         c.department,
         c.document_type,
         COALESCE(c.metadata->>'sectionRole', 'CONTENT') AS section_role`;

/**
 * Shared predicates for every retrieval path.
 *
 * `is_current` plus `documents.is_active` are the default visibility rules.
 * Historical retrieval is opt-in (`includeHistorical`) and exists to support
 * "what did revision 3 say?" - it is never reachable from ordinary chat.
 */
function buildFilterConditions(filters: RetrievalFilters, params: ParamList): string[] {
  const conditions: string[] = ["c.chunk_type = 'CHILD'", 'd.is_active'];

  if (!filters.includeHistorical) conditions.push('c.is_current');

  if (filters.department) conditions.push(`c.department = ${params.add(filters.department)}`);
  if (filters.documentType) conditions.push(`c.document_type = ${params.add(filters.documentType)}`);
  if (filters.category) conditions.push(`c.category = ${params.add(filters.category)}`);
  if (filters.documentCode) conditions.push(`c.document_code = ${params.add(filters.documentCode)}`);

  return conditions;
}

export class RetrievalRepository {
  constructor(private readonly db: Queryable = getPool()) {}

  withExecutor(executor: Queryable): RetrievalRepository {
    return new RetrievalRepository(executor);
  }

  /**
   * Dense retrieval by cosine distance.
   *
   * `score` is cosine similarity in [-1, 1] (1 - distance) so that every
   * candidate source returns "higher is better". The ORDER BY is left as the
   * bare distance operator, which is what lets the partial HNSW index serve the
   * query; the distance threshold is applied by the caller rather than in the
   * WHERE clause, so it cannot silently defeat the index.
   */
  async vectorSearch(
    embedding: readonly number[],
    limit: number,
    filters: RetrievalFilters = {},
  ): Promise<RetrievalCandidateRow[]> {
    const params = new ParamList();
    const vector = params.add(toVectorLiteral(embedding));
    const conditions = buildFilterConditions(filters, params);
    conditions.push('c.embedding IS NOT NULL');
    const limitParam = params.add(limit);

    return queryRows<RetrievalCandidateRow>(
      `SELECT ${CANDIDATE_COLUMNS},
              1 - (c.embedding <=> ${vector}::vector) AS score
         FROM document_chunks c
         JOIN documents d          ON d.id = c.document_id
         JOIN document_revisions r ON r.id = c.document_revision_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY c.embedding <=> ${vector}::vector
        LIMIT ${limitParam}`,
      params.all(),
      this.db,
    );
  }

  /**
   * Lexical retrieval over the weighted tsvector.
   *
   * `websearch_to_tsquery` is used rather than `plainto_tsquery` because it
   * understands quoted phrases and negation, and because it degrades gracefully
   * on the punctuation-heavy identifiers this corpus is full of
   * (ORA-GUIDE-003, ORA-01555, FIN-POL-001).
   *
   * ts_rank_cd with normalisation flag 32 divides by rank+1, which keeps long
   * chunks from dominating purely by containing more matches.
   */
  async lexicalSearch(
    queryText: string,
    limit: number,
    filters: RetrievalFilters = {},
  ): Promise<RetrievalCandidateRow[]> {
    const params = new ParamList();
    const queryParam = params.add(queryText);
    const conditions = buildFilterConditions(filters, params);
    const limitParam = params.add(limit);

    return queryRows<RetrievalCandidateRow>(
      `WITH q AS (SELECT websearch_to_tsquery('english', ${queryParam}) AS query)
       SELECT ${CANDIDATE_COLUMNS},
              ts_rank_cd(c.text_search, q.query, 32) AS score
         FROM document_chunks c
         CROSS JOIN q
         JOIN documents d          ON d.id = c.document_id
         JOIN document_revisions r ON r.id = c.document_revision_id
        WHERE ${conditions.join(' AND ')}
          AND q.query IS NOT NULL
          AND c.text_search @@ q.query
        ORDER BY score DESC, c.chunk_index ASC
        LIMIT ${limitParam}`,
      params.all(),
      this.db,
    );
  }

  /**
   * Exact identifier retrieval.
   *
   * Neither embeddings nor stemmed full-text reliably nail a question like
   * "what does ORA-GUIDE-003 recommend?" - the code is a rare token whose
   * embedding carries little meaning. Pulling the referenced document's chunks
   * directly and letting them compete in the fusion step is far more robust
   * than hoping the ANN index surfaces them.
   *
   * Ordered by chunk_index so the document's opening sections rank first.
   */
  async identifierSearch(
    documentCodes: readonly string[],
    limit: number,
    filters: RetrievalFilters = {},
  ): Promise<RetrievalCandidateRow[]> {
    if (documentCodes.length === 0) return [];

    const params = new ParamList();
    const codes = params.add(documentCodes);
    const conditions = buildFilterConditions(filters, params);
    conditions.push(`c.document_code = ANY(${codes}::text[])`);
    const limitParam = params.add(limit);

    return queryRows<RetrievalCandidateRow>(
      `SELECT ${CANDIDATE_COLUMNS}, 1.0 AS score
         FROM document_chunks c
         JOIN documents d          ON d.id = c.document_id
         JOIN document_revisions r ON r.id = c.document_revision_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY c.chunk_index ASC
        LIMIT ${limitParam}`,
      params.all(),
      this.db,
    );
  }

  /**
   * Parent bodies for a set of child chunks (parent-child retrieval).
   * A small chunk is precise enough to match; its parent section is what the
   * model actually needs to answer without losing surrounding conditions.
   */
  async fetchParents(parentIds: readonly string[]): Promise<RetrievalCandidateRow[]> {
    if (parentIds.length === 0) return [];
    return queryRows<RetrievalCandidateRow>(
      `SELECT ${CANDIDATE_COLUMNS}, 1.0 AS score
         FROM document_chunks c
         JOIN documents d          ON d.id = c.document_id
         JOIN document_revisions r ON r.id = c.document_revision_id
        WHERE c.id = ANY($1::uuid[])`,
      [parentIds],
      this.db,
    );
  }

  /** Document codes that actually exist, used to validate identifiers in a query. */
  async filterExistingDocumentCodes(candidates: readonly string[]): Promise<string[]> {
    if (candidates.length === 0) return [];
    const rows = await queryRows<{ document_code: string }>(
      'SELECT document_code FROM documents WHERE document_code = ANY($1::text[])',
      [candidates],
      this.db,
    );
    return rows.map((row) => row.document_code);
  }
}
