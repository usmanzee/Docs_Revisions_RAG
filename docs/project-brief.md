# Project brief — Docs Revisions RAG

A cold-start handoff. Read this first in a new session; it is written so that
someone who has never seen the repo can be productive in twenty minutes.

Verified against the working tree and the live database on **2026-11-09**.
Numbers marked *(measured)* were read from the database, not recalled.

---

## 1. What this is, in one paragraph

An enterprise Retrieval-Augmented Generation platform over a corpus of company
policy and procedure documents, built around a first-class **document revision
lifecycle**. Documents change over time; the system always answers from the
revision that is *current*, can still retrieve historical revisions when asked,
and never destroys an active revision before its replacement has successfully
processed. On top of retrieval sits a chat assistant that can also **act** — it
reads leave balances and books leave against a mock HCM backend through tool
calling.

Two things make it more than a RAG demo:

1. **The revision lifecycle is enforced by the database**, not by application
   convention. A partial unique index makes "two current revisions" impossible.
2. **Retrieval quality is measured**, not asserted. There is a gold evaluation
   set of 255 questions and a runner that reports Recall@k, MRR, section
   accuracy, current-revision accuracy and refusal behaviour — and it *refuses*
   to print quality numbers when embeddings are mock.

---

## 2. Stack and hard constraints

| Layer | Choice | Note |
|---|---|---|
| Database | PostgreSQL + **pgvector** | Primary store AND vector store. Deliberately not SQL Server, not Chroma, not a separate vector DB. |
| Runtime | Node.js **≥ 22.13.0** | Hard requirement, guarded. `.nvmrc` pins 24. |
| Language | TypeScript strict, ESM, NodeNext | |
| API | **Fastify** | Chosen over Express. |
| LLM | OpenAI via official SDK + LangChain.js | LangChain for tool binding and streaming; **raw SQL for retrieval**. |
| Frontend | React 19 + Vite + react-router-dom 7 | |
| Streaming | SSE over `reply.raw` | Not WebSockets. |
| Tests | Vitest | 275 passing (210 API + 65 HCM) across 16 files. |
| Monorepo | npm workspaces | 5 workspaces. |

### Non-negotiables carried from the original specification

- No OpenAI credentials ever reach the browser. Every model call originates in
  the API.
- Never log: `OPENAI_API_KEY`, the database password, authorization tokens, or
  whole sensitive documents.
- The client never supplies filesystem paths.
- **Never use mock embeddings to report retrieval quality.** The mock provider
  is deterministic and non-semantic; it exists for infrastructure and scale
  testing only.
- Documents are identified by content hash and document code, never filename.
- Ingestion logic lives in modules, never in controllers.
- Only OCR pages whose native text layer is genuinely insufficient.

---

## 3. Repository layout

```
.
├── apps/
│   ├── api/          Fastify API + all ingestion/retrieval/eval modules + CLIs
│   ├── hcm-mock/     Standalone mock HCM leave server (own process, own port)
│   └── web/          React client: employee app + /admin operations console
├── packages/
│   ├── shared/       Domain + API types shared by api and web
│   └── hcm-contract/ Request/response types for the HCM API surface
├── migrations/       0001–0009, forward-only SQL
├── scripts/          Thin tsx wrappers around apps/api/src/cli/*
├── docs/             security-and-permissions.md, this brief
├── data/
│   ├── evaluation/questions.json    THE GOLD SET (255 questions)
│   └── hcm-mock-state.json          HCM mock snapshot
├── storage/documents/               103 generated source files
├── docker/ + docker-compose.yml
└── README.md         1,293 lines, with Mermaid diagrams
```

334 `.ts`/`.tsx` files across `apps/` and `packages/`.

### The API's module boundaries

`apps/api/src/modules/` is where all the real work lives. Controllers are thin.

