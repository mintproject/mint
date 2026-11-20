"""No Hasura role may read or write a stored secret, or read the secrets bound to a run.

The adapter reads and writes `adapter.secret` and `adapter.secret_event` with its own
admin client. A permission for any role would let a user's token reach them (a runner's
own secrets live in the same table as a model owner's). `adapter.workflow_run` is
readable, but its `bound_secrets` column (ids and names of what a run was given) is not.
"""
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
TABLES = ROOT / "metadata" / "tables.yaml"
SECRET_TABLES = {"secret", "secret_event"}
KINDS = ("select", "insert", "update", "delete")


def forbidden_grants(entries):
    """What in a parsed tables.yaml breaks the rule; an empty list when it holds."""
    problems = []
    for entry in entries:
        table = entry["table"]
        if table.get("schema") != "adapter":
            continue
        name = table["name"]
        for kind in KINDS:
            for grant in entry.get(f"{kind}_permissions") or []:
                perm = grant.get("permission") or {}
                if name in SECRET_TABLES:
                    problems.append(f"{grant['role']} has {kind} on adapter.{name}")
                elif name == "workflow_run" and kind in ("select", "update", "insert"):
                    columns = perm.get("columns")
                    # `select` with `*` or an explicit list reaches the column; so can a write
                    if columns == "*" or "bound_secrets" in (columns or []):
                        problems.append(f"{grant['role']} has {kind} on adapter.workflow_run.bound_secrets")
    return problems


def _entries():
    return yaml.safe_load(TABLES.read_text())


def test_the_current_metadata_grants_nothing_on_secrets():
    assert forbidden_grants(_entries()) == []


def test_the_checker_sees_a_grant_on_either_secret_table():
    entries = _entries()
    for entry in entries:
        if entry["table"] == {"name": "secret", "schema": "adapter"}:
            entry["select_permissions"] = [
                {"role": "user", "permission": {"columns": ["id"], "filter": {}}}]
        if entry["table"] == {"name": "secret_event", "schema": "adapter"}:
            entry["insert_permissions"] = [{"role": "anonymous", "permission": {"check": {}}}]
    assert forbidden_grants(entries) == [
        "user has select on adapter.secret", "anonymous has insert on adapter.secret_event"]


def test_the_checker_sees_a_run_select_that_includes_bound_secrets():
    for columns in ("*", ["id", "bound_secrets"]):
        entries = _entries()
        for entry in entries:
            if entry["table"] == {"name": "workflow_run", "schema": "adapter"}:
                entry["select_permissions"] = [
                    {"role": "user", "permission": {"columns": columns, "filter": {}}}]
        assert forbidden_grants(entries) == [
            "user has select on adapter.workflow_run.bound_secrets"]


def test_a_run_select_without_bound_secrets_is_allowed():
    entries = _entries()
    for entry in entries:
        if entry["table"] == {"name": "workflow_run", "schema": "adapter"}:
            entry["select_permissions"] = [
                {"role": "user", "permission": {"columns": ["id", "status"], "filter": {}}}]
    assert forbidden_grants(entries) == []
