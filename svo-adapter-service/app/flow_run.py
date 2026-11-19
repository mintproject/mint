"""What a run of a flow looks like from outside: each step's status, and where
each of the flow's outputs ended up.

Tapis Workflows reports a task's status, messages and stdout, but not the named
outputs it set. So every flow step ends by printing one JSON line,
``{"svo_flow_outputs": {<task output id>: <value>}}``, and this module reads it
back. The adapter's own wrapper prints that line last, after the piece's code
has run, so the last such line in a task's stdout is the adapter's.
"""
from __future__ import annotations

import json
from typing import Any

from . import tapis

REPORT_KEY = "svo_flow_outputs"

_STATUS = {
    "completed": "completed", "complete": "completed", "success": "completed", "succeeded": "completed",
    "failed": "failed", "error": "failed", "terminated": "cancelled", "cancelled": "cancelled",
    "active": "running", "running": "running", "staging": "running", "submitted": "running",
    "pending": "pending", "queued": "pending", "backoff": "running", "skipped": "skipped",
}


def task_id(step: dict[str, Any]) -> str:
    """The pipeline task a plan step became (see tapis.generate_tapis_workflow)."""
    return f"step-{step['step']}-{(step.get('transform_type') or 'transform')}"


def reported_outputs(stdout: Any) -> dict[str, Any]:
    """The outputs a flow step reported on its last report line, or {}."""
    if not isinstance(stdout, str):
        return {}
    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if not line.startswith("{") or REPORT_KEY not in line:
            continue
        try:
            payload = json.loads(line)
        except ValueError:
            continue
        if isinstance(payload, dict) and isinstance(payload.get(REPORT_KEY), dict):
            return payload[REPORT_KEY]
    return {}


def view(plan_json: dict[str, Any], detail: dict[str, Any]) -> dict[str, Any] | None:
    """Steps and outputs of a flow run, or None when the plan is not a flow.

    ``detail`` is tapis.get_run_detail's answer. A step Tapis has not started yet
    is ``pending``. An output whose step has not reported is given with no value.
    """
    flow = plan_json.get("flow")
    if not isinstance(flow, dict):
        return None
    tasks = {str(task.get("task_id")): task for task in detail.get("tasks") or [] if isinstance(task, dict)}
    by_number: dict[int, dict[str, Any]] = {}
    reported: dict[int, dict[str, Any]] = {}
    steps = []
    for step in plan_json.get("steps") or []:
        number = int(step["step"])
        task = tasks.get(task_id(step)) or {}
        by_number[number] = step
        reported[number] = reported_outputs(task.get("stdout"))
        steps.append({
            "step": number,
            "name": step.get("name"),
            "task_id": task_id(step),
            "depends_on": list(step.get("depends_on") or []),
            "status": _STATUS.get(str(task.get("status") or "").lower(), "pending"),
            "message": task.get("last_message"),
        })
    outputs = []
    for declared in flow.get("outputs") or []:
        if not isinstance(declared, dict) or type(declared.get("step")) is not int:
            continue
        step = by_number.get(declared["step"])
        ids = (tapis.flow_output_ids(step) if step else None) or {"outputs": {}, "values": {}}
        if "output" in declared:
            output_id = ids["outputs"].get(str(declared["output"]))
        elif "value" in declared:
            output_id = ids["values"].get(str(declared["value"]))
        else:
            output_id = None  # a published record: reported by the publication, not here
        value = reported.get(declared["step"], {}).get(output_id) if output_id else None
        outputs.append({**declared, "value": value if isinstance(value, str) else None})
    return {"configuration_id": flow.get("configuration_id"), "steps": steps, "outputs": outputs}
