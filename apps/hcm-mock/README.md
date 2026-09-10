# Mock HCM leave service

A stand-in for the real HCM backend, implementing the leave-management contract
so the assistant can be built and tested before the actual API is available.

It runs as **its own process on its own port (3100)**, not as routes bolted into
the main API. That is the point: the assistant talks to it over HTTP exactly as
it will talk to the real system, so swapping means changing a base URL and a
credential — not rewriting a pipeline.

```
apps/hcm-mock          this service (implements the contract)
packages/hcm-contract  the contract itself — types + Zod schemas
                       ↑ shared by the mock and, later, by the API's client
```

---

## Running it

```bash
nvm use
npm run dev:hcm              # just this service
npm run dev                  # hcm-mock + api + web together
```

```bash
curl localhost:3100/health
curl -H "Authorization: Bearer hcm-dev-key" localhost:3100/hcm/api/v1/employees
```

Every call except `/health` and `/` needs `Authorization: Bearer <HCM_MOCK_API_KEY>`,
because a real HCM is behind a credential and a client that never had an auth
path is a client that acquires one late.

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/hcm/api/v1/leave-types` | Reference data: types, eligibility, approval rules |
| `GET` | `/hcm/api/v1/public-holidays?fromDate=&toDate=` | Holidays, so a client can explain uncharged days |
| `GET` | `/hcm/api/v1/employees` | Directory (with seed notes, for development) |
| `GET` | `/hcm/api/v1/employees/:id` | One employee |
| `GET` | `/hcm/api/v1/employees/:id/leave-balances` | All balances |
| `GET` | `/hcm/api/v1/employees/:id/leave-balances/:type` | One balance |
| `GET` | `/hcm/api/v1/employees/:id/leave-requests` | History — filtered, paginated |
| `POST` | `/hcm/api/v1/leave-requests/validate` | **Dry run.** Same rules, nothing created |
| `POST` | `/hcm/api/v1/leave-requests` | Apply |
| `GET` | `/hcm/api/v1/leave-requests/:id` | One request |
| `POST` | `/hcm/api/v1/leave-requests/:id/withdraw` | Employee retracts an undecided request |
| `POST` | `/hcm/api/v1/leave-requests/:id/cancel` | Undo *approved* future leave |
| `POST` | `/hcm/api/v1/leave-requests/:id/decision` | Manager approves or rejects |

`:id` accepts either the internal id or the human-quotable number
(`LR-2026-000023`). Employee ids accept the internal id, the employee number
(`E10001`) or the email — because a chatbot will have whatever the user typed.

### Why `validate` exists separately

It is the endpoint the assistant should reach for **first**. It answers "can I
take next week off?" without committing anyone to anything, and it returns the
shortfall, the notice required and the days it would not charge — so the reply
can be specific instead of "that didn't work".

---

## Lifecycle

```
                    ┌──────────────────┐
   apply ──────────►│ PENDING_APPROVAL │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌──────────┐   ┌──────────┐   ┌───────────┐
        │ APPROVED │   │ REJECTED │   │ WITHDRAWN │
        └────┬─────┘   └──────────┘   └───────────┘
             │                         (employee, before a decision)
             ▼
        ┌───────────┐
        │ CANCELLED │   (approved leave, undone — future dates only)
        └───────────┘
