/**
 * HCM leave-management domain vocabulary.
 *
 * This package is the *contract*, not an implementation. It describes the API
 * as a vendor would publish it, and both sides code against it: the mock server
 * that implements it today, and the client that calls it. When the real HCM
 * system arrives, this file is what gets reconciled against their published
 * spec - and if their shape differs, the change is contained here and in the
 * client's mapping layer rather than spreading through the chat pipeline.
 *
 * Naming follows enterprise HCM convention (Oracle HCM Cloud, Workday,
 * SuccessFactors all look broadly like this): people carry an employee number
 * separate from their internal id, absence types are referenced by code, and
 * requests move through an explicit approval state machine.
 */

/** Leave types are referenced by stable code, never by display name. */
export const LEAVE_TYPE_CODES = [
  'ANNUAL',
  'SICK',
  'UNPAID',
  'PARENTAL',
  'COMPASSIONATE',
  'STUDY',
] as const;
export type LeaveTypeCode = (typeof LEAVE_TYPE_CODES)[number];

/**
 * Request lifecycle.
 *
 *   SUBMITTED ──► PENDING_APPROVAL ──► APPROVED ──► (CANCELLED)
 *                        │
 *                        ├──► REJECTED
 *                        └──► WITHDRAWN   (by the employee, before a decision)
 *
 * WITHDRAWN and CANCELLED are deliberately distinct: withdrawing is the
 * employee retracting a request nobody has decided on yet; cancelling is
 * undoing leave that was already approved, which has different downstream
 * effects on balances and payroll.
 */
export const LEAVE_REQUEST_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
  'CANCELLED',
] as const;
export type LeaveRequestStatus = (typeof LEAVE_REQUEST_STATUSES)[number];

/** Statuses that still consume balance (approved, or awaiting a decision). */
export const BALANCE_CONSUMING_STATUSES: readonly LeaveRequestStatus[] = [
  'SUBMITTED',
  'PENDING_APPROVAL',
  'APPROVED',
];

/** Statuses an employee may still withdraw from. */
export const WITHDRAWABLE_STATUSES: readonly LeaveRequestStatus[] = ['SUBMITTED', 'PENDING_APPROVAL'];

/** Half-day support. A request may start and/or end on a half day. */
export const DAY_PORTIONS = ['FULL_DAY', 'FIRST_HALF', 'SECOND_HALF'] as const;
export type DayPortion = (typeof DAY_PORTIONS)[number];

export const EMPLOYMENT_TYPES = ['PERMANENT', 'FIXED_TERM', 'CONTRACTOR', 'INTERN'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/**
 * Machine-readable reasons a request can be refused.
 *
 * The client branches on these rather than on message text - which matters a
 * great deal for a chatbot, because it decides whether to say "you don't have
 * enough leave", "you applied too late", or "that clashes with an existing
 * booking", and each of those deserves a different reply.
 */
export const LEAVE_VIOLATION_CODES = [
  'INSUFFICIENT_BALANCE',
  'INSUFFICIENT_NOTICE',
  'EXCEEDS_MAX_CONSECUTIVE',
  'OVERLAPPING_REQUEST',
  'INVALID_DATE_RANGE',
  'DATE_IN_PAST',
  'TOO_FAR_IN_FUTURE',
  'NO_WORKING_DAYS',
  'PROBATION_RESTRICTION',
  'LEAVE_TYPE_NOT_ELIGIBLE',
  'BLACKOUT_PERIOD',
  'EMPLOYEE_INACTIVE',
] as const;
export type LeaveViolationCode = (typeof LEAVE_VIOLATION_CODES)[number];

/** Error codes returned in the error envelope. */
export const HCM_ERROR_CODES = [
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'CONFLICT',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'RULE_VIOLATION',
  'RATE_LIMITED',
  'UPSTREAM_ERROR',
  'INTERNAL_ERROR',
] as const;
export type HcmErrorCode = (typeof HCM_ERROR_CODES)[number];
