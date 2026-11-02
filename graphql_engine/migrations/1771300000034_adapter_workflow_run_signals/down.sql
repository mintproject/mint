BEGIN;

ALTER TABLE adapter.workflow_run
    DROP COLUMN IF EXISTS submitted_by,
    DROP COLUMN IF EXISTS model_job_verified,
    DROP COLUMN IF EXISTS model_job_name,
    DROP COLUMN IF EXISTS model_job_uuid,
    DROP COLUMN IF EXISTS health,
    DROP COLUMN IF EXISTS last_signal_at,
    DROP COLUMN IF EXISTS signals_armed,
    DROP COLUMN IF EXISTS dispatched_at;

COMMIT;
