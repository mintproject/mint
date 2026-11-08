"""A Hasura session variable inside an `_in` / `_nin` list is compared as a literal string,
so `user_id: {_in: [X-Hasura-User-Id, '*']}` only ever matched '*' and a per-user permission
row never granted access (reproduced on dev: a user could not read their own problem statement).
Write it as an `_or` of two `_eq` instead."""
from pathlib import Path

import yaml

TABLES = Path(__file__).resolve().parents[1] / "metadata" / "tables.yaml"


def _walk(node, path=""):
    if isinstance(node, dict):
        for key, value in node.items():
            yield from _walk(value, f"{path}.{key}")
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from _walk(value, f"{path}[{index}]")
    yield path, node


def test_no_session_variable_inside_an_in_list():
    offenders = []
    for entry in yaml.safe_load(TABLES.read_text()):
        table = entry["table"]["name"]
        for path, node in _walk(entry):
            if isinstance(node, dict):
                for op in ("_in", "_nin"):
                    values = node.get(op)
                    if isinstance(values, list) and any(
                        isinstance(v, str) and v.startswith("X-Hasura-") for v in values
                    ):
                        offenders.append(f"{table}{path}.{op}")
    assert not offenders, "session variable inside a list (compared literally): " + ", ".join(offenders[:5])


def test_user_scoped_permission_filters_match_the_caller_or_the_wildcard():
    # The rewrite keeps the meaning "this user's row or a shared ('*') row".
    shapes = 0
    for entry in yaml.safe_load(TABLES.read_text()):
        for path, node in _walk(entry):
            if isinstance(node, dict) and set(node) == {"_or"}:
                branches = node["_or"]
                values = {
                    b["user_id"]["_eq"] for b in branches
                    if isinstance(b, dict) and set(b) == {"user_id"} and isinstance(b["user_id"], dict)
                    and set(b["user_id"]) == {"_eq"}
                }
                if values == {"X-Hasura-User-Id", "*"}:
                    shapes += 1
    assert shapes > 0
