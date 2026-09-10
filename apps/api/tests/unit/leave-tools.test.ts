/**
 * Tool execution guarantees.
 *
 * These are the checks that stand between a language model and somebody's real
 * leave record, so they are tested against a stub HCM rather than through the
 * model - the question is whether the executor holds the line, not whether a
 * model happened to behave.
 */

import { describe, expect, it, vi } from 'vitest';
import type { LeaveBalance, LeaveRequest, LeaveValidationResult } from '@docs-rag/hcm-contract';
import { createLeaveTools } from '../../src/modules/chat/tools/leave-tools.js';
import { ToolExecutor } from '../../src/modules/chat/tools/executor.js';
import type { ToolContext } from '../../src/modules/chat/tools/types.js';
import { HcmClientError, type HcmClient } from '../../src/modules/hcm/index.js';

const context: ToolContext = {
  employeeId: 'emp-0001',
  conversationId: 'conv-1',
  turnId: 'turn-1',
};

const balance: LeaveBalance = {
  employeeId: 'emp-0001',
  leaveTypeCode: 'ANNUAL',
  leaveTypeName: 'Annual Leave',
  leaveYear: '2026',
  leaveYearStart: '2026-01-01',
  leaveYearEnd: '2026-12-31',
  entitlementDays: 20,
  carriedOverDays: 0,
  carryOverExpiryDate: null,
  accruedDays: 14,
  takenDays: 6,
  scheduledDays: 0,
  pendingDays: 0,
  availableDays: 14,
  unit: 'DAYS',
  asOfDate: '2026-09-09',
};

const validation: LeaveValidationResult = {
  valid: true,
  employeeId: 'emp-0001',
  leaveTypeCode: 'ANNUAL',
  startDate: '2026-11-16',
  endDate: '2026-11-18',
  requestedDays: 3,
  excludedDates: [],
  balanceBefore: 14,
  balanceAfter: 11,
  violations: [],
};

const created = {
  requestId: 'req-1',
  requestNumber: 'LR-2026-000042',
  employeeId: 'emp-0001',
  leaveTypeName: 'Annual Leave',
  leaveTypeCode: 'ANNUAL',
  startDate: '2026-11-16',
  endDate: '2026-11-18',
  totalDays: 3,
  status: 'PENDING_APPROVAL',
  approverName: 'Daniel Whitfield',
} as unknown as LeaveRequest;

function stubHcm(overrides: Partial<HcmClient> = {}): HcmClient {
  return {
    name: 'stub',
    isConfigured: () => true,
    ping: async () => true,
    getEmployee: vi.fn(),
    listLeaveTypes: vi.fn(),
    getLeaveBalances: vi.fn(async () => [balance]),
    getLeaveBalance: vi.fn(async () => balance),
    getLeaveHistory: vi.fn(async () => ({
      items: [created],
      count: 1,
      limit: 20,
      offset: 0,
      hasMore: false,
      totalResults: 1,
    })),
    getLeaveRequest: vi.fn(async () => created),
    validateLeaveRequest: vi.fn(async () => validation),
    applyForLeave: vi.fn(async () => created),
    withdrawLeaveRequest: vi.fn(async () => ({ ...created, status: 'WITHDRAWN' })),
    cancelLeaveRequest: vi.fn(async () => ({ ...created, status: 'CANCELLED' })),
    ...overrides,
  } as HcmClient;
}

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: `c-${name}`, name, arguments: args });

