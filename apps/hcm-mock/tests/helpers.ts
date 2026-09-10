/**
 * Test harness for the mock HCM.
 *
 * Persistence is disabled: a test suite that writes a snapshot would leak state
 * into the next run and into the developer's own service.
 */

import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Response as InjectResponse } from 'light-my-request';
import { buildApp } from '../src/app.js';
import { loadConfig, type MockConfig } from '../src/config.js';
import type { LeaveService } from '../src/domain/leave-service.js';
import type { HcmStore } from '../src/domain/store.js';

export const API_KEY = 'test-key';
export const BASE = '/hcm/api/v1';

export function testConfig(overrides: Partial<MockConfig> = {}): MockConfig {
  return {
    ...loadConfig({}),
    apiKey: API_KEY,
    persistPath: null,
    latencyMs: 0,
    errorRate: 0,
    logLevel: 'silent',
    logPretty: false,
    ...overrides,
  };
}

export interface Harness {
  app: FastifyInstance;
  store: HcmStore;
  service: LeaveService;
  config: MockConfig;
  get(url: string): Promise<InjectResponse>;
  post(url: string, body?: unknown): Promise<InjectResponse>;
}

export async function createHarness(overrides: Partial<MockConfig> = {}): Promise<Harness> {
  const config = testConfig(overrides);
  const { app, store, service } = await buildApp(config);
  await app.ready();

  const headers = { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' };

  return {
    app,
    store,
    service,
    config,
    get: (url) => app.inject({ method: 'GET', url, headers } satisfies InjectOptions),
    post: (url, body) =>
      app.inject({ method: 'POST', url, headers, payload: body ?? {} } satisfies InjectOptions),
  };
}

/** A weekday far enough ahead to satisfy the long-notice rule. */
export function futureWeekday(daysAhead: number): string {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + daysAhead);
  // Nudge off a weekend so tests do not accidentally land on Saturday.
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return date.toISOString().slice(0, 10);
}
