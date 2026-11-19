"""Role `user` may only change model configurations it owns (and their parameters/IO links).
A catalog admin (a row in `modelcatalog_admin`) may change any of them.

Before this, `modelcatalog_configuration` update and the parameter / IO junction tables
allowed any signed-in user to write any row (`filter: {}`), so one user could repoint another
user's model at their own Tapis app or rewrite its declared inputs.
"""
from pathlib import Path

import pytest
import yaml

TABLES = Path(__file__).resolve().parents[1] / "metadata" / "tables.yaml"
OWNER = {"_eq": "X-Hasura-User-Id"}
ADMIN = {
    "_exists": {
        "_table": {"name": "modelcatalog_admin", "schema": "public"},
        "_where": {"username": {"_eq": "X-Hasura-User-Id"}},
    }
}
OWNER_OR_ADMIN = {"_or": [{"owner_username": OWNER}, ADMIN]}
VIA_CONFIGURATION = {"_or": [{"configuration": {"owner_username": OWNER}}, ADMIN]}
# Someone else's row, or a row nobody owns.
NOT_MINE = {
    "_or": [
        {"owner_username": {"_neq": "X-Hasura-User-Id"}},
        {"owner_username": {"_is_null": True}},
    ]
}
# Used by a configuration of the caller and by no configuration of anyone else.
ONLY_MINE_PARAMETER = {
    "_or": [
        {
            "_and": [
                {"configuration_parameters": {"configuration": {"owner_username": OWNER}}},
                {"_not": {"configuration_parameters": {"configuration": NOT_MINE}}},
            ]
        },
        ADMIN,
    ]
}
CONFIGURATION_LINKS = [
    "modelcatalog_configuration_input",
    "modelcatalog_configuration_output",
    "modelcatalog_configuration_author",
    "modelcatalog_configuration_category",
    "modelcatalog_configuration_region",
    "modelcatalog_configuration_time_interval",
    "modelcatalog_configuration_causal_diagram",
    "modelcatalog_configuration_calibrated_variable",
    "modelcatalog_configuration_calibration_target",
]


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


def test_configuration_update_is_owner_or_admin():
    perm = _user_permission("modelcatalog_configuration", "update")
    assert perm["filter"] == OWNER_OR_ADMIN


def test_an_owner_cannot_give_a_configuration_away_or_leave_it_unowned():
    # owner_username is updatable so an admin can reassign. The post-update check is what
    # stops an owner: the row must still be theirs, and NULL must not slip through.
    perm = _user_permission("modelcatalog_configuration", "update")
    assert "owner_username" in perm["columns"]
    assert perm["check"] == {
        "_or": [{"owner_username": {"_eq": "X-Hasura-User-Id", "_is_null": False}}, ADMIN]
    }


def test_configuration_delete_is_owner_without_setups_or_admin():
    perm = _user_permission("modelcatalog_configuration", "delete")
    assert perm["filter"] == {
        "_or": [
            ADMIN,
            {"_and": [{"owner_username": OWNER}, {"model_configuration_id": {"_is_null": True}}]},
        ]
    }


@pytest.mark.parametrize("table", CONFIGURATION_LINKS)
def test_configuration_links_require_owning_the_configuration(table):
    assert _user_permission(table, "insert")["check"] == VIA_CONFIGURATION
    assert _user_permission(table, "delete")["filter"] == VIA_CONFIGURATION


def test_no_configuration_link_table_is_left_open():
    # Any table that hangs off a configuration and that role `user` can write must be
    # scoped to the configuration's owner. A new link table fails here until it is.
    for entry in yaml.safe_load(TABLES.read_text()):
        name = entry["table"]["name"]
        if not name.startswith("modelcatalog_configuration_"):
            continue
        for kind, key in (("insert", "check"), ("update", "filter"), ("delete", "filter")):
            for perm in entry.get(f"{kind}_permissions") or []:
                if perm["role"] == "user":
                    assert perm["permission"].get(key) != {}, f"{name} {kind} is open to every user"


def test_a_parameter_link_needs_the_callers_configuration_and_an_unshared_parameter():
    # Linking another user's parameter to your own configuration would stop its owner
    # editing it (see the parameter rule below).
    perm = _user_permission("modelcatalog_configuration_parameter", "insert")
    assert perm["check"] == {
        "_or": [
            {
                "_and": [
                    {"configuration": {"owner_username": OWNER}},
                    {"_not": {"parameter": {"configuration_parameters": {"configuration": NOT_MINE}}}},
                ]
            },
            ADMIN,
        ]
    }
    assert _user_permission("modelcatalog_configuration_parameter", "delete")["filter"] == VIA_CONFIGURATION


def test_parameter_update_and_delete_require_that_only_the_caller_uses_it():
    # "Linked to one of my configurations" was not enough: a user could link someone
    # else's parameter to their own configuration and then edit or delete it.
    assert _user_permission("modelcatalog_parameter", "update")["filter"] == ONLY_MINE_PARAMETER
    assert _user_permission("modelcatalog_parameter", "delete")["filter"] == ONLY_MINE_PARAMETER


@pytest.mark.parametrize(
    "table", ["modelcatalog_parameter_intervention", "modelcatalog_parameter_adjusts_variable"]
)
def test_parameter_links_require_owning_a_configuration_that_uses_the_parameter(table):
    rule = {
        "_or": [
            {"parameter": {"configuration_parameters": {"configuration": {"owner_username": OWNER}}}},
            ADMIN,
        ]
    }
    assert _user_permission(table, "insert")["check"] == rule
    assert _user_permission(table, "delete")["filter"] == rule


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