| Module | Responsibility |
|---|---|
| `corpus/` | Synthetic document generator (blueprints per department, PDF/DOCX/text/scanned renderers), revision simulator, gold-question generator |
| `parsing/` | PDF / DOCX / text → structured elements |
| `ocr/` | Provider interface + Tesseract implementation, gated by text-layer density |
| `chunking/` | Structure-aware chunker preserving heading context; parent chunks |
| `embeddings/` | Provider interface: `openai-provider` and `mock-provider` |
| `retrieval/` | Vector + lexical candidates, RRF fusion, query analysis, reranker interface, context assembly |
| `ingestion/` | Discovery → processing → activation; cron scheduler with advisory-lock claim |
| `chat/` | RAG service, agentic tool loop, `tools/leave-tools.ts` |
| `hcm/` | HTTP client for the HCM service |
| `evaluation/` | Retrieval and RAG evaluators, metrics |
| `storage/` | Document storage interface + local driver |
| `vision/` | Optional diagram enrichment (off by default) |

---

## 4. The data model

Nine forward-only migrations. The ones that matter:

| Migration | Contains |
|---|---|
| `0001` | `vector` extension, `system_settings` |
| `0002` | `documents`, `document_revisions` — **the lifecycle invariant** |
| `0003` | `document_chunks` — templated vector dimension, weighted `tsvector` |
| `0004` | Partial HNSW index |
| `0005` | `ingestion_jobs`, `ingestion_job_items` |
| `0006` | `conversations`, `messages` |
| `0007` | `retrieval_logs` |
| `0008` | `evaluation_questions` / `_runs` / `_results` |
| `0009` | `document_assets`, `document_permissions`, `principals` |

### The invariants, and why they are in SQL

**One current revision per document** — `migrations/0002`:

```sql
CREATE UNIQUE INDEX document_revisions_one_current_idx
    ON document_revisions (document_id)
    WHERE is_current;
```

A race that tries to activate two revisions does not produce a corrupt corpus;
it produces a constraint violation. Application code cannot opt out.

**No duplicate chunks** — `migrations/0003`:

```sql
UNIQUE (document_revision_id, chunk_index),
UNIQUE (document_revision_id, content_hash),
```

Re-running ingestion is therefore safe.

**Lexical search weighting** — a generated column, so it can never drift from
the content:

```sql
text_search TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(document_code, '')),   'A') ||
    setweight(to_tsvector('english', coalesce(section_title, '')),   'A') ||
    setweight(to_tsvector('english', coalesce(subsection_title,'')), 'B') ||
    setweight(to_tsvector('english', coalesce(content, '')),         'C')
) STORED
```

**The vector index is partial** — `migrations/0004`:

```sql
CREATE INDEX document_chunks_embedding_hnsw_idx
    ON document_chunks USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE is_current AND embedding IS NOT NULL;
```

Consequence worth knowing: `includeHistorical` queries have **no ANN index** and
fall back to an exact scan.

### Embedding dimension is pinned, not assumed

`0003` is templated (`vector({{EMBEDDING_DIMENSIONS}})`), the chosen value is
written to `system_settings`, and the API **verifies it at boot**. Changing
embedding model dimension requires a schema rebuild; there is no online
re-embedding path.

### Deliberate denormalisation

`document_chunks` carries `is_current`, `document_code`, `department` and
`document_type` — copies of columns that live on the parent tables. This keeps
retrieval to a single-table scan. They are maintained **inside the same
transaction** as revision activation, so they cannot drift.

---

## 5. The revision lifecycle — the core mechanic

Activation is one transaction, in this order:

1. Insert the new revision's chunks **invisible** (`is_current = false`)
2. Demote the outgoing revision
3. Promote the new revision
4. Flip the new chunks visible

A failure at any step rolls back to the previous good state. The old revision is
never dropped before the new one has succeeded. Entry point:
`apps/api/src/repositories/revision-repository.ts` → `activateRevision()`.

Ingestion is **idempotent by hash**: `file_hash` over raw bytes, `content_hash`
over normalised extracted text. If neither changed, processing is skipped.

> **Trap, learned the hard way:** if you need to force re-embedding, setting
> `processing_status = 'PENDING'` is *not enough* — you must also null
> `content_hash`, or the skip optimisation silently keeps the old vectors.

Demos: `npm run demo:revision`, `npm run corpus:revise`, `npm run corpus:corrupt`.

---

## 6. Retrieval

