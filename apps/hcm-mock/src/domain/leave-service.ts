/**
 * Leave operations.
 *
 * All state transitions live here rather than in the route handlers, so the
 * lifecycle rules are in one readable place and can be tested without HTTP.
 */

import { randomUUID } from 'node:crypto';
import type {
  ApplyLeaveRequest,
  DecideLeaveRequest,
  Employee,
  LeaveBalance,
  LeaveRequest,
  LeaveRequestQuery,
  LeaveTypeCode,
  LeaveValidationResult,
} from '@docs-rag/hcm-contract';
import { LEAVE_TYPE_CODES, WITHDRAWABLE_STATUSES } from '@docs-rag/hcm-contract';
import type { LeaveRules } from '../config.js';
import { calculateBalance } from './balances.js';
import { compareDates, today } from './calendar.js';
import { getLeaveType, LEAVE_TYPES } from './leave-types.js';
import { evaluateLeaveRequest } from './rules.js';
import type { HcmStore } from './store.js';

export class HcmError extends Error {
  constructor(
    readonly code:
      | 'VALIDATION_ERROR'
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'FORBIDDEN'
      | 'RULE_VIOLATION',
    message: string,
    readonly statusCode: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HcmError';
  }
}

export class LeaveService {
  constructor(
    private readonly store: HcmStore,
    private readonly rules: LeaveRules,
    private readonly onMutate: () => void = () => undefined,
  ) {}

  // --- lookups -----------------------------------------------------------

  requireEmployee(identifier: string): Employee {
    const employee = this.store.findEmployee(identifier);
    if (!employee) {
      throw new HcmError('NOT_FOUND', `No employee matches "${identifier}".`, 404);
    }
    return employee;
  }

  requireRequest(requestId: string): LeaveRequest {
    const request = this.store.getRequest(requestId);
    if (!request) {
      throw new HcmError('NOT_FOUND', `No leave request matches "${requestId}".`, 404);
    }
    return request;
  }

  listLeaveTypes() {
    return LEAVE_TYPES;
  }

  /**
   * Employee directory.
   *
   * A production HCM would scope this to what the caller is entitled to see.
   * The mock returns everyone, because the assistant needs a way to resolve
   * "who am I talking about" while identity is still being wired up.
   */
  listEmployees(): Employee[] {
    return this.store.listEmployees();
  }

  // --- balances ----------------------------------------------------------

  balancesFor(employee: Employee, asOfDate?: string): LeaveBalance[] {
    const requests = this.store.requestsForEmployee(employee.employeeId);

    return LEAVE_TYPE_CODES
      // Only report balances for types this employee can actually use;
      // listing an unavailable type with "0 days" invites a confused question.
      .filter((code) => {
        const type = getLeaveType(code);
        return type?.eligibleEmploymentTypes.includes(employee.employmentType) ?? false;
      })
      .map((code) =>
        calculateBalance({
          employee,
          leaveTypeCode: code,
          requests,
          rules: this.rules,
          ...(asOfDate ? { asOfDate } : {}),
        }),
      );
  }

  balanceFor(employee: Employee, leaveTypeCode: LeaveTypeCode, asOfDate?: string): LeaveBalance {
    const type = getLeaveType(leaveTypeCode);
    if (!type) throw new HcmError('NOT_FOUND', `Unknown leave type "${leaveTypeCode}".`, 404);

    return calculateBalance({
      employee,
      leaveTypeCode,
      requests: this.store.requestsForEmployee(employee.employeeId),
      rules: this.rules,
      ...(asOfDate ? { asOfDate } : {}),
    });
  }

  // --- history -----------------------------------------------------------

