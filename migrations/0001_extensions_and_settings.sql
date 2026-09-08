-- ---------------------------------------------------------------------------
-- 0001 - Extensions and system settings
--
-- `vector`   : pgvector, provides the vector column type + HNSW/IVFFlat indexes.
-- `pg_trgm`  : trigram similarity, used for fuzzy document-code / title lookup
--              in the document browser (not part of the RAG hot path).
-- `unaccent` : normalisation helper available to future FTS configurations.
--
-- gen_random_uuid() is built into PostgreSQL >= 13, so pgcrypto is not needed.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Small key/value table used to pin schema-level decisions that the application
-- must agree with at boot time (most importantly the embedding dimension that
-- was baked into document_chunks.embedding).
CREATE TABLE IF NOT EXISTS system_settings (
    key         VARCHAR(120) PRIMARY KEY,
    value       TEXT         NOT NULL,
    description TEXT,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Shared trigger function keeping updated_at honest without application help.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;
