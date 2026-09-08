/**
 * Retrieval contracts.
 */

import type { Citation, ExtractionMethod, RetrievalFilters } from '@docs-rag/shared';

/** A chunk that survived retrieval, with the provenance of how it was found. */
export interface RetrievalCandidate {
  chunkId: string;
  documentId: string;
  revisionId: string;
  documentCode: string;
  documentTitle: string;
  revisionNumber: number;
  chunkIndex: number;
  parentChunkId: string | null;
  sectionTitle: string | null;
  subsectionTitle: string | null;
  headingPath: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  effectiveDate: string | null;
  content: string;
  tokenCount: number;
  extractionMethod: ExtractionMethod;
  isCurrent: boolean;
  department: string | null;
  documentType: string | null;
  /**
   * ADMINISTRATIVE marks revision histories and reference lists - real content,
   * but about the document rather than its requirements.
   */
  sectionRole: 'CONTENT' | 'ADMINISTRATIVE';

  /** Fused score; higher is better. */
  score: number;
  /** Per-source ranks, e.g. { vector: 3, lexical: 11 }. */
  ranks: Record<string, number>;
  /** Per-source raw scores. */
  sourceScores: Record<string, number>;
  /** Set when the content was expanded to the parent section. */
  expandedToParent?: boolean;
  rerankScore?: number;
}

export interface RetrievalRequest {
  query: string;
  /** Conversation-resolved query actually used for retrieval. */
  standaloneQuery?: string;
  filters?: RetrievalFilters;
  /** Overrides FINAL_CONTEXT_CHUNKS for this request. */
  limit?: number;
  conversationId?: string | null;
  messageId?: string | null;
  source?: 'CHAT' | 'DEBUG' | 'EVALUATION' | 'BENCHMARK';
  /** Persist a retrieval_logs row. Defaults to the configured setting. */
  log?: boolean;
}

export interface RetrievalTimings {
  embeddingMs: number;
  vectorMs: number;
  lexicalMs: number;
  identifierMs: number;
  fusionMs: number;
  rerankMs: number;
  expandMs: number;
  totalMs: number;
}

export interface RetrievalResult {
  query: string;
  standaloneQuery: string;
  filters: RetrievalFilters;
  /** Candidates chosen for the answer context, in context order. */
  selected: RetrievalCandidate[];
  /** All fused candidates before selection, for debugging. */
  fused: RetrievalCandidate[];
  vectorCandidates: RetrievalCandidate[];
  lexicalCandidates: RetrievalCandidate[];
  identifierCandidates: RetrievalCandidate[];
  /** Document codes recognised in the query and confirmed to exist. */
  detectedDocumentCodes: string[];
  contextTokens: number;
  timings: RetrievalTimings;
  retrievalLogId: string | null;
}

/** The assembled prompt context plus the citations that describe it. */
export interface BuiltContext {
  text: string;
  citations: Citation[];
  tokenCount: number;
  /** Candidates actually included, aligned with citation indices. */
  included: RetrievalCandidate[];
}
