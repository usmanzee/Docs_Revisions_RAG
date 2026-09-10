/**
 * Calendar arithmetic for leave.
 *
 * All dates here are calendar dates (`YYYY-MM-DD`), handled as UTC noon
 * internally. Noon rather than midnight is deliberate: it puts every date
 * comfortably inside its day in any timezone, so a daylight-saving shift or a
 * negative UTC offset cannot roll a date backwards - which is the single most
 * common source of off-by-one-day bugs in leave systems.
 */

export type CalendarDate = string;

export function toDate(value: CalendarDate): Date {
  return new Date(`${value}T12:00:00.000Z`);
}

export function toCalendarDate(date: Date): CalendarDate {
  return date.toISOString().slice(0, 10);
}

export function today(): CalendarDate {
  return toCalendarDate(new Date());
}

export function addDays(value: CalendarDate, days: number): CalendarDate {
  const date = toDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return toCalendarDate(date);
}

/**
 * Add months, clamping to the end of the target month.
 *
 * `setUTCMonth` overflows: 30 November plus three months becomes "30 February",
 * which JavaScript silently rolls forward to 2 March. For a probation end date
 * derived from a hire date that lands on the 29th to 31st, that quietly moves
 * the boundary by a day or two - and a leave request on exactly that boundary
 * would then be allowed or refused wrongly.
 *
 * Clamping to the last valid day is the conventional answer and the one users
 * expect: one month after 31 January is 28 February, not 3 March.
 */
export function addMonths(value: CalendarDate, months: number): CalendarDate {
  const date = toDate(value);
  const day = date.getUTCDate();

  // Move on the first of the month so the addition cannot overflow, then put
  // the day back, capped at however many days the target month actually has.
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);

  const daysInTargetMonth = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 12),
  ).getUTCDate();

  date.setUTCDate(Math.min(day, daysInTargetMonth));
  return toCalendarDate(date);
}

/** Whole days between two calendar dates. Positive when `to` is later. */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  const millis = toDate(to).getTime() - toDate(from).getTime();
  return Math.round(millis / 86_400_000);
}

export function compareDates(a: CalendarDate, b: CalendarDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** ISO-8601 weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(value: CalendarDate): number {
  const day = toDate(value).getUTCDay();
  return day === 0 ? 7 : day;
}

export function eachDate(from: CalendarDate, to: CalendarDate): CalendarDate[] {
  const dates: CalendarDate[] = [];
  for (let cursor = from; compareDates(cursor, to) <= 0; cursor = addDays(cursor, 1)) {
    dates.push(cursor);
  }
  return dates;
}

/**
 * Public holidays.
 *
 * Fixed-date holidays only, generated per year. A real HCM reads these from a
 * configured calendar per location; the shape of the lookup is what matters
 * here, not the accuracy of the dates.
 */
const FIXED_HOLIDAYS: { month: number; day: number; name: string }[] = [
  { month: 1, day: 1, name: "New Year's Day" },
  { month: 5, day: 1, name: 'Labour Day' },
  { month: 12, day: 25, name: 'Christmas Day' },
  { month: 12, day: 26, name: 'Boxing Day' },
];

export interface Holiday {
  date: CalendarDate;
  name: string;
  location: string;
}

export function holidaysForYear(year: number, location = 'GLOBAL'): Holiday[] {
  return FIXED_HOLIDAYS.map((holiday) => ({
    date: `${year}-${String(holiday.month).padStart(2, '0')}-${String(holiday.day).padStart(2, '0')}`,
    name: holiday.name,
    location,
  }));
}

export function holidaysBetween(from: CalendarDate, to: CalendarDate, location = 'GLOBAL'): Holiday[] {
  const firstYear = Number(from.slice(0, 4));
  const lastYear = Number(to.slice(0, 4));

  const holidays: Holiday[] = [];
  for (let year = firstYear; year <= lastYear; year += 1) {
    for (const holiday of holidaysForYear(year, location)) {
      if (compareDates(holiday.date, from) >= 0 && compareDates(holiday.date, to) <= 0) {
        holidays.push(holiday);
      }
    }
  }
  return holidays;
}

export interface WorkingDayBreakdown {
  /** Dates that count against the balance. */
  workingDates: CalendarDate[];
  /** Dates inside the range that are not charged, with the reason. */
  excluded: { date: CalendarDate; reason: 'WEEKEND' | 'PUBLIC_HOLIDAY'; name?: string }[];
}

/**
 * Split a date range into charged and uncharged days.
 *
 * A leave request spanning a weekend does not consume weekend days, and this is
 * the calculation employees most often dispute - so it returns the exclusions
 * with their reasons rather than just a count, letting a client show its work.
 */
export function splitWorkingDays(
  from: CalendarDate,
  to: CalendarDate,
  workingWeekdays: number[],
  location = 'GLOBAL',
): WorkingDayBreakdown {
  const holidayByDate = new Map(holidaysBetween(from, to, location).map((h) => [h.date, h]));
  const working = new Set(workingWeekdays);

  const workingDates: CalendarDate[] = [];
  const excluded: WorkingDayBreakdown['excluded'] = [];

  for (const date of eachDate(from, to)) {
    if (!working.has(isoWeekday(date))) {
      excluded.push({ date, reason: 'WEEKEND' });
      continue;
    }

    const holiday = holidayByDate.get(date);
    if (holiday) {
      excluded.push({ date, reason: 'PUBLIC_HOLIDAY', name: holiday.name });
      continue;
    }

    workingDates.push(date);
  }

  return { workingDates, excluded };
}

/** Leave year boundaries. Calendar-year aligned. */
export function leaveYearFor(date: CalendarDate): { year: string; start: CalendarDate; end: CalendarDate } {
  const year = date.slice(0, 4);
  return { year, start: `${year}-01-01`, end: `${year}-12-31` };
}

/**
 * Fraction of the leave year elapsed, used for monthly accrual.
 * Entitlement is earned as the year progresses rather than granted up front.
 */
export function accrualFraction(asOf: CalendarDate): number {
  const { start, end } = leaveYearFor(asOf);
  const elapsed = daysBetween(start, asOf) + 1;
  const total = daysBetween(start, end) + 1;
  return Math.min(1, Math.max(0, elapsed / total));
}

/** Round to half days, the smallest unit the system books. */
export function roundToHalfDay(value: number): number {
  return Math.round(value * 2) / 2;
}
