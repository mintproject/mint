"""Role `user` may only change Software and Version rows it owns, and their link rows.

Before this, `modelcatalog_software` and `modelcatalog_software_version` had no owner and
allowed any signed-in user to update or delete any row (`filter: {}`). Both deletes cascade
to the configurations underneath, so one user could remove another user's model.
"""
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
TABLES = ROOT / "metadata" / "tables.yaml"
MIGRATION = ROOT / "migrations" / "1771300000040_modelcatalog_software_ownership"

OWNER = {"owner_username": {"_eq": "X-Hasura-User-Id"}}
ADMIN = {
    "_exists": {
        "_table": {"name": "modelcatalog_admin", "schema": "public"},
        "_where": {"username": {"_eq": "X-Hasura-User-Id"}},
    }
}
OWNER_OR_ADMIN = {"_or": [OWNER, ADMIN]}
STILL_OWNED = {"_or": [{"owner_username": {"_eq": "X-Hasura-User-Id", "_is_null": False}}, ADMIN]}
# Someone else's row, or a row nobody owns.
NOT_MINE = {
    "_or": [
        {"owner_username": {"_neq": "X-Hasura-User-Id"}},
        {"owner_username": {"_is_null": True}},
    ]
}

ENTITIES = ["modelcatalog_software", "modelcatalog_software_version"]
LINKS = {
    "modelcatalog_software_author": "software",
    "modelcatalog_software_category": "software",
    "modelcatalog_version_author": "software_version",
    "modelcatalog_software_version_category": "software_version",
    "modelcatalog_software_version_process": "software_version",
    "modelcatalog_software_version_grid": "software_version",
    "modelcatalog_software_version_image": "software_version",
    "modelcatalog_software_version_input_variable": "software_version",
    "modelcatalog_software_version_output_variable": "software_version",
}


def _table(name):
    for entry in yaml.safe_load(TABLES.read_text()):
        if entry["table"] == {"name": name, "schema": "public"}:
            return entry
    raise AssertionError(f"{name} is not tracked")


def _permissions(table, kind, role="user"):
    return [p["permission"] for p in _table(table).get(f"{kind}_permissions") or [] if p["role"] == role]


def _user_permission(table, kind):
    (perm,) = _permissions(table, kind)
    return perm


@pytest.mark.parametrize("table", ENTITIES)
def test_owner_is_preset_from_the_session_and_not_insertable(table):
    perm = _user_permission(table, "insert")
    assert perm["set"]["owner_username"].lower() == "x-hasura-user-id"
    assert "owner_username" not in perm["columns"]
    # Anyone may still add a row; registering under a shared model is existing behaviour.
    assert perm["check"] == {}


@pytest.mark.parametrize("table", ENTITIES)
def test_update_is_owner_or_admin(table):
    assert _user_permission(table, "update")["filter"] == OWNER_OR_ADMIN


@pytest.mark.parametrize("table", ENTITIES)
def test_an_owner_cannot_give_a_row_away_or_leave_it_unowned(table):
    # owner_username is updatable so an admin can reassign. The post-update check is what
    # stops an owner. `_is_null: false` matters: Hasura lets a check through when the
    # comparison is NULL, so without it an owner could blank the column.
    perm = _user_permission(table, "update")
    assert "owner_username" in perm["columns"]
    assert perm["check"] == STILL_OWNED


def test_software_delete_never_takes_another_users_rows():
    assert _user_permission("modelcatalog_software", "delete")["filter"] == {
        "_or": [
            ADMIN,
            {
                "_and": [
                    OWNER,
                    {"_not": {"versions": NOT_MINE}},
                    {"_not": {"versions": {"configurations": NOT_MINE}}},
                ]
            },
        ]
    }


def test_version_delete_never_takes_another_users_configurations():
    assert _user_permission("modelcatalog_software_version", "delete")["filter"] == {
        "_or": [ADMIN, {"_and": [OWNER, {"_not": {"configurations": NOT_MINE}}]}]
    }


@pytest.mark.parametrize("table,parent", sorted(LINKS.items()))
def test_link_rows_require_owning_the_parent(table, parent):
    rule = {"_or": [{parent: OWNER}, ADMIN]}
    assert _user_permission(table, "insert")["check"] == rule
    assert _user_permission(table, "delete")["filter"] == rule
    assert _permissions(table, "update") == []


@pytest.mark.parametrize("table", ENTITIES)
def test_user_can_read_the_owner(table):
    perm = _user_permission(table, "select")
    assert "owner_username" in perm["columns"]
    assert perm["filter"] == {}


@pytest.mark.parametrize("table", ENTITIES + list(LINKS))
def test_anonymous_can_only_read(table):
    for kind in ("insert", "update", "delete"):
        assert _permissions(table, kind, role="anonymous") == []


def test_only_the_admin_secret_writes_the_admin_table():
    entry = _table("modelcatalog_admin")
    for kind in ("insert_permissions", "update_permissions", "delete_permissions"):
        assert not entry.get(kind)


def test_a_user_reads_only_their_own_admin_row():
    # Enough for the UI to ask "am I an admin" without listing who the admins are.
    (select,) = _table("modelcatalog_admin")["select_permissions"]
    assert select["role"] == "user"
    assert select["permission"]["columns"] == ["username"]
    assert select["permission"]["filter"] == {"username": {"_eq": "X-Hasura-User-Id"}}


def test_no_user_write_on_these_tables_is_left_open():
    for table in ENTITIES + list(LINKS):
        for kind in ("update", "delete"):
            for perm in _permissions(table, kind):
                assert perm["filter"] != {}, f"{table} {kind} is open to every user"


def test_migration_adds_and_removes_the_same_things():
    up = (MIGRATION / "up.sql").read_text()
    down = (MIGRATION / "down.sql").read_text()
    for table in ENTITIES:
        assert f"ALTER TABLE {table} ADD COLUMN owner_username TEXT" in up
        assert f"ALTER TABLE {table} DROP COLUMN IF EXISTS owner_username" in down
    assert "CREATE TABLE modelcatalog_admin" in up
    assert "DROP TABLE IF EXISTS modelcatalog_admin" in down


def test_migration_assigns_no_owner_by_guessing():
    # Inferring an owner from the configurations underneath would hand a shared model to
    # whoever added the only configuration. An admin assigns owners (see the runbook).
    up = (MIGRATION / "up.sql").read_text()
    assert "UPDATE" not in up