Three candidate sources, fused with **Reciprocal Rank Fusion** (`RRF_K=60`):

- Vector similarity — pgvector `<=>` cosine distance, `VECTOR_TOP_K=25`
- Lexical — PostgreSQL FTS over the weighted `tsvector`, `LEXICAL_TOP_K=25`
- Document-code exact match

RRF is used rather than score normalisation because vector distance and
`ts_rank` are not on a comparable scale; rank is.

Then: optional parent-chunk expansion → reranker (currently a **no-op**, by
design — an unmeasured reranker is not an improvement) → context assembly capped
by `FINAL_CONTEXT_CHUNKS=8` and `CONTEXT_TOKEN_BUDGET=6000`.

**Citations are constructed from the retrieved chunk rows, never from model
output.** The model cannot invent a citation.

Debugging: `POST /api/debug/retrieval` returns the full candidate trace;
`POST /api/debug/prompt` returns the assembled prompt; `retrieval_logs` persists
per-query traces when `RETRIEVAL_LOGGING_ENABLED=true`.

---

## 7. Chat and tool calling

`apps/api/src/modules/chat/rag-service.ts` runs a bounded agentic loop.

Six tools in `tools/leave-tools.ts`:

| Tool | Kind |
|---|---|
| `get_leave_balance` | read |
| `get_leave_history` | read |
| `validate_leave_request` | read |
| `apply_for_leave` | **write** |
| `withdraw_leave_request` | **write** |
| `cancel_leave_request` | **write** |

Design decisions that took iterations to get right:

- **Identity is injected, never model-supplied.** Every schema is `.strict()`,
  so a model that smuggles in an `employeeId` gets a validation refusal rather
  than a silently stripped field.
- **`apply_for_leave` validates itself.** An earlier design gated writes from
  *outside* — the executor required a `validate_leave_request` earlier in the
  same turn. It read well and matched no real conversation: agreement arrives a
  turn later, so every booking opened with a red "failed" card before retrying.
  Validation now sits inside the write (commit `66c8ed3`).
- **Tools are withdrawn only on the final loop iteration**, not after the first.
  Withdrawing early made validate→apply impossible within one turn.
- **Conversation history is fed to the model**, not only to the query rewriter.
  Without it, "go ahead and book it" produced "you have not yet provided the
  dates."
- **Idempotency keys** are derived from the turn id, so a retry cannot
  double-book.
- The executor still blocks **duplicate writes within a turn**.

SSE event types: `metadata`, `token`, `citation`, `tool`, `reset`, `complete`,
`error`.

> **Zod note:** this project uses Zod 4. Use `z.toJSONSchema(schema, { io:
> 'input', target: 'draft-7' })`. Do **not** reach for `zod-to-json-schema` —
> it is v3-only.

> **Typing note:** annotating a tool as `const t: AssistantTool = {...}`
> collapses the generic and makes `args` `unknown`. Use the `defineTool<T>()`
> helper in `tools/types.ts`.

---

## 8. The mock HCM service

A **separate process on its own port** (3100), so swapping in the real HCM means
changing `HCM_BASE_URL` and a credential — not refactoring the API. It
deliberately does not import from `apps/api` (note the duplicated
`src/runtime.ts`).

Endpoints mirror a real HCM shape: `/leave-types`, `/public-holidays`,
`/employees/:id/leave-balances`, `/employees/:id/leave-requests`,
`/leave-requests/validate`, `POST /leave-requests`, and
`withdraw` / `cancel` / `decision` actions.

Two design points:

- **Balances are derived on every read, never stored.**
  `available = entitlement + carriedOver − taken − scheduled − pending`.
- **`evaluateLeaveRequest()` returns every violation**, not just the first, so
  the assistant can explain all of them at once.

Its rules intentionally mirror the Annual Leave Policy (`HR-POL-001`) in the
document corpus, so the assistant can cite the policy *and* act on the system
without the two contradicting each other.

`HCM_MOCK_LATENCY_MS` and `HCM_MOCK_ERROR_RATE` simulate a slow or flaky
upstream to exercise timeout and retry paths.

---

## 9. The frontend — two applications, one origin

