BEGIN;

ALTER TABLE adapter.workflow_run
    DROP COLUMN IF EXISTS run_token_renewals,
    DROP COLUMN IF EXISTS run_token_deadline_at,
    DROP COLUMN IF EXISTS run_token_expires_at,
    DROP COLUMN IF EXISTS run_token_enc;

COMMIT;
