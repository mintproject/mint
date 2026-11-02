"""Background polling loop — checks Tapis run status for active adapter_workflow_run
rows and updates their status (and provenance) in the adapter schema.

Started as an asyncio task at application startup (see main.lifespan).
Requires SVO_ADAPTER_TAPIS_TOKEN to be set; without it the task is not started.
Set SVO_ADAPTER_POLL_INTERVAL_SECONDS=0 to disable even when a token is configured.

Design:
- Every poll_interval_seconds, query Hasura for runs in "running"/"submitting".
- For each, call tapis.get_run_status (lightweight — just the status string).
- On terminal status (COMPLETED / FAILED / etc.), call tapis.get_run_detail to
  collect per-task error messages, then update the adapter_workflow_run row.
- Emit a "run_status_polled" provenance event for every transition.
- Runs with an execution_id (owned by Ensemble Manager) are included unless
  SVO_ADAPTER_POLL_COORDINATOR_RUNS=0. The service token's account must be a
  member of the Workflows group; a run it cannot read is left unchanged. For
  those runs the poller syncs status only. Output registration stays with
  Ensemble Manager (/runs/{id}/poll).
- A success is not written when the task detail could not be read, because a
  failed child task would otherwise be recorded as "completed". It is retried
  on the next pass.
- Never raises: errors are logged and skipped; the loop keeps running.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from starlette.concurrency import run_in_threadpool

from .config import settings
from . import tapis as tapis_mod
from .result_contract import task_result
from .error_handling import safe_error_message

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# GraphQL — self-contained so this module has no circular imports with main.py
# ---------------------------------------------------------------------------

_LIST_ACTIVE_RUNS = """
query ListActiveRuns {
  adapter_workflow_run(where: {status: {_in: ["running", "submitting"]}}) {
    id tapis_workflow_id tapis_run_id execution_id workflow_plan_id
  }
}
"""

_UPDATE_RUN = """
mutation UpdateRun($id: String!, $set: adapter_workflow_run_set_input!) {
  update_adapter_workflow_run_by_pk(pk_columns: {id: $id}, _set: $set) {
    id status
  }
}
"""

_INSERT_PROVENANCE = """
mutation Provenance($obj: adapter_provenance_event_insert_input!) {
  insert_adapter_provenance_event_one(object: $obj) { id }
}
"""

_GET_PLAN = """
query GetPlan($id: String!) {
  adapter_workflow_plan_by_pk(id: $id) {
    id target_dataset_specification_id plan_json
  }
}
"""

# EM binding mutations — local copies to avoid circular imports with main.py
_INSERT_DATA_OBJECT = """
mutation InsertDataObject($obj: adapter_data_object_insert_input!) {
  insert_adapter_data_object_one(object: $obj) { id label resource_uri }
}
"""

_UPSERT_RESOURCE = """
mutation UpsertResource($obj: resource_insert_input!) {
  insert_resource_one(object: $obj, on_conflict: {
    constraint: resource_pkey, update_columns: [name, url]
  }) { id }
}
"""

_INSERT_EXECUTION_DATA_BINDING = """
mutation InsertExecutionDataBinding($obj: execution_data_binding_insert_input!) {
  insert_execution_data_binding_one(object: $obj, on_conflict: {
    constraint: execution_data_binding_pkey, update_columns: []
  }) { execution_id model_io_id resource_id }
}
"""

# ---------------------------------------------------------------------------
# Tapis status → adapter status.  Statuses not in this map are still-in-progress
# (PENDING, STAGING_INPUTS, RUNNING, ARCHIVING) — no adapter update emitted.
# ---------------------------------------------------------------------------
_TERMINAL: dict[str, str] = {
    "COMPLETED": "completed",
    "FINISHED":  "completed",   # older Tapis tenants use FINISHED
    "NORMAL_COMPLETION": "completed",
    "FAILED":    "failed",
    "CANCELLED": "failed",
    "TERMINATED": "failed",
}


def _failed_task_messages(detail: dict[str, Any]) -> list[str]:
    """Extract child task failures from a Tapis run detail payload."""
    failed = []
    for task in detail.get("tasks") or []:
        if (task.get("status") or "").upper() not in ("FAILED", "ERROR"):
            continue
        task_id = task.get("task_id") or task.get("id") or "unknown-task"
        message = task.get("last_message") or task.get("stderr") or task.get("stdout") or "no detail"
        failed.append(f"{task_id}: {message}")
    return failed


def _terminal_update_set(
    tapis_status: str,
    detail: dict[str, Any] | None = None,
    *,
    now: datetime | None = None,
) -> tuple[str | None, dict[str, Any]]:
    """Map Tapis terminal status + child tasks to adapter status/update fields."""
    adapter_status = _TERMINAL.get(tapis_status.upper())
    if adapter_status is None:
        return None, {}

    detail = detail or {}
    failed_tasks = _failed_task_messages(detail)
    _, result_error = task_result(detail)
    if result_error:
        failed_tasks.append(result_error)
    if failed_tasks:
        adapter_status = "failed"

    update_set: dict[str, Any] = {"status": adapter_status}
    if adapter_status == "completed":
        stamp = now or datetime.now(tz=timezone.utc)
        update_set["completed_at"] = stamp.isoformat()
    else:
        provider_message = next(
            (
                detail.get(key)
                for key in ("error", "message", "last_message", "status_message", "description")
                if detail and detail.get(key)
            ),
            None,
        )
        update_set["error_message"] = safe_error_message(
            "; ".join(failed_tasks)
            if failed_tasks
            else str(provider_message or f"Tapis workflow reported {tapis_status}")
        )
    return adapter_status, update_set


async def _auto_bind_completed_run(
    h, admin_h, run: dict[str, Any], token: str,
) -> dict[str, Any]:
    """After a run completes, attempt to auto-register its output and bind it to
    the Ensemble Manager execution stored on the run.

    Requires: run.execution_id set AND plan.target_dataset_specification_id set.
    Tries to locate the output URI from Tapis task stdout / Jobs archive path.
    Returns a summary dict; never raises.
    """
    run_id = run["id"]
    execution_id = run.get("execution_id")
    plan_id = run.get("workflow_plan_id")

    if not execution_id:
        return {"skipped": "no execution_id on run"}

    if not plan_id:
        log.warning("auto-bind: run %s has no workflow_plan_id", run_id)
        return {"skipped": "no workflow_plan_id"}

    try:
        plan_row = (await h.execute(_GET_PLAN, {"id": plan_id}))["adapter_workflow_plan_by_pk"]
    except Exception as exc:  # noqa: BLE001
        log.warning("auto-bind: could not fetch plan %s: %s", plan_id, exc)
        return {"error": f"plan fetch failed: {exc}"}

    if (plan_row or {}).get("plan_json", {}).get("orchestration_mode") == "em_deferred_post_model":
        return {"skipped": "ensemble_manager owns deferred post-model handoff"}

    ds_id = (plan_row or {}).get("target_dataset_specification_id")
    if not ds_id:
        log.warning("auto-bind: plan %s has no target_dataset_specification_id", plan_id)
        return {"skipped": "no target_dataset_specification_id"}

    # Try to find where Tapis archived the output.
    pipeline_id = run.get("tapis_workflow_id")
    run_uuid = run.get("tapis_run_id")
    output_uri: str | None = None
    if pipeline_id and run_uuid:
        try:
            output_uri = await run_in_threadpool(
                tapis_mod.get_output_uri, pipeline_id, run_uuid, token=token,
            )
        except Exception as exc:  # noqa: BLE001
            log.debug("auto-bind: get_output_uri failed for run %s: %s", run_id, exc)

    if not output_uri:
        log.warning("auto-bind: could not find output URI for run %s — manual /register-output required", run_id)
        await h.execute(_INSERT_PROVENANCE, {"obj": {
            "workflow_run_id": run_id,
            "event_type": "run_completed_output_not_found",
            "payload_json": {"execution_id": execution_id, "model_io_id": ds_id},
        }})
        return {"status": "no_output_uri", "execution_id": execution_id, "model_io_id": ds_id}

    # Register the output as a data object.
    do_id = f"auto-{run_id}"
    try:
        do_result = (await h.execute(_INSERT_DATA_OBJECT, {"obj": {
            "id": do_id,
            "label": f"Auto-registered output of run {run_id[:8]}",
            "resource_uri": output_uri,
            "source_catalog": "tapis",
        }}))["insert_adapter_data_object_one"]
    except Exception as exc:  # noqa: BLE001
        log.error("auto-bind: failed to create data object for run %s: %s", run_id, exc)
        return {"error": f"data_object insert failed: {exc}"}

    # Stamp the run's output_data_object_id.
    try:
        await h.execute(_UPDATE_RUN, {"id": run_id, "set": {"output_data_object_id": do_result["id"]}})
    except Exception as exc:  # noqa: BLE001
        log.warning("auto-bind: could not set output_data_object_id on run %s: %s", run_id, exc)

    # Upsert resource row (public MINT schema needs admin client).
    try:
        await admin_h.execute(_UPSERT_RESOURCE, {"obj": {
            "id": do_result["id"],
            "name": do_result.get("label") or do_result["id"],
            "url": output_uri,
        }})
        await admin_h.execute(_INSERT_EXECUTION_DATA_BINDING, {"obj": {
            "execution_id": execution_id,
            "model_io_id": ds_id,
            "resource_id": do_result["id"],
        }})
    except Exception as exc:  # noqa: BLE001
        log.error("auto-bind: EM binding failed for run %s: %s", run_id, exc)
        return {"error": f"EM binding failed: {exc}", "data_object_id": do_result["id"]}

    await h.execute(_INSERT_PROVENANCE, {"obj": {
        "workflow_run_id": run_id,
        "data_object_id": do_result["id"],
        "event_type": "output_bound_to_execution",
        "payload_json": {
            "execution_id": execution_id,
            "model_io_id": ds_id,
            "resource_id": do_result["id"],
            "output_uri": output_uri,
            "source": "auto_bind_poller",
        },
    }})
    log.info(
        "auto-bind: run %s → execution %s (ds_id=%s uri=%s)",
        run_id[:12], execution_id[:8], ds_id, output_uri[:60] if output_uri else "",
    )
    return {"execution_id": execution_id, "model_io_id": ds_id, "resource_id": do_result["id"]}


async def poll_once(token: str) -> list[dict[str, Any]]:
    """Single poll pass.

    Fetches all active runs, checks each against Tapis, and writes status
    updates for any that have reached a terminal state.
    Returns a list of {run_id, tapis_status, adapter_status} dicts (one per
    transition made this pass).
    """
    from .hasura import get_client  # noqa: PLC0415 — deferred to avoid import cycle

    h = get_client(None)  # admin secret — reads + adapter-schema writes
    rows = (await h.execute(_LIST_ACTIVE_RUNS))["adapter_workflow_run"]
    if not rows:
        return []

    updates: list[dict[str, Any]] = []
    for run in rows:
        run_id = run["id"]
        pipeline_id = run.get("tapis_workflow_id")
        run_uuid = run.get("tapis_run_id")
        if run.get("execution_id") and not settings.poll_coordinator_runs:
            # Ensemble Manager polls these with the UI caller's bearer token,
            # and only while someone requests the run. Opt out of the service
            # token reading them (see poll_coordinator_runs in config).
            continue
        if not (pipeline_id and run_uuid):
            log.debug("poller: run %s missing pipeline_id/run_uuid, skipping", run_id)
            continue

        # --- status check (fast path — no task logs) -------------------------
        try:
            tapis_status: str | None = await run_in_threadpool(
                tapis_mod.get_run_status, pipeline_id, run_uuid, token=token,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("poller: Tapis unreachable for run %s: %s", run_id, exc)
            continue

        if not tapis_status:
            log.debug("poller: no status returned for run %s", run_id)
            continue

        adapter_status = _TERMINAL.get(tapis_status.upper())
        if adapter_status is None:
            continue  # still active — no write needed

        # --- terminal: build the update payload ------------------------------
        detail: dict[str, Any] = {}
        try:
            detail = await run_in_threadpool(
                tapis_mod.get_run_detail, pipeline_id, run_uuid, token=token,
            )
        except Exception as exc:  # noqa: BLE001
            log.debug("poller: could not fetch task detail for run %s: %s", run_id, exc)
        adapter_status, update_set = _terminal_update_set(tapis_status, detail)
        if adapter_status is None:
            continue
        if adapter_status == "completed" and (detail.get("tasks_error") or detail.get("run_error")):
            # Child-task failures are only visible in the task detail; without
            # it a failed run would be recorded as completed. Retry next pass.
            log.warning(
                "poller: run %s reported %s but task detail was unreadable (%s); retrying",
                run_id[:12], tapis_status, detail.get("tasks_error") or detail.get("run_error"),
            )
            continue

        # --- write -----------------------------------------------------------
        try:
            await h.execute(_UPDATE_RUN, {"id": run_id, "set": update_set})
            await h.execute(_INSERT_PROVENANCE, {"obj": {
                "workflow_run_id": run_id,
                "event_type": "run_status_polled",
                "payload_json": {
                    "tapis_status": tapis_status,
                    "adapter_status": adapter_status,
                },
            }})
            updates.append({
                "run_id": run_id,
                "tapis_status": tapis_status,
                "adapter_status": adapter_status,
            })
            log.info("poller: run %s → %s (tapis=%s)", run_id[:12], adapter_status, tapis_status)
        except Exception as exc:  # noqa: BLE001
            log.error("poller: failed to write update for run %s: %s", run_id, exc)
            continue

    return updates


async def run_poller() -> None:
    """Long-running asyncio task started by main.lifespan.

    Polls every settings.poll_interval_seconds until cancelled at shutdown.
    """
    token = settings.tapis_token
    interval = settings.poll_interval_seconds
    log.info("poller: started (interval=%ds, token=%s)", interval, "set" if token else "MISSING")
    while True:
        try:
            updates = await poll_once(token)
            if updates:
                log.info(
                    "poller: %d run(s) transitioned: %s",
                    len(updates),
                    [(u["run_id"][:8], u["adapter_status"]) for u in updates],
                )
        except Exception as exc:  # noqa: BLE001
            log.error("poller: unexpected error: %s", exc)
        await asyncio.sleep(interval)
