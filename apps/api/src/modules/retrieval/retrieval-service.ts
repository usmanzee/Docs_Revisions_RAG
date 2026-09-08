/**
 * Hybrid retrieval.
 *
 *   query -> [ vector | lexical | identifier ] -> RRF -> rerank -> expand -> select
 *
 * Chat code never issues its own vector query: it calls this service, which
 * owns the filtering rules (current revision, active document), the fusion, and
 * the trace that makes a result explainable afterwards.
 *
 * Why three candidate sources rather than the usual two: a question naming a
 * document ("what does ORA-GUIDE-003 say about tablespace monitoring?") is
 * poorly served by both dense and lexical retrieval. The code is a rare token
 * whose embedding carries little meaning, and full-text ranking will happily
 * prefer a long chunk that mentions tablespaces in a different document.
 * Pulling the named document's chunks directly and letting them compete in the
 * fusion is more reliable than hoping either index surfaces them.
 */

import type { RetrievalFilters } from '@docs-rag/shared';
import type { AppConfig } from '../../config/index.js';
import { getConfig } from '../../config/index.js';
import { timed } from '../../utils/async.js';
import { toErrorMessage } from '../../utils/errors.js';
import { childLogger } from '../../utils/logger.js';
import { countTokens } from '../../utils/tokens.js';
import type { RetrievalRepository, RetrievalCandidateRow } from '../../repositories/retrieval-repository.js';
import type { RetrievalLogRepository, CandidateTrace } from '../../repositories/retrieval-log-repository.js';
import { toDateString } from '../../repositories/types.js';
import type { EmbeddingProvider } from '../embeddings/index.js';
import { reciprocalRankFusion, type RankedList } from './rrf.js';
import type { Reranker } from './reranker.js';
import type {
  RetrievalCandidate,
  RetrievalRequest,
  RetrievalResult,
  RetrievalTimings,
} from './types.js';
import { extractDocumentCodes } from './query-analysis.js';

/** How many candidates to keep after fusion, before reranking and selection. */
const FUSION_POOL_MULTIPLIER = 3;

/**
 * Rank multiplier applied to administrative sections (revision histories,
 * reference lists).
 *
 * They are legitimate content and stay retrievable - a question about how a
 * policy changed should still find them - but a revision-history table quotes
 * every threshold the document has ever had, so at full weight it out-ranks the
 * section stating the current rule. Demotion rather than exclusion keeps both
 * questions answerable.
 */
const ADMINISTRATIVE_RANK_MULTIPLIER = 0.45;

function rowToCandidate(row: RetrievalCandidateRow, sourceName: string): RetrievalCandidate {
  return {
    chunkId: row.id,
    documentId: row.document_id,
    revisionId: row.document_revision_id,
    documentCode: row.document_code,
    documentTitle: row.document_title,
    revisionNumber: row.revision_number,
    chunkIndex: row.chunk_index,
    parentChunkId: row.parent_chunk_id,
    sectionTitle: row.section_title,
    subsectionTitle: row.subsection_title,
    headingPath: row.heading_path,
    pageStart: row.page_start,
    pageEnd: row.page_end,
    effectiveDate: toDateString(row.effective_date),
    content: row.content,
    tokenCount: row.token_count,
    extractionMethod: row.extraction_method,
    isCurrent: row.is_current,
    department: row.department,
    documentType: row.document_type,
    sectionRole: row.section_role === 'ADMINISTRATIVE' ? 'ADMINISTRATIVE' : 'CONTENT',
    score: row.score,
    ranks: {},
    sourceScores: { [sourceName]: row.score },
  };
}

function toTrace(candidates: readonly RetrievalCandidate[]): CandidateTrace[] {
  return candidates.map((candidate, index) => ({
    chunkId: candidate.chunkId,
    documentCode: candidate.documentCode,
    revision: candidate.revisionNumber,
    section: candidate.sectionTitle,
    rank: index + 1,
    score: candidate.score,
    preview: candidate.content,
  }));
}

export interface RetrievalServiceDependencies {
  repository: RetrievalRepository;
  embeddings: EmbeddingProvider;
  reranker: Reranker;
  logs?: RetrievalLogRepository;
  config?: AppConfig;
}

export class RetrievalService {
  private readonly logger = childLogger({ component: 'retrieval' });
  private readonly config: AppConfig;

