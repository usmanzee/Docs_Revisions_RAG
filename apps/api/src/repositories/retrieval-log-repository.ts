/**
 * Retrieval trace persistence.
 *
 * One row per retrieval execution. Candidate lists are stored as trimmed JSONB
 * previews rather than full chunk text: the goal is to answer "why did this
 * rank here?" without turning the log table into a second copy of the corpus.
 */

import { getPool, queryOne, queryRows, type Queryable } from '../db/pool.js';
import { buildExcerpt } from '../utils/text.js';
import { toIso } from './types.js';

export type RetrievalLogSource = 'CHAT' | 'DEBUG' | 'EVALUATION' | 'BENCHMARK';

export interface CandidateTrace {
  chunkId: string;
  documentCode: string;
  revision: number;
  section: string | null;
  rank: number;
  score: number;
  preview?: string;
}

export interface RetrievalLogInput {
  conversationId?: string | null;
  messageId?: string | null;
  source: RetrievalLogSource;
  query: string;
  standaloneQuery?: string | null;
  filters?: Record<string, unknown>;
  vectorCandidates: CandidateTrace[];
  lexicalCandidates: CandidateTrace[];
  fusedCandidates: CandidateTrace[];
  selectedChunkIds: string[];
  contextTokens?: number | null;
  timings: {
    embeddingMs?: number;
    vectorMs?: number;
    lexicalMs?: number;
    fusionMs?: number;
    rerankMs?: number;
    totalMs?: number;
  };
  embeddingModel?: string | null;
  reranker?: string | null;
  metadata?: Record<string, unknown>;
}

/** Cap on stored candidates per list - enough to debug, small enough to keep. */
const MAX_STORED_CANDIDATES = 25;
const MAX_PREVIEW_CHARS = 180;

function trimCandidates(candidates: readonly CandidateTrace[]): CandidateTrace[] {
  return candidates.slice(0, MAX_STORED_CANDIDATES).map((candidate) => ({
    ...candidate,
    score: Number(candidate.score.toFixed(6)),
    preview: candidate.preview ? buildExcerpt(candidate.preview, MAX_PREVIEW_CHARS) : undefined,
  }));
}

export interface RetrievalLogSummary {
  id: string;
  source: RetrievalLogSource;
  query: string;
  standaloneQuery: string | null;
  selectedCount: number;
  vectorCount: number;
  lexicalCount: number;
  contextTokens: number | null;
  totalMs: number | null;
  createdAt: string | null;
}

export class RetrievalLogRepository {
  constructor(private readonly db: Queryable = getPool()) {}

  /**
   * Record a trace. Never throws into the caller: an observability failure must
   * not break a chat response, so errors are swallowed and surfaced by the
   * caller's logger instead.
   */
  async record(input: RetrievalLogInput): Promise<string | null> {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO retrieval_logs (
         conversation_id, message_id, source, query, standalone_query, filters,
         vector_candidates, lexical_candidates, fused_candidates, selected_chunk_ids,
         vector_count, lexical_count, selected_count, context_tokens,
         embedding_ms, vector_ms, lexical_ms, fusion_ms, rerank_ms, total_ms,
         embedding_model, reranker, metadata
       ) VALUES (
         $1, $2, $3, $4, $5, $6::jsonb,
         $7::jsonb, $8::jsonb, $9::jsonb, $10::uuid[],
         $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20,
         $21, $22, $23::jsonb
       )
       RETURNING id`,
      [
        input.conversationId ?? null,
        input.messageId ?? null,
        input.source,
        input.query,
        input.standaloneQuery ?? null,
        JSON.stringify(input.filters ?? {}),
        JSON.stringify(trimCandidates(input.vectorCandidates)),
        JSON.stringify(trimCandidates(input.lexicalCandidates)),
        JSON.stringify(trimCandidates(input.fusedCandidates)),
        input.selectedChunkIds,
        input.vectorCandidates.length,
        input.lexicalCandidates.length,
        input.selectedChunkIds.length,
        input.contextTokens ?? null,
        input.timings.embeddingMs ?? null,
        input.timings.vectorMs ?? null,
        input.timings.lexicalMs ?? null,
        input.timings.fusionMs ?? null,
        input.timings.rerankMs ?? null,
        input.timings.totalMs ?? null,
        input.embeddingModel ?? null,
        input.reranker ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
      this.db,
    );
    return row?.id ?? null;
  }

  async listRecent(limit = 50, source?: RetrievalLogSource): Promise<RetrievalLogSummary[]> {
    const rows = await queryRows<{
      id: string;
      source: RetrievalLogSource;
      query: string;
      standalone_query: string | null;
      selected_count: number;
      vector_count: number;
      lexical_count: number;
      context_tokens: number | null;
      total_ms: number | null;
      created_at: Date;
    }>(
      `SELECT id, source, query, standalone_query, selected_count, vector_count,
              lexical_count, context_tokens, total_ms, created_at
         FROM retrieval_logs
        WHERE ($2::text IS NULL OR source = $2)
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit, source ?? null],
      this.db,
    );

    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      query: row.query,
      standaloneQuery: row.standalone_query,
      selectedCount: row.selected_count,
      vectorCount: row.vector_count,
      lexicalCount: row.lexical_count,
      contextTokens: row.context_tokens,
      totalMs: row.total_ms,
      createdAt: toIso(row.created_at),
    }));
  }
}
