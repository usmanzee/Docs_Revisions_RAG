/**
 * HCM API routes.
 *
 * Paths follow the shape enterprise HCM systems publish: a versioned base path,
 * employee-scoped sub-resources for things that belong to a person, and
 * top-level resources for things addressed by their own identifier.
 */

import type { FastifyInstance } from 'fastify';
import {
  applyLeaveSchema,
  balanceQuerySchema,
  cancelLeaveSchema,
  decideLeaveSchema,
  HCM_CONTRACT_VERSION,
  leaveRequestQuerySchema,
  validateLeaveSchema,
  withdrawLeaveSchema,
  type LeaveTypeCode,
} from '@docs-rag/hcm-contract';
import { z } from 'zod';
import type { LeaveService } from '../domain/leave-service.js';
import { HcmError } from '../domain/leave-service.js';
import { SEED_NOTES } from '../domain/seed.js';
import { holidaysBetween } from '../domain/calendar.js';

const employeeParam = z.object({ employeeId: z.string().min(1).max(64) });
const requestParam = z.object({ requestId: z.string().min(1).max(128) });
const leaveTypeParam = employeeParam.extend({
  leaveTypeCode: z.string().min(1).max(32),
});

const holidayQuery = z.object({
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  location: z.string().max(64).default('GLOBAL'),
});

export interface RouteDeps {
  service: LeaveService;
  contractVersion?: string;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { service } = deps;

  // Every response advertises the contract version, so a client can detect
  // drift explicitly instead of discovering it through a parse failure.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-hcm-contract-version', deps.contractVersion ?? HCM_CONTRACT_VERSION);
    return payload;
  });

  // --- service metadata --------------------------------------------------

  app.get('/health', async () => ({
    status: 'ok',
    service: 'hcm-mock',
    contractVersion: HCM_CONTRACT_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
  }));

  /** Human-readable index. Useful when poking at the service by hand. */
  app.get('/', async () => ({
    service: 'Mock HCM leave-management API',
    contractVersion: HCM_CONTRACT_VERSION,
    note: 'Stand-in for the real HCM backend. Same contract, disposable data.',
    authentication: 'Authorization: Bearer <HCM_MOCK_API_KEY>',
    endpoints: [
      'GET    /hcm/api/v1/leave-types',
      'GET    /hcm/api/v1/public-holidays?fromDate=&toDate=',
      'GET    /hcm/api/v1/employees',
      'GET    /hcm/api/v1/employees/:employeeId',
      'GET    /hcm/api/v1/employees/:employeeId/leave-balances',
      'GET    /hcm/api/v1/employees/:employeeId/leave-balances/:leaveTypeCode',
      'GET    /hcm/api/v1/employees/:employeeId/leave-requests',
      'POST   /hcm/api/v1/leave-requests',
      'POST   /hcm/api/v1/leave-requests/validate',
      'GET    /hcm/api/v1/leave-requests/:requestId',
      'POST   /hcm/api/v1/leave-requests/:requestId/withdraw',
      'POST   /hcm/api/v1/leave-requests/:requestId/cancel',
      'POST   /hcm/api/v1/leave-requests/:requestId/decision',
    ],
  }));

  await app.register(
    async (api) => {
      // --- reference data ------------------------------------------------

      api.get('/leave-types', async () => ({ items: service.listLeaveTypes() }));

      api.get('/public-holidays', async (request) => {
        const query = holidayQuery.parse(request.query);
        return {
          items: holidaysBetween(query.fromDate, query.toDate, query.location).map((holiday) => ({
            date: holiday.date,
            name: holiday.name,
            location: holiday.location,
          })),
        };
      });

      // --- employees -----------------------------------------------------

      /**
       * Employee directory.
       *
       * A real HCM would not expose this so freely, but the assistant needs a
       * way to resolve "who am I talking about", and the seed notes make the
       * fixtures self-documenting during development.
       */
      api.get('/employees', async () => ({
        items: service.listEmployees().map((employee) => ({
          ...employee,
          // Why this fixture exists, so the population is self-documenting.
          seedNote: SEED_NOTES[employee.employeeNumber] ?? null,
        })),
      }));

      api.get('/employees/:employeeId', async (request) => {
        const { employeeId } = employeeParam.parse(request.params);
        return service.requireEmployee(employeeId);
      });

      // --- balances -------------------------------------------------------

      api.get('/employees/:employeeId/leave-balances', async (request) => {
        const { employeeId } = employeeParam.parse(request.params);
        const query = balanceQuerySchema.parse(request.query ?? {});
        const employee = service.requireEmployee(employeeId);
        return { items: service.balancesFor(employee, query.asOfDate) };
      });

      api.get('/employees/:employeeId/leave-balances/:leaveTypeCode', async (request) => {
        const params = leaveTypeParam.parse(request.params);
        const query = balanceQuerySchema.parse(request.query ?? {});
        const employee = service.requireEmployee(params.employeeId);
        return service.balanceFor(
          employee,
          params.leaveTypeCode.toUpperCase() as LeaveTypeCode,
          query.asOfDate,
        );
      });

      // --- history --------------------------------------------------------

      api.get('/employees/:employeeId/leave-requests', async (request) => {
        const { employeeId } = employeeParam.parse(request.params);
        const query = leaveRequestQuerySchema.parse(request.query ?? {});
        const employee = service.requireEmployee(employeeId);
        return service.history(employee, query);
      });

      // --- requests -------------------------------------------------------

      /**
       * Dry-run validation.
       *
       * Registered before the `:requestId` routes so "validate" is never
       * mistaken for an identifier.
       */
      api.post('/leave-requests/validate', async (request) => {
        const body = validateLeaveSchema.parse(request.body);
        return service.validate(body);
      });

      api.post('/leave-requests', async (request, reply) => {
        const body = applyLeaveSchema.parse(request.body);
        const created = service.apply(body);
        return reply.status(201).send(created);
      });

      api.get('/leave-requests/:requestId', async (request) => {
        const { requestId } = requestParam.parse(request.params);
        return service.requireRequest(requestId);
      });

      api.post('/leave-requests/:requestId/withdraw', async (request) => {
        const { requestId } = requestParam.parse(request.params);
        const body = withdrawLeaveSchema.parse(request.body ?? {});
        return service.withdraw(requestId, body.reason);
      });

      api.post('/leave-requests/:requestId/cancel', async (request) => {
        const { requestId } = requestParam.parse(request.params);
        const body = cancelLeaveSchema.parse(request.body ?? {});
        return service.cancel(requestId, body.reason);
      });

      /**
       * Manager decision.
       *
       * A POST to a sub-resource rather than a PATCH on the request: approving
       * is an action with its own authority rules, not a field edit, and
       * modelling it as one keeps that distinction visible.
       */
      api.post('/leave-requests/:requestId/decision', async (request) => {
        const { requestId } = requestParam.parse(request.params);
        const body = decideLeaveSchema.parse(request.body);
        return service.decide(requestId, body);
      });
    },
    { prefix: '/hcm/api/v1' },
  );
}

export { HcmError };
