BEGIN;

-- A flow that pauses for the user's edit runs as segments, one Tapis Workflows
-- pipeline each (docs/design/2026-11-20-flow-pause-for-edit.md). Segment 1 ends at
-- the pause; the resumed segment 2 is its own run row.
--   paused_after_step  the flow step segment 1 ends at; NULL for any other run.
--   parent_run_id      on segment 2: the segment 1 run it continues.
--   resumed_run_id     on segment 1: the run that resumed it. The compare-and-set
--                      on this column being NULL is what lets one resume win.
--   segment_json       segment 1: the non-secret arguments segment 2 is started
--                      with (never a token or a secret). Segment 2: the edit it
--                      was started with (who, when, which catalog file, its sha256).
ALTER TABLE adapter.workflow_run
    ADD COLUMN paused_after_step INTEGER,
    ADD COLUMN parent_run_id TEXT,
    ADD COLUMN resumed_run_id TEXT,
    ADD COLUMN segment_json JSONB;

CREATE INDEX workflow_run_parent_run_id_idx
    ON adapter.workflow_run (parent_run_id)
    WHERE parent_run_id IS NOT NULL;

-- The sweep that cancels a run left paused too long reads only these rows.
CREATE INDEX workflow_run_paused_idx
    ON adapter.workflow_run (completed_at)
    WHERE paused_after_step IS NOT NULL AND resumed_run_id IS NULL;

COMMIT;
