/**
 * Synthetic enterprise corpus model.
 *
 * The corpus is not decoration. It exists so that retrieval and answer quality
 * can be measured against facts whose correct value is known by construction:
 * every generated document carries a set of typed facts, every fact appears in
 * exactly one section, and the evaluation generator turns those facts into
 * questions with objectively checkable answers.
 */

import type { CorpusProfile, DocumentType } from '@docs-rag/shared';

/** A single verifiable statement planted in a document. */
export interface DocumentFact {
  /** Stable within a document, e.g. "financeDirectorThreshold". */
  id: string;
  /** Human label used in tables and questions. */
  label: string;
  /** Rendered value as it appears in the document, e.g. "$25,000", "45 days". */
  value: string;
  /** Numeric component when there is one - lets revisions mutate it. */
  numericValue?: number;
  unit?: string;
  /** Section this fact is stated in; becomes `expectedSection` in evaluation. */
  sectionKey: string;
}

export interface SyntheticTable {
  caption?: string;
  header: string[];
  rows: string[][];
}

export interface SyntheticSection {
  /** Stable key used to link facts and questions to a section. */
  key: string;
  title: string;
  paragraphs: string[];
  bullets?: string[];
  /** Numbered procedure steps - kept whole by the chunker where possible. */
  steps?: string[];
  table?: SyntheticTable;
  subsections?: SyntheticSection[];
}

/** A workflow diagram rendered as an image, with its ground-truth text. */
export interface SyntheticWorkflow {
  title: string;
  nodes: string[];
  /**
   * Text form of the diagram, stored in fixture metadata so OCR/vision
   * extraction can later be scored against a known answer.
   */
  expectedText: string;
}

export type SyntheticFormat = 'pdf' | 'pdf-scanned' | 'pdf-mixed' | 'docx' | 'txt' | 'md';

export interface SyntheticDocumentContent {
  documentCode: string;
  title: string;
  department: string;
  documentType: DocumentType;
  category: string;
  owner: string;
  effectiveDate: string;
  revisionNumber: number;
  reviewCycle: string;
  purpose: string;
  scope: string;
  sections: SyntheticSection[];
  facts: DocumentFact[];
  workflow?: SyntheticWorkflow;
  revisionHistory: { revision: number; date: string; summary: string }[];
}

export interface SyntheticRevisionPlan {
  revisionNumber: number;
  effectiveDate: string;
  changeSummary: string;
  /** Mutation applied relative to the previous revision, if any. */
  mutation?: RevisionMutation;
  /** Written as an unreadable file to exercise failure handling. */
  corrupt?: boolean;
}

export interface SyntheticDocumentPlan {
  documentCode: string;
  blueprintKey: string;
  title: string;
  department: string;
  documentType: DocumentType;
  category: string;
  owner: string;
  description: string;
  tags: string[];
  format: SyntheticFormat;
  isActive: boolean;
  /** Near-duplicate of another document, to stress dedup and ranking. */
  duplicateOf?: string;
  includeWorkflow: boolean;
  includeTable: boolean;
  revisions: SyntheticRevisionPlan[];
  seed: number;
}

/** How a new revision differs from its predecessor. */
export type RevisionMutationType =
  | 'NUMERIC_THRESHOLD'
  | 'EFFECTIVE_DATE'
  | 'RESPONSIBILITY'
  | 'PROCESS_STEP_ADDED'
  | 'PROCESS_STEP_REMOVED'
  | 'PARAGRAPH_REPLACED'
  | 'ORACLE_RECOMMENDATION'
  | 'RETENTION_DURATION'
  | 'APPROVAL_ROLE';

export interface RevisionMutation {
  type: RevisionMutationType;
  /** Fact id affected, when the mutation targets a fact. */
  factId?: string;
  previousValue?: string;
  newValue?: string;
  description: string;
}

export interface GeneratedRevision {
  revisionNumber: number;
  storageKey: string;
  fileName: string;
  mimeType: string;
  fileHash: string;
  fileSizeBytes: number;
  effectiveDate: string;
  changeSummary: string;
  content: SyntheticDocumentContent;
  corrupt: boolean;
  mutation?: RevisionMutation;
}

export interface GeneratedDocument {
  plan: SyntheticDocumentPlan;
  revisions: GeneratedRevision[];
}

export interface CorpusGenerationOptions {
  profile: CorpusProfile;
  count: number;
  seed: number;
  scannedRatio: number;
  workflowRatio: number;
  multiRevisionRatio: number;
  corruptRatio: number;
  inactiveRatio: number;
  duplicateRatio: number;
  docxRatio: number;
  textRatio: number;
  tableRatio: number;
  /** Remove existing documents/storage before generating. */
  reset: boolean;
  /** Write data/evaluation/questions.json (quality profile only by default). */
  writeEvaluation: boolean;
}

export interface CorpusGenerationResult {
  profile: CorpusProfile;
  seed: number;
  documentsPlanned: number;
  documentsWritten: number;
  revisionsWritten: number;
  filesWritten: number;
  bytesWritten: number;
  scannedDocuments: number;
  workflowDocuments: number;
  corruptRevisions: number;
  inactiveDocuments: number;
  duplicateDocuments: number;
  formatBreakdown: Record<string, number>;
  evaluationQuestions: number;
  evaluationPath: string | null;
  durationMs: number;
}