  history(employee: Employee, query: LeaveRequestQuery) {
    let requests = this.store.requestsForEmployee(employee.employeeId);

    if (query.status) requests = requests.filter((request) => request.status === query.status);
    if (query.leaveTypeCode) {
      requests = requests.filter((request) => request.leaveTypeCode === query.leaveTypeCode);
    }
    // Overlap semantics: anything that intersects the window, not only requests
    // fully inside it. Asking "what leave do I have in March" should return a
    // booking that starts in February and runs into March.
    if (query.fromDate) {
      requests = requests.filter((request) => compareDates(request.endDate, query.fromDate as string) >= 0);
    }
    if (query.toDate) {
      requests = requests.filter((request) => compareDates(request.startDate, query.toDate as string) <= 0);
    }

    requests.sort((a, b) => {
      switch (query.sort) {
        case 'startDate:asc':
          return compareDates(a.startDate, b.startDate);
        case 'submittedAt:desc':
          return (b.submittedAt ?? '').localeCompare(a.submittedAt ?? '');
        default:
          return compareDates(b.startDate, a.startDate);
      }
    });

    const totalResults = requests.length;
    const page = requests.slice(query.offset, query.offset + query.limit);

    return {
      items: page,
      count: page.length,
      limit: query.limit,
      offset: query.offset,
      hasMore: query.offset + page.length < totalResults,
      totalResults,
    };
  }

  // --- validation --------------------------------------------------------

  /**
   * Dry run. Identical rules to `apply`, but nothing is created.
   *
   * This is the endpoint the assistant should reach for first: it can answer
   * "can I take next week off?" without committing the user to anything, and it
   * returns the shortfall so the reply can be specific.
   */
  validate(input: {
    employeeId: string;
    leaveTypeCode: LeaveTypeCode;
    startDate: string;
    endDate: string;
    startDayPortion: LeaveRequest['startDayPortion'];
    endDayPortion: LeaveRequest['endDayPortion'];
  }): LeaveValidationResult {
    const employee = this.requireEmployee(input.employeeId);
    if (!getLeaveType(input.leaveTypeCode)) {
      throw new HcmError('NOT_FOUND', `Unknown leave type "${input.leaveTypeCode}".`, 404);
    }

    const { days: _days, ...result } = evaluateLeaveRequest({
      employee,
      leaveTypeCode: input.leaveTypeCode,
      startDate: input.startDate,
      endDate: input.endDate,
      startDayPortion: input.startDayPortion,
      endDayPortion: input.endDayPortion,
      existingRequests: this.store.requestsForEmployee(employee.employeeId),
      rules: this.rules,
    });

    return result;
  }

  // --- apply -------------------------------------------------------------

  apply(input: ApplyLeaveRequest): LeaveRequest {
    // Idempotency first: a retry must not create a second request.
    if (input.idempotencyKey) {
      const existing = this.store.requestForIdempotencyKey(input.idempotencyKey);
      if (existing) return existing;
    }

    const employee = this.requireEmployee(input.employeeId);
    const leaveType = getLeaveType(input.leaveTypeCode);
    if (!leaveType) {
      throw new HcmError('NOT_FOUND', `Unknown leave type "${input.leaveTypeCode}".`, 404);
    }

    const evaluation = evaluateLeaveRequest({
      employee,
      leaveTypeCode: input.leaveTypeCode,
      startDate: input.startDate,
      endDate: input.endDate,
      startDayPortion: input.startDayPortion,
      endDayPortion: input.endDayPortion,
      existingRequests: this.store.requestsForEmployee(employee.employeeId),
      rules: this.rules,
    });

    if (!evaluation.valid) {
      // 422: the payload is well-formed, the business rules refuse it. The
      // violations travel in `details` so a caller can explain precisely why.
      throw new HcmError(
        'RULE_VIOLATION',
        'This leave request cannot be submitted.',
        422,
        {
          violations: evaluation.violations,
          requestedDays: evaluation.requestedDays,
          balanceBefore: evaluation.balanceBefore,
        },
      );
    }

    const now = new Date().toISOString();
    const year = input.startDate.slice(0, 4);
    const requestNumber = this.store.nextRequestNumber(year);

    const request: LeaveRequest = {
      requestId: randomUUID(),
      requestNumber,
      employeeId: employee.employeeId,
      employeeNumber: employee.employeeNumber,
      employeeName: employee.displayName,
      leaveTypeCode: input.leaveTypeCode,
      leaveTypeName: leaveType.name,
      startDate: input.startDate,
      endDate: input.endDate,
      startDayPortion: input.startDayPortion,
      endDayPortion: input.endDayPortion,
      totalDays: evaluation.requestedDays,
      days: evaluation.days,
      // Types that need no approval are effective immediately.
      status: leaveType.requiresApproval ? 'PENDING_APPROVAL' : 'APPROVED',
      reason: input.reason ?? null,
      comments: null,
      submittedAt: now,
      decidedAt: leaveType.requiresApproval ? null : now,
      decidedBy: null,
      decidedByName: null,
      withdrawnAt: null,
      cancelledAt: null,
      approverId: employee.managerId,
      approverName: employee.managerName,
      createdAt: now,
      updatedAt: now,
    };

    this.store.putRequest(request);
    if (input.idempotencyKey) this.store.rememberIdempotencyKey(input.idempotencyKey, request.requestId);
    this.onMutate();

    return request;
  }

