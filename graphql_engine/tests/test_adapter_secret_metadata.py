"""adapter.secret / adapter.secret_event must stay admin-only and out of the dump."""
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
TABLES = ROOT / "graphql_engine" / "metadata" / "tables.yaml"
MIGRATION = ROOT / "graphql_engine" / "migrations" / "1771300000036_adapter_secret"
BACKUPS = ROOT / "backups"
SECRET_TABLES = {"secret", "secret_event"}


def _entries():
    entries = yaml.safe_load(TABLES.read_text())
    return {e["table"]["name"]: e for e in entries
            if e["table"].get("schema") == "adapter" and e["table"]["name"] in SECRET_TABLES}


def test_secret_tables_are_tracked_without_permissions_or_relationships():
    entries = _entries()
    assert set(entries) == SECRET_TABLES
    for entry in entries.values():
        forbidden = [k for k in entry if k.endswith("_permissions") or k.endswith("_relationships")]
        assert forbidden == [], forbidden


def test_no_other_table_has_a_relationship_into_the_secret_tables():
    for entry in yaml.safe_load(TABLES.read_text()):
        for rel in (entry.get("object_relationships") or []) + (entry.get("array_relationships") or []):
            target = (rel.get("using") or {}).get("foreign_key_constraint_on")
            if isinstance(target, dict):
                table = target.get("table") or {}
                name = table.get("name") if isinstance(table, dict) else table
                assert name not in SECRET_TABLES


def test_committed_dumps_carry_no_secret_rows():
    for dump in BACKUPS.glob("*.sql"):
        text = dump.read_text(errors="ignore")
        for table in ("adapter.secret", "adapter.secret_event"):
            assert f"COPY {table} " not in text and f"INSERT INTO {table} " not in text, dump.name


def test_migration_creates_and_drops_both_tables():
    up = (MIGRATION / "up.sql").read_text()
    down = (MIGRATION / "down.sql").read_text()
    for name in ("adapter.secret", "adapter.secret_event"):
        assert f"CREATE TABLE {name} " in up
        assert f"DROP TABLE IF EXISTS {name};" in down
    assert "REFERENCES public.modelcatalog_configuration(id) ON DELETE CASCADE" in up
    assert "bound_secrets" in up and "credentials_issued" in up
