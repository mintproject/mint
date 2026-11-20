BEGIN;

-- Discards every recorded owner and every shared flag.
DROP INDEX IF EXISTS adapter.data_object_owner_username_idx;

ALTER TABLE adapter.data_object
    DROP COLUMN IF EXISTS shared,
    DROP COLUMN IF EXISTS owner_username;

COMMIT;