  // --- withdraw / cancel --------------------------------------------------

  /** Employee retracts a request that has not been decided yet. */
  withdraw(requestId: string, reason?: string | null): LeaveRequest {
    const request = this.requireRequest(requestId);

    if (!WITHDRAWABLE_STATUSES.includes(request.status)) {
      throw new HcmError(
        'CONFLICT',
        request.status === 'APPROVED'
          ? `${request.requestNumber} has already been approved. Approved leave is cancelled rather than withdrawn.`
          : `${request.requestNumber} is ${request.status.toLowerCase().replace('_', ' ')} and cannot be withdrawn.`,
        409,
        { currentStatus: request.status, withdrawableFrom: WITHDRAWABLE_STATUSES },
      );
    }

    const now = new Date().toISOString();
    const updated: LeaveRequest = {
      ...request,
      status: 'WITHDRAWN',
      withdrawnAt: now,
      updatedAt: now,
      comments: reason ?? request.comments,
    };

    this.store.putRequest(updated);
    this.onMutate();
    return updated;
  }

  /**
   * Cancel leave that was already approved.
   *
   * Distinct from withdrawal because it undoes a decision, and because leave
   * already taken cannot be undone at all.
   */
  cancel(requestId: string, reason?: string | null): LeaveRequest {
    const request = this.requireRequest(requestId);

    if (request.status !== 'APPROVED') {
      throw new HcmError(
        'CONFLICT',
        `${request.requestNumber} is ${request.status.toLowerCase().replace('_', ' ')}, not approved, so there is nothing to cancel.`,
        409,
        { currentStatus: request.status },
      );
    }

    if (compareDates(request.endDate, today()) < 0) {
      throw new HcmError(
        'CONFLICT',
        `${request.requestNumber} ended on ${request.endDate}. Leave that has already been taken cannot be cancelled.`,
        409,
        { endDate: request.endDate },
      );
    }

    const now = new Date().toISOString();
    const updated: LeaveRequest = {
      ...request,
      status: 'CANCELLED',
      cancelledAt: now,
      updatedAt: now,
      comments: reason ?? request.comments,
    };

    this.store.putRequest(updated);
    this.onMutate();
    return updated;
  }

  // --- manager decision ---------------------------------------------------

  decide(requestId: string, input: DecideLeaveRequest): LeaveRequest {
    const request = this.requireRequest(requestId);

    if (request.status !== 'PENDING_APPROVAL' && request.status !== 'SUBMITTED') {
      throw new HcmError(
        'CONFLICT',
        `${request.requestNumber} is ${request.status.toLowerCase().replace('_', ' ')} and is no longer awaiting a decision.`,
        409,
        { currentStatus: request.status },
      );
    }

    const decider = this.store.findEmployee(input.decidedBy);
    if (!decider) {
      throw new HcmError('NOT_FOUND', `No employee matches approver "${input.decidedBy}".`, 404);
    }

    // Approving your own leave is the control this check exists to enforce.
    if (decider.employeeId === request.employeeId) {
      throw new HcmError('FORBIDDEN', 'An employee cannot decide their own leave request.', 403);
    }

    const now = new Date().toISOString();
    const updated: LeaveRequest = {
      ...request,
      status: input.decision,
      decidedAt: now,
      decidedBy: decider.employeeId,
      decidedByName: decider.displayName,
      comments: input.comments ?? request.comments,
      updatedAt: now,
    };

    this.store.putRequest(updated);
    this.onMutate();
    return updated;
  }
}
