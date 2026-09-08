/**
 * Wire contracts between the API and the web client.
 * Every field here is produced by the API; the client never invents identifiers.
 */

import type {
  AnswerStatus,
  ChunkType,
  DocumentType,
  ExtractionMethod,
  EvaluationQuestionType,
  IngestionItemOutcome,
  IngestionJobStatus,
  IngestionTrigger,
  MessageRole,
  ProcessingStatus,
  RevisionStatus,
} from './domain.js';

// --- Common ----------------------------------------------------------------

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

// --- Documents -------------------------------------------------------------

export interface DocumentSummary {
  id: string;
  documentCode: string;
  title: string;
  documentType: DocumentType;
  department: string;
  category: string | null;
  owner: string | null;
  description: string | null;
  isActive: boolean;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  revisionCount: number;
  currentRevisionNumber: number | null;
  currentRevisionId: string | null;
  currentEffectiveDate: string | null;
  chunkCount: number;
  pendingRevisionCount: number;
  failedRevisionCount: number;
}

export interface RevisionSummary {
  id: string;
  documentId: string;
  documentCode: string;
  documentTitle: string;
  revisionNumber: number;
  filePath: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number | null;
  effectiveDate: string | null;
  revisionDate: string;
  status: RevisionStatus;
  isCurrent: boolean;
  fileHash: string;
  contentHash: string | null;
  processingStatus: ProcessingStatus;
  processingError: string | null;
  processingAttempts: number;
  processedAt: string | null;
  pageCount: number | null;
  ocrPageCount: number;
  chunkCount: number;
  tokenCount: number;
  changeSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentDetail extends DocumentSummary {
  revisions: RevisionSummary[];
}

export interface RevisionContentPage {
  pageNumber: number;
  extractionMethod: ExtractionMethod;
  text: string;
}

export interface RevisionContent {
  revision: RevisionSummary;
  pages: RevisionContentPage[];
  chunkCount: number;
  truncated: boolean;
}

export interface ChunkDetail {
  id: string;
  documentId: string;
  documentRevisionId: string;
  documentCode: string;
  documentTitle: string;
  revisionNumber: number;
  chunkIndex: number;
  chunkType: ChunkType;
  parentChunkId: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  sectionTitle: string | null;
  subsectionTitle: string | null;
  headingPath: string | null;
  content: string;
  tokenCount: number;
  extractionMethod: ExtractionMethod;
  isCurrent: boolean;
  hasEmbedding: boolean;
  createdAt: string;
}

// --- Chat ------------------------------------------------------------------

export interface Citation {
  /** 1-based marker used inside the answer text, e.g. [2]. */
  index: number;
  chunkId: string;
  documentId: string;
  revisionId: string;
  documentCode: string;
  documentTitle: string;
  revision: number;
  page: number | null;
  section: string | null;
  subsection: string | null;
  effectiveDate: string | null;
  excerpt: string;
  extractionMethod: ExtractionMethod;
  score: number;
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  citations: Citation[];
  standaloneQuery: string | null;
  model: string | null;
  answerStatus: AnswerStatus | null;
  retrievalMs: number | null;
  llmMs: number | null;
  totalMs: number | null;
  createdAt: string;
}

export interface RetrievalFilters {
  department?: string | null;
  documentType?: DocumentType | null;
  category?: string | null;
  documentCode?: string | null;
  includeHistorical?: boolean;
}

export interface ChatRequestBody {
  conversationId?: string | null;
  message: string;
  filters?: RetrievalFilters;
}

/** Server-Sent Event payloads emitted by POST /api/chat. */
export type ChatStreamEvent =
  | { type: 'metadata'; conversationId: string; messageId: string; standaloneQuery: string; retrievedChunks: number }
  | { type: 'token'; text: string }
  | { type: 'citation'; citation: Citation }
  | { type: 'complete'; messageId: string; answerStatus: AnswerStatus; citations: Citation[]; timings: { retrievalMs: number; llmMs: number; totalMs: number } }
  | { type: 'error'; code: string; message: string };

// --- Retrieval debug -------------------------------------------------------

export interface RetrievalCandidateDebug {
  chunkId: string;
  documentCode: string;
  documentTitle: string;
  revision: number;
  section: string | null;
  page: number | null;
  rank: number;
  score: number;
  preview: string;
}

export interface FusedCandidateDebug extends RetrievalCandidateDebug {
  vectorRank: number | null;
  lexicalRank: number | null;
  rrfScore: number;
}

export interface RetrievalDebugResponse {
  query: string;
  standaloneQuery: string;
  filters: RetrievalFilters;
  vectorCandidates: RetrievalCandidateDebug[];
  lexicalCandidates: RetrievalCandidateDebug[];
  fused: FusedCandidateDebug[];
  selected: FusedCandidateDebug[];
  contextTokens: number;
  timings: {
    embeddingMs: number;
    vectorMs: number;
    lexicalMs: number;
    fusionMs: number;
    rerankMs: number;
    totalMs: number;
  };
  config: {
    vectorTopK: number;
    lexicalTopK: number;
    rrfK: number;
    finalContextChunks: number;
    reranker: string;
    embeddingProvider: string;
    embeddingModel: string;
  };
}

// --- Admin -----------------------------------------------------------------

export interface IngestionJobSummary {
  id: string;
  trigger: IngestionTrigger;
  status: IngestionJobStatus;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  documentsDiscovered: number;
  documentsProcessed: number;
  documentsSkipped: number;
  documentsFailed: number;
  chunksCreated: number;
  ocrPages: number;
  visionImages: number;
  embeddingBatches: number;
  embeddingProvider: string | null;
  embeddingModel: string | null;
  errorSummary: string | null;
}

export interface IngestionJobItemSummary {
  id: string;
  documentCode: string | null;
  revisionNumber: number | null;
  documentRevisionId: string | null;
  outcome: IngestionItemOutcome;
  skipReason: string | null;
  errorMessage: string | null;
  errorStage: string | null;
  chunksCreated: number;
  pages: number;
  ocrPages: number;
  durationMs: number | null;
}

export interface IngestionJobDetail extends IngestionJobSummary {
  items: IngestionJobItemSummary[];
}

export interface AdminStats {
  documents: {
    total: number;
    active: number;
    inactive: number;
  };
  revisions: {
    total: number;
    current: number;
    pending: number;
    processing: number;
    ready: number;
    failed: number;
    superseded: number;
  };
  chunks: {
    total: number;
    current: number;
    historical: number;
    withEmbedding: number;
    parents: number;
    ocrDerived: number;
  };
  storage: {
    driver: string;
    root: string;
    documentBytes: number | null;
  };
  database: {
    sizeBytes: number | null;
    chunkTableBytes: number | null;
    vectorIndexBytes: number | null;
  };
  embeddings: {
    provider: string;
    model: string;
    dimensions: number;
  };
  ingestion: {
    latestJob: IngestionJobSummary | null;
    scheduleCron: string | null;
    runningJobs: number;
  };
  conversations: {
    total: number;
    messages: number;
  };
}

// --- Evaluation ------------------------------------------------------------

export interface EvaluationQuestion {
  id: string;
  question: string;
  questionType: EvaluationQuestionType;
  expectedDocumentCode: string | null;
  expectedRevision: number | null;
  expectedSection: string | null;
  referenceAnswer: string | null;
  expectedFacts: string[];
  isNoAnswer: boolean;
}

export interface RetrievalEvaluationMetrics {
  questionCount: number;
  answerableCount: number;
  noAnswerCount: number;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  mrr: number;
  sectionAccuracy: number;
  currentRevisionAccuracy: number;
  noAnswerBehaviour: number;
  latencyMs: { p50: number; p95: number; p99: number; mean: number };
}