describe('leave tools', () => {
  describe('identity', () => {
    it('never exposes an employee identifier in any tool schema', () => {
      // The single most important property here. If a model could name an
      // employee, a prompt injection inside a document could read or book
      // somebody else's leave.
      for (const tool of createLeaveTools(stubHcm())) {
        const shape = JSON.stringify(tool.schema);
        expect(shape).not.toMatch(/employeeId/i);
        expect(shape).not.toMatch(/employeeNumber/i);
      }
    });

    it('injects the session employee into the call', async () => {
      const hcm = stubHcm();
      const executor = new ToolExecutor(createLeaveTools(hcm));

      await executor.execute(call('get_leave_balance'), context);

      expect(hcm.getLeaveBalances).toHaveBeenCalledWith('emp-0001');
    });

    it('ignores an employee id smuggled into the arguments', async () => {
      const hcm = stubHcm();
      const executor = new ToolExecutor(createLeaveTools(hcm));

      const result = await executor.execute(
        call('get_leave_balance', { employeeId: 'emp-9999' }),
        context,
      );

      // Strict schemas reject the unknown field outright.
      expect(result.result.error).toBe('invalid arguments');
      expect(hcm.getLeaveBalances).not.toHaveBeenCalled();
    });
  });

  describe('write gating', () => {
    it('refuses to apply before a validation has succeeded', async () => {
      const hcm = stubHcm();
      const executor = new ToolExecutor(createLeaveTools(hcm));

      const result = await executor.execute(
        call('apply_for_leave', {
          leaveTypeCode: 'ANNUAL',
          startDate: '2026-11-16',
          endDate: '2026-11-18',
        }),
        context,
      );

      expect(result.result.error).toBe('prerequisite not satisfied');
      expect(result.result.content).toMatch(/validate_leave_request/);
      expect(hcm.applyForLeave).not.toHaveBeenCalled();
    });

    it('allows apply once validation has succeeded', async () => {
      const hcm = stubHcm();
      const executor = new ToolExecutor(createLeaveTools(hcm));

      await executor.execute(
        call('validate_leave_request', {
          leaveTypeCode: 'ANNUAL',
          startDate: '2026-11-16',
          endDate: '2026-11-18',
        }),
        context,
      );

      const result = await executor.execute(
        call('apply_for_leave', {
          leaveTypeCode: 'ANNUAL',
          startDate: '2026-11-16',
          endDate: '2026-11-18',
        }),
        context,
      );

      expect(result.result.error).toBeUndefined();
      expect(result.result.content).toMatch(/LR-2026-000042/);
      expect(hcm.applyForLeave).toHaveBeenCalledOnce();
    });

    it('does not let a FAILED validation unlock a booking', async () => {
      const refused: LeaveValidationResult = {
        ...validation,
        valid: false,
        violations: [
          { code: 'INSUFFICIENT_BALANCE', severity: 'ERROR', message: 'Only 2 days remain.' },
        ],
      };

      const hcm = stubHcm({ validateLeaveRequest: vi.fn(async () => refused) });
      const executor = new ToolExecutor(createLeaveTools(hcm));

      await executor.execute(
        call('validate_leave_request', {
          leaveTypeCode: 'ANNUAL',
          startDate: '2026-11-16',
          endDate: '2026-11-18',
        }),
        context,
      );

      const result = await executor.execute(
        call('apply_for_leave', {
          leaveTypeCode: 'ANNUAL',
          startDate: '2026-11-16',
          endDate: '2026-11-18',
        }),
        context,
      );

      expect(result.result.error).toBe('prerequisite not satisfied');
      expect(hcm.applyForLeave).not.toHaveBeenCalled();
    });

    it('refuses an identical write twice in one turn', async () => {
      const hcm = stubHcm();
      const executor = new ToolExecutor(createLeaveTools(hcm));
      const args = { leaveTypeCode: 'ANNUAL', startDate: '2026-11-16', endDate: '2026-11-18' };

      await executor.execute(call('validate_leave_request', args), context);
      await executor.execute(call('apply_for_leave', args), context);
      const repeat = await executor.execute(call('apply_for_leave', args), context);

      expect(repeat.result.error).toBe('duplicate write');
      expect(hcm.applyForLeave).toHaveBeenCalledOnce();
    });

    it('sends an idempotency key derived from the turn', async () => {
      const hcm = stubHcm();
      const executor = new ToolExecutor(createLeaveTools(hcm));
      const args = { leaveTypeCode: 'ANNUAL', startDate: '2026-11-16', endDate: '2026-11-18' };

      await executor.execute(call('validate_leave_request', args), context);
      await executor.execute(call('apply_for_leave', args), context);

      expect(hcm.applyForLeave).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: 'turn-1-ANNUAL-2026-11-16-2026-11-18' }),
      );
    });

    it('does not gate reads', async () => {
      const hcm = stubHcm();
      const executor = new ToolExecutor(createLeaveTools(hcm));

      const result = await executor.execute(call('get_leave_history', {}), context);
      expect(result.result.error).toBeUndefined();
    });
  });

  describe('argument handling', () => {
    it('rejects a malformed date instead of passing it on', async () => {
      const hcm = stubHcm();
      const executor = new ToolExecutor(createLeaveTools(hcm));

      const result = await executor.execute(
        call('validate_leave_request', {
          leaveTypeCode: 'ANNUAL',
          startDate: 'next Monday',
          endDate: '2026-11-18',
        }),
        context,
      );

      expect(result.result.error).toBe('invalid arguments');
      expect(result.result.content).toMatch(/YYYY-MM-DD/);
      expect(hcm.validateLeaveRequest).not.toHaveBeenCalled();
    });

    it('rejects an unknown leave type', async () => {
      const executor = new ToolExecutor(createLeaveTools(stubHcm()));

      const result = await executor.execute(
        call('validate_leave_request', {
          leaveTypeCode: 'SABBATICAL',
          startDate: '2026-11-16',
          endDate: '2026-11-18',
        }),
        context,
      );

      expect(result.result.error).toBe('invalid arguments');
    });

    it('tells the model plainly when it invents a tool', async () => {
      const executor = new ToolExecutor(createLeaveTools(stubHcm()));
      const result = await executor.execute(call('delete_all_leave', {}), context);

      expect(result.result.error).toBe('unknown tool');
      expect(result.result.content).toMatch(/get_leave_balance/);
    });
  });

  describe('failure handling', () => {
    it('turns a rule violation into an explainable refusal, not an error', async () => {
      const hcm = stubHcm({
        applyForLeave: vi.fn(async () => {
          throw new HcmClientError('RULE_VIOLATION', 'Refused', 422, undefined, [
            {
              code: 'INSUFFICIENT_NOTICE',
              message: 'Needs 8 days notice, this starts in 3.',
              severity: 'ERROR',
            },
          ]);
        }),
      });

      const executor = new ToolExecutor(createLeaveTools(hcm));
      const args = { leaveTypeCode: 'ANNUAL', startDate: '2026-11-16', endDate: '2026-11-18' };
      await executor.execute(call('validate_leave_request', args), context);

      const result = await executor.execute(call('apply_for_leave', args), context);

      expect(result.result.refused).toBe(true);
      expect(result.result.error).toBeUndefined();
      expect(result.result.content).toMatch(/INSUFFICIENT_NOTICE/);
      expect(result.result.content).toMatch(/8 days notice/);
    });

    it('survives the HCM being unreachable', async () => {
      const hcm = stubHcm({
        getLeaveBalances: vi.fn(async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:3100');
        }),
      });

      const executor = new ToolExecutor(createLeaveTools(hcm));
      const result = await executor.execute(call('get_leave_balance'), context);

      expect(result.result.error).toMatch(/ECONNREFUSED/);
      expect(result.result.content).toMatch(/could not be reached/i);
    });

    it('never lets a throwing tool escape', async () => {
      const hcm = stubHcm({
        getLeaveHistory: vi.fn(() => {
          throw new Error('boom');
        }),
      });

      const executor = new ToolExecutor(createLeaveTools(hcm));
      await expect(executor.execute(call('get_leave_history', {}), context)).resolves.toBeDefined();
    });
  });

  describe('result formatting', () => {
    it('gives the model readable prose, not raw JSON', async () => {
      const executor = new ToolExecutor(createLeaveTools(stubHcm()));
      const result = await executor.execute(call('get_leave_balance', { leaveTypeCode: 'ANNUAL' }), context);

      expect(result.result.content).toContain('available now: 14 days');
      expect(result.result.content).toContain('already taken: 6 days');
      expect(result.result.content).not.toMatch(/^\s*[{[]/);
    });

    it('keeps the structured payload for the UI', async () => {
      const executor = new ToolExecutor(createLeaveTools(stubHcm()));
      const result = await executor.execute(call('get_leave_balance', { leaveTypeCode: 'ANNUAL' }), context);

      expect(result.result.data).toMatchObject({ availableDays: 14, leaveTypeCode: 'ANNUAL' });
    });

    it('explains which dates were not charged', async () => {
      const hcm = stubHcm({
        validateLeaveRequest: vi.fn(async () => ({
          ...validation,
          excludedDates: [
            { date: '2026-11-21', reason: 'WEEKEND' as const },
            { date: '2026-12-25', reason: 'PUBLIC_HOLIDAY' as const, name: 'Christmas Day' },
          ],
        })),
      });

      const executor = new ToolExecutor(createLeaveTools(hcm));
      const result = await executor.execute(
        call('validate_leave_request', {
          leaveTypeCode: 'ANNUAL',
          startDate: '2026-11-16',
          endDate: '2026-11-18',
        }),
        context,
      );

      expect(result.result.content).toMatch(/Not charged/);
      expect(result.result.content).toMatch(/Christmas Day/);
    });
  });
});
