-- Runs once, on an empty data directory.
--
-- Migrations create the application schema; this only has to provide the
-- extension and the separate database the test suite requires.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

SELECT 'CREATE DATABASE docs_rag_test'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'docs_rag_test')\gexec

\connect docs_rag_test
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
