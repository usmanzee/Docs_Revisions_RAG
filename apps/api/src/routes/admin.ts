/**
 * Admin endpoints.
 *
 * Every route here is behind the admin guard. The guard is registered as an
 * onRequest hook on an encapsulated plugin scope, so a route added to this file
 * later is protected by default rather than by remembering to add a hook.
 */

import type { AppInstance } from '../types/fastify.js';
import { z } from 'zod';
import type { AppContainer } from '../container.js';
import { createAdminGuard } from '../middleware/admin-auth.js';
import {
  createRevisionSchema,
  generateCorpusSchema,
  idParamSchema,
  ingestionJobListQuerySchema,
  parse,
  runIngestionSchema,
} from './schemas.js';

const documentIdParam = z.object({ id: z.string().uuid() });

export async function registerAdminRoutes(app: AppInstance, container: AppContainer): Promise<void> {
  await app.register(async (admin) => {
    admin.addHook('onRequest', createAdminGuard(container.config));

    admin.get('/stats', async () => container.admin.stats());

    admin.get('/scheduler', async () => container.admin.schedulerStatus());

    admin.post('/ingestion/run', async (request) => {
      const body = parse(runIngestionSchema, request.body ?? {});
      return container.admin.runIngestion({
        ...(body.limit !== undefined ? { limit: body.limit } : {}),
        skipDiscovery: body.skipDiscovery,
      });
    });

    admin.get('/ingestion/jobs', async (request) => {
      const query = parse(ingestionJobListQuerySchema, request.query);
      return container.admin.listJobs(query.limit);
    });

    admin.get('/ingestion/jobs/:id', async (request) => {
      const { id } = parse(idParamSchema, request.params);
      return container.admin.jobDetail(id);
    });

    admin.post('/revisions/:id/reprocess', async (request) => {
      const { id } = parse(idParamSchema, request.params);
      return container.admin.reprocessRevision(id);
    });

    admin.post('/documents/:id/create-revision', async (request, reply) => {
      const { id } = parse(documentIdParam, request.params);
      const body = parse(createRevisionSchema, request.body ?? {});
      const created = await container.admin.createRevision(id, {
        ...(body.mutationType ? { mutationType: body.mutationType } : {}),
        corrupt: body.corrupt,
      });
      return reply.status(201).send(created);
    });

    admin.post('/corpus/generate', async (request) => {
      const body = parse(generateCorpusSchema, request.body ?? {});
      return container.admin.generateCorpus({
        profile: body.profile,
        ...(body.count !== undefined ? { count: body.count } : {}),
        ...(body.seed !== undefined ? { seed: body.seed } : {}),
        reset: body.reset,
      });
    });
  }, { prefix: '/admin' });
}
