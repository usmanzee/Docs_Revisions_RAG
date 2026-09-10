/**
 * Leave request rules.
 *
 * One function evaluates every rule and returns *all* violations rather than
 * failing on the first. That matters for the assistant integration: telling
 * someone "you don't have enough leave" and then, after they adjust, "and it's
 * also too late to apply" is a poor conversation. One pass, everything at once.
 *
 * Rules mirror the Annual Leave Policy in the document corpus (HR-POL-001), so
 * the assistant can cite the policy and act on the system without the two
 * contradicting each other.
 */

import type {
  DayPortion,
  Employee,
  LeaveRequest,
  LeaveRequestDay,
  LeaveTypeCode,
  LeaveValidationResult,
  LeaveViolation,
} from '@docs-rag/hcm-contract';
import { BALANCE_CONSUMING_STATUSES } from '@docs-rag/hcm-contract';
import type { LeaveRules } from '../config.js';
import { calculateBalance } from './balances.js';
import {
  compareDates,
  daysBetween,
  roundToHalfDay,
  splitWorkingDays,
  today,
  type CalendarDate,
} from './calendar.js';
import { getLeaveType } from './leave-types.js';

export interface EvaluateInput {
  employee: Employee;
  leaveTypeCode: LeaveTypeCode;
  startDate: CalendarDate;
  endDate: CalendarDate;
  startDayPortion: DayPortion;
  endDayPortion: DayPortion;
  /** All existing requests for this employee, for overlap and balance checks. */
  existingRequests: LeaveRequest[];
  rules: LeaveRules;
  /** Excluded from the overlap check when re-validating an existing request. */
  ignoreRequestId?: string;
  asOfDate?: CalendarDate;
}

/**
 * Turn a date range plus half-day portions into the individual charged days.
 *
 * Half days are only meaningful on the first and last day of a range - a half
 * day in the middle of a week off is not a thing anyone means.
 */
export function buildRequestDays(
  workingDates: CalendarDate[],
  startDayPortion: DayPortion,
  endDayPortion: DayPortion,
): LeaveRequestDay[] {
  return workingDates.map((date, index) => {
    const isFirst = index === 0;
    const isLast = index === workingDates.length - 1;

    let portion: DayPortion = 'FULL_DAY';
    if (isFirst && startDayPortion !== 'FULL_DAY') portion = startDayPortion;
    // A single-day request cannot be a half day at both ends; the start wins.
    else if (isLast && endDayPortion !== 'FULL_DAY') portion = endDayPortion;

    return { date, portion, dayValue: portion === 'FULL_DAY' ? 1 : 0.5 };
  });
}

export function totalDaysFor(days: LeaveRequestDay[]): number {
  return roundToHalfDay(days.reduce((total, day) => total + day.dayValue, 0));
}

/** Notice required depends on the length of the request. HR-POL-001. */
export function requiredNoticeDays(workingDays: number, rules: LeaveRules): number {
  return workingDays <= rules.shortLeaveThresholdDays ? rules.noticeShortDays : rules.noticeLongDays;
}

function overlaps(a: { startDate: string; endDate: string }, b: { startDate: string; endDate: string }): boolean {
  return compareDates(a.startDate, b.endDate) <= 0 && compareDates(b.startDate, a.endDate) <= 0;
}

export interface EvaluationOutcome extends LeaveValidationResult {
  /** The charged days, reused by the apply path so it is computed once. */
  days: LeaveRequestDay[];
}

