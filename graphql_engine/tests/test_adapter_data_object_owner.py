"""adapter.data_object gets an owner, and Hasura still gives users no direct read of it."""
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "graphql_engine" / "migrations" / "1771300000044_adapter_data_object_owner"
TABLES = ROOT / "graphql_engine" / "metadata" / "tables.yaml"


def test_migration_adds_a_nullable_indexed_owner_and_reverses_cleanly():
    up = (MIGRATION / "up.sql").read_text()
    down = (MIGRATION / "down.sql").read_text()
    assert "ADD COLUMN owner_username TEXT," in up
    assert "ADD COLUMN shared BOOLEAN NOT NULL DEFAULT false;" in up
    assert "CREATE INDEX data_object_owner_username_idx ON adapter.data_object (owner_username);" in up
    assert "DROP INDEX IF EXISTS adapter.data_object_owner_username_idx;" in down
    assert "DROP COLUMN IF EXISTS owner_username;" in down
    assert "DROP COLUMN IF EXISTS shared," in down
    assert "UPDATE" not in up  # existing rows stay ownerless, which hides them from users


def test_data_object_has_no_role_permissions_so_the_owner_filter_lives_in_the_adapter():
    entry = next(e for e in yaml.safe_load(TABLES.read_text())
                 if e["table"] == {"name": "data_object", "schema": "adapter"})
    assert [k for k in entry if k.endswith("_permissions")] == []
