/**
 * Leave type reference data.
 *
 * In a real HCM these are configured absence plans. Held as a constant here,
 * but shaped exactly like the resource the API returns, so a client that reads
 * `GET /leave-types` and caches it behaves the same against either system.
 */

import type { LeaveType, LeaveTypeCode } from '@docs-rag/hcm-contract';

export const LEAVE_TYPES: readonly LeaveType[] = [
  {
    code: 'ANNUAL',
    name: 'Annual Leave',
    description: 'Paid annual leave entitlement, accrued monthly across the leave year.',
    affectsBalance: true,
    paid: true,
    requiresApproval: true,
    documentationRequiredAfterDays: null,
    eligibleEmploymentTypes: ['PERMANENT', 'FIXED_TERM'],
    allowsRetroactiveRequest: false,
  },
  {
    code: 'SICK',
    name: 'Sick Leave',
    description: 'Paid absence due to illness. May be recorded after the fact.',
    affectsBalance: true,
    paid: true,
    requiresApproval: true,
    // Beyond three consecutive days a fit note is required.
    documentationRequiredAfterDays: 3,
    eligibleEmploymentTypes: ['PERMANENT', 'FIXED_TERM', 'INTERN'],
    // Sickness is not planned; back-dating it is the normal case, not an edge one.
    allowsRetroactiveRequest: true,
  },
  {
    code: 'UNPAID',
    name: 'Unpaid Leave',
    description: 'Authorised absence without pay. Does not draw on an entitlement balance.',
    affectsBalance: false,
    paid: false,
    requiresApproval: true,
    documentationRequiredAfterDays: null,
    eligibleEmploymentTypes: ['PERMANENT', 'FIXED_TERM', 'CONTRACTOR', 'INTERN'],
    allowsRetroactiveRequest: false,
  },
  {
    code: 'PARENTAL',
    name: 'Parental Leave',
    description: 'Statutory leave following the birth or adoption of a child.',
    affectsBalance: true,
    paid: true,
    requiresApproval: true,
    documentationRequiredAfterDays: null,
    eligibleEmploymentTypes: ['PERMANENT'],
    allowsRetroactiveRequest: false,
  },
  {
    code: 'COMPASSIONATE',
    name: 'Compassionate Leave',
    description: 'Paid leave following a bereavement or family emergency.',
    affectsBalance: true,
    paid: true,
    requiresApproval: true,
    documentationRequiredAfterDays: null,
    eligibleEmploymentTypes: ['PERMANENT', 'FIXED_TERM'],
    allowsRetroactiveRequest: true,
  },
  {
    code: 'STUDY',
    name: 'Study Leave',
    description: 'Paid leave for approved professional examinations and study.',
    affectsBalance: true,
    paid: true,
    requiresApproval: true,
    documentationRequiredAfterDays: null,
    eligibleEmploymentTypes: ['PERMANENT'],
    allowsRetroactiveRequest: false,
  },
];

const BY_CODE = new Map(LEAVE_TYPES.map((type) => [type.code, type]));

export function getLeaveType(code: LeaveTypeCode): LeaveType | null {
  return BY_CODE.get(code) ?? null;
}

/** Annual entitlement per type, as a share of the configured annual allowance. */
export const ENTITLEMENT_DAYS: Readonly<Record<LeaveTypeCode, number | 'ANNUAL_ALLOWANCE'>> = {
  ANNUAL: 'ANNUAL_ALLOWANCE',
  SICK: 10,
  UNPAID: 0,
  PARENTAL: 20,
  COMPASSIONATE: 5,
  STUDY: 5,
};
