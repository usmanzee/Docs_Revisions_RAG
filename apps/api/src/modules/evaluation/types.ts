/** Evaluation contracts. */

import type { EvaluationQuestionType, RetrievalEvaluationMetrics } from '@docs-rag/shared';

export interface GoldQuestion {
  id: string;
  question: string;
  questionType: EvaluationQuestionType;
  expectedDocumentCode: string | null;
  expectedRevision: number | null;
  expectedSection: string | null;
  referenceAnswer: string | null;
  expectedFacts: string[];
  isNoAnswer: boolean;
  supersededAnswer?: string;
}

export interface GoldDataset {
  generatedAt: string;
  profile: string;
  questionCount: number;
  noAnswerCount: number;
  questions: GoldQuestion[];
}

export interface RetrievalQuestionResult {
  id: string;
  question: string;
  questionType: EvaluationQuestionType;
  expectedDocumentCode: string | null;
  isNoAnswer: boolean;
  /** 1-based rank of the first correct chunk, or null if never retrieved. */
  hitRank: number | null;
  reciprocalRank: number;
  recallAt1: boolean;
  recallAt3: boolean;
  recallAt5: boolean;
  /** The expected section was among the retrieved chunks. */
  sectionHit: boolean;
  /** The retrieved chunk came from the expected (current) revision. */
  revisionCorrect: boolean | null;
  /** For no-answer questions: retrieval surfaced nothing convincing. */
  refusedCorrectly: boolean | null;
  retrievedTop: { documentCode: string; revision: number; section: string | null; score: number }[];
  latencyMs: number;
}

export interface RetrievalEvaluationReport {
  metrics: RetrievalEvaluationMetrics;
  results: RetrievalQuestionResult[];
  byQuestionType: Record<string, import('./metrics.js').QuestionTypeSummary>;
  embeddingProvider: string;
  embeddingModel: string;
  semantic: boolean;
  corpusProfile: string;
  runId: string | null;
}

export interface RagQuestionResult {
  id: string;
  question: string;
  questionType: EvaluationQuestionType;
  isNoAnswer: boolean;
  answer: string;
  answerStatus: string;
  factsFound: string[];
  factsMissing: string[];
  citedExpectedDocument: boolean;
  citedExpectedRevision: boolean;
  citedSupersededRevision: boolean;
  refusedCorrectly: boolean | null;
  /** Answer still contains a value that a later revision replaced. */
  leakedSupersededAnswer: boolean;
  passed: boolean;
  latencyMs: number;
}

export interface RagEvaluationReport {
  questionCount: number;
  answered: number;
  refused: number;
  factRecall: number;
  citationDocumentAccuracy: number;
  citationRevisionAccuracy: number;
  supersededCitationRate: number;
  noAnswerAccuracy: number;
  passRate: number;
  results: RagQuestionResult[];
  chatModel: string;
  embeddingModel: string;
  runId: string | null;
}
