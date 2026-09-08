-- ---------------------------------------------------------------------------
-- 0003 - Retrieval units (chunks), embeddings and full-text search
--
-- The embedding dimension is templated by the migration runner from
-- EMBEDDING_DIMENSIONS so the dimension constant lives in exactly one place
-- (configuration) instead of being sprinkled through SQL and TypeScript.
-- The applied value is recorded in system_settings and verified at API boot.
--
-- Denormalised columns (document_code, is_current, department, document_type)
-- exist deliberately: they let the vector/FTS hot path filter and rank without
-- joining two more tables per candidate row, and they are maintained inside the
-- same transaction that activates a revision.
-- ---------------------------------------------------------------------------

CREATE TABLE document_chunks (
    id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id          UUID         NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    document_revision_id UUID         NOT NULL REFERENCES document_revisions (id) ON DELETE CASCADE,

    chunk_index          INTEGER      NOT NULL,
    -- CHILD chunks are the retrieval units. PARENT chunks are the larger
    -- section-level bodies handed to the LLM when extra context helps.
    chunk_type           VARCHAR(16)  NOT NULL DEFAULT 'CHILD',
    parent_chunk_id      UUID         REFERENCES document_chunks (id) ON DELETE SET NULL,

    page_start           INTEGER,
    page_end             INTEGER,
    section_title        TEXT,
    subsection_title     TEXT,
    heading_path         TEXT,

    content              TEXT         NOT NULL,
    content_hash         VARCHAR(64)  NOT NULL,
    token_count          INTEGER      NOT NULL DEFAULT 0,

    -- How the underlying text was obtained, so answers can be audited.
    extraction_method    VARCHAR(16)  NOT NULL DEFAULT 'NATIVE_TEXT',

    -- Denormalised from documents/document_revisions for retrieval filtering.
    document_code        VARCHAR(64)  NOT NULL,
    revision_number      INTEGER      NOT NULL,
    is_current           BOOLEAN      NOT NULL DEFAULT FALSE,
    department           VARCHAR(120),
    document_type        VARCHAR(40),
    category             VARCHAR(120),

    embedding            vector({{EMBEDDING_DIMENSIONS}}),
    embedding_model      VARCHAR(120),

    metadata             JSONB        NOT NULL DEFAULT '{}'::jsonb,

    -- Weighted lexical vector. Weight A = identifiers/headings (document codes,
    -- ORA-xxxxx error numbers, section names), weight B = body text.
    text_search          TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('english'::regconfig, coalesce(document_code, '')), 'A') ||
        setweight(to_tsvector('english'::regconfig, coalesce(section_title, '')), 'A') ||
        setweight(to_tsvector('english'::regconfig, coalesce(subsection_title, '')), 'B') ||
        setweight(to_tsvector('english'::regconfig, coalesce(content, '')), 'C')
    ) STORED,

    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT document_chunks_revision_index_key
        UNIQUE (document_revision_id, chunk_index),
    -- Hard guarantee against inserting the same chunk twice for a revision.
    CONSTRAINT document_chunks_revision_content_key
        UNIQUE (document_revision_id, content_hash),
    CONSTRAINT document_chunks_chunk_type_check
        CHECK (chunk_type IN ('CHILD', 'PARENT')),
    CONSTRAINT document_chunks_extraction_method_check
        CHECK (extraction_method IN ('NATIVE_TEXT', 'OCR', 'VISION', 'MIXED'))
);

CREATE INDEX document_chunks_revision_idx        ON document_chunks (document_revision_id);
CREATE INDEX document_chunks_document_idx        ON document_chunks (document_id);
CREATE INDEX document_chunks_parent_idx          ON document_chunks (parent_chunk_id);
CREATE INDEX document_chunks_document_code_idx   ON document_chunks (document_code);
CREATE INDEX document_chunks_current_idx         ON document_chunks (is_current) WHERE is_current;
CREATE INDEX document_chunks_filters_idx         ON document_chunks (department, document_type) WHERE is_current;
CREATE INDEX document_chunks_content_hash_idx    ON document_chunks (content_hash);

-- Lexical retrieval index.
CREATE INDEX document_chunks_text_search_idx
    ON document_chunks USING gin (text_search);

INSERT INTO system_settings (key, value, description)
VALUES (
    'embedding_dimensions',
    '{{EMBEDDING_DIMENSIONS}}',
    'Dimension baked into document_chunks.embedding by migration 0003. The API refuses to start if EMBEDDING_DIMENSIONS disagrees.'
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
