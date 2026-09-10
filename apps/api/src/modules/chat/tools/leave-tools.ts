/**
 * Leave tools.
 *
 * Results are returned to the model as compact, readable text rather than raw
 * JSON. That is deliberate: the model reads them as evidence to explain, and
 * prose it can quote produces better answers than a nested object it has to
 * interpret. The structured payload still travels separately for the UI.
 */

import { z } from 'zod';
import type { LeaveBalance, LeaveRequest, LeaveValidationResult } from '@docs-rag/hcm-contract';
import { LEAVE_TYPE_CODES } from '@docs-rag/hcm-contract';
import type { HcmClient } from '../../hcm/index.js';
import { HcmClientError } from '../../hcm/index.js';
import { toErrorMessage } from '../../../utils/errors.js';
import { defineTool, type AnyAssistantTool, type ToolResult } from './types.js';

/**
 * Schemas are strict throughout.
 *
 * Zod's default is to strip unknown keys, which would silently ignore an
 * `employeeId` a model tried to pass. Ignoring it is safe - identity is injected
 * regardless - but a model sending one is a signal that something has gone
 * wrong, possibly an injection attempt, and it should surface rather than
 * disappear.
 */
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')
  .describe('Calendar date in YYYY-MM-DD form');

const leaveTypeSchema = z
  .enum(LEAVE_TYPE_CODES)
  .describe('Leave type code. ANNUAL unless the user clearly means something else.');

// --- formatting -------------------------------------------------------------

function formatBalance(balance: LeaveBalance): string {
  return [
    `${balance.leaveTypeName} (${balance.leaveTypeCode}), leave year ${balance.leaveYear}:`,
    `  available now: ${balance.availableDays} days`,
    `  entitlement: ${balance.entitlementDays} days` +
      (balance.carriedOverDays > 0 ? ` (+${balance.carriedOverDays} carried over)` : ''),
    `  already taken: ${balance.takenDays} days`,
    `  approved future bookings: ${balance.scheduledDays} days`,
    `  awaiting approval: ${balance.pendingDays} days`,
  ].join('\n');
}

function formatRequest(request: LeaveRequest): string {
  const dates =
    request.startDate === request.endDate
      ? request.startDate
      : `${request.startDate} to ${request.endDate}`;

  return `${request.requestNumber}: ${request.leaveTypeName}, ${dates}, ${request.totalDays} day(s), status ${request.status}`;
}

function formatValidation(result: LeaveValidationResult): string {
  const lines = [
    result.valid
      ? `This request is allowed. It would use ${result.requestedDays} working day(s).`
      : `This request cannot be submitted as it stands. It would use ${result.requestedDays} working day(s).`,
    `Balance would go from ${result.balanceBefore} to ${result.balanceAfter} days.`,
  ];

  if (result.excludedDates.length > 0) {
    const excluded = result.excludedDates
      .map((entry) => `${entry.date} (${entry.name ?? entry.reason.toLowerCase().replace('_', ' ')})`)
      .join(', ');
    lines.push(`Not charged: ${excluded}.`);
  }

  for (const violation of result.violations) {
    lines.push(`${violation.severity === 'ERROR' ? 'BLOCKER' : 'NOTE'} [${violation.code}]: ${violation.message}`);
  }

  return lines.join('\n');
}

/** Turn a client error into a result the model can explain, never a crash. */
function toToolError(error: unknown): ToolResult {
  if (error instanceof HcmClientError) {
    if (error.isRuleViolation && error.violations?.length) {
      const reasons = error.violations
        .map((violation) => `[${violation.code}] ${violation.message}`)
        .join('\n');
      return {
        content: `The leave system refused this request:\n${reasons}`,
        refused: true,
        data: { violations: error.violations },
      };
    }

    return {
      content: `The leave system returned an error: ${error.message}`,
      error: error.message,
      data: { code: error.code, statusCode: error.statusCode },
    };
  }

  const message = toErrorMessage(error);
  return { content: `The leave system could not be reached: ${message}`, error: message };
}

// --- tools ------------------------------------------------------------------

