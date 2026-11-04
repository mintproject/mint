from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "graphql_engine" / "migrations" / "1771300000000_svo_adapter_schema"
METADATA = ROOT / "graphql_engine" / "metadata" / "tables.yaml"
HASURA_CLIENT = ROOT / "svo-adapter-service" / "app" / "hasura.py"
ADAPTER_APP = ROOT / "svo-adapter-service" / "app" / "main.py"

TABLES = (
    "data_object",
    "data_object_variable",
    "transform_spec",
    "transform_contract",
    "transform_edge",
    "readiness_assessment",
    "workflow_plan",
    "workflow_run",
    "provenance_event",
)


def test_adapter_migration_creates_and_rolls_back_all_tables():
    up = (MIGRATIONS / "up.sql").read_text()
    down = (MIGRATIONS / "down.sql").read_text()

    assert "CREATE SCHEMA IF NOT EXISTS adapter;" in up
    for table in TABLES:
        assert f"CREATE TABLE adapter.{table}" in up
    for required_sql in (
        "CONSTRAINT transform_spec_mint_model_config_id_key UNIQUE",
        "CONSTRAINT transform_edge_pair_key UNIQUE",
        "CONSTRAINT transform_contract_role_check CHECK",
        "CREATE INDEX data_object_variable_data_object_id_idx",
        "CREATE INDEX transform_edge_source_contract_id_idx",
        "CREATE INDEX workflow_run_status_idx",
    ):
        assert required_sql in up
    assert "DROP SCHEMA IF EXISTS adapter CASCADE;" in down


def test_adapter_sync_migration_is_separate_and_reversible():
    migration = ROOT / "graphql_engine" / "migrations" / "1771300000017_svo_adapter_sync_schema"
    up = (migration / "up.sql").read_text()
    down = (migration / "down.sql").read_text()

    assert "ADD COLUMN IF NOT EXISTS tapis_app_id TEXT" in up
    assert "ADD COLUMN IF NOT EXISTS tapis_app_version TEXT" in up
    assert "ADD COLUMN IF NOT EXISTS compatibility_json JSONB" in up
    assert "DROP COLUMN IF EXISTS compatibility_json" in down
    assert "DROP COLUMN IF EXISTS tapis_app_version" in down
    assert "DROP COLUMN IF EXISTS tapis_app_id" in down


def test_adapter_metadata_tracks_all_tables_without_duplicate_relationship_sections():
    metadata = METADATA.read_text()
    adapter_section = metadata[metadata.index("    name: data_object\n    schema: adapter") :]
    blocks = re.split(r"(?=^- table:\n)", adapter_section, flags=re.MULTILINE)

    # secret / secret_event (migration ...36) are tracked bare; see test_adapter_secret_metadata.py.
    tracked = {re.search(r"    name: (.+)\n    schema: adapter", block).group(1) for block in blocks if block.strip()}
    assert tracked == set(TABLES) | {"secret", "secret_event"}
    for block in blocks:
        if not block.strip():
            continue
        assert block.count("\n  array_relationships:\n") <= 1
        assert block.count("\n  object_relationships:\n") <= 1

    for relationship in (
        "name: variables",
        "name: readiness_assessments",
        "name: contracts",
        "name: source_edges",
        "name: target_edges",
        "name: workflow_runs",
        "name: provenance_events",
    ):
        assert relationship in adapter_section


def test_adapter_client_queries_have_matching_hasura_tables():
    client = HASURA_CLIENT.read_text() + ADAPTER_APP.read_text()
    queried_tables = (
        "data_object",
        "transform_spec",
        "readiness_assessment",
        "workflow_plan",
        "workflow_run",
        "provenance_event",
    )
    for table in queried_tables:
        assert f"adapter_{table}" in client
