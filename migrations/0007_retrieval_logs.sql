-- ---------------------------------------------------------------------------
-- 0007 - Retrieval observability
--
-- One row per retrieval execution (chat turn, debug call, evaluation question).
-- This is what makes "why did the model answer that?" answerable after the fact
-- and is the data source behind the retrieval debug view.
-- ---------------------------------------------------------------------------

CREATE TABLE retrieval_logs (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id     UUID        REFERENCES conversations (id) ON DELETE CASCADE,
    message_id          UUID        REFERENCES messages (id) ON DELETE CASCADE,
    -- CHAT | DEBUG | EVALUATION | BENCHMARK
    source              VARCHAR(24) NOT NULL DEFAULT 'CHAT',

    query               TEXT        NOT NULL,
    standalone_query    TEXT,
    filters             JSONB       NOT NULL DEFAULT '{}'::jsonb,

    vector_candidates   JSONB       NOT NULL DEFAULT '[]'::jsonb,
    lexical_candidates  JSONB       NOT NULL DEFAULT '[]'::jsonb,
    fused_candidates    JSONB       NOT NULL DEFAULT '[]'::jsonb,
    selected_chunk_ids  UUID[]      NOT NULL DEFAULT '{}',

    vector_count        INTEGER     NOT NULL DEFAULT 0,
    lexical_count       INTEGER     NOT NULL DEFAULT 0,
    selected_count      INTEGER     NOT NULL DEFAULT 0,
    context_tokens      INTEGER,

    embedding_ms        INTEGER,
    vector_ms           INTEGER,
    lexical_ms          INTEGER,
    fusion_ms           INTEGER,
    rerank_ms           INTEGER,
    total_ms            INTEGER,

    embedding_model     VARCHAR(120),
    reranker            VARCHAR(64),
    metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX retrieval_logs_created_at_idx    ON retrieval_logs (created_at DESC);
CREATE INDEX retrieval_logs_conversation_idx  ON retrieval_logs (conversation_id);
CREATE INDEX retrieval_logs_message_idx       ON retrieval_logs (message_id);
CREATE INDEX retrieval_logs_source_idx        ON retrieval_logs (source);
