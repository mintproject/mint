"""Output-side publication state of a run (design 2026-11-05-output-publish-etl.md).

A run's `publication` is derived from the `catalog_register` task's result at
status time; nothing here writes new state except one token-free provenance
event, `run.output.published`, recorded when a poll first sees the outcome.
"""
from __future__ import annotations

from typing import Any

from .error_handling import safe_error_message
from .result_contract import parse_json_payload

PUBLISH_TASK_SUFFIX = "-catalog_register"
PUBLISHED_EVENT = "run.output.published"
_FAILED_TASK_STATES = {"FAILED", "ERROR"}

GET_PUBLISHED_EVENT = """
query GetPublishedEvent($run_id: String!) {
  adapter_provenance_event(
    where: {workflow_run_id: {_eq: $run_id}, event_type: {_eq: "run.output.published"}}
    limit: 1
    order_by: {created_at: desc}
  ) { payload_json }
}
"""

INSERT_PROVENANCE = """
mutation Provenance($obj: adapter_provenance_event_insert_input!) {
  insert_adapter_provenance_event_one(object: $obj) { id }
}
"""


def publication_from_detail(detail: dict[str, Any]) -> dict[str, Any] | None:
    """The outcome of the `catalog_register` task in a Tapis run detail, or None
    while it has not finished (or the run has no publish step)."""
    for task in detail.get("tasks") or []:
        if not str(task.get("task_id") or task.get("id") or "").endswith(PUBLISH_TASK_SUFFIX):
            continue
        payload = parse_json_payload(task.get("stdout")) or {}
        if payload.get("catalog") and payload.get("stac_item"):
            return {
                "status": "published",
                "catalog": str(payload["catalog"]),
                "ckan_dataset": payload.get("ckan_dataset"),
                "stac_item": payload.get("stac_item"),
                "public": bool(payload.get("public")),
            }
        if str(payload.get("status") or "").lower() == "error":
            return {"status": "failed", "error": safe_error_message(payload.get("message") or "publication failed", limit=400)}
        if str(task.get("status") or "").upper() in _FAILED_TASK_STATES:
            message = task.get("last_message") or "publication task failed"
            return {"status": "failed", "error": safe_error_message(message, limit=400)}
        return None
    return None


async def recorded_publication(h, run_id: str) -> dict[str, Any] | None:
    rows = (await h.execute(GET_PUBLISHED_EVENT, {"run_id": run_id})).get("adapter_provenance_event") or []
    payload = (rows[0] or {}).get("payload_json") if rows else None
    return payload if isinstance(payload, dict) else None


async def record_publication(h, run_id: str, publication: dict[str, Any]) -> None:
    """Record the outcome once. The payload is the publication itself: links,
    visibility and a scrubbed error, never args or tokens."""
    if await recorded_publication(h, run_id):
        return
    await h.execute(INSERT_PROVENANCE, {"obj": {
        "workflow_run_id": run_id, "event_type": PUBLISHED_EVENT, "payload_json": publication,
    }})
