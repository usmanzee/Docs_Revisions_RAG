-- ---------------------------------------------------------------------------
-- 0004 - Approximate nearest neighbour index
--
-- Index choice
--   HNSW with vector_cosine_ops. Cosine is the right default for OpenAI
--   embeddings (they are normalised, so cosine ordering == inner-product
--   ordering, but cosine keeps the distance interpretable as 0..2).
--
-- Why a PARTIAL index
--   Normal retrieval only ever searches the current revision of active
--   documents. Building the index over just those rows keeps it small and,
--   more importantly, avoids the classic filtered-ANN failure mode where HNSW
--   returns `ef_search` neighbours that are then almost entirely filtered away.
--   Historical-revision search (the "what did revision 3 say?" feature) is an
--   analytical path and is allowed to fall back to an exact scan.
--
-- Parameters
--   m / ef_construction are left at pgvector defaults (16 / 64) on purpose.
--   `npm run db:indexes` can rebuild with tuned values once there is a real
--   corpus and a real latency target to tune against.
-- ---------------------------------------------------------------------------

SET maintenance_work_mem = '256MB';

CREATE INDEX document_chunks_embedding_hnsw_idx
    ON document_chunks
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE is_current AND embedding IS NOT NULL;

RESET maintenance_work_mem;

INSERT INTO system_settings (key, value, description)
VALUES (
    'vector_index',
    'hnsw_cosine_partial_current',
    'Name/shape of the ANN index strategy currently applied to document_chunks.'
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
