"""Bounded, token-free result contract for hosted adapter tasks."""
from __future__ import annotations

import json
from typing import Any


RESULT_SCHEMA_VERSION = 1
_SCALAR_KEYS = (
    "value",
    "spring_flow",
    "stream_flow",
    "baseflow",
    "flow",
    "average_value",
    "average",
    "mean",
    "total_flow",
    "total",
)


def parse_json_payload(text: Any) -> dict[str, Any] | None:
    """Parse a task's JSON output without returning raw provider text."""
    if not text:
        return None
    try:
        payload = json.loads(str(text))
        return payload if isinstance(payload, dict) else None
    except (TypeError, ValueError):
        pass
    for line in reversed(str(text).splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            payload = json.loads(line)
        except (TypeError, ValueError):
            continue
        if isinstance(payload, dict):
            return payload
    return None


def _number(value: Any) -> int | float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    return None


def scalar_result(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Return only the safe scalar fields a facilitator may see."""
    nested = payload.get("result")
    candidates = nested if isinstance(nested, dict) else payload
    value = next((_number(candidates.get(key)) for key in _SCALAR_KEYS if key in candidates), None)
    if value is None:
        return None
    unit = candidates.get("unit") or payload.get("unit")
    operation = payload.get("operation")
    out: dict[str, Any] = {
        "schema_version": RESULT_SCHEMA_VERSION,
        "status": "ok",
        "value": value,
    }
    if isinstance(unit, str) and unit.strip():
        out["unit"] = unit.strip()
    if isinstance(operation, str) and operation.strip():
        out["operation"] = operation.strip()
    return out


def _structured_error_message(task_id: str, payload: dict[str, Any]) -> str:
    """Preserve safe diagnostic fields without exposing raw provider output."""
    message = payload.get("message") or payload.get("error") or "task returned an error"
    code = payload.get("code")
    prefix = f"{task_id}:"
    if isinstance(code, str) and code.strip():
        prefix += f" [{code.strip()}]"
    text = f"{prefix} {str(message)[:800]}"

    attempts = payload.get("attempts")
    if isinstance(attempts, list):
        rendered_attempts = []
        for attempt in attempts[:8]:
            if not isinstance(attempt, dict):
                continue
            method = str(attempt.get("method") or "lookup")[:80]
            status = str(attempt.get("status") or "unknown")[:40]
            candidate_count = attempt.get("candidate_count")
            suffix = f", candidates={candidate_count}" if candidate_count is not None else ""
            rendered_attempts.append(f"{method}={status}{suffix}")
        if rendered_attempts:
            text += "; attempts: " + ", ".join(rendered_attempts)

    details = payload.get("details")
    if isinstance(details, dict):
        safe_details = []
        for key in ("job_name", "source_uri", "output_name", "output_file", "archived_files",
                    "candidates", "hint"):
            value = details.get(key)
            if value is None:
                continue
            if key in ("archived_files", "candidates") and isinstance(value, list):
                value = ",".join(str(item)[:120] for item in value[:8])
            safe_details.append(f"{key}={str(value)[:240]}")
        if safe_details:
            text += "; details: " + ", ".join(safe_details)
    return text[:1800]


def task_result(detail: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    """Extract the last safe scalar or a bounded structured task error."""
    result: dict[str, Any] | None = None
    for task in detail.get("tasks") or []:
        task_id = task.get("task_id") or task.get("id") or "unknown-task"
        payload = parse_json_payload(task.get("stdout"))
        if isinstance(payload, dict) and str(payload.get("status") or "").lower() == "error":
            return None, _structured_error_message(str(task_id), payload)
        if payload:
            result = scalar_result(payload) or result
    return result, None
