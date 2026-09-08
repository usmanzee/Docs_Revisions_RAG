/**
 * Domain vocabulary shared by the API and the web client.
 *
 * These are plain const objects plus derived union types rather than TS enums,
 * so they survive `isolatedModules`, are usable as runtime lists in the UI, and
 * stay structurally comparable with the CHECK constraints in the migrations.
 */

export const DOCUMENT_TYPES = [
  'POLICY',
  'PROCEDURE',
  'STANDARD',
  'GUIDELINE',
  'MANUAL',
  'TECHNICAL_GUIDE',
  'WORKFLOW',
  'FAQ',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DEPARTMENTS = [
  'Human Resources',
  'Finance',
  'Information Technology',
  'Information Security',
  'Procurement',
  'Operations',
  'Compliance',
  'Database Administration',
  'Enterprise Applications',
] as const;
export type Department = (typeof DEPARTMENTS)[number];

/** Ingestion state machine for a single revision. */
export const PROCESSING_STATUSES = [
  'PENDING',
  'PROCESSING',
  'READY',
  'FAILED',
  'SUPERSEDED',
] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

/** Business lifecycle of a revision, independent of ingestion progress. */
export const REVISION_STATUSES = ['DRAFT', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED'] as const;
export type RevisionStatus = (typeof REVISION_STATUSES)[number];

export const INGESTION_JOB_STATUSES = [
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'PARTIALLY_COMPLETED',
  'FAILED',
] as const;
export type IngestionJobStatus = (typeof INGESTION_JOB_STATUSES)[number];

export const INGESTION_TRIGGERS = ['SCHEDULED', 'MANUAL', 'API', 'TEST'] as const;
export type IngestionTrigger = (typeof INGESTION_TRIGGERS)[number];

export const INGESTION_ITEM_OUTCOMES = ['PROCESSED', 'SKIPPED', 'FAILED'] as const;
export type IngestionItemOutcome = (typeof INGESTION_ITEM_OUTCOMES)[number];

/** How the text behind a chunk was obtained. Surfaced in the UI for auditing. */
export const EXTRACTION_METHODS = ['NATIVE_TEXT', 'OCR', 'VISION', 'MIXED'] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

export const CHUNK_TYPES = ['CHILD', 'PARENT'] as const;
export type ChunkType = (typeof CHUNK_TYPES)[number];

export const CORPUS_PROFILES = ['smoke', 'quality', 'scale'] as const;
export type CorpusProfile = (typeof CORPUS_PROFILES)[number];

export const EVALUATION_QUESTION_TYPES = [
  'DIRECT',
  'PARAPHRASE',
  'TERMINOLOGY',
  'IDENTIFIER',
  'CROSS_SECTION',
  'NO_ANSWER',
  'REVISION_SENSITIVE',
] as const;
export type EvaluationQuestionType = (typeof EVALUATION_QUESTION_TYPES)[number];

export const ANSWER_STATUSES = ['ANSWERED', 'INSUFFICIENT_CONTEXT', 'ERROR'] as const;
export type AnswerStatus = (typeof ANSWER_STATUSES)[number];

export type MessageRole = 'user' | 'assistant' | 'system';