`apps/web/src/App.tsx`:

- **Employee app** (`EmployeeLayout`): `/chat`, `/chat/:conversationId`,
  `/documents`, `/documents/:documentId`
- **Operations console** (`AdminLayout`, lazy-loaded): `/admin`,
  `/admin/documents`, `/admin/documents/:id`, `/admin/retrieval`

The admin bundle is code-split via `React.lazy` and its API calls live in a
separate `api/admin-client.ts`, so admin code never ships to the employee
bundle. The gate has three states: `checking | locked | unlocked`, verified by
calling `adminApi.stats()`.

**This is a UI and bundle separation, not a second trust boundary.** Both apps
are served from one origin and the real guard is the API's `ADMIN_API_KEY`.

---

## 10. Current measured state *(2026-11-09, live database)*

| | |
|---|---|
| Documents | 75 |
| Revisions | 103 (75 current, **0 failed**) |
| Chunks | 854, all 854 embedded |
| Embedding model | `text-embedding-3-small` — uniform, no mixed vectors |
| Source files on disk | 103 |
| Gold questions | 255 (243 answerable, 12 no-answer) |

### Latest evaluation run — `RETRIEVAL`, 2026-09-15, provider `openai`

| Metric | Value |
|---|---|
| Recall@1 | 81.5% |
| Recall@3 | 99.2% |
| Recall@5 | **99.6%** |
| MRR | 0.9027 |
| Section accuracy | 99.6% |
| Current-revision accuracy | **100%** |
| **No-answer behaviour** | **75.0%** ← weakest metric |
| Latency p50 / p95 / p99 | 402 / 486 / 586 ms |

Scale benchmark (separate, larger corpus): 21,430 chunks, retrieval p50/p95/p99
= 2 / 6 / 10 ms, 334 queries/sec.

**The one number to work on:** no-answer behaviour is 75% — of the 12 questions
that *have no answer in the corpus*, 3 get answered anyway. That is the guard
against making things up, and it is the weakest thing in the system. Likely
cause: retrieval always returns something. `VECTOR_TOP_K=25` returns 25 chunks
whether or not any are relevant, RRF ranks them, the context builder forwards
the top 8 — and nothing in the pipeline ever asks *"is any of this actually
relevant?"* Rank is relative; there is no absolute floor.

> **Caveat:** that run predates 3 revisions and ~35 chunks added since. Re-run
> `npm run eval:retrieval` before quoting the numbers as current.

---

## 11. Where the gold set actually lives — read this before touching evaluation

The evaluator reads **`data/evaluation/questions.json`** (132 KB), not the
database. See `apps/api/src/modules/evaluation/retrieval-evaluator.ts:30`.

The `evaluation_questions` **table is currently empty and is not on the read
path.** Only `evaluation_runs` (3 rows) and `evaluation_results` are written.
Don't be misled by an empty table into thinking the gold set is gone.

Scoring rule — corrected in commit `4ab4bca`, and the fix matters:

```ts
function isCorrect(candidate, question) {
  if (candidate.documentCode !== question.expectedDocumentCode) return false;
  if (question.questionType === 'REVISION_SENSITIVE' && question.expectedRevision !== null) {
    return candidate.revisionNumber === question.expectedRevision;
  }
  return candidate.isCurrent;
}
```

Before this, gold data pinned a hard revision *number*, which went stale the
moment `corpus:revise` published a new revision. Six of seven reported "misses"
were the system returning the right document at the right current revision while
the *measurement* was wrong. Recall@5 went 97.1% → 99.6%, current-revision
accuracy 97.5% → 100%, misses 7 → 1.

The lesson, and the thing worth saying out loud: **when a metric looks bad,
check the metric before changing the system.**

---

## 12. How to run it

### Prerequisites
- Node **≥ 22.13.0** (`.nvmrc` → 24). Enforced; see §13.
- PostgreSQL with pgvector — locally, or `docker compose up -d postgres`
  (exposed on **5433** to avoid clashing with a local server)
- Tesseract, for OCR
- An OpenAI API key

### From a clean checkout