```

**Withdraw and cancel are deliberately different operations.** Withdrawing
retracts something nobody has decided on. Cancelling undoes a decision that was
already made, which has different downstream effects on balances and payroll.
Trying to withdraw approved leave returns a `409` that says so.

Leave that has **already been taken** cannot be cancelled at all.

---

## Business rules

Defaults mirror the Annual Leave Policy (`HR-POL-001`) in the document corpus,
so the assistant can cite the policy *and* act on the system without the two
contradicting each other. All are configurable — a real HCM configures absence
plans per organisation, so hardcoding them would be unrealistic.

| Rule | Default | Violation code |
|---|---|---|
| Standard entitlement | 20 days | — |
| Senior grade entitlement | 31 days | — |
| Notice, ≤ 5 working days | 8 calendar days | `INSUFFICIENT_NOTICE` |
| Notice, > 5 working days | 31 calendar days | `INSUFFICIENT_NOTICE` |
| Max consecutive | 10 working days | `EXCEEDS_MAX_CONSECUTIVE` |
| Probation | 3 months | `PROBATION_RESTRICTION` |
| Balance sufficiency | — | `INSUFFICIENT_BALANCE` |
| Overlapping bookings | — | `OVERLAPPING_REQUEST` |
| Employment-type eligibility | — | `LEAVE_TYPE_NOT_ELIGIBLE` |
| Inactive employee | — | `EMPLOYEE_INACTIVE` |

Two design decisions worth knowing:

**Every violation is returned, not just the first.** Telling someone "you don't
have enough leave" and then, once they adjust, "and it's also too late to apply"
is a poor conversation.

**Violations carry machine-readable codes and structured details.** The client
branches on `INSUFFICIENT_BALANCE` vs `INSUFFICIENT_NOTICE` vs
`OVERLAPPING_REQUEST` and composes its own wording — each deserves a different
reply.

```json
{
  "code": "INSUFFICIENT_BALANCE",
  "severity": "ERROR",
  "message": "This request is 10 day(s) but only 5 day(s) of Annual Leave remain available.",
  "details": { "requestedDays": 10, "availableDays": 5, "shortfallDays": 5,
               "entitlementDays": 20, "takenDays": 15 }
}
```

---

## Balances

Derived from requests on every read, **never stored**. A stored balance is a
cache of a calculation, and when a cache and its source disagree the cache is
always the thing that is wrong.

```
available = entitlement + carriedOver − taken − scheduled − pending
```

The three deductions are reported separately because they mean different things
to someone asking "how much leave do I have left?":

- **taken** — approved, and the dates have passed
- **scheduled** — approved, still in the future
- **pending** — awaiting a decision, but already held

Entitlement **accrues monthly** rather than being granted on 1 January, and
part-time patterns are **pro-rated** against a five-day week (E10007 works three
days and gets 12 days, not 20).

---

## The seeded population

Ten employees, chosen to make each rule branch reachable rather than to be a
plausible org chart. Deterministic: the same `HCM_MOCK_SEED` always produces the
same people, balances and history.

| Employee | Situation | Demonstrates |
|---|---|---|
| `E10001` Amara Okafor | Healthy balance | The happy path |
| `E10002` Daniel Whitfield | Senior grade, approves Finance | Higher entitlement, approvals |
| `E10003` Priya Raman | Nearly out of leave | `INSUFFICIENT_BALANCE` |
| `E10004` Tomas Nowak | On probation | `PROBATION_RESTRICTION` (annual only — sick leave still allowed) |
| `E10005` Sarah Lindqvist | Senior, approves IT | Approvals |
| `E10006` Marcus Bello | Contractor | `LEAVE_TYPE_NOT_ELIGIBLE` |
| `E10007` Grace Adeyemi | Part-time, 3 days/week | Pro-rated entitlement |
| `E10008` Ravi Chandran | Pending request 45 days out | `OVERLAPPING_REQUEST` |
| `E10009` Elena Moreau | Fixed-term | Partial eligibility |
| `E10010` Peter Osei | Left the organisation | `EMPLOYEE_INACTIVE` |

`GET /hcm/api/v1/employees` returns a `seedNote` on each one, so the population
is self-documenting.

---

## Making it behave like a real upstream

A client written against an API that is always instant and always succeeds has
never had its timeout or retry path executed.

```bash
HCM_MOCK_LATENCY_MS=800   # every call takes ~800ms, jittered
HCM_MOCK_ERROR_RATE=0.2   # one call in five returns 503 with Retry-After
```

Both default to off.

**Idempotency:** `POST /leave-requests` accepts an `idempotencyKey`. A retry
with the same key returns the original request rather than booking the leave
twice — essential when the caller is a chatbot that may retry on a timeout.

---

## State

In-memory, snapshotted to `data/hcm-mock-state.json` so applied leave survives a
restart. Delete the file to reseed. A snapshot from a different seed is
discarded rather than migrated — a confusing half-migrated state is worse than a
clean reseed.

The mock **does not touch the RAG database**. Sharing it would blur exactly the
boundary this service exists to model.

---

## Tests

```bash
npm run test:hcm      # 65 tests
```

Covering calendar arithmetic (weekends, holidays, leap years, month-end
clamping), every validation rule, the full lifecycle, balance transitions,
pagination, auth and the error envelope.

---

## Swapping in the real HCM

1. Reconcile `packages/hcm-contract` against the vendor's published spec. If
   shapes differ, the change is contained there and in the client's mapping
   layer.
2. Point `HCM_BASE_URL` and `HCM_API_KEY` at the real system.
3. Stop running this service.

Nothing in the assistant's pipeline should need to change. That is the property
this whole arrangement is designed to buy.
