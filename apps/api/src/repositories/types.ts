/**
 * Database row shapes.
 *
 * These mirror the migrations exactly (snake_case, nullability included) and are
 * the only place the rest of the codebase learns the physical schema. Mapping
 * to camelCase domain objects happens in the repositories, so a column rename
 * touches two files rather than forty.
 */

import type {
  ChunkType,
  DocumentType,
  ExtractionMethod,
  IngestionItemOutcome,
  IngestionJobStatus,
  IngestionTrigger,
  MessageRole,
  ProcessingStatus,
  RevisionStatus,
} from '@docs-rag/shared';

export interface DocumentRow {
  id: string;
  document_code: string;
  title: string;
  document_type: DocumentType;
  department: string;
  category: string | null;
  owner: string | null;
  description: string | null;
  is_active: boolean;
  security_classification: string;
  source_system: string;
  tags: string[];
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface DocumentRevisionRow {
  id: string;
  document_id: string;
  revision_number: number;
  file_path: string;
  file_name: string;
  storage_driver: string;
  mime_type: string;
  file_size_bytes: number | null;
  effective_date: Date | null;
  revision_date: Date;
  change_summary: string | null;
  status: RevisionStatus;
  is_current: boolean;
  file_hash: string;
  content_hash: string | null;
  source_modified_at: Date | null;
  processing_status: ProcessingStatus;
  processing_error: string | null;
  processing_attempts: number;
  processed_at: Date | null;
  claimed_at: Date | null;
  claimed_by: string | null;
  page_count: number | null;
  ocr_page_count: number;
  chunk_count: number;
  token_count: number;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface DocumentChunkRow {
  id: string;
  document_id: string;
  document_revision_id: string;
  chunk_index: number;
  chunk_type: ChunkType;
  parent_chunk_id: string | null;
  page_start: number | null;
  page_end: number | null;
  section_title: string | null;
  subsection_title: string | null;
  heading_path: string | null;
  content: string;
  content_hash: string;
  token_count: number;
  extraction_method: ExtractionMethod;
  document_code: string;
  revision_number: number;
  is_current: boolean;
  department: string | null;
  document_type: DocumentType | null;
  category: string | null;
  embedding_model: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface IngestionJobRow {
  id: string;
  trigger: IngestionTrigger;
  status: IngestionJobStatus;
  started_at: Date;
  completed_at: Date | null;
  duration_ms: number | null;
  documents_discovered: number;
  documents_processed: number;
  documents_skipped: number;
  documents_failed: number;
  chunks_created: number;
  ocr_pages: number;
  vision_images: number;
  embedding_batches: number;
  embedding_tokens: number;
  embedding_provider: string | null;
  embedding_model: string | null;
  error_summary: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface IngestionJobItemRow {
  id: string;
  ingestion_job_id: string;
  document_id: string | null;
  document_revision_id: string | null;
  document_code: string | null;
  revision_number: number | null;
  outcome: IngestionItemOutcome;
  skip_reason: string | null;
  error_message: string | null;
  error_stage: string | null;
  chunks_created: number;
  pages: number;
  ocr_pages: number;
  duration_ms: number | null;
  parse_ms: number | null;
  ocr_ms: number | null;
  chunk_ms: number | null;
  embed_ms: number | null;
  persist_ms: number | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface ConversationRow {
  id: string;
  title: string | null;
  user_id: string | null;
  filters: Record<string, unknown>;
  summary: string | null;
  message_count: number;
  last_message_at: Date | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  citations: unknown;
  standalone_query: string | null;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  context_tokens: number | null;
  retrieval_ms: number | null;
  llm_ms: number | null;
  total_ms: number | null;
  answer_status: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface DocumentAssetRow {
  id: string;
  document_id: string;
  document_revision_id: string;
  asset_type: string;
  page_number: number | null;
  asset_index: number;
  file_path: string | null;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  extracted_text: string | null;
  description: string | null;
  expected_text: string | null;
  extraction_method: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

/** Date columns arrive as JS Dates; the API speaks ISO strings. */
export function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** `date` columns (no time component) should not gain a spurious timezone. */
export function toDateString(value: Date | null): string | null {
  if (!value) return null;
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
