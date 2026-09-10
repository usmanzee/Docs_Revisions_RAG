/**
 * Resource shapes returned by the HCM API.
 *
 * Dates are ISO strings throughout. Calendar dates use `YYYY-MM-DD` with no
 * time component - a leave day is a date, not an instant, and attaching a
 * timezone to it is how off-by-one-day bugs are born. Timestamps that describe
 * *when something happened* are full ISO-8601 with an offset.
 */

import type {
  DayPortion,
  EmploymentType,
  HcmErrorCode,
  LeaveRequestStatus,
  LeaveTypeCode,
  LeaveViolationCode,
} from './domain.js';

// --- Reference data --------------------------------------------------------

export interface LeaveType {
  code: LeaveTypeCode;
  name: string;
  description: string;
  /** Deducted from an entitlement balance. Unpaid leave is not. */
  affectsBalance: boolean;
  paid: boolean;
  requiresApproval: boolean;
  /** Supporting evidence needed beyond this many consecutive days, if any. */
  documentationRequiredAfterDays: number | null;
  /** Employment types eligible for this leave type. */
  eligibleEmploymentTypes: EmploymentType[];
  /** May be requested for a date already past (sick leave typically may). */
  allowsRetroactiveRequest: boolean;
}

// --- People ----------------------------------------------------------------

export interface Employee {
  /** Internal identifier. Opaque; never parse it. */
  employeeId: string;
  /** The number people actually quote, e.g. "E10042". */
  employeeNumber: string;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  department: string;
  jobTitle: string;
  employmentType: EmploymentType;
  /** Manager who approves this employee's leave. Null for the top of the tree. */
  managerId: string | null;
  managerName: string | null;
  hireDate: string;
  /** Derived from hireDate and the configured probation period. */
  onProbation: boolean;
  probationEndDate: string | null;
  /** Inactive employees cannot request leave. */
  active: boolean;
  /** Working days of the week, ISO-8601 numbering (1 = Monday). */
  workingDays: number[];
  location: string;
}

// --- Balances --------------------------------------------------------------

export interface LeaveBalance {
  employeeId: string;
  leaveTypeCode: LeaveTypeCode;
  leaveTypeName: string;
  /** Leave year this balance covers, e.g. "2026". */
  leaveYear: string;
  leaveYearStart: string;
  leaveYearEnd: string;

  /** Days granted for the full leave year. */
  entitlementDays: number;
  /** Days brought forward from the previous year. */
  carriedOverDays: number;
  /** Deadline after which carried-over days lapse. */
  carryOverExpiryDate: string | null;
  /** Entitlement accrued so far this year (entitlement is earned monthly). */
  accruedDays: number;
  /** Days already taken (APPROVED requests with dates in the past). */
  takenDays: number;
  /** Days committed to APPROVED future requests. */
  scheduledDays: number;
  /** Days held by requests awaiting a decision. */
  pendingDays: number;
  /**
   * What the employee can actually book right now.
   * entitlement + carriedOver - taken - scheduled - pending
   */
  availableDays: number;
  unit: 'DAYS';
  asOfDate: string;
}

// --- Requests --------------------------------------------------------------

export interface LeaveRequestDay {
  date: string;
  portion: DayPortion;
  /** 1 for a full day, 0.5 for a half day. */
  dayValue: number;
}

export interface LeaveRequest {
  requestId: string;
  /** Human-quotable reference, e.g. "LR-2026-000148". */
  requestNumber: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;

  leaveTypeCode: LeaveTypeCode;
  leaveTypeName: string;

  startDate: string;
  endDate: string;
  startDayPortion: DayPortion;
  endDayPortion: DayPortion;
  /** Working days consumed, excluding weekends and public holidays. */
  totalDays: number;
  /** The individual days, so a client can show exactly what was booked. */
  days: LeaveRequestDay[];

  status: LeaveRequestStatus;
  reason: string | null;
  comments: string | null;

  submittedAt: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  withdrawnAt: string | null;
  cancelledAt: string | null;

  approverId: string | null;
  approverName: string | null;

  createdAt: string;
  updatedAt: string;
}

// --- Validation ------------------------------------------------------------

export interface LeaveViolation {
  code: LeaveViolationCode;
  message: string;
  /** Structured detail so a client can compose its own wording. */
  details?: Record<string, unknown>;
  /** A blocking violation prevents submission; a warning does not. */
  severity: 'ERROR' | 'WARNING';
}

export interface LeaveValidationResult {
  valid: boolean;
  employeeId: string;
  leaveTypeCode: LeaveTypeCode;
  startDate: string;
  endDate: string;
  /** Working days the request would consume. */
  requestedDays: number;
  /** Non-working days that fall inside the range and are not charged. */
  excludedDates: { date: string; reason: 'WEEKEND' | 'PUBLIC_HOLIDAY'; name?: string }[];
  balanceBefore: number;
  balanceAfter: number;
  violations: LeaveViolation[];
}

// --- Envelopes -------------------------------------------------------------

/**
 * Paginated collection.
 *
 * `hasMore` rather than a page count: a caller iterating a list should not have
 * to know the total, and computing one is an extra query the server may not
 * want to run.
 */
export interface Paginated<T> {
  items: T[];
  count: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  totalResults: number;
}

export interface HcmErrorBody {
  error: {
    code: HcmErrorCode;
    message: string;
    details?: unknown;
    /** Echoed from the request, or generated. For support tickets. */
    correlationId?: string;
  };
}

/** Public holidays, so a client can explain why a day was not charged. */
export interface PublicHoliday {
  date: string;
  name: string;
  location: string;
}
