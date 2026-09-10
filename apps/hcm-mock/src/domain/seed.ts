/**
 * Deterministic seed population.
 *
 * The employees are chosen to cover the situations the assistant will actually
 * hit, not to be a plausible org chart:
 *
 *   - someone with a healthy balance          (the happy path)
 *   - someone with almost none left           (INSUFFICIENT_BALANCE)
 *   - someone still on probation              (PROBATION_RESTRICTION)
 *   - a contractor                            (LEAVE_TYPE_NOT_ELIGIBLE)
 *   - someone part-time                       (pro-rated entitlement)
 *   - someone with a pending request          (OVERLAPPING_REQUEST)
 *   - an inactive leaver                      (EMPLOYEE_INACTIVE)
 *
 * Every one of those is a branch in the rules engine that would otherwise only
 * be reachable by hand-editing data mid-demo.
 */

import type { Employee, LeaveRequest, LeaveTypeCode } from '@docs-rag/hcm-contract';
import type { LeaveRules } from '../config.js';
import { addDays, addMonths, compareDates, splitWorkingDays, today } from './calendar.js';
import { buildRequestDays, totalDaysFor } from './rules.js';
import type { HcmStore } from './store.js';

/** Small deterministic PRNG, so a seed always produces the same population. */
class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = (seed >>> 0) || 1;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)] as T;
  }
}

const FULL_WEEK = [1, 2, 3, 4, 5];

interface Profile {
  employeeNumber: string;
  firstName: string;
  lastName: string;
  department: string;
  jobTitle: string;
  employmentType: Employee['employmentType'];
  managerNumber: string | null;
  /** Months of service. Negative values are not used; small = on probation. */
  serviceMonths: number;
  workingDays?: number[];
  active?: boolean;
  /** Approved leave already taken this year, to shape the opening balance. */
  daysAlreadyTaken?: number;
  /** A pending future request, for the overlap scenario. */
  pendingRequest?: { inDays: number; lengthDays: number; leaveTypeCode: LeaveTypeCode };
  note: string;
}

/**
 * The fixed cast. Deliberately hand-written rather than generated: each one
 * exists to make a specific rule reachable, and a random population would only
 * cover them by luck.
 */
