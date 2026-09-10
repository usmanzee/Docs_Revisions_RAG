/**
 * HCM client abstraction.
 *
 * The assistant depends on this interface, not on HTTP or on any particular
 * vendor. Swapping the mock for the real HCM means writing one implementation
 * (or, if the contract matches, only changing a base URL) - the tools, the
 * prompt and the chat pipeline stay exactly as they are.
 *
 * This mirrors the pattern already used for storage, embeddings, OCR and the
 * chat model: an interface, a real implementation, and a factory that picks one
 * from configuration.
 */

import type {
  ApplyLeaveRequest,
  Employee,
  LeaveBalance,
  LeaveRequest,
  LeaveType,
  LeaveValidationResult,
  Paginated,
  ValidateLeaveRequest,
} from '@docs-rag/hcm-contract';

export interface LeaveHistoryQuery {
  status?: string;
  leaveTypeCode?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
  offset?: number;
}

export interface HcmClient {
  readonly name: string;
  /** False when no HCM is configured; the assistant then omits leave tools. */
  isConfigured(): boolean;
  /** Cheap liveness probe, used by the readiness endpoint. */
  ping(): Promise<boolean>;

  getEmployee(employeeId: string): Promise<Employee>;
  listLeaveTypes(): Promise<LeaveType[]>;

  getLeaveBalances(employeeId: string): Promise<LeaveBalance[]>;
  getLeaveBalance(employeeId: string, leaveTypeCode: string): Promise<LeaveBalance>;

  getLeaveHistory(employeeId: string, query?: LeaveHistoryQuery): Promise<Paginated<LeaveRequest>>;
  getLeaveRequest(requestId: string): Promise<LeaveRequest>;

  validateLeaveRequest(input: ValidateLeaveRequest): Promise<LeaveValidationResult>;
  applyForLeave(input: ApplyLeaveRequest): Promise<LeaveRequest>;
  withdrawLeaveRequest(requestId: string, reason?: string): Promise<LeaveRequest>;
  cancelLeaveRequest(requestId: string, reason?: string): Promise<LeaveRequest>;
}

/**
 * A failure from the HCM system, carrying enough structure for the assistant to
 * explain it rather than say "something went wrong".
 *
 * `violations` is the important field: a refused leave request is not an error
 * in the system, it is an answer, and the assistant needs the specific reason to
 * tell the user what to do about it.
 */
export class HcmClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly details?: unknown,
    readonly violations?: { code: string; message: string; severity: string; details?: unknown }[],
  ) {
    super(message);
    this.name = 'HcmClientError';
  }

  /** True when the request was well-formed but the business rules refused it. */
  get isRuleViolation(): boolean {
    return this.statusCode === 422 || this.code === 'RULE_VIOLATION';
  }

  /** True when retrying might succeed. */
  get isRetryable(): boolean {
    return this.statusCode >= 500 || this.statusCode === 429 || this.statusCode === 408;
  }
}