export function evaluateLeaveRequest(input: EvaluateInput): EvaluationOutcome {
  const asOfDate = input.asOfDate ?? today();
  const violations: LeaveViolation[] = [];
  const leaveType = getLeaveType(input.leaveTypeCode);

  // --- date sanity, first: everything downstream assumes a valid range ----
  if (compareDates(input.endDate, input.startDate) < 0) {
    violations.push({
      code: 'INVALID_DATE_RANGE',
      severity: 'ERROR',
      message: `The end date (${input.endDate}) is before the start date (${input.startDate}).`,
      details: { startDate: input.startDate, endDate: input.endDate },
    });

    // No point evaluating anything else against a nonsensical range.
    return {
      valid: false,
      employeeId: input.employee.employeeId,
      leaveTypeCode: input.leaveTypeCode,
      startDate: input.startDate,
      endDate: input.endDate,
      requestedDays: 0,
      excludedDates: [],
      balanceBefore: 0,
      balanceAfter: 0,
      violations,
      days: [],
    };
  }

  const { workingDates, excluded } = splitWorkingDays(
    input.startDate,
    input.endDate,
    input.employee.workingDays,
    input.employee.location,
  );

  const days = buildRequestDays(workingDates, input.startDayPortion, input.endDayPortion);
  const requestedDays = totalDaysFor(days);

  // --- employee state ----------------------------------------------------
  if (!input.employee.active) {
    violations.push({
      code: 'EMPLOYEE_INACTIVE',
      severity: 'ERROR',
      message: 'This employee record is not active, so leave cannot be requested.',
    });
  }

  // --- the range contains nothing chargeable -----------------------------
  if (workingDates.length === 0) {
    violations.push({
      code: 'NO_WORKING_DAYS',
      severity: 'ERROR',
      message:
        'The selected dates contain no working days - they fall entirely on weekends or public holidays.',
      details: { excluded },
    });
  }

  // --- eligibility -------------------------------------------------------
  if (leaveType && !leaveType.eligibleEmploymentTypes.includes(input.employee.employmentType)) {
    violations.push({
      code: 'LEAVE_TYPE_NOT_ELIGIBLE',
      severity: 'ERROR',
      message: `${leaveType.name} is not available to ${input.employee.employmentType.toLowerCase().replace('_', '-')} employees.`,
      details: {
        employmentType: input.employee.employmentType,
        eligibleEmploymentTypes: leaveType.eligibleEmploymentTypes,
      },
    });
  }

  // --- probation ---------------------------------------------------------
  // Sickness and bereavement are never withheld during probation.
  const probationApplies =
    input.employee.onProbation && !leaveType?.allowsRetroactiveRequest && input.leaveTypeCode === 'ANNUAL';

  if (probationApplies && input.employee.probationEndDate) {
    if (compareDates(input.startDate, input.employee.probationEndDate) <= 0) {
      violations.push({
        code: 'PROBATION_RESTRICTION',
        severity: 'ERROR',
        message: `Annual leave cannot normally be taken during the first ${input.rules.probationMonths} months of employment. Probation ends on ${input.employee.probationEndDate}.`,
        details: {
          probationEndDate: input.employee.probationEndDate,
          probationMonths: input.rules.probationMonths,
        },
      });
    }
  }

  // --- dates in the past --------------------------------------------------
  if (compareDates(input.startDate, asOfDate) < 0 && !leaveType?.allowsRetroactiveRequest) {
    violations.push({
      code: 'DATE_IN_PAST',
      severity: 'ERROR',
      message: `${leaveType?.name ?? 'This leave type'} cannot be requested for a date in the past.`,
      details: { startDate: input.startDate, asOfDate },
    });
  }

  // --- booking horizon ----------------------------------------------------
  const daysAhead = daysBetween(asOfDate, input.startDate);
  if (daysAhead > input.rules.maxAdvanceBookingDays) {
    violations.push({
      code: 'TOO_FAR_IN_FUTURE',
      severity: 'ERROR',
      message: `Leave can be requested at most ${input.rules.maxAdvanceBookingDays} days in advance.`,
      details: { daysAhead, maxAdvanceBookingDays: input.rules.maxAdvanceBookingDays },
    });
  }

  // --- notice period ------------------------------------------------------
  // Only for planned leave; you cannot give notice of falling ill.
  if (workingDates.length > 0 && !leaveType?.allowsRetroactiveRequest && daysAhead >= 0) {
    const required = requiredNoticeDays(requestedDays, input.rules);
    if (daysAhead < required) {
      violations.push({
        code: 'INSUFFICIENT_NOTICE',
        severity: 'ERROR',
        message: `A request of ${requestedDays} working day(s) needs ${required} calendar days' notice, but this starts in ${daysAhead} day(s).`,
        details: {
          requiredNoticeDays: required,
          actualNoticeDays: daysAhead,
          shortLeaveThresholdDays: input.rules.shortLeaveThresholdDays,
        },
      });
    }
  }

  // --- maximum consecutive ------------------------------------------------
  if (requestedDays > input.rules.maxConsecutiveDays) {
    violations.push({
      code: 'EXCEEDS_MAX_CONSECUTIVE',
      severity: 'ERROR',
      message: `This request is ${requestedDays} working days. More than ${input.rules.maxConsecutiveDays} consecutive days requires written approval from the department head.`,
      details: { requestedDays, maxConsecutiveDays: input.rules.maxConsecutiveDays },
    });
  }

  // --- overlapping requests -----------------------------------------------
  const clashes = input.existingRequests.filter(
    (request) =>
      request.requestId !== input.ignoreRequestId &&
      BALANCE_CONSUMING_STATUSES.includes(request.status) &&
      overlaps(input, request),
  );

  if (clashes.length > 0) {
    const first = clashes[0] as LeaveRequest;
    violations.push({
      code: 'OVERLAPPING_REQUEST',
      severity: 'ERROR',
      message: `These dates overlap an existing ${first.status.toLowerCase().replace('_', ' ')} request (${first.requestNumber}, ${first.startDate} to ${first.endDate}).`,
      details: {
        conflicts: clashes.map((request) => ({
          requestNumber: request.requestNumber,
          startDate: request.startDate,
          endDate: request.endDate,
          status: request.status,
        })),
      },
    });
  }

  // --- balance -------------------------------------------------------------
  const balance = calculateBalance({
    employee: input.employee,
    leaveTypeCode: input.leaveTypeCode,
    requests: input.existingRequests.filter((request) => request.requestId !== input.ignoreRequestId),
    rules: input.rules,
    asOfDate,
    carriedOverDays: 0,
  });

  const affectsBalance = leaveType?.affectsBalance ?? true;
  const balanceBefore = balance.availableDays;
  const balanceAfter = affectsBalance
    ? roundToHalfDay(balanceBefore - requestedDays)
    : balanceBefore;

  if (affectsBalance && requestedDays > balanceBefore) {
    violations.push({
      code: 'INSUFFICIENT_BALANCE',
      severity: 'ERROR',
      message: `This request is ${requestedDays} day(s) but only ${balanceBefore} day(s) of ${leaveType?.name ?? input.leaveTypeCode} remain available.`,
      details: {
        requestedDays,
        availableDays: balanceBefore,
        shortfallDays: roundToHalfDay(requestedDays - balanceBefore),
        entitlementDays: balance.entitlementDays,
        takenDays: balance.takenDays,
        scheduledDays: balance.scheduledDays,
        pendingDays: balance.pendingDays,
      },
    });
  }

  // --- advisory ------------------------------------------------------------
  // A warning, not a refusal: the request is allowed, the employee just needs
  // to know something is expected of them.
  if (
    leaveType?.documentationRequiredAfterDays !== null &&
    leaveType?.documentationRequiredAfterDays !== undefined &&
    requestedDays > leaveType.documentationRequiredAfterDays
  ) {
    violations.push({
      code: 'LEAVE_TYPE_NOT_ELIGIBLE',
      severity: 'WARNING',
      message: `${leaveType.name} longer than ${leaveType.documentationRequiredAfterDays} days requires supporting documentation.`,
      details: { documentationRequiredAfterDays: leaveType.documentationRequiredAfterDays },
    });
  }

  return {
    valid: violations.every((violation) => violation.severity !== 'ERROR'),
    employeeId: input.employee.employeeId,
    leaveTypeCode: input.leaveTypeCode,
    startDate: input.startDate,
    endDate: input.endDate,
    requestedDays,
    excludedDates: excluded,
    balanceBefore,
    balanceAfter,
    violations,
    days,
  };
}
