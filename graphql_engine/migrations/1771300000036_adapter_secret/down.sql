BEGIN;

-- Destroys every stored secret. Export the ciphertext first.
ALTER TABLE adapter.workflow_run
    DROP COLUMN IF EXISTS credentials_issued,
    DROP COLUMN IF EXISTS bound_secrets;

DROP TABLE IF EXISTS adapter.secret_event;
DROP TABLE IF EXISTS adapter.secret;

COMMIT;
