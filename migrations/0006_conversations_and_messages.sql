-- ---------------------------------------------------------------------------
-- 0006 - Chat persistence
--
-- Citations are stored as JSONB on the assistant message. They are built from
-- retrieved chunk rows, never from model output, so an answer stays auditable
-- even after the underlying revision is superseded.
-- ---------------------------------------------------------------------------

CREATE TABLE conversations (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    title        TEXT,
    -- Placeholder identity column. Replaced by a real principal id when
    -- authentication lands (see docs/security-and-permissions.md).
    user_id      VARCHAR(120),
    filters      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    summary      TEXT,
    message_count INTEGER    NOT NULL DEFAULT 0,
    last_message_at TIMESTAMPTZ,
    metadata     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX conversations_updated_at_idx ON conversations (updated_at DESC);
CREATE INDEX conversations_user_idx       ON conversations (user_id);

CREATE TRIGGER conversations_set_updated_at
    BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE messages (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id    UUID        NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    role               VARCHAR(16) NOT NULL,
    content            TEXT        NOT NULL,
    -- Retrieval-derived citation payload (array of citation objects).
    citations          JSONB       NOT NULL DEFAULT '[]'::jsonb,
    standalone_query   TEXT,
    model              VARCHAR(120),
    prompt_tokens      INTEGER,
    completion_tokens  INTEGER,
    context_tokens     INTEGER,
    retrieval_ms       INTEGER,
    llm_ms             INTEGER,
    total_ms           INTEGER,
    -- ANSWERED | INSUFFICIENT_CONTEXT | ERROR
    answer_status      VARCHAR(32),
    error              TEXT,
    metadata           JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT messages_role_check CHECK (role IN ('user', 'assistant', 'system'))
);

CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);
