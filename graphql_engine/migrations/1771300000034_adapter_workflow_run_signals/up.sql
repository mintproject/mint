BEGIN;

-- The composite model task now reports back to the adapter (started,
-- job_submitted, finished) and a background sweep marks a run whose task never
-- reported as stalled. `health` is a liveness verdict beside the lifecycle
-- `status`; the Tapis job identity is kept in typed columns so cancel can act
-- only on a job the adapter has verified against Tapis.
ALTER TABLE adapter.workflow_run
    ADD COLUMN dispatched_at TIMESTAMPTZ,
    ADD COLUMN signals_armed BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN last_signal_at TIMESTAMPTZ,
    ADD COLUMN health TEXT,
    ADD COLUMN model_job_uuid TEXT,
    ADD COLUMN model_job_name TEXT,
    ADD COLUMN model_job_verified BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN submitted_by TEXT;

COMMIT;
