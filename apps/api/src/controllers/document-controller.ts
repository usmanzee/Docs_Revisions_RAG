/**
 * Document browsing.
 *
 * Note how the file-download handler works: the client supplies a revision
 * UUID, the server looks up that revision's storage key, and the storage driver
 * resolves it. At no point does a client-supplied string become a path, which
 * is what makes traversal structurally impossible rather than filtered out.
 */

import type {
  ChunkDetail,
  DocumentDetail,
  DocumentSummary,
  Paginated,
  RevisionContent,
  RevisionSummary,
} from '@docs-rag/shared';
import type { ChunkRepository } from '../repositories/chunk-repository.js';
import { mapChunkDetail } from '../repositories/chunk-repository.js';
import type { DocumentRepository, DocumentListFilters } from '../repositories/document-repository.js';
import type { RevisionRepository } from '../repositories/revision-repository.js';
import { mapRevisionSummary } from '../repositories/revision-repository.js';
import { NotFoundError } from '../utils/errors.js';
import { elementsToText } from '../modules/parsing/types.js';
import type { ParserRegistry } from '../modules/parsing/index.js';
import type { DocumentStorage } from '../modules/storage/index.js';

export interface DocumentControllerDependencies {
  documents: DocumentRepository;
  revisions: RevisionRepository;
  chunks: ChunkRepository;
  storage: DocumentStorage;
  parsers: ParserRegistry;
}

export class DocumentController {
  constructor(private readonly deps: DocumentControllerDependencies) {}

  async list(filters: DocumentListFilters): Promise<Paginated<DocumentSummary>> {
    return this.deps.documents.list(filters);
  }

  async facets(): Promise<{ departments: string[]; documentTypes: string[]; categories: string[] }> {
    return this.deps.documents.listFacets();
  }

  async detail(id: string): Promise<DocumentDetail> {
    const summary = await this.deps.documents.findSummaryById(id);
    if (!summary) throw new NotFoundError('Document', id);

    const revisions = await this.deps.revisions.findByDocumentId(id);
    return { ...summary, revisions: revisions.map(mapRevisionSummary) };
  }

  async detailByCode(documentCode: string): Promise<DocumentDetail> {
    const summary = await this.deps.documents.findSummaryByCode(documentCode);
    if (!summary) throw new NotFoundError('Document', documentCode);

    const revisions = await this.deps.revisions.findByDocumentId(summary.id);
    return { ...summary, revisions: revisions.map(mapRevisionSummary) };
  }

  async revisions(documentId: string): Promise<RevisionSummary[]> {
    const document = await this.deps.documents.findById(documentId);
    if (!document) throw new NotFoundError('Document', documentId);

    const revisions = await this.deps.revisions.findByDocumentId(documentId);
    return revisions.map(mapRevisionSummary);
  }

  async revision(id: string): Promise<RevisionSummary> {
    const revision = await this.deps.revisions.findById(id);
    if (!revision) throw new NotFoundError('Revision', id);
    return mapRevisionSummary(revision);
  }

  /**
   * Extracted text of a revision, for the source viewer.
   *
   * Parsed on demand rather than stored: chunks hold the retrieval-shaped view
   * of a document, which is not the same as a faithful page-by-page rendering,
   * and keeping a second full copy of every document in the database to serve an
   * occasional preview would be a poor trade.
   */
  async revisionContent(id: string, maxPages: number): Promise<RevisionContent> {
    const revision = await this.deps.revisions.findById(id);
    if (!revision) throw new NotFoundError('Revision', id);

    const chunkCount = await this.deps.chunks.countByRevision(id);

    const bytes = await this.deps.storage.read(revision.file_path);
    const parsed = await this.deps.parsers.parse(bytes, {
      key: revision.file_path,
      mimeType: revision.mime_type,
    });

    const pages = parsed.pages.slice(0, maxPages).map((page) => ({
      pageNumber: page.pageNumber,
      extractionMethod: page.extractionMethod,
      text: elementsToText(page.elements),
    }));

    return {
      revision: mapRevisionSummary(revision),
      pages,
      chunkCount,
      truncated: parsed.pages.length > maxPages,
    };
  }

  /** Original bytes, streamed. Content-Disposition is always `inline`-safe. */
  async revisionFile(id: string): Promise<{ stream: NodeJS.ReadableStream; mimeType: string; fileName: string }> {
    const revision = await this.deps.revisions.findById(id);
    if (!revision) throw new NotFoundError('Revision', id);

    const stream = await this.deps.storage.createReadStream(revision.file_path);
    return { stream, mimeType: revision.mime_type, fileName: revision.file_name };
  }

  async chunk(id: string): Promise<ChunkDetail> {
    const chunk = await this.deps.chunks.findById(id);
    if (!chunk) throw new NotFoundError('Chunk', id);
    return mapChunkDetail(chunk);
  }

  async chunksForRevision(revisionId: string): Promise<ChunkDetail[]> {
    const revision = await this.deps.revisions.findById(revisionId);
    if (!revision) throw new NotFoundError('Revision', revisionId);

    const chunks = await this.deps.chunks.findByRevision(revisionId);
    return chunks.map(mapChunkDetail);
  }
}
