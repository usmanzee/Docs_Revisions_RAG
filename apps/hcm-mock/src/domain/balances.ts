/**
 * Balance calculation.
 *
 * Balances are derived from requests on every read, never stored. A stored
 * balance is a cache of a calculation, and when a cache and its source disagree
 * the cache is always the thing that is wrong - so there is no cache.
 *
 * The distinction that matters to a user asking "how much leave do I have
 * left?" is between days already taken, days committed to approved future
 * bookings, and days held by requests nobody has decided on yet. All three
 * reduce what they can book today, but they mean different things, so all three
 * are reported separately.
 */

import type { Employee, LeaveBalance, LeaveRequest, LeaveTypeCode } from '@docs-rag/hcm-contract';
import { BALANCE_CONSUMING_STATUSES } from '@docs-rag/hcm-contract';
import type { LeaveRules } from '../config.js';
import { accrualFraction, addMonths, compareDates, leaveYearFor, roundToHalfDay, today } from './calendar.js';
import { ENTITLEMENT_DAYS, getLeaveType } from './leave-types.js';

/** Senior grades get the higher allowance. Job title is the proxy here. */
function isSeniorGrade(employee: Employee): boolean {
  return /head|director|chief|lead|principal|manager/i.test(employee.jobTitle);
}

export function annualEntitlementFor(employee: Employee, rules: LeaveRules): number {
  const base = isSeniorGrade(employee)
    ? rules.seniorEntitlementDays
    : rules.standardEntitlementDays;

  // Part-time patterns pro-rate against a five-day week.
  const workingDaysPerWeek = employee.workingDays.length;
  if (workingDaysPerWeek >= 5) return base;
  return roundToHalfDay((base * workingDaysPerWeek) / 5);
}

export function entitlementFor(
  employee: Employee,
  leaveTypeCode: LeaveTypeCode,
  rules: LeaveRules,
): number {
  const configured = ENTITLEMENT_DAYS[leaveTypeCode];
  if (configured === 'ANNUAL_ALLOWANCE') return annualEntitlementFor(employee, rules);
  return configured;
}

export interface BalanceInput {
  employee: Employee;
  leaveTypeCode: LeaveTypeCode;
  requests: LeaveRequest[];
  rules: LeaveRules;
  asOfDate?: string;
  /** Days carried in from the previous leave year. */
  carriedOverDays?: number;
}

export function calculateBalance(input: BalanceInput): LeaveBalance {
  const asOfDate = input.asOfDate ?? today();
  const { year, start, end } = leaveYearFor(asOfDate);
  const leaveType = getLeaveType(input.leaveTypeCode);

  const entitlementDays = entitlementFor(input.employee, input.leaveTypeCode, input.rules);

  // Carry-over is capped by policy and lapses partway through the new year.
  const carriedOverDays = Math.min(input.carriedOverDays ?? 0, input.rules.carryOverLimitDays);
  const carryOverExpiryDate =
    carriedOverDays > 0 ? addMonths(start, input.rules.carryOverExpiryMonths) : null;
  const carryOverStillValid =
    carryOverExpiryDate === null || compareDates(asOfDate, carryOverExpiryDate) <= 0;
  const effectiveCarryOver = carryOverStillValid ? carriedOverDays : 0;

  // Entitlement is earned monthly rather than granted on 1 January.
  const accruedDays = roundToHalfDay(entitlementDays * accrualFraction(asOfDate));

  const relevant = input.requests.filter(
    (request) =>
      request.leaveTypeCode === input.leaveTypeCode &&
      BALANCE_CONSUMING_STATUSES.includes(request.status) &&
      // Only requests inside this leave year affect this year's balance.
      compareDates(request.startDate, start) >= 0 &&
      compareDates(request.startDate, end) <= 0,
  );

  let takenDays = 0;
  let scheduledDays = 0;
  let pendingDays = 0;

  for (const request of relevant) {
    if (request.status === 'APPROVED') {
      // Split on whether the leave has actually happened yet.
      if (compareDates(request.endDate, asOfDate) < 0) takenDays += request.totalDays;
      else scheduledDays += request.totalDays;
    } else {
      pendingDays += request.totalDays;
    }
  }

  // Unpaid leave draws on no entitlement, so it can never be short.
  const affectsBalance = leaveType?.affectsBalance ?? true;

  const availableDays = affectsBalance
    ? roundToHalfDay(entitlementDays + effectiveCarryOver - takenDays - scheduledDays - pendingDays)
    : Number.POSITIVE_INFINITY;

  return {
    employeeId: input.employee.employeeId,
    leaveTypeCode: input.leaveTypeCode,
    leaveTypeName: leaveType?.name ?? input.leaveTypeCode,
    leaveYear: year,
    leaveYearStart: start,
    leaveYearEnd: end,
    entitlementDays,
    carriedOverDays: effectiveCarryOver,
    carryOverExpiryDate,
    accruedDays,
    takenDays: roundToHalfDay(takenDays),
    scheduledDays: roundToHalfDay(scheduledDays),
    pendingDays: roundToHalfDay(pendingDays),
    // Unpaid leave reports 0 rather than Infinity, which does not survive JSON.
    availableDays: Number.isFinite(availableDays) ? availableDays : 0,
    unit: 'DAYS',
    asOfDate,
  };
}
