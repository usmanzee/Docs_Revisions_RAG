/**
 * Calendar arithmetic.
 *
 * Worth testing on its own because leave systems get date handling wrong in
 * ways that are invisible until someone is charged for a Saturday.
 */

import { describe, expect, it } from 'vitest';
import {
  accrualFraction,
  addDays,
  addMonths,
  daysBetween,
  holidaysBetween,
  isoWeekday,
  leaveYearFor,
  roundToHalfDay,
  splitWorkingDays,
} from '../src/domain/calendar.js';

describe('calendar', () => {
  it('uses ISO weekday numbering', () => {
    expect(isoWeekday('2026-09-07')).toBe(1); // Monday
    expect(isoWeekday('2026-09-12')).toBe(6); // Saturday
    expect(isoWeekday('2026-09-13')).toBe(7); // Sunday
  });

  it('adds days across a month boundary', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('handles a leap year', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(daysBetween('2028-02-01', '2028-03-01')).toBe(29);
  });

  it('adds months, clamping to the end of a shorter target month', () => {
    expect(addMonths('2026-01-15', 3)).toBe('2026-04-15');
    // 30 Nov + 3 months would overflow "30 Feb"; it must clamp, not roll over.
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    // 2028 is a leap year, so the clamp lands on the 29th.
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
  });

  it('counts days between dates', () => {
    expect(daysBetween('2026-09-07', '2026-09-14')).toBe(7);
    expect(daysBetween('2026-09-14', '2026-09-07')).toBe(-7);
    expect(daysBetween('2026-09-07', '2026-09-07')).toBe(0);
  });

  describe('working days', () => {
    const fullWeek = [1, 2, 3, 4, 5];

    it('excludes weekends', () => {
      // Monday to Sunday.
      const result = splitWorkingDays('2026-09-07', '2026-09-13', fullWeek);
      expect(result.workingDates).toHaveLength(5);
      expect(result.excluded.map((entry) => entry.reason)).toEqual(['WEEKEND', 'WEEKEND']);
    });

    it('excludes public holidays with their name', () => {
      const result = splitWorkingDays('2026-12-24', '2026-12-28', fullWeek);
      const holidays = result.excluded.filter((entry) => entry.reason === 'PUBLIC_HOLIDAY');

      // Christmas Day 2026 is a Friday, so it is excluded as a holiday.
      expect(holidays.map((entry) => entry.name)).toContain('Christmas Day');
      expect(result.workingDates).not.toContain('2026-12-25');
    });

    it('classifies a holiday that lands on a weekend as a weekend', () => {
      // Boxing Day 2026 is a Saturday. It is not charged either way, and the
      // weekend is the honest reason - the day was never a working day.
      const result = splitWorkingDays('2026-12-26', '2026-12-26', fullWeek);
      expect(result.workingDates).toHaveLength(0);
      expect(result.excluded[0]?.reason).toBe('WEEKEND');
    });

    it('respects a part-time working pattern', () => {
      // Monday, Tuesday, Wednesday only.
      const result = splitWorkingDays('2026-09-07', '2026-09-11', [1, 2, 3]);
      expect(result.workingDates).toEqual(['2026-09-07', '2026-09-08', '2026-09-09']);
    });

    it('returns nothing chargeable for a weekend-only range', () => {
      const result = splitWorkingDays('2026-09-12', '2026-09-13', fullWeek);
      expect(result.workingDates).toHaveLength(0);
    });

    it('handles a single day', () => {
      expect(splitWorkingDays('2026-09-07', '2026-09-07', fullWeek).workingDates).toEqual(['2026-09-07']);
    });

    it('spans a year boundary', () => {
      const result = splitWorkingDays('2026-12-28', '2027-01-04', fullWeek);
      // New Year's Day falls in the range and must not be charged.
      expect(result.excluded.some((entry) => entry.name === "New Year's Day")).toBe(true);
    });
  });

  it('reports holidays inside a range only', () => {
    const holidays = holidaysBetween('2026-12-01', '2026-12-31');
    expect(holidays.map((holiday) => holiday.date)).toEqual(['2026-12-25', '2026-12-26']);
  });

  it('derives the leave year from a date', () => {
    expect(leaveYearFor('2026-06-15')).toEqual({
      year: '2026',
      start: '2026-01-01',
      end: '2026-12-31',
    });
  });

  it('accrues entitlement across the year', () => {
    expect(accrualFraction('2026-01-01')).toBeCloseTo(1 / 365, 3);
    expect(accrualFraction('2026-12-31')).toBe(1);
    expect(accrualFraction('2026-07-02')).toBeCloseTo(0.5, 1);
  });

  it('rounds to half days', () => {
    expect(roundToHalfDay(1.2)).toBe(1);
    expect(roundToHalfDay(1.3)).toBe(1.5);
    expect(roundToHalfDay(1.75)).toBe(2);
  });
});