export function createLeaveTools(hcm: HcmClient): AnyAssistantTool[] {
  const getLeaveBalance = defineTool({
    name: 'get_leave_balance',
    description:
      'Get the current leave balance for the signed-in employee: how many days are available, ' +
      'already taken, approved for future dates, and awaiting approval. Use this for any question ' +
      'about how much leave someone has left.',
    mutates: false,
    schema: z.object({
      leaveTypeCode: leaveTypeSchema
        .optional()
        .describe('Omit to return every leave type the employee is eligible for.'),
    }).strict(),
    async execute(args, context) {
      try {
        if (args.leaveTypeCode) {
          const balance = await hcm.getLeaveBalance(context.employeeId, args.leaveTypeCode);
          return { content: formatBalance(balance), data: balance };
        }

        const balances = await hcm.getLeaveBalances(context.employeeId);
        return {
          content: balances.map(formatBalance).join('\n\n'),
          data: balances,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  });

  const getLeaveHistory = defineTool({
    name: 'get_leave_history',
    description:
      'List the signed-in employee\'s leave requests - past, pending and upcoming. Use this to answer ' +
      '"what leave have I booked", "do I have anything pending", or to find a request the user wants ' +
      'to withdraw.',
    mutates: false,
    schema: z.object({
      status: z
        .enum(['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELLED'])
        .optional()
        .describe('Filter by status. Omit for all.'),
      leaveTypeCode: leaveTypeSchema.optional(),
      fromDate: dateSchema.optional().describe('Only requests ending on or after this date.'),
      toDate: dateSchema.optional().describe('Only requests starting on or before this date.'),
      limit: z.number().int().min(1).max(50).optional().describe('Default 20.'),
    }).strict(),
    async execute(args, context) {
      try {
        const page = await hcm.getLeaveHistory(context.employeeId, args);

        if (page.items.length === 0) {
          return { content: 'No leave requests match that.', data: page };
        }

        const lines = page.items.map(formatRequest).join('\n');
        const more = page.hasMore ? `\n(showing ${page.count} of ${page.totalResults})` : '';
        return { content: `${lines}${more}`, data: page };
      } catch (error) {
        return toToolError(error);
      }
    },
  });

  const validateLeaveRequest = defineTool({
    name: 'validate_leave_request',
    description:
      'Check whether a leave request WOULD be accepted, without submitting it. Returns the working ' +
      'days it would use, the resulting balance, which dates are not charged, and any blocking rule. ' +
      'Always call this before apply_for_leave, and use it to answer "can I take X off?".',
    mutates: false,
    schema: z.object({
      leaveTypeCode: leaveTypeSchema,
      startDate: dateSchema,
      endDate: dateSchema.describe('Same as startDate for a single day.'),
      startDayPortion: z
        .enum(['FULL_DAY', 'FIRST_HALF', 'SECOND_HALF'])
        .optional()
        .describe('For a half day on the first date.'),
      endDayPortion: z.enum(['FULL_DAY', 'FIRST_HALF', 'SECOND_HALF']).optional(),
    }).strict(),
    async execute(args, context) {
      try {
        const result = await hcm.validateLeaveRequest({
          employeeId: context.employeeId,
          leaveTypeCode: args.leaveTypeCode,
          startDate: args.startDate,
          endDate: args.endDate,
          startDayPortion: args.startDayPortion ?? 'FULL_DAY',
          endDayPortion: args.endDayPortion ?? 'FULL_DAY',
        });

        return { content: formatValidation(result), data: result, refused: !result.valid };
      } catch (error) {
        return toToolError(error);
      }
    },
  });

  const applyForLeave = defineTool({
    name: 'apply_for_leave',
    description:
      'Submit a leave request for approval. This is a real action that creates a record. Only call it ' +
      'after validate_leave_request succeeded for the same dates AND the user has explicitly confirmed ' +
      'they want it submitted.',
    mutates: true,
    // Enforced by the executor, not merely requested here: a model cannot book
    // leave it has not first checked.
    requiresPriorTool: 'validate_leave_request',
    schema: z.object({
      leaveTypeCode: leaveTypeSchema,
      startDate: dateSchema,
      endDate: dateSchema,
      startDayPortion: z.enum(['FULL_DAY', 'FIRST_HALF', 'SECOND_HALF']).optional(),
      endDayPortion: z.enum(['FULL_DAY', 'FIRST_HALF', 'SECOND_HALF']).optional(),
      reason: z.string().max(500).optional().describe('Short reason, if the user gave one.'),
    }).strict(),
    async execute(args, context) {
      try {
        const request = await hcm.applyForLeave({
          employeeId: context.employeeId,
          leaveTypeCode: args.leaveTypeCode,
          startDate: args.startDate,
          endDate: args.endDate,
          startDayPortion: args.startDayPortion ?? 'FULL_DAY',
          endDayPortion: args.endDayPortion ?? 'FULL_DAY',
          reason: args.reason ?? null,
          // Derived from the turn and the dates, so a retry within one turn
          // cannot book the same leave twice.
          idempotencyKey: `${context.turnId}-${args.leaveTypeCode}-${args.startDate}-${args.endDate}`,
        });

        return {
          content: `Submitted. ${formatRequest(request)}. Approver: ${request.approverName ?? 'not assigned'}.`,
          data: request,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  });

  const withdrawLeaveRequest = defineTool({
    name: 'withdraw_leave_request',
    description:
      'Withdraw a leave request that is still awaiting approval. This is a real action. Use ' +
      'get_leave_history first to find the request number, and confirm with the user before calling. ' +
      'For leave that has already been APPROVED, use cancel_leave_request instead.',
    mutates: true,
    schema: z.object({
      requestNumber: z
        .string()
        .min(3)
        .max(64)
        .describe('The request reference, e.g. LR-2026-000023.'),
      reason: z.string().max(500).optional(),
    }).strict(),
    async execute(args) {
      try {
        const request = await hcm.withdrawLeaveRequest(args.requestNumber, args.reason);
        return { content: `Withdrawn. ${formatRequest(request)}`, data: request };
      } catch (error) {
        return toToolError(error);
      }
    },
  });

  const cancelLeaveRequest = defineTool({
    name: 'cancel_leave_request',
    description:
      'Cancel leave that has already been APPROVED and has not yet been taken. This is a real action. ' +
      'Confirm with the user before calling.',
    mutates: true,
    schema: z.object({
      requestNumber: z.string().min(3).max(64).describe('The request reference, e.g. LR-2026-000023.'),
      reason: z.string().max(500).optional(),
    }).strict(),
    async execute(args) {
      try {
        const request = await hcm.cancelLeaveRequest(args.requestNumber, args.reason);
        return { content: `Cancelled. ${formatRequest(request)}`, data: request };
      } catch (error) {
        return toToolError(error);
      }
    },
  });

  return [
    getLeaveBalance,
    getLeaveHistory,
    validateLeaveRequest,
    applyForLeave,
    withdrawLeaveRequest,
    cancelLeaveRequest,
  ];
}
