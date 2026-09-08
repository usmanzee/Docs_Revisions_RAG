/** Document, revision and chunk browsing endpoints. */

import type { AppInstance } from '../types/fastify.js';
import { z } from 'zod';
import type { AppContainer } from '../container.js';
import {
  documentCodeSchema,
  documentListQuerySchema,
  idParamSchema,
  parse,
  revisionContentQuerySchema,
} from './schemas.js';

const codeParamSchema = z.object({ code: documentCodeSchema });

export async function registerDocumentRoutes(app: AppInstance, container: AppContainer): Promise<void> {
  app.get('/documents', async (request) => {
    const query = parse(documentListQuerySchema, request.query);
    return container.documents.list({
      page: query.page,
      pageSize: query.pageSize,
      search: query.search ?? null,
      department: query.department ?? null,
      documentType: query.documentType ?? null,
      category: query.category ?? null,
      isActive: query.isActive ?? null,
      processingStatus: query.processingStatus ?? null,
      sort: query.sort ?? null,
    });
  });

  /** Facet values for the browser's filter controls. */
  app.get('/documents/facets', async () => container.documents.facets());

  /** Lookup by business code, so the UI can deep-link to /documents/FIN-POL-001. */
  app.get('/documents/by-code/:code', async (request) => {
    const { code } = parse(codeParamSchema, request.params);
    return container.documents.detailByCode(code);
  });

  app.get('/documents/:id', async (request) => {
    const { id } = parse(idParamSchema, request.params);
    return container.documents.detail(id);
  });

  app.get('/documents/:id/revisions', async (request) => {
    const { id } = parse(idParamSchema, request.params);
    return container.documents.revisions(id);
  });

  app.get('/revisions/:id', async (request) => {
    const { id } = parse(idParamSchema, request.params);
    return container.documents.revision(id);
  });

  app.get('/revisions/:id/content', async (request) => {
    const { id } = parse(idParamSchema, request.params);
    const query = parse(revisionContentQuerySchema, request.query);
    return container.documents.revisionContent(id, query.maxPages);
  });

  app.get('/revisions/:id/chunks', async (request) => {
    const { id } = parse(idParamSchema, request.params);
    return container.documents.chunksForRevision(id);
  });

  /**
   * Original file download.
   *
   * The client names a revision by UUID; the server resolves the storage key.
   * `Content-Disposition: attachment` plus `X-Content-Type-Options: nosniff`
   * means a document can never be rendered as active content in the browser,
   * whatever its bytes claim to be.
   */
  app.get('/revisions/:id/file', async (request, reply) => {
    const { id } = parse(idParamSchema, request.params);
    const file = await container.documents.revisionFile(id);

    // Strip anything that could break out of the header value.
    const safeName = file.fileName.replace(/[^A-Za-z0-9._-]/g, '_');

    return reply
      .header('Content-Type', file.mimeType)
      .header('Content-Disposition', `attachment; filename="${safeName}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .send(file.stream);
  });

  app.get('/chunks/:id', async (request) => {
    const { id } = parse(idParamSchema, request.params);
    return container.documents.chunk(id);
  });
}
