/**
 * A pinned clock for the whole suite.
 *
 * Almost everything in this domain is a date calculation relative to "now":
 * notice periods, accrual, probation, the leave year a request falls into, and
 * the seeded population's hire dates and leave history. A suite that reads the
 * real clock therefore tests a different scenario every day it runs, and
 * eventually a scenario the assertions were never written for.
 *
 * That is not hypothetical. These tests were green when written and three of
 * them began failing on 2026-11-02 without a line of code changing: the
 * balance assertions book `futureWeekday(60)`, which crossed from December into
 * January, and a request in next year's leave year correctly does not touch
 * this year's balance. The code was right; the test's idea of "sixty days from
 * now" had drifted out of the leave year it assumed.
 *
 * So the clock is frozen. Only `Date` is faked - timers are left real, because
 * Fastify's lifecycle runs on them.
 *
 * The date is chosen so that the window every test needs stays inside one leave
 * year:
 *   - `now + ~70 days` must not cross 31 December, or bookings land in the next
 *     leave year and stop affecting this year's balance;
 *   - `now - ~210 days` must not cross 1 January, or the seeded historical
 *     leave lands in the previous leave year and `takenDays` reads zero.
 * Mid-September satisfies both with room to spare.
 */

import { afterAll, beforeAll, vi } from 'vitest';

export const FIXED_NOW = new Date('2026-09-15T12:00:00.000Z');

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: FIXED_NOW });
});

afterAll(() => {
  vi.useRealTimers();
});
