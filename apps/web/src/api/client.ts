/**
 * Typed API client.
 *
 * One place that knows about transport concerns: base URL, the admin header,
 * and turning an error body into something the UI can render. Every response
 * type comes from @docs-rag/shared, so a contract change in the API surfaces as
 * a compile error here rather than as an undefined at runtime.
 *
 * There is no OpenAI key in this file, or anywhere else in the browser bundle:
 * all model calls happen server-side.
 */

import type {
  AdminStats,
  ApiErrorBody,
  ChatMessage,
  ChunkDetail,
  ConversationSummary,
  DocumentDetail,
  DocumentSummary,
  IngestionJobDetail,
  IngestionJobSummary,
  Paginated,
  RetrievalDebugResponse,
  RetrievalFilters,
  RevisionContent,
  RevisionSummary,
} from '@docs-rag/shared';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The admin secret is held in memory and mirrored to sessionStorage so a page
 * reload does not lose it. This is a development convenience for a demo tool -
 * a real deployment replaces it with a session cookie from an identity
 * provider, and nothing else in the client has to change.
 */
const ADMIN_KEY_STORAGE = 'docs-rag.adminKey';

let adminKey = readStoredAdminKey();

function readStoredAdminKey(): string {
  try {
    return sessionStorage.getItem(ADMIN_KEY_STORAGE) ?? 'dev-admin-key';
  } catch {
    return 'dev-admin-key';
  }
}

export function getAdminKey(): string {
  return adminKey;
}

export function setAdminKey(value: string): void {
  adminKey = value;
  try {
    sessionStorage.setItem(ADMIN_KEY_STORAGE, value);
  } catch {
    // Private browsing: keeping it in memory for this tab is good enough.
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  admin?: boolean;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.admin) headers['x-admin-key'] = adminKey;

  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed: unknown = text.length > 0 ? JSON.parse(text) : null;

  if (!response.ok) {
    const body = parsed as ApiErrorBody | null;
    throw new ApiError(
      body?.error?.code ?? 'UNKNOWN',
      body?.error?.message ?? `Request failed with status ${response.status}`,
      response.status,
      body?.error?.details,
    );
  }

  return parsed as T;
}

type QueryValue = string | number | boolean | null | undefined;

function toQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query.length > 0 ? `?${query}` : '';
}

// --- Documents -------------------------------------------------------------

export interface DocumentListParams extends Record<string, QueryValue> {
  page?: number;
  pageSize?: number;
  search?: string;
  department?: string;
  documentType?: string;
  processingStatus?: string;
  isActive?: boolean;
}

export const api = {
  /** Service readiness, including whether leave tools are available. */
  readiness: () =>
    request<{
      status: string;
      hcm?: { configured: boolean; reachable: boolean; leaveToolsEnabled: boolean };
    }>('/ready'),

  listDocuments: (params: DocumentListParams = {}) =>
    request<Paginated<DocumentSummary>>(`/api/documents${toQuery(params)}`),

  documentFacets: () =>
    request<{ departments: string[]; documentTypes: string[]; categories: string[] }>(
      '/api/documents/facets',
    ),

  getDocument: (id: string) => request<DocumentDetail>(`/api/documents/${id}`),

  getDocumentByCode: (code: string) => request<DocumentDetail>(`/api/documents/by-code/${code}`),

  getRevision: (id: string) => request<RevisionSummary>(`/api/revisions/${id}`),

  getRevisionContent: (id: string, maxPages = 20) =>
    request<RevisionContent>(`/api/revisions/${id}/content${toQuery({ maxPages })}`),

  getRevisionChunks: (id: string) => request<ChunkDetail[]>(`/api/revisions/${id}/chunks`),

  getChunk: (id: string) => request<ChunkDetail>(`/api/chunks/${id}`),

  /** Download URL for the original file. The server resolves the storage key. */
  revisionFileUrl: (id: string) => `/api/revisions/${id}/file`,

  // --- Conversations -------------------------------------------------------

  listConversations: () => request<ConversationSummary[]>('/api/conversations'),

  createConversation: () => request<ConversationSummary>('/api/conversations', { method: 'POST', body: {} }),

  getMessages: (conversationId: string) =>
    request<ChatMessage[]>(`/api/conversations/${conversationId}/messages`),

  deleteConversation: (id: string) =>
    request<void>(`/api/conversations/${id}`, { method: 'DELETE' }),

  // --- Admin ---------------------------------------------------------------

  adminStats: () => request<AdminStats>('/api/admin/stats', { admin: true }),

  schedulerStatus: () =>
    request<{ enabled: boolean; cron: string | null; nextRun: string | null }>('/api/admin/scheduler', {
      admin: true,
    }),

  listIngestionJobs: (limit = 15) =>
    request<IngestionJobSummary[]>(`/api/admin/ingestion/jobs${toQuery({ limit })}`, { admin: true }),

  getIngestionJob: (id: string) =>
    request<IngestionJobDetail>(`/api/admin/ingestion/jobs/${id}`, { admin: true }),

  runIngestion: (body: { limit?: number; skipDiscovery?: boolean } = {}) =>
    request<{
      jobId: string | null;
      status: string;
      processed: number;
      skipped: number;
      failed: number;
      chunksCreated: number;
      durationMs: number;
      skippedReason?: string;
    }>('/api/admin/ingestion/run', { method: 'POST', body, admin: true }),

  createRevision: (documentId: string, body: { corrupt?: boolean; mutationType?: string } = {}) =>
    request<{
      documentCode: string;
      revisionNumber: number;
      previousRevisionNumber: number;
      changeSummary: string;
      mutation: { type: string; previousValue?: string; newValue?: string };
      corrupt: boolean;
    }>(`/api/admin/documents/${documentId}/create-revision`, { method: 'POST', body, admin: true }),

  reprocessRevision: (revisionId: string) =>
    request<{ processed: number; failed: number }>(`/api/admin/revisions/${revisionId}/reprocess`, {
      method: 'POST',
      body: {},
      admin: true,
    }),

  generateCorpus: (body: { profile: string; count?: number; seed?: number; reset?: boolean }) =>
    request<{
      documentsWritten: number;
      revisionsWritten: number;
      evaluationQuestions: number;
      durationMs: number;
    }>('/api/admin/corpus/generate', { method: 'POST', body, admin: true }),

  // --- Debug ---------------------------------------------------------------

  debugRetrieval: (body: { query: string; filters?: RetrievalFilters }) =>
    request<RetrievalDebugResponse>('/api/debug/retrieval', { method: 'POST', body, admin: true }),
};
