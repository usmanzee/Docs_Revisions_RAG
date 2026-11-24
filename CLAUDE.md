# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read docs/project-brief.md before starting any task.

Enterprise RAG over company policy documents, built around a database-enforced **document revision lifecycle**, with a chat assistant that can also act on a (mock) HCM leave system via tool calling. PostgreSQL + pgvector is both the primary and the vector store. TypeScript strict, ESM/NodeNext, npm workspaces.

`docs/project-brief.md` is the detailed cold-start handoff (measured state, eval numbers, incident history) — read it before non-trivial work. `README.md` explains the design rationale.

## Commands

Node **≥ 22.13** is a hard requirement (`.nvmrc` pins 24). On Node 20, `pdfjs-dist` fails with `Promise.withResolvers is not a function`, which looks like corrupt PDFs. `scripts/check-node.mjs` runs as `predev`/`pretest`/`prebuild` and blocks unsupported versions.

```bash
npm run dev                 # hcm-mock :3100 + api :3000 + web :5173 (Vite proxies /api)
npm run typecheck           # all workspaces; `npm run lint` is an alias
npm run build               # shared → hcm-contract → hcm-mock → api → web
npm test                    # API suite, then HCM suite

# Single test file / single test (API)
npm run test --workspace @docs-rag/api -- tests/unit/rrf.test.ts
npm run test --workspace @docs-rag/api -- tests/unit/chunking.test.ts -t "keeps a small table whole"
npm run test --workspace @docs-rag/api -- tests/unit            # unit tests only, no DB needed
npm run test:integration --workspace @docs-rag/api              # needs TEST_DATABASE_URL
npm run test:hcm                                                # HCM mock suite

# Database / corpus / ingestion
docker compose up -d postgres             # pgvector, exposed on 5433
npm run db:migrate | db:migrate:status | db:reset | db:psql
npm run corpus:generate -- --profile=quality --count=75 --seed=123
npm run ingestion:run [-- --limit=50 | --revision=<uuid> | --skip-discovery]
npm run corpus:revise -- --document=FIN-POL-001 --fact=financeDirectorThreshold
npm run corpus:corrupt -- --document=FIN-POL-001
npm run demo:revision
npm run eval:retrieval | eval:rag | benchmark:retrieval
```

`scripts/*.ts` are thin tsx wrappers around `apps/api/src/cli/*`. Put the logic in `cli/`.

## Workspaces

- `apps/api`: Fastify API. Also holds every ingestion/retrieval/eval module and the CLIs.
- `apps/hcm-mock`: a standalone HCM leave service with its own process and port. It must **not** import from `apps/api`; that is why `src/runtime.ts` is duplicated. The API reaches it only over HTTP (`HCM_BASE_URL`), so a real HCM can be swapped in.
- `apps/web`: React 19 + Vite. It contains an employee app (`/`) and a lazily loaded operations console (`/admin/*`, `api/admin-client.ts`). Admin code must stay out of the employee bundle. This split is UI-only; the real guard is `ADMIN_API_KEY` on the server.
- `packages/shared` and `packages/hcm-contract`: these resolve through **`dist/`**, not `src/` (`npm install` builds them via `prepare`). After editing either package, run `npm run build --workspace @docs-rag/shared` (or `hcm-contract`) before consumers can see the change.

## API architecture (`apps/api/src`)

- `container.ts` is the composition root. Modules take dependencies through constructors, and `ContainerOverrides` lets tests inject a stub chat model, the mock embeddings, a test pool, and so on. Wire new services in here rather than adding singletons.
- Layering: `routes/` (registration + Zod schemas) → `controllers/` (thin) → `modules/*` (all real logic) → `repositories/` (**all SQL lives here**). Ingestion logic never goes in controllers.
- Config: `config/env.ts` is a Zod schema and the **only** place that reads `process.env`. Add new settings there and to `.env.example`.
- SQL is raw and parameterised. Optional filters are built with `db/query-builder.ts`, which only appends `$n` placeholders. Retrieval deliberately avoids LangChain vector stores; LangChain is used only for chat-model tool binding and streaming.

