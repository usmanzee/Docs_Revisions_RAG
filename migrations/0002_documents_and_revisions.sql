-- ---------------------------------------------------------------------------
-- 0002 - Logical documents and their revisions
--
-- `documents` is the stable, revision-independent identity of a document.
-- `document_revisions` is one physical file at one point in time.
--
-- Identity rules:
--   * A document is identified by a UUID. `document_code` is a human label with
--     a uniqueness constraint - it is NOT the primary key.
--   * A revision is identified by a UUID. Filenames are never identifiers.
--   * `file_path` is a storage-driver-relative key (e.g. "FIN-POL-0001/rev-002/
--     expense-policy.pdf"), never an absolute filesystem path. The storage
--     abstraction resolves it, which is what keeps path traversal impossible.
-- ---------------------------------------------------------------------------

CREATE TABLE documents (
    id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    document_code           VARCHAR(64)  NOT NULL,
    title                   TEXT         NOT NULL,
    document_type           VARCHAR(40)  NOT NULL,
    department              VARCHAR(120) NOT NULL,
    category                VARCHAR(120),
    owner                   TEXT,
    description             TEXT,
    -- Inactive documents are retained but excluded from default retrieval.
    is_active               BOOLEAN      NOT NULL DEFAULT TRUE,
    security_classification VARCHAR(40)  NOT NULL DEFAULT 'INTERNAL',
    -- Which upstream system this document was discovered in. Lets the same
    -- schema serve a local filesystem today and SharePoint/S3 later.
    source_system           VARCHAR(64)  NOT NULL DEFAULT 'LOCAL_FS',
    tags                    TEXT[]       NOT NULL DEFAULT '{}',
    metadata                JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT documents_document_code_key UNIQUE (document_code),
    CONSTRAINT documents_document_type_check CHECK (document_type IN (
        'POLICY', 'PROCEDURE', 'STANDARD', 'GUIDELINE',
        'MANUAL', 'TECHNICAL_GUIDE', 'WORKFLOW', 'FAQ'
    ))
);

CREATE INDEX documents_department_idx    ON documents (department);
CREATE INDEX documents_document_type_idx ON documents (document_type);
CREATE INDEX documents_category_idx      ON documents (category);
CREATE INDEX documents_is_active_idx     ON documents (is_active);
CREATE INDEX documents_code_trgm_idx     ON documents USING gin (document_code gin_trgm_ops);
CREATE INDEX documents_title_trgm_idx    ON documents USING gin (title gin_trgm_ops);

CREATE TRIGGER documents_set_updated_at
    BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE document_revisions (
    id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id        UUID         NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    revision_number    INTEGER      NOT NULL,

    -- Storage-relative key + descriptive file metadata.
    file_path          TEXT         NOT NULL,
    file_name          TEXT         NOT NULL,
    storage_driver     VARCHAR(32)  NOT NULL DEFAULT 'local',
    mime_type          VARCHAR(160) NOT NULL,
    file_size_bytes    BIGINT,

    effective_date     DATE,
    revision_date      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    change_summary     TEXT,

    -- Business lifecycle status (independent of the processing state machine).
    status             VARCHAR(24)  NOT NULL DEFAULT 'ACTIVE',
    is_current         BOOLEAN      NOT NULL DEFAULT FALSE,

    -- SHA-256 of the raw bytes; SHA-256 of the normalised extracted text.
    file_hash          VARCHAR(64)  NOT NULL,
    content_hash       VARCHAR(64),
    source_modified_at TIMESTAMPTZ,

    -- Ingestion state machine.
    processing_status  VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
    processing_error   TEXT,
    processing_attempts INTEGER     NOT NULL DEFAULT 0,
    processed_at       TIMESTAMPTZ,
    -- Cooperative claim so concurrent ingestion workers cannot double-process.
    claimed_at         TIMESTAMPTZ,
    claimed_by         TEXT,

    -- Denormalised processing results, useful for the admin UI and benchmarks.
    page_count         INTEGER,
    ocr_page_count     INTEGER      NOT NULL DEFAULT 0,
    chunk_count        INTEGER      NOT NULL DEFAULT 0,
    token_count        INTEGER      NOT NULL DEFAULT 0,

    metadata           JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT document_revisions_document_revision_key
        UNIQUE (document_id, revision_number),
    CONSTRAINT document_revisions_revision_number_check
        CHECK (revision_number > 0),
    CONSTRAINT document_revisions_status_check CHECK (status IN (
        'DRAFT', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED'
    )),
    CONSTRAINT document_revisions_processing_status_check CHECK (processing_status IN (
        'PENDING', 'PROCESSING', 'READY', 'FAILED', 'SUPERSEDED'
    ))
);

-- At most one current revision per document, enforced by the database rather
-- than by hopeful application code.
CREATE UNIQUE INDEX document_revisions_one_current_idx
    ON document_revisions (document_id)
    WHERE is_current;

CREATE INDEX document_revisions_document_id_idx       ON document_revisions (document_id);
CREATE INDEX document_revisions_processing_status_idx ON document_revisions (processing_status);
-- Ingestion discovery hot path: oldest pending work first.
CREATE INDEX document_revisions_pending_idx
    ON document_revisions (created_at)
    WHERE processing_status = 'PENDING';
CREATE INDEX document_revisions_file_hash_idx        ON document_revisions (file_hash);
CREATE INDEX document_revisions_is_current_idx       ON document_revisions (is_current) WHERE is_current;

CREATE TRIGGER document_revisions_set_updated_at
    BEFORE UPDATE ON document_revisions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
