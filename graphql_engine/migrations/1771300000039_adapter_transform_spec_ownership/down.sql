BEGIN;

-- Discards every recorded approval.
DROP INDEX IF EXISTS adapter.idx_transform_spec_etl_process;
DROP INDEX IF EXISTS adapter.idx_transform_spec_owner;

ALTER TABLE adapter.transform_spec
    DROP CONSTRAINT IF EXISTS transform_spec_visibility_check,
    DROP COLUMN IF EXISTS approved_source_sha256,
    DROP COLUMN IF EXISTS mint_etl_process_id,
    DROP COLUMN IF EXISTS visibility,
    DROP COLUMN IF EXISTS owner_username;

COMMIT;
