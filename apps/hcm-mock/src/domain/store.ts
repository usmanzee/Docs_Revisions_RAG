/**
 * In-memory data store with optional file persistence.
 *
 * A stand-in for an external system should not share the RAG database - doing
 * so would blur exactly the boundary this service exists to model. It keeps its
 * own state, and snapshots it to JSON so a demo survives a restart.
 *
 * The store owns *facts* (employees, requests). Balances are derived on read
 * rather than stored, because a stored balance and a set of requests can
 * disagree, and when they do the balance is always the one that is wrong.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Employee, LeaveRequest, LeaveTypeCode } from '@docs-rag/hcm-contract';

export interface StoreSnapshot {
  version: 1;
  seed: number;
  employees: Employee[];
  requests: LeaveRequest[];
  sequence: number;
  /** Maps an idempotency key to the request it created. */
  idempotency: Record<string, string>;
}

export class HcmStore {
  private employees = new Map<string, Employee>();
  private requests = new Map<string, LeaveRequest>();
  private idempotency = new Map<string, string>();
  private sequence = 0;

  constructor(private readonly persistPath: string | null) {}

  // --- lifecycle ---------------------------------------------------------

  load(snapshot: StoreSnapshot): void {
    this.employees = new Map(snapshot.employees.map((employee) => [employee.employeeId, employee]));
    this.requests = new Map(snapshot.requests.map((request) => [request.requestId, request]));
    this.idempotency = new Map(Object.entries(snapshot.idempotency ?? {}));
    this.sequence = snapshot.sequence;
  }

  snapshot(seed: number): StoreSnapshot {
    return {
      version: 1,
      seed,
      employees: [...this.employees.values()],
      requests: [...this.requests.values()],
      sequence: this.sequence,
      idempotency: Object.fromEntries(this.idempotency),
    };
  }

  /** Read a snapshot from disk. Returns null when absent or unreadable. */
  readPersisted(): StoreSnapshot | null {
    if (!this.persistPath) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.persistPath, 'utf8')) as StoreSnapshot;
      // A snapshot from an older shape is discarded rather than migrated: this
      // is a mock, and a confusing half-migrated state is worse than a reseed.
      return parsed.version === 1 ? parsed : null;
    } catch {
      return null;
    }
  }

  persist(seed: number): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(path.dirname(this.persistPath), { recursive: true });
      writeFileSync(this.persistPath, `${JSON.stringify(this.snapshot(seed), null, 2)}\n`, 'utf8');
    } catch {
      // Persistence is a convenience; losing it must not fail a request.
    }
  }

  reset(): void {
    this.employees.clear();
    this.requests.clear();
    this.idempotency.clear();
    this.sequence = 0;
  }

  // --- employees ---------------------------------------------------------

  putEmployee(employee: Employee): void {
    this.employees.set(employee.employeeId, employee);
  }

  getEmployee(employeeId: string): Employee | null {
    return this.employees.get(employeeId) ?? null;
  }

  /**
   * Resolve by internal id, employee number or email.
   *
   * Real callers quote whichever identifier they happen to have, and a chatbot
   * will have whatever the user typed. Accepting all three here removes a whole
   * class of "employee not found" that is really "wrong identifier kind".
   */
  findEmployee(identifier: string): Employee | null {
    const direct = this.employees.get(identifier);
    if (direct) return direct;

    const needle = identifier.trim().toLowerCase();
    for (const employee of this.employees.values()) {
      if (
        employee.employeeNumber.toLowerCase() === needle ||
        employee.email.toLowerCase() === needle
      ) {
        return employee;
      }
    }
    return null;
  }

  listEmployees(): Employee[] {
    return [...this.employees.values()].sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber));
  }

  // --- requests ----------------------------------------------------------

  putRequest(request: LeaveRequest): void {
    this.requests.set(request.requestId, request);
  }

  getRequest(requestId: string): LeaveRequest | null {
    const byId = this.requests.get(requestId);
    if (byId) return byId;

    // Also accept the human-quotable request number.
    for (const request of this.requests.values()) {
      if (request.requestNumber.toLowerCase() === requestId.trim().toLowerCase()) return request;
    }
    return null;
  }

  requestsForEmployee(employeeId: string): LeaveRequest[] {
    return [...this.requests.values()].filter((request) => request.employeeId === employeeId);
  }

  requestsForEmployeeAndType(employeeId: string, leaveTypeCode: LeaveTypeCode): LeaveRequest[] {
    return this.requestsForEmployee(employeeId).filter(
      (request) => request.leaveTypeCode === leaveTypeCode,
    );
  }

  allRequests(): LeaveRequest[] {
    return [...this.requests.values()];
  }

  // --- identifiers -------------------------------------------------------

  nextRequestNumber(year: string): string {
    this.sequence += 1;
    return `LR-${year}-${String(this.sequence).padStart(6, '0')}`;
  }

  rememberIdempotencyKey(key: string, requestId: string): void {
    this.idempotency.set(key, requestId);
  }

  requestForIdempotencyKey(key: string): LeaveRequest | null {
    const requestId = this.idempotency.get(key);
    return requestId ? (this.requests.get(requestId) ?? null) : null;
  }
}
