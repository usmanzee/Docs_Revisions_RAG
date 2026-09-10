/**
 * HTTP implementation of the HCM client.
 *
 * Points at the mock today and at the real HCM tomorrow. The only things that
 * would change are the base URL, the credential, and - if the vendor's shapes
 * differ from the contract - the parsing in this file. Nothing above it moves.
 */

import type {
  ApplyLeaveRequest,
  Employee,
  HcmErrorBody,
  LeaveBalance,
  LeaveRequest,
  LeaveType,
  LeaveValidationResult,
  Paginated,
  ValidateLeaveRequest,
} from '@docs-rag/hcm-contract';
import { HCM_API_BASE_PATH } from '@docs-rag/hcm-contract';
import { retry, withTimeout } from '../../utils/async.js';
import { toErrorMessage } from '../../utils/errors.js';
import { childLogger } from '../../utils/logger.js';
import { HcmClientError, type HcmClient, type LeaveHistoryQuery } from './types.js';

export interface HttpHcmClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  retryLimit: number;
}

export class HttpHcmClient implements HcmClient {
  readonly name = 'http';

  private readonly logger = childLogger({ component: 'hcm-client' });

  constructor(private readonly options: HttpHcmClientOptions) {}

  isConfigured(): boolean {
    return this.options.baseUrl.trim().length > 0;
  }

  private url(path: string, query?: Record<string, string | number | undefined>): string {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    const url = new URL(`${base}${HCM_API_BASE_PATH}${path}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === '') continue;
      url.searchParams.set(key, String(value));
    }

    return url.toString();
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; query?: Record<string, string | number | undefined>; correlationId?: string } = {},
  ): Promise<T> {
    const url = this.url(path, options.query);

    const execute = async (): Promise<T> => {
      const response = await withTimeout(
        fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            'content-type': 'application/json',
            ...(options.correlationId ? { 'x-correlation-id': options.correlationId } : {}),
          },
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        }),
        this.options.timeoutMs,
        `HCM request timed out after ${this.options.timeoutMs}ms: ${method} ${path}`,
      );

      const text = await response.text();
      const parsed: unknown = text.length > 0 ? safeJson(text) : null;

      if (!response.ok) {
        const body = parsed as HcmErrorBody | null;
        const details = body?.error?.details as { violations?: never[] } | undefined;

        throw new HcmClientError(
          body?.error?.code ?? 'UPSTREAM_ERROR',
          body?.error?.message ?? `HCM returned ${response.status}`,
          response.status,
          body?.error?.details,
          details?.violations,
        );
      }

      return parsed as T;
    };

    return retry(execute, {
      retries: this.options.retryLimit,
      baseDelayMs: 300,
      // A refused leave request is a considered answer, not a transient fault.
      // Retrying it would be pointless and could double-submit a write.
      shouldRetry: (error) => error instanceof HcmClientError && error.isRetryable,
      onRetry: (error, attempt, delayMs) => {
        this.logger.warn(
          { attempt, delayMs, path, err: { message: toErrorMessage(error) } },
          'retrying HCM request',
        );
      },
    });
  }

  async ping(): Promise<boolean> {
    try {
      const base = this.options.baseUrl.replace(/\/+$/, '');
      const response = await withTimeout(fetch(`${base}/health`), 3000, 'HCM health check timed out');
      return response.ok;
    } catch {
      return false;
    }
  }

  async getEmployee(employeeId: string): Promise<Employee> {
    return this.request<Employee>('GET', `/employees/${encodeURIComponent(employeeId)}`);
  }

  async listLeaveTypes(): Promise<LeaveType[]> {
    const body = await this.request<{ items: LeaveType[] }>('GET', '/leave-types');
    return body.items;
  }

  async getLeaveBalances(employeeId: string): Promise<LeaveBalance[]> {
    const body = await this.request<{ items: LeaveBalance[] }>(
      'GET',
      `/employees/${encodeURIComponent(employeeId)}/leave-balances`,
    );
    return body.items;
  }

  async getLeaveBalance(employeeId: string, leaveTypeCode: string): Promise<LeaveBalance> {
    return this.request<LeaveBalance>(
      'GET',
      `/employees/${encodeURIComponent(employeeId)}/leave-balances/${encodeURIComponent(leaveTypeCode)}`,
    );
  }

  async getLeaveHistory(employeeId: string, query: LeaveHistoryQuery = {}): Promise<Paginated<LeaveRequest>> {
    return this.request<Paginated<LeaveRequest>>(
      'GET',
      `/employees/${encodeURIComponent(employeeId)}/leave-requests`,
      {
        query: {
          status: query.status,
          leaveTypeCode: query.leaveTypeCode,
          fromDate: query.fromDate,
          toDate: query.toDate,
          limit: query.limit ?? 20,
          offset: query.offset ?? 0,
        },
      },
    );
  }

  async getLeaveRequest(requestId: string): Promise<LeaveRequest> {
    return this.request<LeaveRequest>('GET', `/leave-requests/${encodeURIComponent(requestId)}`);
  }

  async validateLeaveRequest(input: ValidateLeaveRequest): Promise<LeaveValidationResult> {
    return this.request<LeaveValidationResult>('POST', '/leave-requests/validate', { body: input });
  }

  async applyForLeave(input: ApplyLeaveRequest): Promise<LeaveRequest> {
    return this.request<LeaveRequest>('POST', '/leave-requests', { body: input });
  }

  async withdrawLeaveRequest(requestId: string, reason?: string): Promise<LeaveRequest> {
    return this.request<LeaveRequest>(
      'POST',
      `/leave-requests/${encodeURIComponent(requestId)}/withdraw`,
      { body: { reason: reason ?? null } },
    );
  }

  async cancelLeaveRequest(requestId: string, reason?: string): Promise<LeaveRequest> {
    return this.request<LeaveRequest>('POST', `/leave-requests/${encodeURIComponent(requestId)}/cancel`, {
      body: { reason: reason ?? null },
    });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
