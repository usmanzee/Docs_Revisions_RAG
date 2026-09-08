/**
 * Retrieval debugging.
 *
 * Returns every stage of the pipeline for one query: the standalone rewrite,
 * each candidate list with its own scores and ranks, the fused ordering, and
 * what finally made it into the context. This is the difference between "the
 * answer was wrong" and "the answer was wrong because the lexical search
 * matched a superseded chunk that outranked the right one".
 */

import type {
  FusedCandidateDebug,
  RetrievalCandidateDebug,
  RetrievalDebugResponse,
  RetrievalFilters,
} from '@docs-rag/shared';
import type { AppConfig } from '../config/index.js';
import type { RetrievalLogRepository } from '../repositories/retrieval-log-repository.js';
import type { RagService } from '../modules/chat/rag-service.js';
import type { EmbeddingProvider } from '../modules/embeddings/index.js';
import type { RetrievalCandidate } from '../modules/retrieval/types.js';
import { buildExcerpt } from '../utils/text.js';

function toCandidateDebug(candidate: RetrievalCandidate, rank: number): RetrievalCandidateDebug {
  return {
    chunkId: candidate.chunkId,
    documentCode: candidate.documentCode,
    documentTitle: candidate.documentTitle,
    revision: candidate.revisionNumber,
    section: candidate.sectionTitle,
    page: candidate.pageStart,
    rank,
    score: Number(candidate.score.toFixed(6)),
    preview: buildExcerpt(candidate.content, 200),
  };
}

function toFusedDebug(candidate: RetrievalCandidate, rank: number): FusedCandidateDebug {
  return {
    ...toCandidateDebug(candidate, rank),
    vectorRank: candidate.ranks.vector ?? null,
    lexicalRank: candidate.ranks.lexical ?? null,
    rrfScore: Number(candidate.score.toFixed(6)),
  };
}

export interface DebugControllerDependencies {
  rag: RagService;
  embeddings: EmbeddingProvider;
  logs: RetrievalLogRepository;
  config: AppConfig;
}

export class DebugController {
  constructor(private readonly deps: DebugControllerDependencies) {}

  async retrieval(input: {
    query: string;
    filters?: RetrievalFilters;
    conversationId?: string | null;
    limit?: number;
  }): Promise<RetrievalDebugResponse> {
    // Runs the identical preparation path the chat endpoint uses, so what is
    // shown here is genuinely what the model would have been given.
    const prepared = await this.deps.rag.prepare({
      question: input.query,
      conversationId: input.conversationId ?? null,
      ...(input.filters ? { filters: input.filters } : {}),
      source: 'DEBUG',
    });

    const { retrieval } = prepared;

    return {
      query: input.query,
      standaloneQuery: prepared.standaloneQuery,
      filters: retrieval.filters,
      vectorCandidates: retrieval.vectorCandidates.map((candidate, index) =>
        toCandidateDebug(candidate, index + 1),
      ),
      lexicalCandidates: retrieval.lexicalCandidates.map((candidate, index) =>
        toCandidateDebug(candidate, index + 1),
      ),
      fused: retrieval.fused.map((candidate, index) => toFusedDebug(candidate, index + 1)),
      selected: retrieval.selected.map((candidate, index) => toFusedDebug(candidate, index + 1)),
      contextTokens: prepared.contextTokens,
      timings: {
        embeddingMs: retrieval.timings.embeddingMs,
        vectorMs: retrieval.timings.vectorMs,
        lexicalMs: retrieval.timings.lexicalMs,
        fusionMs: retrieval.timings.fusionMs,
        rerankMs: retrieval.timings.rerankMs,
        totalMs: retrieval.timings.totalMs,
      },
      config: {
        vectorTopK: this.deps.config.retrieval.vectorTopK,
        lexicalTopK: this.deps.config.retrieval.lexicalTopK,
        rrfK: this.deps.config.retrieval.rrfK,
        finalContextChunks: this.deps.config.retrieval.finalContextChunks,
        reranker: this.deps.config.retrieval.reranker,
        embeddingProvider: this.deps.embeddings.name,
        embeddingModel: this.deps.embeddings.model,
      },
    };
  }

  /** The exact prompt the model would receive. Invaluable when an answer is odd. */
  async prompt(input: { query: string; filters?: RetrievalFilters; conversationId?: string | null }) {
    const prepared = await this.deps.rag.prepare({
      question: input.query,
      conversationId: input.conversationId ?? null,
      ...(input.filters ? { filters: input.filters } : {}),
      source: 'DEBUG',
    });

    return {
      standaloneQuery: prepared.standaloneQuery,
      systemPrompt: prepared.systemPrompt,
      userPrompt: prepared.userPrompt,
      contextTokens: prepared.contextTokens,
      citations: prepared.citations,
    };
  }

  async recentLogs(limit: number, source?: 'CHAT' | 'DEBUG' | 'EVALUATION' | 'BENCHMARK') {
    return this.deps.logs.listRecent(limit, source);
  }
}
