/**
 * HTTP surface: validation, authentication, streaming and file access.
 *
 * Uses Fastify's `inject`, so the real routing, hooks, security plugins and
 * error handling all run without binding a port.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createContainer } from '../../src/container.js';
import { closeTestPool, getTestPool, testConfig, truncateAll } from '../helpers/database.js';
import { createHarness, generateFixtureCorpus, type TestHarness } from '../helpers/fixtures.js';
import { StubChatModel } from '../helpers/stub-chat-model.js';

const ADMIN_KEY = 'dev-admin-key';

describe('HTTP API', () => {
  let pool: pg.Pool;
  let harness: TestHarness;
  let app: FastifyInstance;
  let chatModel: StubChatModel;
  let documentId: string;
  let revisionId: string;

  beforeAll(async () => {
    pool = await getTestPool();
    await truncateAll();

    harness = await createHarness(testConfig(), pool);
    await generateFixtureCorpus(harness, { count: 5 });
    await harness.ingestion.run({ trigger: 'TEST' });

    chatModel = new StubChatModel();

    const container = createContainer({
      config: harness.config,
      pool,
      storage: harness.storage,
      embeddings: harness.embeddings,
      chatModel,
      withScheduler: false,
    });

    app = await buildApp({ container });
    await app.ready();

    const document = await harness.documents.findByCode('FIN-POL-001');
    documentId = document?.id as string;
    const revisions = await harness.revisions.findByDocumentId(documentId);
    revisionId = revisions[0]?.id as string;
  });

  afterAll(async () => {
    await app.close();
    await harness.cleanup();
    await closeTestPool();
  });

  describe('health', () => {
    it('reports liveness without touching the database', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok' });
    });

    it('reports readiness including dependency state', async () => {
      const response = await app.inject({ method: 'GET', url: '/ready' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ready', database: 'reachable' });
    });
  });

  describe('documents', () => {
    it('lists documents with pagination metadata', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/documents?pageSize=2' });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(body.items).toHaveLength(2);
      expect(body.total).toBe(5);
      expect(body.totalPages).toBe(3);
    });

    it('filters by department', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/documents?department=Finance' });
      const body = response.json();
      expect(body.items.every((item: { department: string }) => item.department === 'Finance')).toBe(true);
    });

    it('rejects an unknown document type', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/documents?documentType=NONSENSE' });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a page size beyond the cap', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/documents?pageSize=100000' });
      expect(response.statusCode).toBe(400);
    });

    it('returns a document with its revisions', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/documents/${documentId}` });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(body.documentCode).toBe('FIN-POL-001');
      expect(body.revisions.length).toBeGreaterThan(0);
      expect(body.revisions[0]).toHaveProperty('processingStatus');
    });

    it('supports lookup by document code', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/documents/by-code/FIN-POL-001' });
      expect(response.statusCode).toBe(200);
      expect(response.json().documentCode).toBe('FIN-POL-001');
    });

    it('rejects a non-UUID id rather than querying with it', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/documents/not-a-uuid' });
      expect(response.statusCode).toBe(400);
    });

    it('returns 404 for a well-formed but unknown id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/documents/00000000-0000-4000-8000-000000000000',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
    });

    it('returns extracted revision content', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/revisions/${revisionId}/content` });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(body.pages.length).toBeGreaterThan(0);
      expect(body.pages[0].text.length).toBeGreaterThan(0);
    });

    it('returns the chunks of a revision', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/revisions/${revisionId}/chunks` });
      const chunks = response.json();

      expect(response.statusCode).toBe(200);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]).toHaveProperty('sectionTitle');
      // The vector itself is never exposed - only whether one exists.
      expect(chunks[0]).not.toHaveProperty('embedding');
    });
  });

  describe('file download', () => {
    it('serves the original file as an attachment', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/revisions/${revisionId}/file` });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('application/pdf');
      expect(response.headers['content-disposition']).toMatch(/^attachment; filename="/);
      // Never let a browser sniff a document into active content.
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('accepts only a revision id, never a path', async () => {
      // There is no route that takes a path, so traversal has nothing to
      // target. These are the shapes an attacker would try.
      for (const attempt of [
        '/api/revisions/..%2F..%2Fetc%2Fpasswd/file',
        '/api/revisions/%2Fetc%2Fpasswd/file',
        '/api/revisions/../../../etc/passwd/file',
      ]) {
        const response = await app.inject({ method: 'GET', url: attempt });
        expect([400, 404]).toContain(response.statusCode);
      }
    });
  });

  describe('admin authentication', () => {
    it('rejects an admin request with no key', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/stats' });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHORIZED');
    });

    it('rejects an incorrect key', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/stats',
        headers: { 'x-admin-key': 'wrong-key-entirely' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('accepts the configured key', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/stats',
        headers: { 'x-admin-key': ADMIN_KEY },
      });

      expect(response.statusCode).toBe(200);
      const stats = response.json();
      expect(stats.documents.total).toBe(5);
      expect(stats.revisions.current).toBe(5);
      expect(stats.chunks.total).toBeGreaterThan(0);
      expect(stats.embeddings.provider).toBe('mock');
    });

    it('guards every admin route, not just stats', async () => {
      for (const url of ['/api/admin/ingestion/jobs', '/api/admin/scheduler']) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(401);
      }
    });

    it('guards the debug routes too', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/debug/retrieval',
        payload: { query: 'anything' },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('admin operations', () => {
    it('creates a revision and leaves the previous one current', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/documents/${documentId}/create-revision`,
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: {},
      });

      expect(response.statusCode).toBe(201);
      const created = response.json();
      expect(created.revisionNumber).toBe(2);
      expect(created.mutation).toHaveProperty('type');

      const revisions = await harness.revisions.findByDocumentId(documentId);
      expect(revisions.find((revision) => revision.is_current)?.revision_number).toBe(1);
    });

    it('runs ingestion and activates the new revision', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/ingestion/run',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().failed).toBe(0);

      const revisions = await harness.revisions.findByDocumentId(documentId);
      expect(revisions.find((revision) => revision.is_current)?.revision_number).toBe(2);
    });

    it('lists ingestion jobs with their items', async () => {
      const list = await app.inject({
        method: 'GET',
        url: '/api/admin/ingestion/jobs',
        headers: { 'x-admin-key': ADMIN_KEY },
      });

      const jobs = list.json();
      expect(jobs.length).toBeGreaterThan(0);

      const detail = await app.inject({
        method: 'GET',
        url: `/api/admin/ingestion/jobs/${jobs[0].id}`,
        headers: { 'x-admin-key': ADMIN_KEY },
      });

      expect(detail.statusCode).toBe(200);
      expect(Array.isArray(detail.json().items)).toBe(true);
    });

    it('rejects an unknown field in an admin payload', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/ingestion/run',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { limit: 5, dropTables: true },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('conversations and chat', () => {
    it('creates a conversation', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toHaveProperty('id');
    });

    it('rejects an empty chat message', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: '   ' } });
      expect(response.statusCode).toBe(400);
    });

    it('rejects an overlong chat message', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { message: 'x'.repeat(5000) },
      });
      expect(response.statusCode).toBe(400);
    });

    it('streams an answer as Server-Sent Events with citations', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { message: 'What expenses require Finance Director approval?' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');

      const body = response.payload;
      expect(body).toContain('event: metadata');
      expect(body).toContain('event: token');
      expect(body).toContain('event: citation');
      expect(body).toContain('event: complete');

      const complete = body
        .split('\n\n')
        .find((frame) => frame.startsWith('event: complete'))
        ?.split('data: ')[1];

      const parsed = JSON.parse(complete as string);
      expect(parsed.citations.length).toBeGreaterThan(0);
      expect(parsed.citations[0].documentCode).toBeTruthy();
      expect(parsed.citations[0]).toHaveProperty('chunkId');
      expect(parsed.answerStatus).toBe('ANSWERED');
    });

    it('persists the turn, including citations', async () => {
      const conversations = await app.inject({ method: 'GET', url: '/api/conversations' });
      const first = conversations.json()[0];

      expect(first.messageCount).toBeGreaterThanOrEqual(2);
      expect(first.title).toBeTruthy();

      const messages = await app.inject({ method: 'GET', url: `/api/conversations/${first.id}/messages` });
      const body = messages.json();

      const assistant = body.find((message: { role: string }) => message.role === 'assistant');
      expect(assistant.content.length).toBeGreaterThan(0);
      expect(assistant.citations.length).toBeGreaterThan(0);
    });

    it('reports a model failure as an SSE error event, not a broken stream', async () => {
      chatModel.setOptions({ failNext: true });

      const response = await app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: { message: 'What is the backup retention period?' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.payload).toContain('event: error');

      chatModel.setOptions({});
    });

    it('returns a complete answer from the non-streaming endpoint', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/chat/complete',
        payload: { message: 'How long are production backups retained?' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.message.content.length).toBeGreaterThan(0);
      expect(body.conversationId).toBeTruthy();
    });
  });

  describe('debug endpoints', () => {
    it('returns every retrieval stage', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/debug/retrieval',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { query: 'What expenses require Finance Director approval?' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.vectorCandidates.length).toBeGreaterThan(0);
      expect(body.fused.length).toBeGreaterThan(0);
      expect(body.selected.length).toBeGreaterThan(0);
      expect(body.selected[0]).toHaveProperty('rrfScore');
      expect(body.config.rrfK).toBe(60);
      expect(body.timings).toHaveProperty('vectorMs');
    });

    it('returns the exact prompt the model would receive', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/debug/prompt',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { query: 'What expenses require Finance Director approval?' },
      });

      const body = response.json();
      expect(body.systemPrompt).toContain('Never fabricate');
      expect(body.userPrompt).toContain('BEGIN DOCUMENT CONTEXT');
    });

    it('never exposes the API key in the config view', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/debug/config',
        headers: { 'x-admin-key': ADMIN_KEY },
      });

      const body = JSON.stringify(response.json());
      expect(body).not.toContain('sk-');
      expect(response.json().openai).toHaveProperty('apiKeyConfigured');
      expect(response.json().openai).not.toHaveProperty('apiKey');
    });
  });

  describe('security headers', () => {
    it('sets restrictive headers on API responses', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/documents' });
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    });

    it('returns a structured error body with a request id', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
      const body = response.json();

      expect(response.statusCode).toBe(404);
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.requestId).toBeTruthy();
    });
  });
});