const PROFILES: Profile[] = [
  {
    employeeNumber: 'E10001',
    firstName: 'Amara',
    lastName: 'Okafor',
    department: 'Finance',
    jobTitle: 'Financial Analyst',
    employmentType: 'PERMANENT',
    managerNumber: 'E10002',
    serviceMonths: 38,
    daysAlreadyTaken: 6,
    note: 'Healthy balance. The default happy path.',
  },
  {
    employeeNumber: 'E10002',
    firstName: 'Daniel',
    lastName: 'Whitfield',
    department: 'Finance',
    jobTitle: 'Finance Director',
    employmentType: 'PERMANENT',
    managerNumber: null,
    serviceMonths: 96,
    daysAlreadyTaken: 11,
    note: 'Senior grade, higher entitlement. Approves the Finance team.',
  },
  {
    employeeNumber: 'E10003',
    firstName: 'Priya',
    lastName: 'Raman',
    department: 'Information Technology',
    jobTitle: 'Systems Engineer',
    employmentType: 'PERMANENT',
    managerNumber: 'E10005',
    serviceMonths: 27,
    // Almost everything used: triggers INSUFFICIENT_BALANCE on most requests.
    daysAlreadyTaken: 18,
    note: 'Nearly out of leave. Use to demonstrate a refused request.',
  },
  {
    employeeNumber: 'E10004',
    firstName: 'Tomas',
    lastName: 'Nowak',
    department: 'Information Technology',
    jobTitle: 'Junior Developer',
    employmentType: 'PERMANENT',
    managerNumber: 'E10005',
    // Under the probation threshold.
    serviceMonths: 1,
    note: 'On probation. Annual leave is blocked; sick leave is not.',
  },
  {
    employeeNumber: 'E10005',
    firstName: 'Sarah',
    lastName: 'Lindqvist',
    department: 'Information Technology',
    jobTitle: 'Head of IT Operations',
    employmentType: 'PERMANENT',
    managerNumber: null,
    serviceMonths: 74,
    daysAlreadyTaken: 9,
    note: 'Senior grade. Approves the IT team.',
  },
  {
    employeeNumber: 'E10006',
    firstName: 'Marcus',
    lastName: 'Bello',
    department: 'Enterprise Applications',
    jobTitle: 'Integration Consultant',
    employmentType: 'CONTRACTOR',
    managerNumber: 'E10005',
    serviceMonths: 14,
    note: 'Contractor. Annual leave is not available; unpaid leave is.',
  },
  {
    employeeNumber: 'E10007',
    firstName: 'Grace',
    lastName: 'Adeyemi',
    department: 'Human Resources',
    jobTitle: 'HR Business Partner',
    employmentType: 'PERMANENT',
    managerNumber: null,
    serviceMonths: 52,
    // Three-day week: entitlement is pro-rated, and Thu/Fri are non-working.
    workingDays: [1, 2, 3],
    daysAlreadyTaken: 4,
    note: 'Part-time, three days a week. Pro-rated entitlement.',
  },
  {
    employeeNumber: 'E10008',
    firstName: 'Ravi',
    lastName: 'Chandran',
    department: 'Database Administration',
    jobTitle: 'Database Administrator',
    employmentType: 'PERMANENT',
    managerNumber: 'E10005',
    serviceMonths: 61,
    daysAlreadyTaken: 5,
    pendingRequest: { inDays: 45, lengthDays: 5, leaveTypeCode: 'ANNUAL' },
    note: 'Has a pending request 45 days out. Use to demonstrate an overlap clash.',
  },
  {
    employeeNumber: 'E10009',
    firstName: 'Elena',
    lastName: 'Moreau',
    department: 'Procurement',
    jobTitle: 'Procurement Officer',
    employmentType: 'FIXED_TERM',
    managerNumber: 'E10002',
    serviceMonths: 19,
    daysAlreadyTaken: 3,
    note: 'Fixed-term. Eligible for annual leave, not for parental or study leave.',
  },
  {
    employeeNumber: 'E10010',
    firstName: 'Peter',
    lastName: 'Osei',
    department: 'Operations',
    jobTitle: 'Operations Coordinator',
    employmentType: 'PERMANENT',
    managerNumber: null,
    serviceMonths: 41,
    active: false,
    note: 'Left the organisation. Requests must be refused.',
  },
];

function makeEmployee(profile: Profile, rules: LeaveRules, index: number): Employee {
  const now = today();
  const hireDate = addMonths(now, -profile.serviceMonths);
  const probationEndDate = addMonths(hireDate, rules.probationMonths);
  const onProbation = compareDates(now, probationEndDate) < 0;

  return {
    employeeId: `emp-${String(index + 1).padStart(4, '0')}`,
    employeeNumber: profile.employeeNumber,
    firstName: profile.firstName,
    lastName: profile.lastName,
    displayName: `${profile.firstName} ${profile.lastName}`,
    email: `${profile.firstName}.${profile.lastName}`.toLowerCase().replace(/[^a-z.]/g, '') + '@example.com',
    department: profile.department,
    jobTitle: profile.jobTitle,
    employmentType: profile.employmentType,
    managerId: null, // resolved in a second pass, once every id exists
    managerName: null,
    hireDate,
    onProbation,
    probationEndDate: onProbation ? probationEndDate : null,
    active: profile.active ?? true,
    workingDays: profile.workingDays ?? FULL_WEEK,
    location: 'GLOBAL',
  };
}

