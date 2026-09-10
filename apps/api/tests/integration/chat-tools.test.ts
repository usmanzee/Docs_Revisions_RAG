/**
 * The chat pipeline with leave tools, end to end over HTTP.
 *
 * The model is scripted so the assertions are about the pipeline - event order,
 * gating, persistence, identity - rather than about what a real model chose to
 * do on a given day.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import type { LeaveBalance, LeaveRequest, LeaveValidationResult } from '@docs-rag/hcm-contract';
import { buildApp } from '../../src/app.js';
import { createContainer } from '../../src/container.js';
import { closeTestPool, getTestPool, testConfig, truncateAll } from '../helpers/database.js';
import { createHarness, generateFixtureCorpus, type TestHarness } from '../helpers/fixtures.js';
import { StubChatModel } from '../helpers/stub-chat-model.js';
import type { HcmClient } from '../../src/modules/hcm/index.js';
import { HcmClientError } from '../../src/modules/hcm/index.js';

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

const submitted = {
  requestId: 'req-1',
  requestNumber: 'LR-2026-000042',
  leaveTypeCode: 'ANNUAL',
  leaveTypeName: 'Annual Leave',
  startDate: '2026-11-16',
  endDate: '2026-11-18',
  totalDays: 3,
  status: 'PENDING_APPROVAL',
  approverName: 'Daniel Whitfield',
} as unknown as LeaveRequest;

/** Records what it was asked, so identity can be asserted. */
class RecordingHcm implements HcmClient {
  readonly name = 'recording';
  readonly balanceCalls: string[] = [];
  readonly applyCalls: unknown[] = [];
  failApply = false;

  isConfigured(): boolean {
    return true;
  }
  async ping(): Promise<boolean> {
    return true;
  }
  async getEmployee(): Promise<never> {
    throw new Error('not used');
  }
  async listLeaveTypes(): Promise<never> {
    throw new Error('not used');
  }
  async getLeaveBalances(employeeId: string): Promise<LeaveBalance[]> {
    this.balanceCalls.push(employeeId);
    return [balance];
  }
  async getLeaveBalance(employeeId: string): Promise<LeaveBalance> {
    this.balanceCalls.push(employeeId);
    return balance;
  }
  async getLeaveHistory() {
    return { items: [submitted], count: 1, limit: 20, offset: 0, hasMore: false, totalResults: 1 };
  }
  async getLeaveRequest(): Promise<LeaveRequest> {
    return submitted;
  }
  async validateLeaveRequest(): Promise<LeaveValidationResult> {
    return validation;
  }
  async applyForLeave(input: unknown): Promise<LeaveRequest> {
    if (this.failApply) {
      throw new HcmClientError('RULE_VIOLATION', 'Refused', 422, undefined, [
        { code: 'INSUFFICIENT_BALANCE', message: 'Only 2 days remain.', severity: 'ERROR' },
      ]);
    }
    this.applyCalls.push(input);
    return submitted;
  }
  async withdrawLeaveRequest(): Promise<LeaveRequest> {
    return { ...submitted, status: 'WITHDRAWN' } as LeaveRequest;
  }
  async cancelLeaveRequest(): Promise<LeaveRequest> {
    return { ...submitted, status: 'CANCELLED' } as LeaveRequest;
  }
}

