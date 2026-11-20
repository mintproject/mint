BEGIN;

-- Discards every recorded owner.
DROP INDEX IF EXISTS adapter.data_object_owner_username_idx;

ALTER TABLE adapter.data_object DROP COLUMN IF EXISTS owner_username;

COMMIT;
