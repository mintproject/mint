BEGIN;

-- Carry a catalog ETL process's owner and visibility into the adapter registry,
-- so planning can be scoped to the calling user.
ALTER TABLE adapter.transform_spec
    ADD COLUMN owner_username TEXT,
    ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public',
    ADD COLUMN mint_etl_process_id TEXT,
    ADD COLUMN approved_source_sha256 TEXT,
    ADD CONSTRAINT transform_spec_visibility_check
        CHECK (visibility IN ('private', 'shared', 'public'));

COMMENT ON COLUMN adapter.transform_spec.owner_username IS
    'Owner of the catalog ETL process this row was synced from. NULL for built-in pieces and pieces derived from model configurations.';
COMMENT ON COLUMN adapter.transform_spec.visibility IS
    'private, shared or public, copied from the catalog ETL process.';
COMMENT ON COLUMN adapter.transform_spec.mint_etl_process_id IS
    'Id of the catalog ETL process this row was synced from. The sync deletes rows whose process is gone.';
COMMENT ON COLUMN adapter.transform_spec.approved_source_sha256 IS
    'SHA-256 of the stored source an admin approved. The piece counts as approved only while its current source has this hash.';

-- Rows already synced from ETL processes recorded both values in their metadata.
UPDATE adapter.transform_spec
SET mint_etl_process_id = parameters_schema_json -> 'metadata' ->> 'mint_etl_process_id',
    visibility = COALESCE(
        NULLIF(parameters_schema_json -> 'metadata' ->> 'visibility', ''), 'public')
WHERE parameters_schema_json -> 'metadata' ->> 'mint_etl_process_id' IS NOT NULL
  AND COALESCE(NULLIF(parameters_schema_json -> 'metadata' ->> 'visibility', ''), 'public')
      IN ('private', 'shared', 'public');

UPDATE adapter.transform_spec
SET mint_etl_process_id = parameters_schema_json -> 'metadata' ->> 'mint_etl_process_id'
WHERE mint_etl_process_id IS NULL
  AND parameters_schema_json -> 'metadata' ->> 'mint_etl_process_id' IS NOT NULL;

CREATE INDEX idx_transform_spec_owner ON adapter.transform_spec(owner_username);
CREATE INDEX idx_transform_spec_etl_process ON adapter.transform_spec(mint_etl_process_id);

COMMIT;
