/**
 * Mock HCM configuration.
 *
 * The leave *rules* are configurable rather than hardcoded, for two reasons.
 * A real HCM system configures absence plans per organisation, so hardcoding
 * would be unrealistic. And these defaults deliberately mirror the Annual Leave
 * Policy in the document corpus (HR-POL-001) - the whole point of the eventual
 * integration is that the assistant can cite the policy *and* act on the system
 * that implements it, so the two must agree.
 *
 * If the corpus is regenerated with a different seed its numbers will change,
 * and these defaults should be brought back into line.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(): string {
  let dir = here;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'migrations'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const REPO_ROOT = findRepoRoot();
dotenv.config({ path: path.join(REPO_ROOT, '.env'), override: false, quiet: true });

const num = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
};

export interface LeaveRules {
  /** Days granted per leave year at standard grade. HR-POL-001. */
  standardEntitlementDays: number;
  /** Days granted at senior grade. */
  seniorEntitlementDays: number;
  /** Maximum days carried into the next leave year. */
  carryOverLimitDays: number;
  /** Months into the new year after which carried-over days lapse. */
  carryOverExpiryMonths: number;
  /** Calendar days' notice for a request of `shortLeaveThresholdDays` or fewer. */
  noticeShortDays: number;
  /** Calendar days' notice for a longer request. */
  noticeLongDays: number;
  /** Working days at or below which the short notice period applies. */
  shortLeaveThresholdDays: number;
  /** Maximum consecutive working days without an exception. */
  maxConsecutiveDays: number;
  /** Months of service before annual leave may be taken. */
  probationMonths: number;
  /** How far ahead a request may be made. */
  maxAdvanceBookingDays: number;
  /** Days beyond which supporting documentation is required for sick leave. */
  sickDocumentationAfterDays: number;
}

export interface MockConfig {
  host: string;
  port: number;
  corsOrigins: string[];
  /** Bearer token callers must present. Mirrors a real system's API credential. */
  apiKey: string;
  /** Artificial latency, so the client is built against realistic timing. */
  latencyMs: number;
  /** Probability [0,1] of returning a 503, to exercise client error handling. */
  errorRate: number;
  /** Where the in-memory store is snapshotted, so restarts keep state. */
  persistPath: string | null;
  /** Deterministic seed for the generated employee population. */
  seed: number;
  employeeCount: number;
  logLevel: string;
  logPretty: boolean;
  rules: LeaveRules;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MockConfig {
  const persist = env.HCM_MOCK_PERSIST_PATH ?? path.join(REPO_ROOT, 'data', 'hcm-mock-state.json');

  return {
    host: env.HCM_MOCK_HOST ?? '0.0.0.0',
    port: num(env.HCM_MOCK_PORT, 3100),
    corsOrigins: (env.HCM_MOCK_CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:3000')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    apiKey: env.HCM_MOCK_API_KEY ?? 'hcm-dev-key',
    latencyMs: num(env.HCM_MOCK_LATENCY_MS, 0),
    errorRate: Math.min(1, Math.max(0, num(env.HCM_MOCK_ERROR_RATE, 0))),
    persistPath: bool(env.HCM_MOCK_PERSIST, true) ? persist : null,
    seed: num(env.HCM_MOCK_SEED, 20260101),
    employeeCount: num(env.HCM_MOCK_EMPLOYEE_COUNT, 12),
    logLevel: env.HCM_MOCK_LOG_LEVEL ?? env.LOG_LEVEL ?? 'info',
    logPretty: bool(env.LOG_PRETTY, true),
    rules: {
      standardEntitlementDays: num(env.HCM_RULE_STANDARD_ENTITLEMENT, 20),
      seniorEntitlementDays: num(env.HCM_RULE_SENIOR_ENTITLEMENT, 31),
      carryOverLimitDays: num(env.HCM_RULE_CARRY_OVER_LIMIT, 8),
      carryOverExpiryMonths: num(env.HCM_RULE_CARRY_OVER_EXPIRY_MONTHS, 4),
      noticeShortDays: num(env.HCM_RULE_NOTICE_SHORT_DAYS, 8),
      noticeLongDays: num(env.HCM_RULE_NOTICE_LONG_DAYS, 31),
      shortLeaveThresholdDays: num(env.HCM_RULE_SHORT_LEAVE_THRESHOLD, 5),
      maxConsecutiveDays: num(env.HCM_RULE_MAX_CONSECUTIVE_DAYS, 10),
      probationMonths: num(env.HCM_RULE_PROBATION_MONTHS, 3),
      maxAdvanceBookingDays: num(env.HCM_RULE_MAX_ADVANCE_DAYS, 400),
      sickDocumentationAfterDays: num(env.HCM_RULE_SICK_DOC_AFTER_DAYS, 3),
    },
  };
}
