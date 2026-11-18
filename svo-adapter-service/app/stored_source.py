"""Python source stored with a transform spec, and its approval state.

A spec can carry source in two places inside ``parameters_schema_json.metadata``:
``source`` (specs registered straight into the adapter) and ``runtime.source``
(specs synced from a catalog ETL process). Either may be ``{"code": "..."}`` or
a plain string.
"""
from __future__ import annotations

import hashlib
from typing import Any


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
