-- ---------------------------------------------------------------------------
-- 0008 - Evaluation datasets and results
--
-- The gold questions live in data/evaluation/questions.json (generated with the
-- corpus so expected answers are objectively verifiable). They are also loaded
-- into PostgreSQL so evaluation runs can be joined against documents/revisions
-- and compared over time.
-- ---------------------------------------------------------------------------

CREATE TABLE evaluation_questions (
    id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Stable id from questions.json, so re-imports update instead of duplicate.
    external_id            VARCHAR(120) NOT NULL,
    question               TEXT        NOT NULL,
    -- DIRECT | PARAPHRASE | TERMINOLOGY | IDENTIFIER | CROSS_SECTION |
    -- NO_ANSWER | REVISION_SENSITIVE
    question_type          VARCHAR(32) NOT NULL DEFAULT 'DIRECT',
    expected_document_code VARCHAR(64),
    expected_revision      INTEGER,
    expected_section       TEXT,
    reference_answer       TEXT,
    expected_facts         JSONB       NOT NULL DEFAULT '[]'::jsonb,
    -- TRUE for questions that must NOT be answerable from the corpus.
    is_no_answer           BOOLEAN     NOT NULL DEFAULT FALSE,
    corpus_seed            INTEGER,
    corpus_profile         VARCHAR(24),
    metadata               JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT evaluation_questions_external_id_key UNIQUE (external_id)
);

CREATE INDEX evaluation_questions_type_idx ON evaluation_questions (question_type);
CREATE INDEX evaluation_questions_doc_idx  ON evaluation_questions (expected_document_code);


CREATE TABLE evaluation_runs (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- RETRIEVAL | RAG | BENCHMARK
    kind               VARCHAR(24) NOT NULL DEFAULT 'RETRIEVAL',
    started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at       TIMESTAMPTZ,
    question_count     INTEGER     NOT NULL DEFAULT 0,
    embedding_provider VARCHAR(32),
    embedding_model    VARCHAR(120),
    chat_model         VARCHAR(120),
    -- Recall@k, MRR, revision accuracy, refusal accuracy, latency percentiles.
    metrics            JSONB       NOT NULL DEFAULT '{}'::jsonb,
    config             JSONB       NOT NULL DEFAULT '{}'::jsonb,
    notes              TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX evaluation_runs_started_at_idx ON evaluation_runs (started_at DESC);


CREATE TABLE evaluation_results (
    id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    evaluation_run_id      UUID        NOT NULL REFERENCES evaluation_runs (id) ON DELETE CASCADE,
    evaluation_question_id UUID        REFERENCES evaluation_questions (id) ON DELETE SET NULL,
    external_id            VARCHAR(120),
    question               TEXT        NOT NULL,

    hit_rank               INTEGER,
    reciprocal_rank        DOUBLE PRECISION NOT NULL DEFAULT 0,
    recall_at_1            BOOLEAN     NOT NULL DEFAULT FALSE,
    recall_at_3            BOOLEAN     NOT NULL DEFAULT FALSE,
    recall_at_5            BOOLEAN     NOT NULL DEFAULT FALSE,
    section_hit            BOOLEAN     NOT NULL DEFAULT FALSE,
    revision_correct       BOOLEAN,
    refused_correctly      BOOLEAN,
    facts_found            JSONB       NOT NULL DEFAULT '[]'::jsonb,
    facts_missing          JSONB       NOT NULL DEFAULT '[]'::jsonb,
    answer                 TEXT,
    citations              JSONB       NOT NULL DEFAULT '[]'::jsonb,
    retrieved              JSONB       NOT NULL DEFAULT '[]'::jsonb,
    latency_ms             INTEGER,
    passed                 BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX evaluation_results_run_idx    ON evaluation_results (evaluation_run_id);
CREATE INDEX evaluation_results_passed_idx ON evaluation_results (passed);
