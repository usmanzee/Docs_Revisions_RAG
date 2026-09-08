# Docs Revisions RAG

An enterprise Retrieval-Augmented Generation platform for internal documents — HR and finance policies,
IT and security procedures, procurement rules, operational manuals and Oracle database guidance.

The point of this project is not the chatbot. The point is everything a chatbot needs to be trustworthy
in an organisation where documents are **revised**: an ingestion pipeline that can fail safely, a
revision lifecycle that never leaves a document unanswerable, hybrid retrieval that finds things by
meaning *and* by exact identifier, answers that cite the document, revision and section they came from,
and the tooling to prove all of that with numbers.

Everything runs against a synthetic corpus that the project generates itself, so there is no dependency
on anyone's real documents — and because the generator plants known facts, retrieval and answer quality
can be measured objectively rather than eyeballed.

---

## Table of contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Why these technology choices](#why-these-technology-choices)
- [Quick start](#quick-start)
- [The revision lifecycle](#the-revision-lifecycle)
- [The synthetic corpus](#the-synthetic-corpus)
- [Ingestion](#ingestion)
- [Retrieval](#retrieval)
- [Evaluation and benchmarking](#evaluation-and-benchmarking)
- [Scale testing](#scale-testing)
- [Configuration](#configuration)
- [Command reference](#command-reference)
- [Project layout](#project-layout)
- [Testing](#testing)
- [Operations](#operations)
- [Security](#security)
- [Known limitations](#known-limitations)

---

## What it does

| Capability | Where it lives |
|---|---|
| Generates a realistic, reproducible enterprise corpus (PDF, DOCX, Markdown, scanned PDFs, workflow diagrams, corrupt files) | `apps/api/src/modules/corpus` |
| Tracks logical documents separately from their revisions, with a database-enforced "exactly one current revision" rule | `migrations/0002_*`, `apps/api/src/repositories/revision-repository.ts` |
| Parses PDFs structurally — headings by font size, tables from column gaps, running headers stripped | `apps/api/src/modules/parsing` |
| OCRs only the pages whose text layer is genuinely insufficient | `apps/api/src/modules/ocr`, `parsing/pdf-parser.ts` |
| Chunks by document structure, keeping procedures and tables intact | `apps/api/src/modules/chunking` |
| Activates a new revision atomically, leaving the old one serving traffic until the new one succeeds | `revision-processor.ts`, `revision-repository.ts` |
| Hybrid retrieval: pgvector + PostgreSQL full-text + exact identifier lookup, fused with RRF | `apps/api/src/modules/retrieval` |
| Grounded answers with citations built from chunk rows, never from model output | `apps/api/src/modules/chat` |
| Streams answers over Server-Sent Events | `routes/chat.ts`, `utils/sse.ts` |
| Measures Recall@k, MRR, revision accuracy and refusal behaviour against a gold dataset | `apps/api/src/modules/evaluation` |
| Benchmarks retrieval latency and reports real index sizes | `scripts/benchmark-retrieval.ts` |

---

## Architecture

The chat path and the ingestion path are deliberately separate. They share the database and the
embedding provider, and nothing else — an ingestion run cannot block a chat request, and a chat request
cannot see a half-processed revision.

```mermaid
flowchart TB
    subgraph client["React client"]
        UI["Chat · Documents · Admin · Retrieval debug"]
    end

    subgraph api["Node.js API (Fastify)"]
        CHAT["Chat / RAG routes<br/>SSE streaming"]
        DOCS["Document API"]
        ADMIN["Admin API<br/>ingestion control"]
        DEBUG["Retrieval debug<br/>(non-production)"]
    end

    subgraph retrieval["Retrieval service"]
        VEC["Vector search<br/>pgvector · cosine"]
        LEX["Lexical search<br/>PostgreSQL FTS"]
        IDENT["Identifier lookup<br/>exact document codes"]
        RRF["Reciprocal Rank Fusion"]
        RERANK["Reranker (pluggable)"]
        CTX["Context builder<br/>dedup · merge · budget"]
    end

    subgraph data["PostgreSQL + pgvector"]
        PG[("documents · revisions<br/>chunks + embeddings<br/>jobs · conversations · logs")]
    end

    LLM["OpenAI chat model"]

    UI --> CHAT & DOCS & ADMIN & DEBUG
    CHAT --> retrieval
    DEBUG --> retrieval
    VEC --> PG
    LEX --> PG
    IDENT --> PG
    VEC & LEX & IDENT --> RRF --> RERANK --> CTX
    CTX --> LLM
    LLM -->|streamed tokens| CHAT
    DOCS --> PG
    ADMIN --> PG
```

Ingestion is a separate pipeline, driven by a scheduler, a CLI command or an admin endpoint:

```mermaid
flowchart TB
    START["Trigger<br/>cron · CLI · admin API"] --> LOCK{"Advisory lock<br/>available?"}
    LOCK -->|no| SKIP["Skip this run"]
    LOCK -->|yes| STALE["Release stale PROCESSING claims"]
    STALE --> DISC["Discovery<br/>scan storage vs database"]
    DISC --> GUARD{"Cost guard<br/>large OpenAI run allowed?"}
    GUARD -->|no| ABORT["Abort, revisions returned to PENDING"]
    GUARD -->|yes| CLAIM["Claim PENDING revisions<br/>FOR UPDATE SKIP LOCKED"]

    CLAIM --> PARSE["Read + parse"]
    PARSE --> OCRQ{"Text layer<br/>sufficient?"}
    OCRQ -->|yes| STRUCT["Structured content"]
    OCRQ -->|no| OCR["Render page → OCR"] --> STRUCT
    STRUCT --> VISION["Vision enrichment<br/>(optional, off by default)"]
    VISION --> HASH{"Content hash<br/>unchanged?"}
    HASH -->|yes| SKIPDOC["Skip re-embedding"]
    HASH -->|no| CHUNK["Structure-aware chunking"]
    CHUNK --> EMBED["Embed child chunks"]
    EMBED --> TX["Transaction:<br/>insert chunks (is_current = false)<br/>demote old revision<br/>promote new revision"]
    TX --> READY["READY + CURRENT"]

    PARSE -.->|throws| FAIL["Mark FAILED<br/>previous revision stays current"]
    CHUNK -.->|throws| FAIL
    EMBED -.->|throws| FAIL
    TX -.->|throws| ROLLBACK["ROLLBACK<br/>old revision untouched"]
```

### Database relationships

```mermaid
erDiagram
    documents ||--o{ document_revisions : "has"
    document_revisions ||--o{ document_chunks : "produces"
    documents ||--o{ document_chunks : "denormalised for filtering"
    document_revisions ||--o{ document_assets : "extracted images"
    ingestion_jobs ||--o{ ingestion_job_items : "one per revision"
    document_revisions ||--o{ ingestion_job_items : "processed in"
    conversations ||--o{ messages : "contains"
    conversations ||--o{ retrieval_logs : "traces"
    messages ||--o| retrieval_logs : "explains"
    documents ||--o{ document_permissions : "future access control"
    principals ||--o{ document_permissions : "granted to"
    evaluation_runs ||--o{ evaluation_results : "scores"

    documents {
        uuid id PK
        varchar document_code UK
        text title
        varchar document_type
        varchar department
        boolean is_active
    }
    document_revisions {
        uuid id PK
        uuid document_id FK
        int revision_number
        text file_path "storage key, never a path"
        boolean is_current "partial unique per document"
        varchar processing_status
        varchar file_hash
        varchar content_hash
    }
    document_chunks {
        uuid id PK
        uuid document_revision_id FK
        uuid parent_chunk_id FK
        text content
        vector embedding
        tsvector text_search
        boolean is_current
        varchar extraction_method
    }
```

---

## Why these technology choices

### Why PostgreSQL for everything

A RAG system has two kinds of state that people usually split across two databases: relational metadata
(which document, which revision, is it current) and vectors. Splitting them means every retrieval query
becomes a distributed join, and every revision activation becomes a distributed transaction you cannot
actually make atomic.

Keeping both in PostgreSQL means the single most important operation in this system — *promote the new
revision and demote the old one, or do neither* — is one `BEGIN … COMMIT`. There is no window where a
document has two current revisions, and no window where it has none.

It also means retrieval can filter on `is_current`, `is_active`, department and document type in the
same query that ranks by vector distance, using ordinary indexes, with no application-side reconciliation.

### Why pgvector

It is the vector index that lives inside the database holding the metadata, which is the whole argument
above. Beyond that: cosine distance with an HNSW index, `EXPLAIN` that works, `pg_relation_size` that
tells you what the index actually costs, and backups that include the vectors.

The index is **partial** — `WHERE is_current AND embedding IS NOT NULL`. Normal retrieval only ever
searches current revisions, so building the index over just those rows keeps it small and avoids the
classic filtered-ANN failure where HNSW returns `ef_search` neighbours that are then almost entirely
filtered away. Historical-revision search is an analytical path and is allowed to fall back to an exact
scan.

### Why not a dedicated vector database

Chroma and friends are excellent at being a vector index. They are not a place to store the fact that
revision 2 superseded revision 1 on a particular date, nor can they participate in the transaction that
makes that true. This project's hard problems are lifecycle problems, so the database that owns the
lifecycle should own the vectors.

### Why raw SQL for retrieval rather than a LangChain vector store

LangChain is used where it is genuinely the right tool: the OpenAI chat integration, streaming, message
types, and the recursive character splitter for the one case that needs it (a single paragraph too long
to fit in a chunk).

Retrieval is not that case. The hot path needs a weighted `tsvector`, predicates aligned with a partial
index, metadata filters and distance in one round trip. Expressing that through a generic store wrapper
costs clarity and control and buys nothing. The retrieval SQL lives in a repository behind an interface,
so it is still swappable — it is just not pretending to be generic.

---

## Quick start

### Prerequisites

- **Node.js ≥ 22.13** (`.nvmrc` pins 24). The current releases of `openai`, `@langchain/openai` and
  `pdfjs-dist` require it.
- **PostgreSQL 15+ with pgvector**, either via Docker Compose or installed locally.
- An **OpenAI API key** for real embeddings and chat. Everything except answer generation runs without
  one, using the deterministic mock embedding provider.

### From a clean checkout

```bash
git clone <repository-url> docs-revisions-rag
cd docs-revisions-rag

cp .env.example .env
# Edit .env: set OPENAI_API_KEY, and set EMBEDDING_PROVIDER=openai for real retrieval quality.

# Start PostgreSQL with pgvector (exposed on 5433 to avoid clashing with a local server)
docker compose up -d postgres

# If you used Docker, point DATABASE_URL at it:
#   DATABASE_URL=postgres://rag:rag@localhost:5433/docs_rag
#   TEST_DATABASE_URL=postgres://rag:rag@localhost:5433/docs_rag_test

npm install
npm run db:migrate

# Generate 75 realistic documents plus a gold evaluation dataset
npm run corpus:generate -- --profile=quality --count=75 --seed=123

# Parse, OCR where needed, chunk, embed and activate
npm run ingestion:run

# API on :3000, web client on :5173
npm run dev
```

Open <http://localhost:5173> and ask:

> What expenses require Finance Director approval?

You should get an answer with a citation to `FIN-POL-001`, and clicking the citation should show the
exact passage, its revision and its page.

### Running everything in Docker

```bash
cp .env.example .env          # set OPENAI_API_KEY
docker compose up -d          # postgres + api + web

docker compose exec api npx tsx scripts/migrate.ts up
docker compose exec api npx tsx scripts/generate-mock-corpus.ts --profile=quality --count=75
docker compose exec api npx tsx scripts/run-ingestion.ts
```

The client is then on <http://localhost:5173> and proxies `/api` to the API container, so the browser
only ever talks to one origin.

---

## The revision lifecycle

This is the part worth reading closely, because it is what separates this from a document chatbot.

```mermaid
stateDiagram-v2
    [*] --> PENDING : revision discovered or created

    PENDING --> PROCESSING : claimed by an ingestion run
    PROCESSING --> READY : parsed, chunked, embedded, activated
    PROCESSING --> FAILED : any stage threw
    PROCESSING --> PENDING : worker died (stale claim released)

    FAILED --> PENDING : explicitly reprocessed
    READY --> SUPERSEDED : a newer revision was activated

    note right of PROCESSING
        The previous revision stays
        is_current = true and fully
        searchable for this whole period.
    end note

    note right of READY
        Activation is one transaction:
        demote old + promote new,
        or neither.
    end note

    note right of SUPERSEDED
        Chunks are retained, not deleted,
        so "what did revision 3 say?"
        stays answerable.
    end note
```

The guarantees, and where they are enforced:

| Guarantee | Enforced by |
|---|---|
| A document never has two current revisions | Partial unique index `document_revisions_one_current_idx` |
| A document never has zero current revisions during an update | Demote and promote happen in one transaction |
| A failing revision cannot affect the live one | New chunks are inserted with `is_current = false`; only activation flips them |
| An unprocessed revision is invisible to retrieval | Retrieval filters `is_current`, which is only set at activation |
| A superseded revision's content survives | Activation flips `is_current`; it never deletes chunks |
| Re-processing an old revision cannot roll a document backwards | `shouldActivate` refuses if a newer revision is already READY |
| Two ingestion runs cannot process the same revision | `FOR UPDATE SKIP LOCKED` on claim, plus a session advisory lock per run |

### See it happen

```bash
npm run demo:revision
```

That script walks the whole scenario and prints the answer at each step:

```
1. Starting state          rev 1 CURRENT      → "…up to $27,500, requires the approval of the Finance Director."
>>> Created revision 2: Finance Director approval threshold changed from $27,500 to $35,000.
2. After creating          rev 1 CURRENT      → "…up to $27,500…"   (unchanged: revision 2 is PENDING)
   the revision            rev 2 PENDING
>>> Running ingestion...
3. After ingestion         rev 1 SUPERSEDED   → "…up to $35,000, requires the approval of the Finance Director."
                           rev 2 CURRENT
```

Or drive it by hand:

```bash
npm run corpus:revise -- --document=FIN-POL-001 --fact=financeDirectorThreshold
npm run db:psql -- -c "SELECT revision_number, is_current, processing_status FROM document_revisions r JOIN documents d ON d.id = r.document_id WHERE d.document_code = 'FIN-POL-001' ORDER BY 1"
npm run ingestion:run
```

### The failure case

```bash
npm run corpus:corrupt -- --document=FIN-POL-001   # writes an unreadable file as a new revision
npm run ingestion:run
```

The run reports `PARTIALLY_COMPLETED`. The corrupt revision is `FAILED` with the failing stage recorded.
The previous revision is still `CURRENT`, still has its chunks, and still answers questions. Both
scenarios are covered by integration tests (`tests/integration/revision-lifecycle.test.ts` and
`failed-revision.test.ts`).

---

## The synthetic corpus

Since the original documents are not available, the project generates its own. The generator is not
decoration — it is what makes the evaluation numbers mean anything.

**Deterministic.** The same seed always produces the same corpus: the same documents, the same numbers
inside them, the same defects in the same places. `planCorpus` is pure, and every document draws from an
RNG stream derived from its own code, so adding a document does not shift the content of the others.

**Fact-driven.** Each document type is described by a *blueprint* that declares typed facts —
`financeDirectorThreshold`, `p1Escalation`, `warningThreshold` — and the sections those facts appear in.
The generator instantiates the facts once and the blueprint's prose reads them, so a threshold appears
consistently in the policy statement, in the approval table, and in the gold answer. Change the fact,
and all three change together.

**Realistically messy.** Configurable ratios produce scanned PDFs, mixed native/scanned documents, DOCX
and Markdown files, near-duplicate documents, inactive documents, multi-revision documents and
intentionally corrupt files.

```bash
npm run corpus:generate -- --profile=smoke                       # ~15 documents, fast iteration
npm run corpus:generate -- --profile=quality --count=75 --seed=123  # coherent, with gold questions
npm run corpus:generate -- --profile=scale --count=5000 --seed=123  # infrastructure testing
```

| Profile | Size | Purpose | Gold dataset |
|---|---|---|---|
| `smoke` | ~15 | Fast development loop | yes |
| `quality` | ~75 | Retrieval and answer evaluation with real embeddings | yes |
| `scale` | 1,000–5,000+ | Ingestion throughput, index build, query latency | no — see below |

The scale profile writes no gold dataset on purpose. It exists to test infrastructure, and infrastructure
testing uses mock embeddings; publishing "recall" numbers computed from non-semantic vectors would be
exactly the kind of dishonesty this project is built to avoid.

### Scanned documents are genuinely scanned

A scanned PDF here is a real one: the laid-out text is painted onto a bitmap, the bitmap becomes the whole
page, and no text layer is written. Light scan artefacts — a fraction of a degree of skew, faint speckle,
slightly grey paper — are applied deterministically so OCR faces something closer to a real scan than to
a screenshot.

Native extraction on such a document returns nothing, which forces the pipeline down the OCR path for
real rather than because a metadata flag said so. The OCR integration test asserts that the specific
monetary threshold survives recognition, because an answer built on a misread number is wrong in exactly
the way that matters.

### Workflow diagrams

Documents that describe a process carry a real flowchart, drawn to a bitmap and embedded in the PDF. The
diagram's text form is stored in the revision's metadata as ground truth, so OCR and vision extraction
can be scored against a known answer later.

### Gold evaluation data

Generating a `quality` corpus also writes `data/evaluation/questions.json`:

```json
{
  "id": "FIN-POL-001-q01",
  "question": "What expense amount requires Finance Director approval?",
  "questionType": "DIRECT",
  "expectedDocumentCode": "FIN-POL-001",
  "expectedRevision": 1,
  "expectedSection": "Approval Requirements",
  "referenceAnswer": "Expenditure at or above $27,500 requires Finance Director approval before the commitment is made.",
  "expectedFacts": ["$27,500"],
  "isNoAnswer": false
}
```

Question shapes include direct, paraphrased, terminology, exact-identifier, cross-section,
revision-sensitive, and — importantly — **no-answer** questions about plausible topics the corpus does
not cover. A system that answers everything is not grounded, and without negative examples that failure
is invisible.

---

## Ingestion

```bash
npm run ingestion:run                     # one synchronisation
npm run ingestion:run -- --limit=50       # bound the batch
npm run ingestion:run -- --revision=<uuid>  # reprocess one revision
```

Or `POST /api/admin/ingestion/run`, or on a schedule via `INGESTION_CRON` (empty by default — waiting for
a cron tick to see whether a change worked is a miserable development loop).

### Discovery

Discovery reconciles the storage driver with the database:

- a file with no revision row → registered as `PENDING`
- a file whose bytes changed → re-queued as `PENDING`
- a revision row whose file has vanished → **reported, never deleted** (losing a file is an operational
  problem, not a reason to silently drop the organisation's current policy)

Dropping a `rev-003/` folder onto the share is therefore enough to publish a revision, which is how a
real document repository behaves.

### Parsing

PDFs are the interesting case, because a PDF has no notion of a heading — only glyphs at coordinates.

- **Lines** are reconstructed by grouping glyph runs by baseline `y`, not by trusting content-stream
  order, which is frequently scrambled for tables.
- **Headings** are detected by font size against the document's modal body size, with textual heuristics
  as a fallback for OCR'd pages that have no font metrics.
- **Tables** are recovered from column gaps: pdfjs represents a wide horizontal gap as a whitespace item
  whose advance width spans it, which is the only signal a PDF gives that two runs are in different
  columns.
- **Running headers and footers** are removed evidence-based — a line is dropped only if the same
  normalised text (digits mapped to `#`, so "Page 1 of 9" and "Page 7 of 9" match) appears in the same
  band on most pages. Left in, that boilerplate lands in every chunk and dilutes every embedding.

### OCR

OCR is decided **per page**, not per document, because real corpora contain policies with a scanned
appendix bolted on. A page is sent to OCR only when its native text is below an absolute floor *and*
below a character-per-area density — an A4 page with 150 characters is a header on a scan, while an index
card with 150 characters may be the whole page.

The extraction method is recorded per chunk (`NATIVE_TEXT`, `OCR`, `VISION`, `MIXED`) and surfaced in the
UI and in citations, so an answer sourced from recognised text can be audited as such.

### Chunking

Fixed-size splitting is cheap and wrong: it severs numbered procedures mid-sequence, orphans table rows
from their header, and drops the heading that told you which policy a threshold belonged to.

Rules, in priority order:

1. Never cross a top-level section boundary.
2. Keep a numbered procedure whole when it fits inside `CHUNK_MAX_TOKENS`.
3. Keep a table whole when it fits; when it does not, repeat the header row on every piece.
4. Otherwise pack elements up to `CHUNK_TARGET_TOKENS`, tolerating overflow to `CHUNK_MAX_TOKENS` rather
   than stranding an atomic block.
5. Split an oversized single paragraph with a recursive character splitter — the one place a generic
   splitter is the right tool.

Trivially small sections (Purpose, Scope) are merged with their neighbours, but only with sections of the
same *role*: merging is kept timid because a merged chunk can carry only one section title, and citations
are expected to name the section an answer came from.

**Section roles.** A revision-history table quotes every threshold the document has ever had. At full
weight it out-ranks the section stating the *current* rule, so a document with a long history answers
questions with a summary of its own edits. Such sections are tagged `ADMINISTRATIVE` and demoted in
ranking — demoted, not excluded, so "how did this policy change?" still works.

**Embedding context.** What gets embedded is not the bare chunk. It is prefixed with its document and
heading context:

```
Document: FIN-POL-001 Business Expense Policy
Department: Finance
Section: Approval Requirements

Approval authority is determined by the total value of the commitment…
```

A chunk that says "must be approved by the Finance Director" is far more findable when its vector also
knows which policy and section it came from. The **stored** content stays clean, so citations show the
passage rather than the scaffolding.

---

## Retrieval

```mermaid
flowchart TB
    Q["User question"] --> HIST{"Follow-up?<br/>pronouns, short, starts with 'what about'"}
    HIST -->|no| SQ["Standalone query = question"]
    HIST -->|yes| RW["Rewrite using recent turns<br/>(bounded history)"] --> SQ

    SQ --> IDS["Extract document codes<br/>FIN-POL-001, ORA-GUIDE-003, ORA-01555"]
    SQ --> EMB["Embed query"]

    EMB --> VEC["pgvector · cosine<br/>VECTOR_TOP_K"]
    SQ --> LEX["websearch_to_tsquery<br/>weighted tsvector · LEXICAL_TOP_K"]
    IDS --> IDENT["Exact document lookup<br/>weight 0.6"]

    VEC --> RRF["Reciprocal Rank Fusion<br/>k = RRF_K"]
    LEX --> RRF
    IDENT --> RRF

    RRF --> DEMOTE["Demote administrative sections"]
    DEMOTE --> RERANK["Reranker (noop by default)"]
    RERANK --> PARENT["Parent expansion<br/>swap child for its section"]
    PARENT --> DEDUP["Deduplicate + merge adjacent"]
    DEDUP --> BUDGET["Token budget"]
    BUDGET --> CTX["Context + citations"]
    CTX --> LLM["OpenAI chat model"]
    LLM --> ANS["Streamed answer with [n] markers"]
```

### Why three candidate sources

Vector search finds things by meaning and misses exact identifiers — `ORA-GUIDE-003` is a rare token
whose embedding carries little signal. Full-text search finds identifiers and misses paraphrases. Both
together cover most questions.

The third source exists because "what does ORA-GUIDE-003 say about tablespace monitoring?" is poorly
served even by both: full-text ranking will happily prefer a long chunk that mentions tablespaces in a
*different* document. Pulling the named document's chunks directly and letting them compete in the fusion
is more reliable than hoping either index surfaces them. It is weighted below the other two, because an
explicit code is a strong signal about *which document* and says nothing about which section answers the
question.

### Why RRF rather than score normalisation

pgvector returns cosine similarity in `[-1, 1]`. `ts_rank_cd` returns an unbounded figure whose scale
depends on the query. Normalising those onto a common scale requires assumptions that break exactly when
a query is unusual — which is when you need retrieval to work.

RRF uses only *position*:

```
score(d) = Σ  weight / (k + rank)
```

`k` damps the top ranks: larger flattens the curve so a document must appear in several lists to win;
smaller lets a single first place dominate. 60 is the value from the original paper and a sane default;
it is configurable via `RRF_K`, and the implementation is unit-tested (`tests/unit/rrf.test.ts`).

### Hybrid retrieval, observed

A real trace from the corpus, with the **mock** provider deliberately in use so one source is weak:

```
Query: "What is the standard annual leave entitlement?"

  vector  → ERP-STD-002                     (hashed on "standard", matching
                                             "ERP … Segregation of Duties Standard")
  lexical → HR-POL-001, HR-POL-005          (correct)
  fused   → ERP-STD-002 · HR-POL-001 · HR-POL-005 · HR-POL-001/Carry-Over
```

The dense side was wrong, and lexical retrieval rescued it: the right document lands at rank 2 and its
"Annual Leave Entitlement" section reaches the model. That is precisely the failure mode a single-strategy
retriever cannot recover from — and it is why `LEXICAL_TOP_K` is not set to zero once embeddings are
"good enough".

(The dense miss here is a mock-embedding artefact; the mock provider is a hashing vectoriser, not a
semantic model. With OpenAI embeddings that query resolves correctly on both sides. The point stands: the
two strategies fail on different queries, which is the whole argument for fusing them.)

### Parent-child retrieval

Small chunks match precisely; larger sections answer completely. A matched child is swapped for its
parent section when the parent adds meaningful context and fits the per-source budget — a threshold means
little without the conditions stated around it. Expansion is skipped when the parent is very large, since
spending most of the budget on one section starves the rest.

### Context assembly

Before generation: near-duplicates are dropped (chunk overlap produces containment ratios around 0.3–0.5,
genuine duplicates land above 0.85), adjacent chunks from the same section are merged back into one
passage, and the result is fitted to `CONTEXT_TOKEN_BUDGET`.

Every source is written with a header giving its document code, title, revision, effective date, section
and page — and marked when it came from OCR or from a superseded revision.

### Citations

**Citations are built from chunk rows, never parsed out of model output.** The model chooses which
bracket to write; it cannot invent what that bracket points at. A marker referring to a source that does
not exist renders as plain text rather than as a clickable, authoritative-looking link.

```json
{
  "answer": "Expenditure at or above $27,500 requires Finance Director approval [1].",
  "citations": [{
    "index": 1,
    "chunkId": "…", "documentId": "…", "revisionId": "…",
    "documentCode": "FIN-POL-001",
    "documentTitle": "Business Expense Policy",
    "revision": 2,
    "page": 1,
    "section": "Approval Requirements",
    "excerpt": "Approval authority is determined by the total value of the commitment…",
    "extractionMethod": "NATIVE_TEXT"
  }]
}
```

### Debugging a bad answer

```bash
curl -s -X POST localhost:3000/api/debug/retrieval \
  -H 'content-type: application/json' -H 'x-admin-key: dev-admin-key' \
  -d '{"query":"What expenses require Finance Director approval?"}' | jq
```

Or use the **Retrieval debug** page in the UI, which shows each candidate list with its own ranks and
scores alongside the fused ordering. The useful question when an answer is wrong is almost never "was
retrieval bad?" but "which stage went wrong" — a lexical match on a stale chunk, a dense neighbour that
outranked the right passage, or fusion weighting them badly.

---

## Evaluation and benchmarking

### Retrieval quality

```bash
npm run eval:retrieval
```

Scores retrieval against the gold dataset and reports Recall@1/3/5, MRR, section accuracy,
current-revision accuracy, no-answer behaviour and latency percentiles, broken down by question type.

Two deliberate choices:

- **Recall is measured over documents, not chunks.** The question is whether the system found the right
  document; a corpus that splits a policy into ten pieces should not be penalised for surfacing the
  second-best chunk of the right one first.
- **A hit must be on the current revision.** A retriever that confidently returns the superseded answer
  has failed at the thing this system exists to get right, and a metric that scored it as a hit would
  hide that.

The runner **refuses to report quality numbers when the mock embedding provider is in use.** Those
vectors are lexical hashes; recall computed from them is not a retrieval-quality result. `--allow-non-semantic`
exists to exercise the harness itself, and the output is labelled as meaningless when used.

### Answer quality

```bash
npm run eval:rag -- --limit=30
```

Runs the full pipeline and checks: are the expected facts present in the answer, does the citation point
at the right document *and the right revision*, did it cite a superseded revision, and were the no-answer
questions refused?

Scoring is deterministic string and citation matching — no LLM judge. A judge doubles the cost of every
run and introduces its own errors into a measurement whose entire purpose is to be trustworthy. The facts
are known by construction, so string matching is sufficient and honest.

### Latency and index size

```bash
npm run benchmark:retrieval -- --iterations=10
```

```
Storage
  database size                    13.0 MB
  document_chunks (incl. indexes)  3.2 MB
  vector index (HNSW)              776 KB
  full-text index (GIN)            384 KB

Latency (ms)
  stage                p50  p95  p99   mean
  hybrid (end to end)  2.0  4.0  15.0  2.3
    query embedding    0.0  0.0  0.0   0.0
    vector search      2.0  3.0  4.0   2.1
    lexical search     1.0  1.0  3.0   1.1
  vector SQL only      2.3  3.5  3.6   2.5
  lexical SQL only     1.2  2.9  8.7   1.5
```

Vector and lexical search are timed separately because they scale differently: ANN search degrades with
index size, full-text search with matching-row count. Warm-up runs are discarded — the first queries pay
for connection setup, plan caching and pulling index pages into the buffer cache, and including them
would report a latency nobody experiences.

---

## Scale testing

Test the infrastructure without paying to embed a corpus nobody intends to evaluate:

```bash
EMBEDDING_PROVIDER=mock npm run corpus:generate -- --profile=scale --count=5000 --seed=123
EMBEDDING_PROVIDER=mock npm run ingestion:run
EMBEDDING_PROVIDER=mock npm run benchmark:retrieval
```

Then switch back for semantic quality:

```bash
EMBEDDING_PROVIDER=openai npm run corpus:generate -- --profile=quality --count=75 --seed=123
npm run ingestion:run
npm run eval:retrieval
```

### Measured at 2,000 documents

Generated, ingested and benchmarked on a laptop (PostgreSQL 18 + pgvector 0.8.6, mock embeddings,
OCR disabled — the scanned documents are exercised by the quality corpus instead):

| | |
|---|---|
| Corpus generation | 2,000 documents / 2,783 revisions / 174 MB in **2m 08s** |
| Ingestion | 2,579 revisions → **21,430 chunks in 47s** (≈ 54 revisions/s) |
| Database size | 446 MB (chunk table + indexes 423 MB) |
| HNSW index | 156 MB · GIN full-text index 12.3 MB |
| Hybrid retrieval | **p50 2 ms · p95 6 ms · p99 10 ms**, 334 queries/s |

The 204 revisions that failed in that run were the scanned PDFs, correctly, because OCR was disabled for
it — a scanned document has no extractable text, the revision is marked `FAILED` with the reason
recorded, and the other 2,579 complete unaffected. That is the failure-isolation behaviour working, not
an error in the run.

### The cost guard

Attempting to ingest a large corpus through OpenAI without saying so explicitly **fails**:

```
Refusing to embed 5000 revisions through OpenAI: that exceeds
LARGE_OPENAI_INGESTION_THRESHOLD=250 and ALLOW_LARGE_OPENAI_INGESTION is false.

Either:
  • set EMBEDDING_PROVIDER=mock for infrastructure/scale testing, or
  • set ALLOW_LARGE_OPENAI_INGESTION=true if you intend to pay for this run, or
  • lower MAX_DOCUMENTS_PER_INGESTION_RUN to ingest in smaller batches.
```

It throws rather than warns: a warning scrolls past, and by the time you read it you have spent the money.

### Tuning the vector index

The migration builds the HNSW index with pgvector's defaults (`m=16`, `ef_construction=64`) on purpose —
tuning before there is a corpus and a latency target is guesswork. Once there is:

```bash
npm run db:indexes -- --m=32 --ef-construction=128
```

It rebuilds `CONCURRENTLY` and swaps atomically, so retrieval is never without an index. Query-time recall
is governed by `hnsw.ef_search`, which can be set per session. Measure with `npm run eval:retrieval`
before and after — do not tune blind.

---

## Configuration

Every setting is validated at boot by a Zod schema in `apps/api/src/config/env.ts`. Nothing else in the
codebase reads `process.env`, which is what makes "the embedding dimension is configurable" true rather
than aspirational. See `.env.example` for the annotated full list.

The settings worth understanding:

| Variable | Default | Why it matters |
|---|---|---|
| `EMBEDDING_PROVIDER` | `openai` | `mock` gives deterministic non-semantic vectors for scale testing |
| `EMBEDDING_DIMENSIONS` | `1536` | Baked into the `vector(n)` column by migration 0003; the API **refuses to start** if the two disagree |
| `CHUNK_TARGET_TOKENS` / `MAX` / `OVERLAP` | 650 / 900 / 100 | Starting defaults, not universal truths — measure before changing |
| `VECTOR_TOP_K` / `LEXICAL_TOP_K` | 25 / 25 | Candidates per source before fusion |
| `RRF_K` | 60 | Fusion damping; larger rewards agreement across sources |
| `FINAL_CONTEXT_CHUNKS` / `CONTEXT_TOKEN_BUDGET` | 8 / 6000 | What actually reaches the model |
| `VECTOR_MAX_DISTANCE` | 0.95 | Discards weak dense hits so an unanswerable question does not manufacture context |
| `INGESTION_CRON` | *(empty)* | Empty disables scheduling — the right default for development |
| `ALLOW_LARGE_OPENAI_INGESTION` | `false` | The cost guard above |
| `OCR_MIN_NATIVE_CHARS` / `OCR_MIN_CHARS_PER_PAGE_AREA` | 180 / 0.0004 | When a page is treated as scanned |
| `VISION_ENABLED` | `false` | Diagram description; off because of cost |
| `ENABLE_DEBUG_ENDPOINTS` | `false` | Debug routes are on outside production and require explicit opt-in inside it |

### Changing the embedding model

The dimension lives in exactly one place — configuration — and is templated into the migration:

```bash
# In .env
OPENAI_EMBEDDING_MODEL=text-embedding-3-large
EMBEDDING_DIMENSIONS=3072

npm run db:reset          # the column type changes, so the schema must be rebuilt
npm run corpus:generate -- --profile=quality --count=75 --seed=123
npm run ingestion:run
```

Starting the API with a mismatch fails immediately with an explanation, rather than failing row by row
deep inside ingestion.

---

## Command reference

| Command | What it does |
|---|---|
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:migrate:status` | Show applied/pending migrations and checksum drift |
| `npm run db:reset` | Drop and rebuild the schema (refuses in production) |
| `npm run db:indexes` | Rebuild the HNSW index, optionally with tuned parameters |
| `npm run db:psql` | Open `psql` against `DATABASE_URL` |
| `npm run corpus:generate` | Generate the synthetic corpus and gold questions |
| `npm run corpus:revise -- --document=CODE` | Publish a new revision with one changed rule |
| `npm run corpus:corrupt -- --document=CODE` | Publish a deliberately unreadable revision |
| `npm run ingestion:run` | Run one ingestion synchronisation |
| `npm run demo:revision` | Walk the full revision lifecycle, printing the answer at each step |
| `npm run eval:retrieval` | Score retrieval against the gold dataset |
| `npm run eval:rag` | Score end-to-end answers, citations and refusals |
| `npm run benchmark:retrieval` | Latency percentiles and real index sizes |
| `npm run dev` | API and web client together |
| `npm run build` | Build all workspaces |
| `npm test` | Full test suite |
| `npm run typecheck` | Typecheck every workspace |

---

## Project layout

```
apps/
  api/
    src/
      config/        env schema + typed configuration (the only reader of process.env)
      db/            pool, transactions, migrator, pgvector serialisation
      repositories/  all SQL; row types; mapping to API DTOs
      modules/
        corpus/      blueprints, planner, composer, renderers, revision simulator
        storage/     DocumentStorage interface + local driver (path traversal defence)
        parsing/     PDF / DOCX / text parsers, structured elements
        ocr/         OCRProvider interface + Tesseract implementation
        vision/      optional diagram description
        chunking/    structure-aware chunker
        embeddings/  EmbeddingProvider interface, OpenAI + deterministic mock
        ingestion/   discovery, per-revision processor, orchestrator, scheduler
        retrieval/   RRF, reranker, query analysis, context builder, service
        chat/        chat model provider, RAG service
        evaluation/  gold dataset loading, metrics, retrieval + RAG evaluators
      controllers/   handler logic
      routes/        route registration + Zod schemas
      middleware/    error handling, admin auth
      prompts/       RAG system prompt, rewrite prompt
      cli/           implementations behind the npm scripts
    tests/
      unit/          pure logic: fusion, chunking, dedup, planning, path safety
      integration/   real PostgreSQL: ingestion, lifecycle, failure, retrieval, HTTP, OCR
  web/
    src/
      api/           typed client + SSE reader
      components/    sidebar, badges, formatting
      features/
        chat/        streaming chat with inline citations
        documents/   register browser and revision timeline
        admin/       lifecycle console and retrieval debug
        sources/     citation source panel
packages/shared/     types shared by API and client
scripts/             thin entry points for the npm commands
migrations/          numbered, checksummed SQL
docker/              Dockerfiles, nginx config, Postgres init
storage/documents/   simulated enterprise document repository
data/evaluation/     generated gold dataset
```

---

## Testing

```bash
npm test                                        # everything
npm run test --workspace @docs-rag/api -- tests/unit   # fast, no database
npm run test:integration --workspace @docs-rag/api     # requires TEST_DATABASE_URL
```

176 tests across 11 files. Integration tests run against a real PostgreSQL with pgvector — a test suite
for a database-centric system that mocks the database proves very little. The suite refuses to run unless
the database name contains `test`.

Covered scenarios, mapped to where they live:

| Scenario | File |
|---|---|
| Normal ingestion, idempotency, unchanged-content skip | `integration/ingestion.test.ts` |
| Discovery of new and modified files; missing files reported not deleted | `integration/ingestion.test.ts` |
| Concurrent runs serialised by advisory lock | `integration/ingestion.test.ts` |
| Revision created → invisible → activated → old one superseded but retained | `integration/revision-lifecycle.test.ts` |
| Exactly one current revision, enforced by the database | `integration/revision-lifecycle.test.ts` |
| Corrupt revision fails alone; previous stays current and searchable; recovery | `integration/failed-revision.test.ts` |
| Hybrid retrieval, exact codes, metadata filters, current vs historical | `integration/retrieval.test.ts` |
| Scanned PDF OCR, mixed pages, no wasted OCR, OCR provenance on chunks | `integration/ocr.test.ts` |
| HTTP validation, admin auth, path traversal, SSE streaming, citation payloads | `integration/api.test.ts` |
| RRF maths, chunking rules, dedup, corpus determinism, cost guard, path safety | `tests/unit/*` |

---

## Operations

**Structured logging.** JSON via pino, with `requestId`, `conversationId`, `documentId`, `revisionId`,
`ingestionJobId` and stage durations. Secrets are redacted centrally, so a stray `logger.info({ config })`
cannot leak an API key or a database password.

**Observability.** Every ingestion run writes an `ingestion_jobs` row with per-revision items recording
outcome, failing stage, chunk counts and per-stage timings. Every retrieval writes a `retrieval_logs` row
with the candidate lists and the fused ordering — which is what makes "why did the model answer that?"
answerable after the fact.

**Health.** `/health` answers "is the process up?" without touching the database, so an orchestrator uses
it to decide whether to restart. `/ready` checks dependencies.

**Graceful shutdown.** The scheduler stops, in-flight requests finish, OCR workers are terminated, then
the pool closes. The OCR step matters: without it the process hangs on exit holding its database session
— and with it, the ingestion advisory lock.

---

## Security

Implemented:

- **Zod validation** on every body, query string and path parameter.
- **Parameterised SQL everywhere.** Dynamic *structure* (optional filters) is built by a small helper
  that only ever appends `$n` placeholders; values never touch the statement string.
- **Path traversal is structurally impossible.** No route accepts a path. A client names a revision by
  UUID; the server looks up its storage key; the storage driver resolves it, rejecting absolute paths,
  UNC paths, NUL bytes and anything that escapes the root — compared with a trailing separator so
  `/storage/documents-evil` cannot pass as a child of `/storage/documents`.
- **Safe file serving.** `Content-Disposition: attachment` plus `X-Content-Type-Options: nosniff`, so a
  document can never render as active content.
- **Prompt injection defence.** Retrieved content is framed explicitly as data between markers, and the
  system prompt instructs the model to disregard instructions found inside documents. Documents in a
  corpus like this are edited by many people over many years.
- **Citations cannot be fabricated**, because they are built from chunk rows.
- **Helmet, CORS allow-list, rate limiting**, and a constant-time comparison on the admin secret.
- **No credentials in the browser.** All model calls originate from the API.

Not implemented, deliberately: real authentication. The admin secret is the right amount of security for
a demo tool and the wrong amount for anything else. It is isolated behind a single hook so replacing it
with OIDC/SSO touches one file. The permission model — principals, group membership, per-document
ALLOW/DENY — exists as schema and is documented in **[docs/security-and-permissions.md](docs/security-and-permissions.md)**,
including why authorisation must filter *before* retrieval rather than after.

---

## Known limitations

Stated plainly, because a system that hides its edges is harder to trust.

- **Authentication is a shared secret.** See above.
- **Historical-revision retrieval has no ANN index.** The HNSW index is partial on `is_current`, so
  `includeHistorical` queries fall back to an exact scan. Fine at demo scale, a problem at a million
  chunks; the fix is a second index, at the cost of build time and disk.
- **The reranker is a no-op.** The interface and the evaluation harness are in place; no cross-encoder is
  wired up, because an unmeasured reranker is not an improvement.
- **Vision enrichment is off by default** and unevaluated. The corpus stores ground-truth diagram text so
  it *can* be scored, but that comparison is not built.
- **Chunk sizes run well below the configured target on this corpus**, and this has a consequence worth
  knowing. Measured over 21,430 chunks: mean 109 tokens, max 434, against a `CHUNK_TARGET_TOKENS` of 650.
  Generated sections are simply short, and the chunker will not split a section or merge across one to hit
  a number. Two follow-ons:
  - **Parent chunks never form on this corpus** — zero of 21,430. A parent is only created for a section
    larger than the target, and none are. The parent-child path is implemented, unit-tested and wired into
    retrieval, but on this data it is dormant; it would come alive on a corpus with longer sections.
  - **`FINAL_CONTEXT_CHUNKS` binds before `CONTEXT_TOKEN_BUDGET`.** Eight chunks of ~110 tokens is ~900
    tokens against a 6,000-token budget. Both defaults are the ones specified, and they are the right
    shape for documents with substantial sections; on *this* corpus, raising the chunk count would use the
    budget better.
- **DOCX has no page numbers.** Pagination is a rendering artefact, not stored in the file, so citations
  from DOCX carry a section but no page rather than an invented one.
- **The query rewriter is heuristic-gated.** It fires on pronouns, short questions and follow-up openers.
  It will occasionally rewrite something that did not need it — one cheap model call — and could miss an
  unusual follow-up phrasing.
- **`text-embedding-3-*` dimension changes require a schema rebuild.** The column type is fixed at
  migration time; there is no online re-embedding path.

---

## Licence

Provided as a portfolio and reference implementation.