/** Parse an SSE payload into ordered events. */
function parseSse(payload: string): { event: string; data: Record<string, unknown> }[] {
  return payload
    .split('\n\n')
    .filter((frame) => frame.startsWith('event:'))
    .map((frame) => {
      const event = /^event: (\w+)/.exec(frame)?.[1] ?? '';
      const data = frame.split('data: ')[1] ?? '{}';
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

describe('chat with leave tools', () => {
  let pool: pg.Pool;
  let harness: TestHarness;
  let app: FastifyInstance;
  let chatModel: StubChatModel;
  let hcm: RecordingHcm;

  beforeAll(async () => {
    pool = await getTestPool();
    await truncateAll();

    harness = await createHarness(testConfig(), pool);
    await generateFixtureCorpus(harness, { count: 4 });
    await harness.ingestion.run({ trigger: 'TEST' });

    chatModel = new StubChatModel();
    hcm = new RecordingHcm();

    const container = createContainer({
      config: {
        ...harness.config,
        hcm: { ...harness.config.hcm, baseUrl: 'http://stub', toolsEnabled: true, defaultEmployeeId: 'emp-0001' },
      },
      pool,
      storage: harness.storage,
      embeddings: harness.embeddings,
      chatModel,
      hcm,
      withScheduler: false,
    });

    app = await buildApp({ container });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await harness.cleanup();
    await closeTestPool();
  });

  beforeEach(() => {
    chatModel.setOptions({});
    hcm.failApply = false;
  });

  const ask = (message: string) => app.inject({ method: 'POST', url: '/api/chat', payload: { message } });

  it('offers the leave tools to the model', async () => {
    await ask('How many leave days do I have?');

    const offered = chatModel.toolRequests.at(0)?.tools.map((tool) => tool.name) ?? [];
    expect(offered).toContain('get_leave_balance');
    expect(offered).toContain('validate_leave_request');
    expect(offered).toContain('apply_for_leave');
  });

  it('still supplies retrieved document context alongside the tools', async () => {
    await ask('What does the policy say about carry-over?');

    // The current question is the last user turn; earlier ones are history.
    const userTurn = chatModel.toolRequests.at(-1)?.turns.findLast((turn) => turn.role === 'user');
    expect((userTurn as { content: string }).content).toContain('BEGIN DOCUMENT CONTEXT');
  });

  it('describes the leave capability in the system prompt only when tools exist', async () => {
    await ask('Anything');
    expect(chatModel.toolRequests.at(-1)?.system).toContain('LEAVE MANAGEMENT');
    // And it always states today's date, so relative dates can be resolved.
    expect(chatModel.toolRequests.at(-1)?.system).toMatch(/Today is \w+day, \d{4}-\d{2}-\d{2}/);
  });

  it('streams a tool event and answers from the tool result', async () => {
    chatModel.setOptions({
      toolCallScript: [[{ id: 'c1', name: 'get_leave_balance', arguments: { leaveTypeCode: 'ANNUAL' } }]],
    });

    const response = await ask('How many leave days do I have left?');
    const events = parseSse(response.payload);

    const order = events.map((entry) => entry.event);
    expect(order[0]).toBe('metadata');
    expect(order).toContain('tool');
    expect(order.at(-1)).toBe('complete');

    const toolEvent = events.find((entry) => entry.event === 'tool');
    const activity = toolEvent?.data.activity as Record<string, unknown>;
    expect(activity.name).toBe('get_leave_balance');
    expect(activity.error).toBeNull();
    expect(String(activity.summary)).toContain('available now: 14 days');

    // The answer was built from the tool output.
    const tokens = events
      .filter((entry) => entry.event === 'token')
      .map((entry) => entry.data.text)
      .join('');
    expect(tokens).toContain('14 days');
  });

  it('uses the session employee, not anything the model supplied', async () => {
    hcm.balanceCalls.length = 0;
    chatModel.setOptions({
      toolCallScript: [
        [{ id: 'c1', name: 'get_leave_balance', arguments: { leaveTypeCode: 'ANNUAL' } }],
      ],
    });

    await ask('My balance please');

    expect(hcm.balanceCalls).toEqual(['emp-0001']);
  });

  it('marks the answer ANSWERED when grounded in tools rather than citations', async () => {
    chatModel.setOptions({
      toolCallScript: [[{ id: 'c1', name: 'get_leave_balance', arguments: {} }]],
    });

    const response = await ask('How much leave do I have?');
    const complete = parseSse(response.payload).find((entry) => entry.event === 'complete');

    // A balance answer legitimately has no document citation.
    expect(complete?.data.answerStatus).toBe('ANSWERED');
  });

  it('refuses to book leave that was never validated', async () => {
    chatModel.setOptions({
      toolCallScript: [
        [
          {
            id: 'c1',
            name: 'apply_for_leave',
            arguments: { leaveTypeCode: 'ANNUAL', startDate: '2026-11-16', endDate: '2026-11-18' },
          },
        ],
      ],
    });

    const response = await ask('Book me off 16 to 18 November');
    const events = parseSse(response.payload);
    const activity = events.find((entry) => entry.event === 'tool')?.data.activity as Record<string, unknown>;

    expect(activity.error).toBe('prerequisite not satisfied');
    expect(hcm.applyCalls).toHaveLength(0);
  });

  it('books leave once validation has run in the same turn', async () => {
    hcm.applyCalls.length = 0;
    const args = { leaveTypeCode: 'ANNUAL', startDate: '2026-11-16', endDate: '2026-11-18' };

    chatModel.setOptions({
      toolCallScript: [
        [{ id: 'c1', name: 'validate_leave_request', arguments: args }],
        [{ id: 'c2', name: 'apply_for_leave', arguments: args }],
      ],
    });

    const response = await ask('Yes, please book it');
    const events = parseSse(response.payload);
    const tools = events
      .filter((entry) => entry.event === 'tool')
      .map((entry) => (entry.data.activity as { name: string }).name);

    expect(tools).toEqual(['validate_leave_request', 'apply_for_leave']);
    expect(hcm.applyCalls).toHaveLength(1);
  });

  it('reports a refused booking as a refusal, not a crash', async () => {
    hcm.failApply = true;
    const args = { leaveTypeCode: 'ANNUAL', startDate: '2026-11-16', endDate: '2026-11-18' };

    chatModel.setOptions({
      toolCallScript: [
        [{ id: 'c1', name: 'validate_leave_request', arguments: args }],
        [{ id: 'c2', name: 'apply_for_leave', arguments: args }],
      ],
    });

    const response = await ask('Book it');
    expect(response.statusCode).toBe(200);

    const events = parseSse(response.payload);
    expect(events.map((entry) => entry.event)).not.toContain('error');

    const applyActivity = events
      .filter((entry) => entry.event === 'tool')
      .map((entry) => entry.data.activity as Record<string, unknown>)
      .find((activity) => activity.name === 'apply_for_leave');

    expect(applyActivity?.refused).toBe(true);
    expect(String(applyActivity?.summary)).toContain('INSUFFICIENT_BALANCE');
  });

  it('persists tool activity with the message', async () => {
    chatModel.setOptions({
      toolCallScript: [[{ id: 'c1', name: 'get_leave_balance', arguments: {} }]],
    });

    const response = await ask('Balance?');
    const complete = parseSse(response.payload).find((entry) => entry.event === 'complete');
    const conversationId = parseSse(response.payload)[0]?.data.conversationId as string;

    expect((complete?.data.toolActivity as unknown[]).length).toBe(1);

    const messages = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages`,
    });

    const assistant = (messages.json() as { role: string; toolActivity: unknown[] }[]).find(
      (message) => message.role === 'assistant',
    );
    expect(assistant?.toolActivity).toHaveLength(1);
  });

  it('bounds the loop so a model asking for tools forever cannot spin', async () => {
    // More batches than CHAT_MAX_TOOL_ITERATIONS allows.
    chatModel.setOptions({
      toolCallScript: Array.from({ length: 10 }, (_value, index) => [
        { id: `c${index}`, name: 'get_leave_history', arguments: {} },
      ]),
    });

    const response = await ask('Loop please');
    const events = parseSse(response.payload);

    expect(response.statusCode).toBe(200);
    expect(events.at(-1)?.event).toBe('complete');
    // Bounded by CHAT_MAX_TOOL_ITERATIONS: tools are withdrawn on the final
    // permitted iteration, so at most one batch per earlier iteration runs.
    expect(events.filter((entry) => entry.event === 'tool').length).toBeLessThanOrEqual(
      harness.config.hcm.maxToolIterations,
    );
  });
});

describe('chat without an HCM configured', () => {
  let pool: pg.Pool;
  let harness: TestHarness;
  let app: FastifyInstance;
  let chatModel: StubChatModel;

  beforeAll(async () => {
    pool = await getTestPool();
    await truncateAll();

    harness = await createHarness(testConfig(), pool);
    await generateFixtureCorpus(harness, { count: 3 });
    await harness.ingestion.run({ trigger: 'TEST' });

    chatModel = new StubChatModel();

    const container = createContainer({
      config: { ...harness.config, hcm: { ...harness.config.hcm, baseUrl: null, toolsEnabled: false } },
      pool,
      storage: harness.storage,
      embeddings: harness.embeddings,
      chatModel,
      withScheduler: false,
    });

    app = await buildApp({ container });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await harness.cleanup();
    await closeTestPool();
  });

  it('offers no leave tools and does not mention the capability', async () => {
    await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'Do I have leave left?' } });

    const request = chatModel.toolRequests.at(-1);
    expect(request?.tools).toHaveLength(0);
    // Promising a capability that does not exist is worse than staying quiet.
    expect(request?.system).not.toContain('LEAVE MANAGEMENT');
  });

  it('still answers document questions normally', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { message: 'What expenses require Finance Director approval?' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toContain('event: citation');
  });
});