```bash
nvm use                      # or: nvm install 24
npm install

cp .env.example .env
# Set OPENAI_API_KEY.
# Set EMBEDDING_PROVIDER=openai — mock gives non-semantic vectors.
# If using Docker Postgres, point DATABASE_URL at :5433.

npm run db:migrate           # 0001..0009
npm run corpus:generate      # 75 documents + data/evaluation/questions.json
npm run ingestion:run        # parse → OCR where needed → chunk → embed → activate
npm run dev                  # HCM :3100, API :3000, web :5173
```

### Ports

| Service | Port |
|---|---|
| API | 3000 |
| Web | 5173 |
| HCM mock | 3100 |
| Docker Postgres | 5433 |

### Command reference

| Command | Does |
|---|---|
| `npm run dev` | All three processes in parallel |
| `npm test` | API suite then HCM suite (needs `TEST_DATABASE_URL`) |
| `npm run typecheck` | All workspaces |
| `npm run db:migrate` / `:status` / `db:reset` | Migrations |
| `npm run db:psql` | psql against `DATABASE_URL` |
| `npm run corpus:generate` | Regenerate corpus + gold set |
| `npm run corpus:revise` | Publish a new revision of an existing document |
| `npm run corpus:corrupt` | Create a deliberately broken revision |
| `npm run ingestion:run` | One ingestion pass |
| `npm run eval:retrieval` | Recall@k, MRR, no-answer behaviour |
| `npm run eval:rag` | Answer-quality evaluation |
| `npm run benchmark:retrieval` | Latency and throughput |
| `npm run demo:revision` | Walk the revision lifecycle live |

---

## 13. Traps that have already cost time

Every one of these is a real incident in this repo's history. Read them before
debugging anything.

1. **Node 20 silently destroys ingestion.** `pdfjs-dist` needs
   `Promise.withResolvers`. On Node 20, 77 of 100 revisions failed; the 23 that
   "worked" were non-PDF formats. Guards now exist in
   `apps/api/src/utils/runtime.ts`, `apps/hcm-mock/src/runtime.ts`, and
   `scripts/check-node.mjs` wired as `predev`/`prebuild`/`pretest`. The last one
   exists because `npm run dev` starts three processes and **Vite survives on
   Node 20**, burying the other two guards under an ECONNREFUSED flood.

2. **Mixed embeddings produce silent garbage.** The database once held 801
   `deterministic-mock` chunks alongside 18 `text-embedding-3-small` while
   `.env` said `openai`. Vector search was noise; only the lexical half worked,
   and nothing errored. **Always check:**
   `SELECT embedding_model, count(*) FROM document_chunks GROUP BY 1;`

3. **Forcing re-embedding needs `content_hash = NULL`.** See §5.

4. **SSE tokens can vanish while every test passes.** `navigate()` on the
   `metadata` event re-fired the conversation-loader effect, which replaced
   `turns` with database rows carrying different ids — so every later token
   matched nothing and was discarded. 35 API tests were green throughout; no
   test would have caught it. Fixed with `streamingConversationRef` plus a
   `findLastIndex` fallback in `ChatPage.tsx`.

5. **`setUTCMonth` overflows month ends.** "30 Feb" rolled to 2 March, which
   would misplace probation end dates for anyone hired on the 29th–31st. See the
   clamping in `apps/hcm-mock/src/domain/calendar.ts` → `addMonths()`.

6. **Twice, the test was wrong and the code was right.** 2026-12-26 is a
   Saturday and is correctly excluded as `WEEKEND` before the holiday check;
   leave starting *after* probation ends is correctly allowed. Check your
   expectation before you change behaviour.

7. **Fastify logger specialisation** breaks type inference in two places; cast
   with `as FastifyBaseLogger`.