/** Build an approved historical request, used to shape opening balances. */
function makeHistoricalRequest(
  store: HcmStore,
  employee: Employee,
  startDate: string,
  targetDays: number,
  leaveTypeCode: LeaveTypeCode,
  status: LeaveRequest['status'],
  rng: Rng,
): LeaveRequest | null {
  // Walk the end date out until enough working days are covered.
  let endDate = startDate;
  for (let i = 0; i < 60; i += 1) {
    const { workingDates } = splitWorkingDays(startDate, endDate, employee.workingDays, employee.location);
    if (workingDates.length >= targetDays) break;
    endDate = addDays(endDate, 1);
  }

  const { workingDates } = splitWorkingDays(startDate, endDate, employee.workingDays, employee.location);
  if (workingDates.length === 0) return null;

  const days = buildRequestDays(workingDates, 'FULL_DAY', 'FULL_DAY');
  const year = startDate.slice(0, 4);
  const createdAt = new Date(`${addDays(startDate, -rng.int(20, 50))}T09:00:00.000Z`).toISOString();

  const request: LeaveRequest = {
    requestId: `req-${store.nextRequestNumber(year).toLowerCase()}`,
    requestNumber: '',
    employeeId: employee.employeeId,
    employeeNumber: employee.employeeNumber,
    employeeName: employee.displayName,
    leaveTypeCode,
    leaveTypeName: leaveTypeCode === 'ANNUAL' ? 'Annual Leave' : leaveTypeCode,
    startDate,
    endDate,
    startDayPortion: 'FULL_DAY',
    endDayPortion: 'FULL_DAY',
    totalDays: totalDaysFor(days),
    days,
    status,
    reason: rng.pick(['Family holiday', 'Personal time', 'Annual break', 'Long weekend', null]),
    comments: null,
    submittedAt: createdAt,
    decidedAt: status === 'APPROVED' ? new Date(`${addDays(startDate, -rng.int(5, 18))}T10:00:00.000Z`).toISOString() : null,
    decidedBy: status === 'APPROVED' ? employee.managerId : null,
    decidedByName: status === 'APPROVED' ? employee.managerName : null,
    withdrawnAt: null,
    cancelledAt: null,
    approverId: employee.managerId,
    approverName: employee.managerName,
    createdAt,
    updatedAt: createdAt,
  };

  // The id embeds the number, so derive the display number back out of it.
  request.requestNumber = request.requestId.replace(/^req-/, '').toUpperCase();
  return request;
}

export function seedStore(store: HcmStore, rules: LeaveRules, seed: number): void {
  const rng = new Rng(seed);
  store.reset();

  const employees = PROFILES.map((profile, index) => makeEmployee(profile, rules, index));
  const byNumber = new Map(employees.map((employee) => [employee.employeeNumber, employee]));

  // Second pass: wire up managers now that every employee has an id.
  for (const [index, profile] of PROFILES.entries()) {
    const employee = employees[index] as Employee;
    if (!profile.managerNumber) continue;
    const manager = byNumber.get(profile.managerNumber);
    if (!manager) continue;
    employee.managerId = manager.employeeId;
    employee.managerName = manager.displayName;
  }

  for (const employee of employees) store.putEmployee(employee);

  const now = today();

  for (const [index, profile] of PROFILES.entries()) {
    const employee = employees[index] as Employee;

    // Historical approved leave, spread across the year so far.
    let remaining = profile.daysAlreadyTaken ?? 0;
    let cursor = addDays(now, -rng.int(150, 210));

    while (remaining > 0) {
      const chunk = Math.min(remaining, rng.int(1, 5));
      const request = makeHistoricalRequest(store, employee, cursor, chunk, 'ANNUAL', 'APPROVED', rng);
      if (request) {
        store.putRequest(request);
        remaining -= request.totalDays;
        cursor = addDays(request.endDate, rng.int(14, 40));
      } else {
        cursor = addDays(cursor, 7);
      }
      // Stop if the walk would run past today.
      if (compareDates(cursor, now) >= 0) break;
    }

    if (profile.pendingRequest) {
      const request = makeHistoricalRequest(
        store,
        employee,
        addDays(now, profile.pendingRequest.inDays),
        profile.pendingRequest.lengthDays,
        profile.pendingRequest.leaveTypeCode,
        'PENDING_APPROVAL',
        rng,
      );
      if (request) store.putRequest(request);
    }
  }
}

/** Notes describing why each seeded employee exists. Surfaced by the API. */
export const SEED_NOTES: Readonly<Record<string, string>> = Object.fromEntries(
  PROFILES.map((profile) => [profile.employeeNumber, profile.note]),
);
