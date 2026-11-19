"""A flow is a model configuration with a row in `modelcatalog_configuration_flow` and
its pieces in `modelcatalog_configuration_step`. Role `user` may make its own
configuration a flow, out of pieces it can see, and nothing about a flow is edited in
place."""
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
TABLES = ROOT / "metadata" / "tables.yaml"
MIGRATION = ROOT / "migrations" / "1771300000041_modelcatalog_configuration_flow"

OWNER = {"owner_username": {"_eq": "X-Hasura-User-Id"}}
ADMIN = {
    "_exists": {
        "_table": {"name": "modelcatalog_admin", "schema": "public"},
        "_where": {"username": {"_eq": "X-Hasura-User-Id"}},
    }
}
OWN_CONFIGURATION_OR_ADMIN = {"_or": [{"configuration": OWNER}, ADMIN]}
VISIBLE_PIECE = {"_or": [{"visibility": {"_eq": "public"}}, {"visibility": {"_eq": "shared"}}, OWNER]}
FLOW = "modelcatalog_configuration_flow"
STEP = "modelcatalog_configuration_step"


def _table(name):
    for entry in yaml.safe_load(TABLES.read_text()):
        if entry["table"] == {"name": name, "schema": "public"}:
            return entry
    raise AssertionError(f"{name} is not tracked")


def _permissions(table, kind, role="user"):
    return [p["permission"] for p in _table(table).get(f"{kind}_permissions") or [] if p["role"] == role]


def test_only_the_configurations_owner_or_an_admin_makes_it_a_flow():
    (perm,) = _permissions(FLOW, "insert")
    assert perm["check"] == OWN_CONFIGURATION_OR_ADMIN


def test_a_step_needs_the_callers_flow_and_a_piece_the_caller_can_see():
    # Without the visibility half, inserting a step would tell a user whether a private
    # piece id exists.
    (perm,) = _permissions(STEP, "insert")
    assert perm["check"] == {
        "_or": [
            {"_and": [{"flow": {"configuration": OWNER}}, {"etl_process": VISIBLE_PIECE}]},
            ADMIN,
        ]
    }


def test_a_flow_is_not_edited_in_place():
    # Plans are built from the graph. A changed flow is a new configuration.
    assert _permissions(FLOW, "update") == []
    assert _permissions(STEP, "update") == []


def test_a_flow_is_removed_whole_by_its_owner_or_an_admin():
    (perm,) = _permissions(FLOW, "delete")
    assert perm["filter"] == OWN_CONFIGURATION_OR_ADMIN
    # Steps go with the flow, never one at a time.
    assert _permissions(STEP, "delete") == []


def test_everyone_can_read_a_flow_like_any_model():
    for table in (FLOW, STEP):
        for role in ("anonymous", "user"):
            (perm,) = _permissions(table, "select", role=role)
            assert perm["filter"] == {}


def test_anonymous_cannot_write():
    for table in (FLOW, STEP):
        for kind in ("insert", "update", "delete"):
            assert _permissions(table, kind, role="anonymous") == []


def test_a_configuration_exposes_whether_it_is_a_flow():
    rels = {r["name"]: r for r in _table("modelcatalog_configuration")["object_relationships"]}
    using = rels["flow"]["using"]["foreign_key_constraint_on"]
    assert using == {"column": "configuration_id", "table": {"name": FLOW, "schema": "public"}}


def test_deleting_a_piece_empties_the_step_and_does_not_block_the_delete():
    up = (MIGRATION / "up.sql").read_text()
    assert "REFERENCES modelcatalog_etl_process(id) ON DELETE SET NULL" in up
    assert "REFERENCES modelcatalog_etl_process(id) ON DELETE RESTRICT" not in up


def test_steps_and_the_marker_go_with_the_configuration():
    up = (MIGRATION / "up.sql").read_text()
    assert "REFERENCES modelcatalog_configuration(id) ON DELETE CASCADE" in up
    assert "REFERENCES modelcatalog_configuration_flow(configuration_id) ON DELETE CASCADE" in up


def test_migration_drops_what_it_creates():
    down = (MIGRATION / "down.sql").read_text()
    for table in (STEP, FLOW):
        assert f"DROP TABLE IF EXISTS {table};" in down
    assert down.index(STEP) < down.index(FLOW)