### Revision lifecycle (the core invariant)

- `documents` 1→N `document_revisions`. The partial unique index `document_revisions_one_current_idx` (`migrations/0002`) makes two current revisions impossible.
- `RevisionRepository.activateRevision()` runs in one transaction: insert the new chunks with `is_current=false` → demote the old revision → promote the new one → flip the chunks visible. A failure leaves the previous revision current and searchable. Superseded chunks are kept, never deleted.
- Status flow: `PENDING → PROCESSING → READY | FAILED`, and `READY → SUPERSEDED`. Claims use `FOR UPDATE SKIP LOCKED` plus a per-run session advisory lock.
- `document_chunks` denormalises `is_current`, `document_code`, `department` and `document_type` so retrieval scans one table. These columns must be updated in the same transaction as activation.
- Ingestion is idempotent by `file_hash` (raw bytes) and `content_hash` (normalised text). **To force re-embedding you must also set `content_hash = NULL`**; setting `PENDING` alone silently keeps the old vectors.
- Discovery reports a missing source file and never deletes its revision.

### Ingestion pipeline (`modules/ingestion` → `parsing` → `ocr` → `chunking` → `embeddings`)

- OCR (Tesseract) is decided **per page**, by native text below both an absolute floor and a chars-per-area density. Only those pages get OCR. The extraction method (`NATIVE_TEXT`/`OCR`/`VISION`/`MIXED`) is recorded on each chunk.
- The chunker is structure-aware: it never crosses a top-level section, keeps procedures and tables whole, and repeats table headers when it has to split. Revision-history sections are tagged `ADMINISTRATIVE` and demoted in ranking. Embedded text gets a Document/Department/Section prefix; stored `content` stays clean.
- The embedding dimension is templated into `migrations/0003` (`{{EMBEDDING_DIMENSIONS}}`) and checked at boot. Changing it requires `db:reset` and a re-ingest.

### Retrieval and chat (`modules/retrieval`, `modules/chat`)

- Candidates come from three sources: pgvector cosine, PostgreSQL FTS over a weighted generated `tsvector`, and exact document-code lookup. They are fused with RRF (`rrf.ts`, `RRF_K`), then admin sections are demoted → reranker (a deliberate no-op) → parent expansion → dedup/merge → token budget (`context-builder.ts`).
- The HNSW index is partial on `is_current`, so `includeHistorical` queries do an exact scan.
- **Citations are built from chunk rows, never parsed from model output.**
- `rag-service.ts` runs a bounded agentic loop (`CHAT_MAX_TOOL_ITERATIONS`). Retrieval always runs, and the leave tools sit on top. Tools are withdrawn only on the final iteration. Conversation history goes to the model, not only to the query rewriter. SSE events are `metadata`, `token`, `citation`, `tool`, `reset`, `complete` and `error` (`utils/sse.ts`).
- Leave tools (`chat/tools/leave-tools.ts`, `executor.ts`):
  - Every schema is `.strict()`, and **no tool accepts an employee id**. The executor injects identity from the session (`CHAT_DEFAULT_EMPLOYEE_ID` for now).
  - `apply_for_leave` re-validates the exact request inside itself. There is no executor-level "validate first" gate.
  - The executor refuses duplicate writes within a turn, and idempotency keys derive from the turn id.
- Define tools with the `defineTool<T>()` helper in `tools/types.ts`. Annotating `const t: AssistantTool = {...}` collapses the generic and makes `args` `unknown`.
- The project uses Zod 4. For JSON Schema use `z.toJSONSchema(schema, { io: 'input', target: 'draft-7' })`, never `zod-to-json-schema` (which only supports v3).

### HCM mock (`apps/hcm-mock`)

