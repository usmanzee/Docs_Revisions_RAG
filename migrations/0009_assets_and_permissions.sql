-- ---------------------------------------------------------------------------
-- 0009 - Document assets and the permission model skeleton
--
-- ASSETS
--   Images extracted from a revision (workflow diagrams, screenshots, scanned
--   page renders). `description` holds the vision-model description when the
--   optional VisionDocumentEnricher is enabled; `expected_text` holds the
--   ground-truth representation written by the synthetic corpus generator so
--   OCR/vision extraction can be scored against it.
--
-- PERMISSIONS (design skeleton - not enforced yet)
--   The tables below exist so retrieval can later filter unauthorised documents
--   BEFORE any content reaches the LLM. Nothing in the current code path reads
--   them; see docs/security-and-permissions.md for the intended rollout.
-- ---------------------------------------------------------------------------

CREATE TABLE document_assets (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id          UUID        NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    document_revision_id UUID        NOT NULL REFERENCES document_revisions (id) ON DELETE CASCADE,
    -- IMAGE | DIAGRAM | TABLE_IMAGE | SCANNED_PAGE
    asset_type           VARCHAR(32) NOT NULL DEFAULT 'IMAGE',
    page_number          INTEGER,
    asset_index          INTEGER     NOT NULL DEFAULT 0,
    file_path            TEXT,
    mime_type            VARCHAR(120),
    width                INTEGER,
    height               INTEGER,
    -- Text obtained from the asset (OCR or vision).
    extracted_text       TEXT,
    description          TEXT,
    -- Ground truth planted by the corpus generator, for evaluation only.
    expected_text        TEXT,
    extraction_method    VARCHAR(16),
    metadata             JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT document_assets_revision_index_key UNIQUE (document_revision_id, page_number, asset_index)
);

CREATE INDEX document_assets_document_idx ON document_assets (document_id);
CREATE INDEX document_assets_revision_idx ON document_assets (document_revision_id);


-- --- Permission skeleton ---------------------------------------------------

CREATE TABLE principals (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- USER | ROLE | GROUP | DEPARTMENT
    principal_type VARCHAR(24) NOT NULL,
    external_id   VARCHAR(200) NOT NULL,
    display_name  TEXT,
    department    VARCHAR(120),
    metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT principals_type_external_key UNIQUE (principal_type, external_id)
);

CREATE TABLE principal_memberships (
    parent_principal_id UUID NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
    child_principal_id  UUID NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
    PRIMARY KEY (parent_principal_id, child_principal_id)
);

CREATE TABLE document_permissions (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id  UUID        NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    principal_id UUID        NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
    -- READ | WRITE | OWNER
    permission   VARCHAR(24) NOT NULL DEFAULT 'READ',
    -- ALLOW | DENY. DENY always wins when the resolver is implemented.
    effect       VARCHAR(8)  NOT NULL DEFAULT 'ALLOW',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT document_permissions_unique UNIQUE (document_id, principal_id, permission),
    CONSTRAINT document_permissions_effect_check CHECK (effect IN ('ALLOW', 'DENY'))
);

CREATE INDEX document_permissions_document_idx  ON document_permissions (document_id);
CREATE INDEX document_permissions_principal_idx ON document_permissions (principal_id);
