/**
 * The HCM API surface, exercised through real HTTP routing.
 *
 * Uses Fastify's `inject`, so auth hooks, validation and the error envelope all
 * run exactly as they do in the running service.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, createHarness, futureWeekday, type Harness } from './helpers.js';

describe('mock HCM API', () => {
  let hcm: Harness;

  beforeAll(async () => {
    hcm = await createHarness();
  });

  afterAll(async () => {
    await hcm.app.close();
  });

  describe('authentication', () => {
    it('leaves health open', async () => {
      const response = await hcm.app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok', service: 'hcm-mock' });
    });

    it('rejects a call with no token', async () => {
      const response = await hcm.app.inject({ method: 'GET', url: `${BASE}/leave-types` });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.message).toMatch(/bearer token/i);
    });

    it('rejects a wrong token', async () => {
      const response = await hcm.app.inject({
        method: 'GET',
        url: `${BASE}/leave-types`,
        headers: { authorization: 'Bearer not-the-key' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('advertises the contract version on every response', async () => {
      const response = await hcm.get(`${BASE}/leave-types`);
      expect(response.headers['x-hcm-contract-version']).toBe('1.0.0');
    });
  });

  describe('reference data', () => {
    it('lists leave types with their eligibility rules', async () => {
      const response = await hcm.get(`${BASE}/leave-types`);
      const items = response.json().items as { code: string; eligibleEmploymentTypes: string[] }[];

      expect(items.map((type) => type.code)).toContain('ANNUAL');
      const annual = items.find((type) => type.code === 'ANNUAL');
      expect(annual?.eligibleEmploymentTypes).not.toContain('CONTRACTOR');
    });

    it('returns public holidays inside a window', async () => {
      const response = await hcm.get(`${BASE}/public-holidays?fromDate=2026-12-01&toDate=2026-12-31`);
      const dates = (response.json().items as { date: string }[]).map((holiday) => holiday.date);
      expect(dates).toEqual(['2026-12-25', '2026-12-26']);
    });
  });

  describe('employees', () => {
    it('resolves by employee number, internal id and email', async () => {
      const byNumber = await hcm.get(`${BASE}/employees/E10001`);
      expect(byNumber.statusCode).toBe(200);

      const employee = byNumber.json() as { employeeId: string; email: string };

      expect((await hcm.get(`${BASE}/employees/${employee.employeeId}`)).statusCode).toBe(200);
      expect((await hcm.get(`${BASE}/employees/${employee.email}`)).statusCode).toBe(200);
    });

    it('returns a structured 404 for an unknown employee', async () => {
      const response = await hcm.get(`${BASE}/employees/E99999`);
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
      expect(response.json().error.correlationId).toBeTruthy();
    });
  });

  describe('balances', () => {
    it('breaks a balance into taken, scheduled, pending and available', async () => {
      const response = await hcm.get(`${BASE}/employees/E10001/leave-balances/ANNUAL`);
      const balance = response.json();

      expect(balance.entitlementDays).toBe(20);
      expect(balance.availableDays).toBe(
        balance.entitlementDays +
          balance.carriedOverDays -
          balance.takenDays -
          balance.scheduledDays -
          balance.pendingDays,
      );
    });

    it('pro-rates entitlement for a part-time pattern', async () => {
      // E10007 works three days a week: 20 * 3/5 = 12.
      const response = await hcm.get(`${BASE}/employees/E10007/leave-balances/ANNUAL`);
      expect(response.json().entitlementDays).toBe(12);
    });

    it('grants senior grades the higher entitlement', async () => {
      const response = await hcm.get(`${BASE}/employees/E10002/leave-balances/ANNUAL`);
      expect(response.json().entitlementDays).toBe(31);
    });

    it('lists only leave types the employee is eligible for', async () => {
      const response = await hcm.get(`${BASE}/employees/E10006/leave-balances`);
      const codes = (response.json().items as { leaveTypeCode: string }[]).map((b) => b.leaveTypeCode);

      // A contractor gets unpaid leave but not annual.
      expect(codes).toContain('UNPAID');
      expect(codes).not.toContain('ANNUAL');
    });
  });

  describe('validation', () => {
    it('accepts a well-formed request and reports the resulting balance', async () => {
      const response = await hcm.post(`${BASE}/leave-requests/validate`, {
        employeeId: 'E10001',
        leaveTypeCode: 'ANNUAL',
        startDate: futureWeekday(60),
        endDate: futureWeekday(60),
      });

      const result = response.json();
      expect(result.valid).toBe(true);
      expect(result.requestedDays).toBe(1);
      expect(result.balanceAfter).toBe(result.balanceBefore - 1);
    });

    it('does not charge weekends, and says which days it excluded', async () => {
      // Friday through the following Monday.
      const friday = (() => {
        const date = new Date();
        date.setUTCHours(12, 0, 0, 0);
        date.setUTCDate(date.getUTCDate() + 60);
        while (date.getUTCDay() !== 5) date.setUTCDate(date.getUTCDate() + 1);
        return date.toISOString().slice(0, 10);
      })();

      const monday = (() => {
        const date = new Date(`${friday}T12:00:00Z`);
        date.setUTCDate(date.getUTCDate() + 3);
        return date.toISOString().slice(0, 10);
      })();

      const response = await hcm.post(`${BASE}/leave-requests/validate`, {
        employeeId: 'E10001',
        leaveTypeCode: 'ANNUAL',
        startDate: friday,
        endDate: monday,
      });

      const result = response.json();
      expect(result.requestedDays).toBe(2);
      expect(result.excludedDates).toHaveLength(2);
      expect(result.excludedDates.every((entry: { reason: string }) => entry.reason === 'WEEKEND')).toBe(true);
    });

    it('refuses when the balance is short, and reports the shortfall', async () => {
      const response = await hcm.post(`${BASE}/leave-requests/validate`, {
        employeeId: 'E10003',
        leaveTypeCode: 'ANNUAL',
        startDate: futureWeekday(60),
        endDate: futureWeekday(74),
      });

      const result = response.json();
      expect(result.valid).toBe(false);

      const violation = result.violations.find(
        (entry: { code: string }) => entry.code === 'INSUFFICIENT_BALANCE',
      );
      expect(violation).toBeDefined();
      expect(violation.details.shortfallDays).toBeGreaterThan(0);
    });

    it('enforces the notice period, scaled by request length', async () => {
      const response = await hcm.post(`${BASE}/leave-requests/validate`, {
        employeeId: 'E10001',
        leaveTypeCode: 'ANNUAL',
        startDate: futureWeekday(2),
        endDate: futureWeekday(2),
      });

      const violation = response
        .json()
        .violations.find((entry: { code: string }) => entry.code === 'INSUFFICIENT_NOTICE');

      expect(violation).toBeDefined();
      // Short leave: the eight-day rule, not the thirty-one-day one.
      expect(violation.details.requiredNoticeDays).toBe(8);
    });

    it('blocks annual leave taken during probation', async () => {
      const employee = (await hcm.get(`${BASE}/employees/E10004`)).json();
      // A date inside probation, with adequate notice.
      const during = employee.probationEndDate;

      const response = await hcm.post(`${BASE}/leave-requests/validate`, {
        employeeId: 'E10004',
        leaveTypeCode: 'ANNUAL',
        startDate: during,
        endDate: during,
      });

      expect(
        response.json().violations.some((entry: { code: string }) => entry.code === 'PROBATION_RESTRICTION'),
      ).toBe(true);
    });

    it('does not block sick leave during probation', async () => {
      const employee = (await hcm.get(`${BASE}/employees/E10004`)).json();

      const response = await hcm.post(`${BASE}/leave-requests/validate`, {
        employeeId: 'E10004',
        leaveTypeCode: 'SICK',
        startDate: employee.probationEndDate,
        endDate: employee.probationEndDate,
      });

      expect(
        response.json().violations.some((entry: { code: string }) => entry.code === 'PROBATION_RESTRICTION'),
      ).toBe(false);
    });

    it('refuses a leave type the employment type is not eligible for', async () => {
      const response = await hcm.post(`${BASE}/leave-requests/validate`, {
        employeeId: 'E10006',
        leaveTypeCode: 'ANNUAL',
        startDate: futureWeekday(60),
        endDate: futureWeekday(60),
      });

      expect(
        response.json().violations.some((entry: { code: string }) => entry.code === 'LEAVE_TYPE_NOT_ELIGIBLE'),
      ).toBe(true);
    });

    it('refuses a request from an inactive employee', async () => {
      const response = await hcm.post(`${BASE}/leave-requests/validate`, {
        employeeId: 'E10010',
        leaveTypeCode: 'ANNUAL',
        startDate: futureWeekday(60),
        endDate: futureWeekday(60),
      });

      expect(
        response.json().violations.some((entry: { code: string }) => entry.code === 'EMPLOYEE_INACTIVE'),
      ).toBe(true);
    });

    it('caps consecutive days', async () => {
      const response = await hcm.post(`${BASE}/leave-requests/validate`, {
        employeeId: 'E10002',
        leaveTypeCode: 'ANNUAL',
        startDate: futureWeekday(60),
        endDate: futureWeekday(85),
      });

      expect(
        response.json().violations.some((entry: { code: string }) => entry.code === 'EXCEEDS_MAX_CONSECUTIVE'),
      ).toBe(true);
    });

    it('rejects an inverted date range without evaluating anything else', async () => {
      const response = await hcm.post(`${BASE}/leave-requests/validate`, {
        employeeId: 'E10001',
        leaveTypeCode: 'ANNUAL',
        startDate: futureWeekday(70),
        endDate: futureWeekday(60),
      });

      const result = response.json();
      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].code).toBe('INVALID_DATE_RANGE');
    });

    it('reports every violation at once rather than stopping at the first', async () => {
      // Short notice AND over balance, together.
      const response = await hcm.post(`${BASE}/leave-requests/validate`, {
        employeeId: 'E10003',
        leaveTypeCode: 'ANNUAL',
        startDate: futureWeekday(1),
        endDate: futureWeekday(20),
      });

      const codes = response.json().violations.map((entry: { code: string }) => entry.code);
      expect(codes).toContain('INSUFFICIENT_NOTICE');
      expect(codes).toContain('INSUFFICIENT_BALANCE');
    });

    it('counts a half day as half a day', async () => {
      const day = futureWeekday(60);
      const response = await hcm.post(`${BASE}/leave-requests/validate`, {
        employeeId: 'E10001',
        leaveTypeCode: 'ANNUAL',
        startDate: day,
        endDate: day,
        startDayPortion: 'SECOND_HALF',
      });

      expect(response.json().requestedDays).toBe(0.5);
    });

    it('rejects a malformed date rather than guessing', async () => {
      const response = await hcm.post(`${BASE}/leave-requests/validate`, {
        employeeId: 'E10001',
        leaveTypeCode: 'ANNUAL',
        startDate: '2026-02-31',
        endDate: '2026-02-31',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an unknown field instead of ignoring it', async () => {
      const response = await hcm.post(`${BASE}/leave-requests/validate`, {
        employeeId: 'E10001',
        leaveTypeCode: 'ANNUAL',
        startDate: futureWeekday(60),
        endDate: futureWeekday(60),
        approveImmediately: true,
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
