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
# A report line is a handful of ids and locations. Anything longer is not one.
_MAX_REPORT_LINE = 100_000
_MAX_VALUE = 20_000
_MAX_LOCATION = 2_000

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
        if not line.startswith("{") or REPORT_KEY not in line or len(line) > _MAX_REPORT_LINE:
            continue
        try:
            payload = json.loads(line)
        except Exception:  # a piece's own output: malformed or nested past what json reads
            continue
        if isinstance(payload, dict) and isinstance(payload.get(REPORT_KEY), dict):
            return payload[REPORT_KEY]
    return {}


def location(value: Any) -> str | None:
    """Where an output is, from what its step reported.

    A piece written for a flow reports each output's location. A piece written
    for a chain reports one summary of everything it wrote, as JSON, for the next
    piece to read; the folder it wrote to is that summary's ``output_uri``.
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    if text.startswith("{"):
        try:
            summary = json.loads(text)
        except Exception:
            return None
        text = summary.get("output_uri") if isinstance(summary, dict) else None
        if not isinstance(text, str):
            return None
    return text if text and len(text) <= _MAX_LOCATION else None


def view(plan_json: dict[str, Any], detail: dict[str, Any]) -> dict[str, Any] | None:
    """Steps and outputs of a flow run, or None when the plan is not a flow.

    ``detail`` is tapis.get_run_detail's answer. A step Tapis has not started yet
    is ``pending``. An output whose step has not reported is given with no value.
    ``value`` is what the step reported; ``location`` is where the output is.
    """
    flow = plan_json.get("flow")
    if not isinstance(flow, dict):
        return None
    tasks = {str(task.get("task_id")): task for task in detail.get("tasks") or [] if isinstance(task, dict)}
    by_number: dict[int, dict[str, Any]] = {}
    reported: dict[int, dict[str, Any]] = {}
    steps = []
    # A flow input that takes a collection is gathered first, by a task of the
    # adapter's own. It is shown as a step, ahead of the flow's, named by its id.
    for collection in flow.get("collections") or []:
        gather_id = str(collection.get("gather"))
        task = tasks.get(gather_id) or {}
        steps.append({
            "step": gather_id,
            "name": f"Gather {collection.get('label')}",
            "task_id": gather_id,
            "depends_on": [],
            "status": _STATUS.get(str(task.get("status") or "").lower(), "pending"),
            "message": task.get("last_message"),
        })
    for step in plan_json.get("steps") or []:
        number = int(step["step"])
        task = tasks.get(task_id(step)) or {}
        by_number[number] = step
        reported[number] = reported_outputs(task.get("stdout"))
        steps.append({
            "step": number,
            "name": step.get("name"),
            "task_id": task_id(step),
            # What it waits for: the gather tasks of the collections it reads, then
            # the steps it follows.
            "depends_on": [*tapis.gather_ids(step), *(step.get("depends_on") or [])],
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
        value = value if isinstance(value, str) and len(value) <= _MAX_VALUE else None
        outputs.append({**declared, "value": value, "location": location(value)})
    return {"configuration_id": flow.get("configuration_id"), "steps": steps, "outputs": outputs}