- Balances are derived on every read and never stored.
- `evaluateLeaveRequest()` returns every violation, not just the first.
- Its default rules deliberately mirror `HR-POL-001` in the generated corpus; keep the two consistent.
- `HCM_MOCK_LATENCY_MS` and `HCM_MOCK_ERROR_RATE` simulate a slow or flaky upstream.

## Testing

- API integration tests use a **real PostgreSQL** at `TEST_DATABASE_URL` (selected when `NODE_ENV=test`). The harness refuses to run unless the URL contains `test`. It migrates once, then truncates between suites, and files run serially.
- `tests/setup.ts` forces `EMBEDDING_PROVIDER=mock` and disables cron. `tests/helpers/stub-chat-model.ts` scripts model answers and tool calls. Tests never call OpenAI.
- The HCM suite freezes `Date` at `2026-09-15T12:00:00Z` (`apps/hcm-mock/tests/setup.ts`). Keep it pinned. If you move it, `now+70d` must stay before 31 Dec and `now−210d` must stay after 1 Jan, or the balance tests break or pass vacuously.
- Twice in this repo's history the test was wrong and the code was right, for example weekend-before-holiday ordering and leave starting after probation. Check the expectation before changing domain behaviour.

## Gotchas

- **Never report retrieval quality from mock embeddings.** They are a non-semantic hashing vectoriser, kept for infrastructure and scale testing only.
- Before trusting any retrieval result, check that embeddings are uniform with `SELECT embedding_model, count(*) FROM document_chunks GROUP BY 1;`. Mixed mock and OpenAI vectors fail silently.
- The gold eval set is `data/evaluation/questions.json` (generated, gitignored). The `evaluation_questions` table is empty and not on the read path. A candidate is scored correct against the *current* revision unless the question is `REVISION_SENSITIVE`. When a metric looks bad, check the metric first.
- The client never supplies filesystem paths. Revisions are addressed by UUID and resolved through `modules/storage`, which has the path-traversal defence.
- Never log secrets or whole documents. Redaction is centralised in `utils/logger.ts`.
- Fastify logger specialisation breaks type inference in places; cast with `as FastifyBaseLogger`.
- `ChatPage.tsx` streaming relies on `streamingConversationRef`. A route change on `metadata` once silently discarded every token while all tests stayed green.

## Workflow

The setup lives in `.claude/`. Skills are in `skills/`, agents in `agents/`, and the migration guard hook in `hooks/`.

| Step | Use | Output |
|---|---|---|
| Brief and plan | `/plan <brief>` | Options, failure cases and a recommendation, then `docs/plans/<date>-<slug>.md` once decided |
| Research unknowns | `researcher` agent | Options with sources; read-only |
| Build in parallel | `/split <plan>` | One `builder` per independent task, each in its own git worktree |
| Review | `/sceptic-review` (plus the `reviewer` agent) | Findings by severity with real test results |
| Record the decision | `/decision` | `docs/decisions/NNNN-<slug>.md` |
| Ship | `/ship` | Feature branch, commit, then push and PR only after confirmation |
| Measure retrieval | `/retrieval-check` | Embedding uniformity check, then eval against the brief's baseline |

Things that work differently in parallel worktrees:
- Builders run unit tests only. Integration tests share one test database and truncate it, so they run once in the main checkout after merging.
- Worktrees symlink `node_modules`, so changes to `packages/*` aren't visible inside one. Those tasks run first, alone, in the main checkout.
- The shell may default to Node 20. Prefix commands with `source ~/.nvm/nvm.sh && nvm use >/dev/null &&` when `node -v` < 22.

## Rules
- Plan before code for anything bigger than a small fix. Use /plan.
- Every behaviour change needs a test.
  Unit tests: npm run test --workspace @docs-rag/api -- tests/unit
- Never edit an existing migration. Add a new numbered one.
- Never retry a write to an external system unless it is idempotent.
- Never report retrieval quality from mock embeddings.
- Keep the HCM test clock pinned (apps/hcm-mock/tests/setup.ts).
- When a metric looks wrong, check the metric before changing the system.
- Keep README "Known limitations" accurate when behaviour changes.
