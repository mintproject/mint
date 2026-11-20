"""adapter.workflow_run segment columns: migration, and that none is readable by a user."""
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
TABLES = ROOT / "graphql_engine" / "metadata" / "tables.yaml"
MIGRATION = ROOT / "graphql_engine" / "migrations" / "1771300000042_adapter_workflow_run_segments"
COLUMNS = ("paused_after_step", "parent_run_id", "resumed_run_id", "segment_json")


def test_migration_adds_the_segment_columns_and_indexes():
    up = (MIGRATION / "up.sql").read_text()
    assert "ALTER TABLE adapter.workflow_run" in up
    for column in COLUMNS:
        assert f"ADD COLUMN {column} " in up
    assert "paused_after_step INTEGER" in up and "segment_json JSONB" in up
    # Nothing is required of a run that never paused.
    assert not [line for line in up.splitlines() if "ADD COLUMN" in line and "NOT NULL" in line]
    assert "workflow_run_parent_run_id_idx" in up and "workflow_run_paused_idx" in up
    assert "BEGIN;" in up and up.rstrip().endswith("COMMIT;")


def test_down_drops_exactly_what_up_adds():
    down = (MIGRATION / "down.sql").read_text()
    for column in COLUMNS:
        assert f"DROP COLUMN IF EXISTS {column}" in down
    assert "DROP INDEX IF EXISTS adapter.workflow_run_paused_idx;" in down
    assert "DROP INDEX IF EXISTS adapter.workflow_run_parent_run_id_idx;" in down


def test_workflow_run_stays_admin_only_so_the_replayed_arguments_are_not_readable():
    entry = next(e for e in yaml.safe_load(TABLES.read_text())
                 if e["table"] == {"name": "workflow_run", "schema": "adapter"})
    assert [k for k in entry if k.endswith("_permissions")] == []