8. **The HCM suite's clock is pinned, and must stay pinned.**
   `apps/hcm-mock/tests/setup.ts` freezes `Date` at **2026-09-15T12:00:00Z**.
   Without it the suite tests a different scenario every day it runs. Three
   balance tests broke on 2026-11-02 with no code change: they book
   `futureWeekday(60)`, which crossed into January, and a request in *next*
   year's leave year correctly does not touch *this* year's balance
   (`balances.ts` filters `relevant` to the leave year of `asOfDate`). The code
   was right; the test's idea of "sixty days from now" had drifted out of the
   leave year it assumed.

   Worse, the same drift made three sibling tests pass **vacuously** — "releases
   the balance when rejected" and "cancels approved future leave and restores
   the balance" assert `after === before`, which held trivially once nothing
   ever moved. A mutation that stopped releasing balance on
   `REJECTED`/`CANCELLED`/`WITHDRAWN` was caught by zero tests before the clock
   was pinned and by three after it.

   If you change `FIXED_NOW`, keep it inside this window:
   - `now + ~70 days` must not cross 31 December, or bookings land in the next
     leave year and stop affecting the balance under test;
   - `now − ~210 days` must not cross 1 January, or the seeded historical leave
     lands in the previous leave year and `takenDays` reads zero.

   Only `Date` is faked; timers stay real, because Fastify's lifecycle runs on
   them.

---

## 14. Known limitations — stated, not hidden

- **No authentication on chat.** The assistant always acts as
  `CHAT_DEFAULT_EMPLOYEE_ID`. Identity injection is built correctly — the model
  cannot choose whose data it touches — but *which* identity is a constant. A
  banner in the UI says so. **This is the single thing that must change before
  anyone else uses it.** Explicitly deferred.
- **Confirmation before a write is prompt-enforced, not code-enforced.** The
  named next hardening step is a two-phase confirm where the client must echo a
  token back before a write executes.
- **Document permissions are designed but not implemented.** Schema exists
  (`0009`); design is in `docs/security-and-permissions.md`.
- **`/admin` is a UI split, not a trust boundary.** See §9.
- **No-answer behaviour is 75%.** See §10.
- **Historical-revision retrieval has no ANN index.** See §4.
- **The reranker is a no-op.** Interface and harness exist; nothing is wired.
- **Vision enrichment is off and unevaluated.**
- **Parent chunks never form on this corpus** — 0 of 21,430 at scale. Generated
  sections are short (mean 109 tokens vs `CHUNK_TARGET_TOKENS=650`), and the
  chunker will not split or merge across a section to hit a number. The
  parent-child path is implemented, unit-tested and wired — but dormant on this
  data. Consequently `FINAL_CONTEXT_CHUNKS` binds long before
  `CONTEXT_TOKEN_BUDGET` (8 × ~110 tokens ≈ 900 against a 6,000 budget).
- **DOCX citations carry a section but no page**, because pagination is a
  rendering artefact and inventing one would be worse.
- **The query rewriter is heuristic-gated** on pronouns, short questions and
  follow-up openers. It will occasionally rewrite something that didn't need it.

---

## 15. Git state

```
f9fec0d  project brief and tests fix                                        (HEAD)
66c8ed3  Validate inside apply_for_leave instead of gating it from outside
ca0bba2  Add demo video link and screenshots to the README
b69d4be  Add app screenshots for the README
bcbe254  Stop npm run dev before it starts anything on an unsupported Node
7bc6636  Split the web client into an employee app and an operations console
4ab4bca  Score retrieval against the current revision, not a recorded number
7cda88e  tool calling, leave management, mock HCM server
e23f633  ingition issue fix
2238732  Enterprise RAG platform with document revision lifecycle
```

Working tree: Clean after the Claude Code setup commit.

---

## 16. If you are starting a new session

Say this, and you have enough context:

> Enterprise RAG over policy documents. PostgreSQL + pgvector as both primary
> and vector store, Fastify API, React client, TypeScript strict throughout.
> Read `docs/project-brief.md` first. Core mechanic is the document revision
> lifecycle — the invariant is a partial unique index in `migrations/0002`, and
> activation is a single transaction in `revision-repository.ts`. Retrieval is
> hybrid vector + FTS fused with RRF, measured against 255 gold questions in
> `data/evaluation/questions.json`. Node ≥ 22 is a hard requirement. Before
> trusting any retrieval result, check that `document_chunks.embedding_model` is
> uniform.

The highest-value open problem is the **no-answer rate of 75%** (§10).
