/**
 * Admin and debug endpoints.
 *
 * Split from the employee client so these never ship in the bundle an ordinary
 * user downloads. Only the lazily-loaded console imports this module, which
 * means the employee application does not even advertise that these routes
 * exist - a small thing, but the separation should be real in the build output
 * and not only in the routing table.
 *
 * Every call here carries the admin credential and returns 401 without it.
 */

import type {
  AdminStats,
  IngestionJobDetail,
  IngestionJobSummary,
  RetrievalDebugResponse,
  RetrievalFilters,
} from '@docs-rag/shared';
import { request, toQuery } from './client.js';

export interface IngestionRunResult {
  jobId: string | null;
  status: string;
  processed: number;
  skipped: number;
  failed: number;
  chunksCreated: number;
  durationMs: number;
  skippedReason?: string;
}

export interface CreatedRevision {
  documentCode: string;
  revisionNumber: number;
  previousRevisionNumber: number;
  changeSummary: string;
  mutation: { type: string; previousValue?: string; newValue?: string };
  corrupt: boolean;
}

export interface CorpusGenerationResult {
  documentsWritten: number;
  revisionsWritten: number;
  evaluationQuestions: number;
  durationMs: number;
}

export const adminApi = {
  stats: () => request<AdminStats>('/api/admin/stats', { admin: true }),

  schedulerStatus: () =>
    request<{ enabled: boolean; cron: string | null; nextRun: string | null }>('/api/admin/scheduler', {
      admin: true,
    }),

  listIngestionJobs: (limit = 15) =>
    request<IngestionJobSummary[]>(`/api/admin/ingestion/jobs${toQuery({ limit })}`, { admin: true }),

  getIngestionJob: (id: string) =>
    request<IngestionJobDetail>(`/api/admin/ingestion/jobs/${id}`, { admin: true }),

  runIngestion: (body: { limit?: number; skipDiscovery?: boolean } = {}) =>
    request<IngestionRunResult>('/api/admin/ingestion/run', { method: 'POST', body, admin: true }),

  createRevision: (documentId: string, body: { corrupt?: boolean; mutationType?: string } = {}) =>
    request<CreatedRevision>(`/api/admin/documents/${documentId}/create-revision`, {
      method: 'POST',
      body,
      admin: true,
    }),

  reprocessRevision: (revisionId: string) =>
    request<{ processed: number; failed: number }>(`/api/admin/revisions/${revisionId}/reprocess`, {
      method: 'POST',
      body: {},
      admin: true,
    }),

  generateCorpus: (body: { profile: string; count?: number; seed?: number; reset?: boolean }) =>
    request<CorpusGenerationResult>('/api/admin/corpus/generate', { method: 'POST', body, admin: true }),

  // --- Debug ---------------------------------------------------------------

  debugRetrieval: (body: { query: string; filters?: RetrievalFilters }) =>
    request<RetrievalDebugResponse>('/api/debug/retrieval', { method: 'POST', body, admin: true }),
};
