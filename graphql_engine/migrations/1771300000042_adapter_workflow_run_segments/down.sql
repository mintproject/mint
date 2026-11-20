BEGIN;

DROP INDEX IF EXISTS adapter.workflow_run_paused_idx;
DROP INDEX IF EXISTS adapter.workflow_run_parent_run_id_idx;

ALTER TABLE adapter.workflow_run
    DROP COLUMN IF EXISTS segment_json,
    DROP COLUMN IF EXISTS resumed_run_id,
    DROP COLUMN IF EXISTS parent_run_id,
    DROP COLUMN IF EXISTS paused_after_step;

COMMIT;
