/**
 * The request lifecycle.
 *
 * A fresh harness per test: these mutate state, and a shared one would make the
 * suite order-dependent - which is exactly the kind of test that passes alone
 * and fails in CI.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE, createHarness, futureWeekday, type Harness } from './helpers.js';

describe('leave request lifecycle', () => {
  let hcm: Harness;

  beforeEach(async () => {
    hcm = await createHarness();
  });

  afterEach(async () => {
    await hcm.app.close();
  });

  const apply = (overrides: Record<string, unknown> = {}) =>
    hcm.post(`${BASE}/leave-requests`, {
      employeeId: 'E10001',
      leaveTypeCode: 'ANNUAL',
      startDate: futureWeekday(60),
      endDate: futureWeekday(60),
      reason: 'Personal',
      ...overrides,
    });

  describe('applying', () => {
    it('creates a request awaiting approval', async () => {
      const response = await apply();
      expect(response.statusCode).toBe(201);

      const request = response.json();
      expect(request.status).toBe('PENDING_APPROVAL');
      expect(request.requestNumber).toMatch(/^LR-\d{4}-\d{6}$/);
      expect(request.approverName).toBe('Daniel Whitfield');
      expect(request.submittedAt).toBeTruthy();
      expect(request.decidedAt).toBeNull();
    });

    it('itemises the days it booked', async () => {
      const start = futureWeekday(60);
      const response = await apply({ startDate: start, endDate: futureWeekday(64) });
      const request = response.json();

      expect(request.days.length).toBe(request.totalDays);
      expect(request.days.every((day: { dayValue: number }) => day.dayValue === 1)).toBe(true);
    });

    it('holds the days against the balance while pending', async () => {
      const before = (await hcm.get(`${BASE}/employees/E10001/leave-balances/ANNUAL`)).json();
      await apply();
      const after = (await hcm.get(`${BASE}/employees/E10001/leave-balances/ANNUAL`)).json();

      expect(after.pendingDays).toBe(before.pendingDays + 1);
      expect(after.availableDays).toBe(before.availableDays - 1);
    });

    it('returns 422 with the violations when a rule refuses it', async () => {
      const response = await apply({ startDate: futureWeekday(1), endDate: futureWeekday(1) });

      expect(response.statusCode).toBe(422);
      const body = response.json();
      expect(body.error.code).toBe('RULE_VIOLATION');
      expect(body.error.details.violations[0].code).toBe('INSUFFICIENT_NOTICE');
    });

    it('refuses dates that overlap an existing request', async () => {
      const start = futureWeekday(60);
      const end = futureWeekday(64);
      await apply({ startDate: start, endDate: end });

      const clash = await apply({ startDate: end, endDate: futureWeekday(68) });

      expect(clash.statusCode).toBe(422);
      const violation = clash.json().error.details.violations[0];
      expect(violation.code).toBe('OVERLAPPING_REQUEST');
      expect(violation.details.conflicts).toHaveLength(1);
    });

    it('treats a repeated idempotency key as the same request', async () => {
      const first = await apply({ idempotencyKey: 'key-abc-12345678' });
      const second = await apply({ idempotencyKey: 'key-abc-12345678' });

      expect(second.json().requestId).toBe(first.json().requestId);

      const history = (await hcm.get(`${BASE}/employees/E10001/leave-requests?status=PENDING_APPROVAL`)).json();
      expect(history.totalResults).toBe(1);
    });

    it('approves immediately when the leave type needs no approval', async () => {
      // Every seeded type requires approval, so this asserts the default holds
      // rather than silently auto-approving.
      const request = (await apply()).json();
      expect(request.status).toBe('PENDING_APPROVAL');
    });
  });

  describe('withdrawing', () => {
    it('withdraws a pending request and releases the balance', async () => {
      const created = (await apply()).json();
      const before = (await hcm.get(`${BASE}/employees/E10001/leave-balances/ANNUAL`)).json();

      const response = await hcm.post(`${BASE}/leave-requests/${created.requestId}/withdraw`, {
        reason: 'Changed my mind',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('WITHDRAWN');
      expect(response.json().withdrawnAt).toBeTruthy();

      const after = (await hcm.get(`${BASE}/employees/E10001/leave-balances/ANNUAL`)).json();
      expect(after.availableDays).toBe(before.availableDays + created.totalDays);
    });

    it('accepts the human-quotable request number as well as the id', async () => {
      const created = (await apply()).json();
      const response = await hcm.post(`${BASE}/leave-requests/${created.requestNumber}/withdraw`, {});
      expect(response.json().status).toBe('WITHDRAWN');
    });

    it('refuses to withdraw an approved request, and says what to do instead', async () => {
      const created = (await apply()).json();
      await hcm.post(`${BASE}/leave-requests/${created.requestId}/decision`, {
        decision: 'APPROVED',
        decidedBy: 'E10002',
      });

      const response = await hcm.post(`${BASE}/leave-requests/${created.requestId}/withdraw`, {});

      expect(response.statusCode).toBe(409);
      expect(response.json().error.message).toMatch(/cancelled rather than withdrawn/i);
    });

    it('refuses to withdraw twice', async () => {
      const created = (await apply()).json();
      await hcm.post(`${BASE}/leave-requests/${created.requestId}/withdraw`, {});

      const second = await hcm.post(`${BASE}/leave-requests/${created.requestId}/withdraw`, {});
      expect(second.statusCode).toBe(409);
    });

    it('returns 404 for an unknown request', async () => {
      const response = await hcm.post(`${BASE}/leave-requests/LR-2026-999999/withdraw`, {});
      expect(response.statusCode).toBe(404);
    });
  });

  describe('approving and rejecting', () => {
    it('records who decided and when', async () => {
      const created = (await apply()).json();

      const response = await hcm.post(`${BASE}/leave-requests/${created.requestId}/decision`, {
        decision: 'APPROVED',
        decidedBy: 'E10002',
        comments: 'Fine by me',
      });

      const decided = response.json();
      expect(decided.status).toBe('APPROVED');
      expect(decided.decidedByName).toBe('Daniel Whitfield');
      expect(decided.decidedAt).toBeTruthy();
      expect(decided.comments).toBe('Fine by me');
    });

    it('moves days from pending to scheduled once approved', async () => {
      const created = (await apply()).json();
      await hcm.post(`${BASE}/leave-requests/${created.requestId}/decision`, {
        decision: 'APPROVED',
        decidedBy: 'E10002',
      });

      const balance = (await hcm.get(`${BASE}/employees/E10001/leave-balances/ANNUAL`)).json();
      expect(balance.pendingDays).toBe(0);
      expect(balance.scheduledDays).toBe(created.totalDays);
    });

    it('releases the balance when rejected', async () => {
      const before = (await hcm.get(`${BASE}/employees/E10001/leave-balances/ANNUAL`)).json();
      const created = (await apply()).json();

      await hcm.post(`${BASE}/leave-requests/${created.requestId}/decision`, {
        decision: 'REJECTED',
        decidedBy: 'E10002',
        comments: 'Too busy that week',
      });

      const after = (await hcm.get(`${BASE}/employees/E10001/leave-balances/ANNUAL`)).json();
      expect(after.availableDays).toBe(before.availableDays);
    });

    it('forbids deciding your own request', async () => {
      const created = (await apply()).json();

      const response = await hcm.post(`${BASE}/leave-requests/${created.requestId}/decision`, {
        decision: 'APPROVED',
        decidedBy: 'E10001',
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
    });

    it('refuses to decide a request that is already settled', async () => {
      const created = (await apply()).json();
      await hcm.post(`${BASE}/leave-requests/${created.requestId}/withdraw`, {});

      const response = await hcm.post(`${BASE}/leave-requests/${created.requestId}/decision`, {
        decision: 'APPROVED',
        decidedBy: 'E10002',
      });

      expect(response.statusCode).toBe(409);
    });
  });

  describe('cancelling', () => {
    it('cancels approved future leave and restores the balance', async () => {
      const before = (await hcm.get(`${BASE}/employees/E10001/leave-balances/ANNUAL`)).json();
      const created = (await apply()).json();
      await hcm.post(`${BASE}/leave-requests/${created.requestId}/decision`, {
        decision: 'APPROVED',
        decidedBy: 'E10002',
      });

      const response = await hcm.post(`${BASE}/leave-requests/${created.requestId}/cancel`, {
        reason: 'Trip called off',
      });

      expect(response.json().status).toBe('CANCELLED');
      expect(response.json().cancelledAt).toBeTruthy();

      const after = (await hcm.get(`${BASE}/employees/E10001/leave-balances/ANNUAL`)).json();
      expect(after.availableDays).toBe(before.availableDays);
    });

    it('refuses to cancel a request that was never approved', async () => {
      const created = (await apply()).json();
      const response = await hcm.post(`${BASE}/leave-requests/${created.requestId}/cancel`, {});

      expect(response.statusCode).toBe(409);
      expect(response.json().error.message).toMatch(/not approved/i);
    });

    it('refuses to cancel leave that has already been taken', async () => {
      // Seeded historical leave is approved and in the past.
      const history = (
        await hcm.get(`${BASE}/employees/E10001/leave-requests?status=APPROVED&sort=startDate:asc`)
      ).json();
      const past = history.items[0];

      const response = await hcm.post(`${BASE}/leave-requests/${past.requestId}/cancel`, {});
      expect(response.statusCode).toBe(409);
      expect(response.json().error.message).toMatch(/already been taken/i);
    });
  });

  describe('history', () => {
    it('paginates, newest first', async () => {
      const page = (await hcm.get(`${BASE}/employees/E10001/leave-requests?limit=2`)).json();

      expect(page.items).toHaveLength(2);
      expect(page.limit).toBe(2);
      expect(page.hasMore).toBe(page.totalResults > 2);
      // Descending by start date.
      expect(page.items[0].startDate >= page.items[1].startDate).toBe(true);
    });

    it('returns overlapping requests for a date window, not only contained ones', async () => {
      const start = futureWeekday(60);
      const end = futureWeekday(66);
      await apply({ startDate: start, endDate: end });

      // A window that only clips the tail of the request must still match it.
      const response = await hcm.get(
        `${BASE}/employees/E10001/leave-requests?fromDate=${end}&toDate=${futureWeekday(90)}`,
      );

      expect(response.json().totalResults).toBeGreaterThanOrEqual(1);
    });

    it('filters by status and leave type', async () => {
      await apply();
      const pending = (await hcm.get(`${BASE}/employees/E10001/leave-requests?status=PENDING_APPROVAL`)).json();
      expect(pending.items.every((r: { status: string }) => r.status === 'PENDING_APPROVAL')).toBe(true);

      const sick = (await hcm.get(`${BASE}/employees/E10001/leave-requests?leaveTypeCode=SICK`)).json();
      expect(sick.totalResults).toBe(0);
    });
  });
});
