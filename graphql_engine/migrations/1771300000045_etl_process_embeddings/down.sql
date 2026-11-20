DROP INDEX IF EXISTS modelcatalog_etl_process_embedding_hnsw;
ALTER TABLE modelcatalog_etl_process
  DROP COLUMN IF EXISTS embedding,
  DROP COLUMN IF EXISTS semantic_text;
