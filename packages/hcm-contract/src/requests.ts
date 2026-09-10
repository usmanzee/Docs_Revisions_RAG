/**
 * Request payloads and their validation schemas.
 *
 * Zod schemas live in the contract rather than in the server so that a client
 * can validate a payload *before* sending it. For the chatbot integration that
 * matters: a model-produced argument set can be checked locally and the user
 * asked for the missing piece, instead of a round trip that fails.
 */

import { z } from 'zod';
import { DAY_PORTIONS, LEAVE_TYPE_CODES, LEAVE_REQUEST_STATUSES } from './domain.js';

/** Calendar date, no time component. Rejects "2026-02-31" and similar. */
export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a calendar date in YYYY-MM-DD form')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    // Round-tripping catches impossible dates that Date happily rolls over.
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'not a real calendar date');

export const employeeIdSchema = z.string().min(1).max(64);

export const applyLeaveSchema = z
  .object({
    employeeId: employeeIdSchema,
    leaveTypeCode: z.enum(LEAVE_TYPE_CODES),
    startDate: calendarDateSchema,
    endDate: calendarDateSchema,
    startDayPortion: z.enum(DAY_PORTIONS).default('FULL_DAY'),
    endDayPortion: z.enum(DAY_PORTIONS).default('FULL_DAY'),
    reason: z.string().trim().max(500).nullish(),
    /**
     * Idempotency key. A retried submission with the same key returns the
     * original request instead of creating a duplicate - which is essential
     * when the caller is a chatbot that may retry on a timeout.
     */
    idempotencyKey: z.string().min(8).max(128).optional(),
  })
  .strict();

export type ApplyLeaveRequest = z.infer<typeof applyLeaveSchema>;

/** Same shape as applying, but nothing is created. */
export const validateLeaveSchema = applyLeaveSchema.omit({ idempotencyKey: true });
export type ValidateLeaveRequest = z.infer<typeof validateLeaveSchema>;

export const withdrawLeaveSchema = z
  .object({
    /** Recorded on the request; some organisations require one. */
    reason: z.string().trim().max(500).nullish(),
  })
  .strict();

export type WithdrawLeaveRequest = z.infer<typeof withdrawLeaveSchema>;

export const cancelLeaveSchema = withdrawLeaveSchema;
export type CancelLeaveRequest = WithdrawLeaveRequest;

/**
 * Manager decision on a pending request.
 *
 * Separate from the employee-facing operations because it is a different
 * actor with different authority - the same distinction the real system makes.
 */
export const decideLeaveSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    decidedBy: employeeIdSchema,
    comments: z.string().trim().max(500).nullish(),
  })
  .strict();

export type DecideLeaveRequest = z.infer<typeof decideLeaveSchema>;

export const leaveRequestQuerySchema = z
  .object({
    status: z.enum(LEAVE_REQUEST_STATUSES).optional(),
    leaveTypeCode: z.enum(LEAVE_TYPE_CODES).optional(),
    /** Inclusive lower bound on endDate - "anything that overlaps from here". */
    fromDate: calendarDateSchema.optional(),
    /** Inclusive upper bound on startDate. */
    toDate: calendarDateSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(25),
    offset: z.coerce.number().int().min(0).default(0),
    /** Newest first by default: history is read backwards. */
    sort: z.enum(['startDate:asc', 'startDate:desc', 'submittedAt:desc']).default('startDate:desc'),
  })
  .strict();

export type LeaveRequestQuery = z.infer<typeof leaveRequestQuerySchema>;

export const balanceQuerySchema = z
  .object({
    /** Balance as at this date. Defaults to today. */
    asOfDate: calendarDateSchema.optional(),
    leaveYear: z.string().regex(/^\d{4}$/).optional(),
  })
  .strict();

export type BalanceQuery = z.infer<typeof balanceQuerySchema>;
