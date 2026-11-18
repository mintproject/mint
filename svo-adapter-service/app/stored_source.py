"""Python source stored with a transform spec, and its approval state.

A spec can carry source in two places inside ``parameters_schema_json.metadata``:
``source`` (specs registered straight into the adapter) and ``runtime.source``
(specs synced from a catalog ETL process). Either may be ``{"code": "..."}`` or
a plain string.
"""
from __future__ import annotations

import hashlib
from typing import Any, Iterable, Iterator

from .config import settings


def _code(source: Any) -> str | None:
    if isinstance(source, dict):
        source = source.get("code")
    return source if isinstance(source, str) and source.strip() else None


def stored_source(spec: dict[str, Any]) -> str | None:
    """The spec's stored Python source, or None when it runs built-in code."""
    metadata = (spec.get("parameters_schema_json") or {}).get("metadata") or {}
    runtime = metadata.get("runtime") if isinstance(metadata.get("runtime"), dict) else {}
    return _code(metadata.get("source")) or _code(runtime.get("source"))


def source_sha256(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def is_approved(spec: dict[str, Any]) -> bool:
    """True only while the spec's current source is the one an admin approved."""
    source = stored_source(spec)
    approved = spec.get("approved_source_sha256")
    return bool(source and approved and source_sha256(source) == approved)


# ---------------------------------------------------------------------------
# Who may run a piece's stored source
# ---------------------------------------------------------------------------

def decision(spec: dict[str, Any], username: str | None, opt_in_ids: Iterable[str] = ()) -> str:
    """Why ``username`` may (or may not) run this piece.

    ``builtin``   no stored source: runs code reviewed in this repository
    ``own``       the caller owns the piece
    ``approved``  shared or public, and an admin approved the current source
    ``opt_in``    shared or public, unapproved, and the caller named it
    ``denied``    anything else, and every stored-source piece while
                  ``stored_source_enabled`` is off
    """
    if not stored_source(spec):
        return "builtin"
    if not settings.stored_source_enabled:
        return "denied"
    owner = spec.get("owner_username")
    if username and owner and owner == username:
        return "own"
    if (spec.get("visibility") or "public") in ("shared", "public"):
        if is_approved(spec):
            return "approved"
        if username and spec.get("id") in set(opt_in_ids):
            return "opt_in"
    return "denied"


def plannable(registry: list[dict[str, Any]], username: str | None,
              opt_in_ids: Iterable[str] = ()) -> list[dict[str, Any]]:
    """The pieces the planner may choose for this caller."""
    opt_in = set(opt_in_ids)
    return [spec for spec in registry if decision(spec, username, opt_in) != "denied"]


def annotate_step(step: dict[str, Any], spec: dict[str, Any], source: str) -> None:
    """Record on a plan step which stored source it carries, so the submit-time
    check can tell whether the piece changed after the plan was made."""
    step["python_source"] = source
    step["stored_source"] = {
        "spec_id": spec.get("id"),
        "owner_username": spec.get("owner_username"),
        "visibility": spec.get("visibility") or "public",
        "sha256": source_sha256(source),
        "approved": is_approved(spec),
    }


def iter_stored_steps(node: Any) -> Iterator[dict[str, Any]]:
    """Every step carrying stored source anywhere in a plan (main steps and the
    steps nested under input stages)."""
    if isinstance(node, dict):
        if isinstance(node.get("python_source"), str):
            yield node
        for value in node.values():
            yield from iter_stored_steps(value)
    elif isinstance(node, list):
        for value in node:
            yield from iter_stored_steps(value)


def check_plan(plan_json: dict[str, Any], registry: list[dict[str, Any]],
               username: str | None, opt_in_ids: Iterable[str] = ()) -> list[dict[str, Any]]:
    """Problems that stop ``username`` submitting this plan. Empty = allowed.

    Evaluated against the submitter, not whoever made the plan, and against the
    piece as it is now, not as it was when the plan was made.
    """
    by_id = {spec.get("id"): spec for spec in registry}
    opt_in = set(opt_in_ids)
    problems: list[dict[str, Any]] = []
    for step in iter_stored_steps(plan_json):
        recorded = step.get("stored_source") or {}
        spec_id = step.get("transform_spec_id") or recorded.get("spec_id")
        spec = by_id.get(spec_id)

        def problem(code: str) -> None:
            problems.append({"code": code, "transform_spec_id": spec_id})

        if not settings.stored_source_enabled:
            problem("STORED_SOURCE_DISABLED")
        elif spec is None:
            problem("STORED_SOURCE_PIECE_NOT_VISIBLE")
        elif not (recorded.get("sha256") == source_sha256(step["python_source"])
                  == source_sha256(stored_source(spec) or "")):
            problem("STORED_SOURCE_CHANGED")
        elif decision(spec, username, opt_in) == "denied":
            problem("STORED_SOURCE_NOT_PERMITTED")
    return problems


def allowed_args(step: dict[str, Any], secret_params: Iterable[str]) -> set[str]:
    """Pipeline args a stored-source step may bind: its Tapis token, its source
    URI and the run arguments the piece declares, never another secret."""
    declared = set(((step.get("parameters_schema_json") or {}).get("properties") or {}))
    return ({"tapis_token", "source_uri"} | declared) - (set(secret_params) - {"tapis_token"})
