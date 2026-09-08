-- ---------------------------------------------------------------------------
-- 0005 - Ingestion job tracking
--
-- A job is one synchronisation run. A job item is one revision handled by that
-- run. A single failing document must never fail the whole run, so per-item
-- outcomes are recorded independently and the job rolls up to
-- PARTIALLY_COMPLETED rather than FAILED.
-- ---------------------------------------------------------------------------

CREATE TABLE ingestion_jobs (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- SCHEDULED | MANUAL | API | TEST
    trigger               VARCHAR(24) NOT NULL DEFAULT 'MANUAL',
    status                VARCHAR(24) NOT NULL DEFAULT 'PENDING',
    started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at          TIMESTAMPTZ,
    duration_ms           INTEGER,

    documents_discovered  INTEGER     NOT NULL DEFAULT 0,
    documents_processed   INTEGER     NOT NULL DEFAULT 0,
    documents_skipped     INTEGER     NOT NULL DEFAULT 0,
    documents_failed      INTEGER     NOT NULL DEFAULT 0,
    chunks_created        INTEGER     NOT NULL DEFAULT 0,
    ocr_pages             INTEGER     NOT NULL DEFAULT 0,
    vision_images         INTEGER     NOT NULL DEFAULT 0,
    embedding_batches     INTEGER     NOT NULL DEFAULT 0,
    embedding_tokens      INTEGER     NOT NULL DEFAULT 0,

    embedding_provider    VARCHAR(32),
    embedding_model       VARCHAR(120),
    error_summary         TEXT,
    metadata              JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ingestion_jobs_status_check CHECK (status IN (
        'PENDING', 'RUNNING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED'
    ))
);

CREATE INDEX ingestion_jobs_started_at_idx ON ingestion_jobs (started_at DESC);
CREATE INDEX ingestion_jobs_status_idx     ON ingestion_jobs (status);

CREATE TRIGGER ingestion_jobs_set_updated_at
    BEFORE UPDATE ON ingestion_jobs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE ingestion_job_items (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    ingestion_job_id     UUID        NOT NULL REFERENCES ingestion_jobs (id) ON DELETE CASCADE,
    document_id          UUID        REFERENCES documents (id) ON DELETE SET NULL,
    document_revision_id UUID        REFERENCES document_revisions (id) ON DELETE SET NULL,
    document_code        VARCHAR(64),
    revision_number      INTEGER,

    -- PROCESSED | SKIPPED | FAILED
    outcome              VARCHAR(24) NOT NULL,
    skip_reason          VARCHAR(64),
    error_message        TEXT,
    error_stage          VARCHAR(40),

    chunks_created       INTEGER     NOT NULL DEFAULT 0,
    pages                INTEGER     NOT NULL DEFAULT 0,
    ocr_pages            INTEGER     NOT NULL DEFAULT 0,
    duration_ms          INTEGER,
    parse_ms             INTEGER,
    ocr_ms               INTEGER,
    chunk_ms             INTEGER,
    embed_ms             INTEGER,
    persist_ms           INTEGER,

    metadata             JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ingestion_job_items_outcome_check CHECK (outcome IN (
        'PROCESSED', 'SKIPPED', 'FAILED'
    ))
);

CREATE INDEX ingestion_job_items_job_idx      ON ingestion_job_items (ingestion_job_id);
CREATE INDEX ingestion_job_items_revision_idx ON ingestion_job_items (document_revision_id);
CREATE INDEX ingestion_job_items_outcome_idx  ON ingestion_job_items (outcome);