  constructor(private readonly deps: RetrievalServiceDependencies) {
    this.config = deps.config ?? getConfig();
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const started = performance.now();
    const filters: RetrievalFilters = request.filters ?? {};
    const query = request.standaloneQuery?.trim() || request.query.trim();

    const timings: RetrievalTimings = {
      embeddingMs: 0,
      vectorMs: 0,
      lexicalMs: 0,
      identifierMs: 0,
      fusionMs: 0,
      rerankMs: 0,
      expandMs: 0,
      totalMs: 0,
    };

    // --- identifier detection -------------------------------------------
    const mentioned = extractDocumentCodes(query);
    const detectedDocumentCodes =
      mentioned.length > 0 ? await this.deps.repository.filterExistingDocumentCodes(mentioned) : [];

    // --- candidate generation (in parallel) -------------------------------
    const { result: embedding, ms: embeddingMs } = await timed(() =>
      this.deps.embeddings.embedQuery(query),
    );
    timings.embeddingMs = embeddingMs;

    const [vectorOutcome, lexicalOutcome, identifierOutcome] = await Promise.all([
      timed(() => this.deps.repository.vectorSearch(embedding, this.config.retrieval.vectorTopK, filters)),
      timed(() => this.deps.repository.lexicalSearch(query, this.config.retrieval.lexicalTopK, filters)),
      timed(() =>
        this.deps.repository.identifierSearch(
          detectedDocumentCodes,
          // A named document should contribute enough of itself to answer a
          // question about any of its sections.
          Math.max(8, Math.floor(this.config.retrieval.vectorTopK / 2)),
          filters,
        ),
      ),
    ]);

    timings.vectorMs = vectorOutcome.ms;
    timings.lexicalMs = lexicalOutcome.ms;
    timings.identifierMs = identifierOutcome.ms;

    // Discard vector hits beyond the configured distance: on a query with no
    // good match, the nearest neighbours are still returned, and passing them
    // on would manufacture context for a question the corpus cannot answer.
    const minSimilarity = 1 - this.config.retrieval.vectorMaxDistance;
    const vectorCandidates = vectorOutcome.result
      .filter((row) => row.score >= minSimilarity)
      .map((row) => rowToCandidate(row, 'vector'));

    const lexicalCandidates = lexicalOutcome.result.map((row) => rowToCandidate(row, 'lexical'));
    const identifierCandidates = identifierOutcome.result.map((row) => rowToCandidate(row, 'identifier'));

    // --- fusion -----------------------------------------------------------
    const fusionStarted = performance.now();

    const lists: RankedList[] = [
      { name: 'vector', items: vectorCandidates.map((c) => ({ id: c.chunkId, score: c.score })) },
      { name: 'lexical', items: lexicalCandidates.map((c) => ({ id: c.chunkId, score: c.score })) },
    ];

    if (identifierCandidates.length > 0) {
      // Weighted below the learned rankers: an explicit code is a strong signal
      // about *which document*, but says nothing about which section answers
      // the question, so it should inform the ranking rather than dictate it.
      lists.push({
        name: 'identifier',
        weight: 0.6,
        items: identifierCandidates.map((c) => ({ id: c.chunkId, score: c.score })),
      });
    }

    const byId = new Map<string, RetrievalCandidate>();
    for (const candidate of [...vectorCandidates, ...lexicalCandidates, ...identifierCandidates]) {
      const existing = byId.get(candidate.chunkId);
      if (existing) {
        Object.assign(existing.sourceScores, candidate.sourceScores);
        continue;
      }
      byId.set(candidate.chunkId, { ...candidate });
    }

    const limit = request.limit ?? this.config.retrieval.finalContextChunks;

    const fused = reciprocalRankFusion(lists, {
      k: this.config.retrieval.rrfK,
      limit: Math.max(limit * FUSION_POOL_MULTIPLIER, limit),
    })
      .map((item) => {
        const candidate = byId.get(item.id);
        if (!candidate) return null;
        const multiplier =
          candidate.sectionRole === 'ADMINISTRATIVE' ? ADMINISTRATIVE_RANK_MULTIPLIER : 1;
        return {
          ...candidate,
          score: item.rrfScore * multiplier,
          ranks: item.ranks,
          sourceScores: item.scores,
        };
      })
      .filter((candidate): candidate is RetrievalCandidate => candidate !== null)
      // Demotion can reorder, so sort again rather than trusting fusion order.
      .sort((a, b) => b.score - a.score);

    timings.fusionMs = Math.round(performance.now() - fusionStarted);

    // --- rerank -----------------------------------------------------------
    const { result: reranked, ms: rerankMs } = await timed(() =>
      this.deps.reranker.rerank(query, fused, limit),
    );
    timings.rerankMs = rerankMs;

    // --- parent expansion --------------------------------------------------
    const { result: selected, ms: expandMs } = await timed(() => this.expandToParents(reranked));
    timings.expandMs = expandMs;

    timings.totalMs = Math.round(performance.now() - started);

    const contextTokens = selected.reduce((total, candidate) => total + candidate.tokenCount, 0);

    const result: RetrievalResult = {
      query: request.query,
      standaloneQuery: query,
      filters,
      selected,
      fused,
      vectorCandidates,
      lexicalCandidates,
      identifierCandidates,
      detectedDocumentCodes,
      contextTokens,
      timings,
      retrievalLogId: null,
    };

    const shouldLog = request.log ?? this.config.retrieval.loggingEnabled;
    if (shouldLog && this.deps.logs) {
      result.retrievalLogId = await this.recordTrace(request, result);
    }

    this.logger.debug(
      {
        conversationId: request.conversationId,
        vector: vectorCandidates.length,
        lexical: lexicalCandidates.length,
        identifier: identifierCandidates.length,
        selected: selected.length,
        totalMs: timings.totalMs,
      },
      'retrieval complete',
    );

    return result;
  }

