/**
 * Chunking contracts.
 */

import type { ChunkType, ExtractionMethod } from '@docs-rag/shared';

export interface ChunkDocumentContext {
  documentCode: string;
  documentTitle: string;
  documentType: string;
  department: string;
  category: string | null;
  revisionNumber: number;
  effectiveDate: string | null;
}

export interface BuiltChunk {
  /** Position within the revision; also the join key for parent references. */
  chunkIndex: number;
  chunkType: ChunkType;
  /** chunkIndex of the parent section chunk, resolved to a UUID on insert. */
  parentChunkIndex: number | null;
  pageStart: number | null;
  pageEnd: number | null;
  sectionTitle: string | null;
  subsectionTitle: string | null;
  /** Breadcrumb, e.g. "Approval Requirements > International Travel". */
  headingPath: string | null;
  /** Body text, as stored and as shown in citations. */
  content: string;
  /**
   * What is actually embedded: the body prefixed with its document and heading
   * context. A chunk that says "must be approved by the Finance Director" is
   * far more findable when its vector also knows it comes from the approval
   * section of the Business Expense Policy.
   */
  embeddingText: string;
  tokenCount: number;
  extractionMethod: ExtractionMethod;
  metadata: Record<string, unknown>;
}

export interface ChunkingResult {
  chunks: BuiltChunk[];
  /** Chunks intended for retrieval (excludes parents). */
  childCount: number;
  parentCount: number;
  totalTokens: number;
}

export interface DocumentChunker {
  readonly name: string;
  chunk(
    document: import('../parsing/types.js').ParsedDocument,
    context: ChunkDocumentContext,
  ): Promise<ChunkingResult>;
}
