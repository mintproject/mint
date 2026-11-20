CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE modelcatalog_etl_process
  ADD COLUMN IF NOT EXISTS semantic_text TEXT,
  ADD COLUMN IF NOT EXISTS embedding vector(384);

CREATE INDEX IF NOT EXISTS modelcatalog_etl_process_embedding_hnsw
  ON modelcatalog_etl_process USING hnsw (embedding vector_cosine_ops);
