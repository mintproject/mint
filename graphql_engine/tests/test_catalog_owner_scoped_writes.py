"""Role `user` may only change model configurations it owns (and their parameters/IO links).

Before this, `modelcatalog_configuration` update and the parameter / IO junction tables
allowed any signed-in user to write any row (`filter: {}`), so one user could repoint another
user's model at their own Tapis app or rewrite its declared inputs.
"""
from pathlib import Path

import pytest
import yaml

TABLES = Path(__file__).resolve().parents[1] / "metadata" / "tables.yaml"
OWNER = {"_eq": "X-Hasura-User-Id"}
VIA_CONFIGURATION = {"configuration": {"owner_username": OWNER}}
VIA_PARAMETER_LINK = {"configuration_parameters": VIA_CONFIGURATION}


def _table(name):
    for entry in yaml.safe_load(TABLES.read_text()):
        if entry["table"]["name"] == name and entry["table"]["schema"] == "public":
            return entry
    raise AssertionError(f"{name} is not tracked")


def _user_permission(table, kind):
    for perm in _table(table).get(f"{kind}_permissions") or []:
        if perm["role"] == "user":
            return perm["permission"]
    raise AssertionError(f"{table} has no user {kind} permission")


def test_configuration_update_is_owner_only():
    perm = _user_permission("modelcatalog_configuration", "update")
    assert perm["filter"] == {"owner_username": OWNER}
    # Ownership itself must stay immutable through update.
    assert "owner_username" not in perm["columns"]


@pytest.mark.parametrize(
    "table",
    [
        "modelcatalog_configuration_parameter",
        "modelcatalog_configuration_input",
        "modelcatalog_configuration_output",
    ],
)
def test_configuration_links_require_owning_the_configuration(table):
    assert _user_permission(table, "insert")["check"] == VIA_CONFIGURATION
    assert _user_permission(table, "delete")["filter"] == VIA_CONFIGURATION


def test_parameter_update_and_delete_require_an_owned_configuration_link():
    assert _user_permission("modelcatalog_parameter", "update")["filter"] == VIA_PARAMETER_LINK
    assert _user_permission("modelcatalog_parameter", "delete")["filter"] == VIA_PARAMETER_LINK


def test_parameter_has_the_relationship_the_filters_use():
    rels = {r["name"]: r for r in _table("modelcatalog_parameter")["array_relationships"]}
    using = rels["configuration_parameters"]["using"]["foreign_key_constraint_on"]
    assert using["column"] == "parameter_id"
    assert using["table"]["name"] == "modelcatalog_configuration_parameter"


def test_user_can_read_owner_username_so_relationship_filters_resolve():
    # Hasura evaluates `configuration.owner_username` with the caller's select permission.
    perm = _user_permission("modelcatalog_configuration", "select")
    assert "owner_username" in perm["columns"]
    assert perm["filter"] == {}
