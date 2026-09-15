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
  ApiErrorBody,
  ChatMessage,
  ChunkDetail,
  ConversationSummary,
  DocumentDetail,
  DocumentSummary,
  Paginated,
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

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
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

export function toQuery(params: Record<string, QueryValue>): string {
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
    request<void>(`/api/conversations/${id}`, { method: 'DELETE' })
};