  /**
   * Swap a matched child for its parent section when the extra context is
   * likely to help and the budget can absorb it.
   *
   * The child is what matched - it is small and precise, which is why it ranked.
   * The parent is what answers, because a threshold means little without the
   * conditions stated around it. Expansion is skipped when the parent is very
   * large, since spending most of the budget on one section starves the rest.
   */
  private async expandToParents(candidates: RetrievalCandidate[]): Promise<RetrievalCandidate[]> {
    if (!this.config.retrieval.parentExpansion || candidates.length === 0) return candidates;

    const parentIds = [
      ...new Set(
        candidates
          .map((candidate) => candidate.parentChunkId)
          .filter((id): id is string => id !== null),
      ),
    ];
    if (parentIds.length === 0) return candidates;

    const parents = await this.deps.repository.fetchParents(parentIds);
    const parentById = new Map(parents.map((row) => [row.id, row]));

    // Budget per source, so one expansion cannot consume the whole context.
    const perSourceCeiling = Math.max(
      600,
      Math.floor(this.config.retrieval.contextTokenBudget / Math.max(2, candidates.length)),
    );

    const usedParents = new Set<string>();

    return candidates.map((candidate) => {
      if (!candidate.parentChunkId) return candidate;
      if (usedParents.has(candidate.parentChunkId)) return candidate;

      const parent = parentById.get(candidate.parentChunkId);
      if (!parent) return candidate;

      const parentTokens = countTokens(parent.content);
      if (parentTokens > perSourceCeiling) return candidate;
      // No point expanding when the parent adds almost nothing.
      if (parentTokens <= candidate.tokenCount * 1.15) return candidate;

      usedParents.add(candidate.parentChunkId);

      return {
        ...candidate,
        content: parent.content,
        tokenCount: parentTokens,
        pageStart: parent.page_start ?? candidate.pageStart,
        pageEnd: parent.page_end ?? candidate.pageEnd,
        expandedToParent: true,
      };
    });
  }

  /** Persist a retrieval trace. Never allowed to break the caller. */
  private async recordTrace(request: RetrievalRequest, result: RetrievalResult): Promise<string | null> {
    if (!this.deps.logs) return null;

    try {
      return await this.deps.logs.record({
        conversationId: request.conversationId ?? null,
        messageId: request.messageId ?? null,
        source: request.source ?? 'CHAT',
        query: result.query,
        standaloneQuery: result.standaloneQuery,
        filters: result.filters as Record<string, unknown>,
        vectorCandidates: toTrace(result.vectorCandidates),
        lexicalCandidates: toTrace(result.lexicalCandidates),
        fusedCandidates: toTrace(result.fused),
        selectedChunkIds: result.selected.map((candidate) => candidate.chunkId),
        contextTokens: result.contextTokens,
        timings: {
          embeddingMs: result.timings.embeddingMs,
          vectorMs: result.timings.vectorMs,
          lexicalMs: result.timings.lexicalMs,
          fusionMs: result.timings.fusionMs,
          rerankMs: result.timings.rerankMs,
          totalMs: result.timings.totalMs,
        },
        embeddingModel: this.deps.embeddings.model,
        reranker: this.deps.reranker.name,
        metadata: {
          detectedDocumentCodes: result.detectedDocumentCodes,
          identifierCandidates: result.identifierCandidates.length,
        },
      });
    } catch (error) {
      // Observability must never take down the request it was observing.
      this.logger.warn({ err: { message: toErrorMessage(error) } }, 'failed to record retrieval trace');
      return null;
    }
  }
}
