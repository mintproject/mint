"""A flow that stops for the user's edit, run as segments.

Design: docs/design/2026-11-20-flow-pause-for-edit.md.

A pipeline cannot take a human's input, and one that waited would hold a Tapis run
open for as long as a person takes. So a flow with a pause runs as two pipelines.
Segment 1 is the paused step and the steps it reads from; it ends, and no Tapis run
exists while the person edits. Segment 2 is every other step, submitted when the
person resumes, under a token minted for them then.

A link cannot point at a task of another pipeline, so the links segment 2 has into
segment 1 are rewritten here:

* a link to something segment 1 reported becomes a pipeline argument, named by
  :func:`resume_arg`, that the resume fills from what that task printed;
* a link to the paused step's editable output becomes a link to a gather task of
  its own (``gather-edit``) that fetches the edited file, checks it, and stores it
  in the run's folder. When the step reported a summary (a JSON object that names
  the file under the editable's ``key``), that task also hands on the summary with
  the key pointing at the edited file, so every later step finds the edit.

Everything here is pure: plans in, plans out. The routes that submit them are in
``main.py``.
"""
from __future__ import annotations

import copy
import json
import re
from typing import Any

from . import flow_graph, flow_run, gather_fetch, run_tokens, tapis
from .config import settings

EDIT_GATHER_ID = flow_run.EDIT_GATHER_ID
# The pipeline argument that carries the edited file's address into segment 2.
EDIT_URL_ARG = "resume_edit_url"
RESERVED_PREFIX = "resume_"
_UNSAFE = re.compile(r"[^A-Za-z0-9_]+")

CODE_UNSUPPORTED = "FLOW_PAUSE_UNSUPPORTED"
CODE_INVALID = "FLOW_PAUSE_INVALID"


def paused_steps(plan_json: dict[str, Any]) -> list[int]:
    flow = plan_json.get("flow") if isinstance(plan_json.get("flow"), dict) else {}
    return [int(step) for step in flow.get("pause_after") or [] if type(step) is int]


def output_key(declared: dict[str, Any]) -> str:
    """How a resume names an editable output: ``<step>:<output position>``."""
    return f"{declared['step']}:{declared['output']}"


def editable_outputs(plan_json: dict[str, Any]) -> list[dict[str, Any]]:
    flow = plan_json.get("flow") if isinstance(plan_json.get("flow"), dict) else {}
    return [declared for declared in flow.get("outputs") or []
            if isinstance(declared, dict) and isinstance(declared.get("editable"), dict)]


def pause_of(plan_json: dict[str, Any]) -> int | None:
    pauses = paused_steps(plan_json)
    return pauses[0] if len(pauses) == 1 else None


def problem(plan_json: dict[str, Any]) -> dict[str, str] | None:
    """Why this plan's pause cannot be run, as ``{code, message}``, or None.

    The first cut: one pause per run, one editable file per pause, a data output
    that a later step reads.
    """
    pauses = paused_steps(plan_json)
    if not pauses:
        return None
    if len(pauses) > 1:
        return {"code": CODE_UNSUPPORTED, "message": "a flow may pause only once in a run"}
    pause = pauses[0]
    steps = {int(step["step"]): step for step in plan_json.get("steps") or []}
    if pause not in steps:
        return {"code": CODE_INVALID, "message": f"the flow pauses after step {pause}, which it does not have"}
    editable = editable_outputs(plan_json)
    elsewhere = [declared for declared in editable if declared.get("step") != pause]
    if elsewhere:
        return {"code": CODE_INVALID,
                "message": "only an output of the step the flow pauses after may be marked editable"}
    here = [declared for declared in editable if declared.get("step") == pause]
    if len(here) != 1:
        return {"code": CODE_INVALID,
                "message": "a paused step needs exactly one output marked editable, naming the file to edit"}
    declared = here[0]
    spec = declared["editable"]
    if "output" not in declared:
        return {"code": CODE_INVALID, "message": "the editable output must be a file output, not a value"}
    why = flow_graph.editable_problem(spec)
    if why:
        return {"code": CODE_INVALID, "message": why}
    if not set(steps) - first_positions(plan_json, pause):
        return {"code": CODE_INVALID, "message": "no step runs after the pause"}
    reads = [wire for step in steps.values() if int(step["step"]) not in first_positions(plan_json, pause)
             for wire in step.get("wires") or []
             if (wire.get("from") or {}).get("step") == pause
             and str((wire.get("from") or {}).get("output")) == str(declared["output"])]
    if not reads:
        return {"code": CODE_INVALID, "message": "no step after the pause reads the editable output"}
    return None


def first_positions(plan_json: dict[str, Any], pause: int) -> set[int]:
    """The paused step and every step it follows, however far back."""
    depends = {int(step["step"]): [int(dep) for dep in step.get("depends_on") or []]
               for step in plan_json.get("steps") or []}
    found: set[int] = set()
    todo = [pause]
    while todo:
        number = todo.pop()
        if number in found or number not in depends:
            continue
        found.add(number)
        todo.extend(depends[number])
    return found


def _gathers_read(steps: list[dict[str, Any]]) -> set[str]:
    return {gather for step in steps for gather in tapis.gather_ids(step)}


def _flow(plan_json: dict[str, Any], **over: Any) -> dict[str, Any]:
    return {**(plan_json.get("flow") if isinstance(plan_json.get("flow"), dict) else {}), **over}


def first_segment(plan_json: dict[str, Any], pause: int) -> dict[str, Any]:
    """The plan of segment 1: the steps up to and including the paused one, and the
    gather tasks they read."""
    keep = first_positions(plan_json, pause)
    steps = [copy.deepcopy(step) for step in plan_json.get("steps") or [] if int(step["step"]) in keep]
    read = _gathers_read(steps)
    collections = [collection for collection in (plan_json.get("flow") or {}).get("collections") or []
                   if collection.get("gather") in read]
    return {**plan_json, "steps": steps, "flow": _flow(plan_json, collections=collections)}


def resume_arg(source: dict[str, Any]) -> str:
    """The pipeline argument a link to an earlier segment becomes. Named for what it
    carries, so the same source is one argument however many steps read it."""
    if "gather" in source:
        return "resume_" + _UNSAFE.sub("_", str(source["gather"]))
    kind = "value" if "value" in source else "output"
    return f"resume_step{int(source['step'])}_{kind}_{_UNSAFE.sub('_', str(source[kind]))}"


def second_segment(
    plan_json: dict[str, Any], pause: int, *, merge_key: str | None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """The plan of segment 2, and what must be filled in when it is submitted.

    The edited file's address is not part of the plan: the gather task reads it from
    the pipeline argument ``EDIT_URL_ARG``, which the resume fills.
    ``merge_key`` is the summary key to point at the edit, or None when the paused
    step reported a plain location (then the later steps are handed the edit itself).
    Returns ``(plan, needed)``: each ``needed`` item is ``{arg, kind, ...}`` naming a
    pipeline argument the resume must give, and where in segment 1 it comes from.
    """
    first = first_positions(plan_json, pause)
    all_steps = [step for step in plan_json.get("steps") or []]
    steps_by_number = {int(step["step"]): step for step in all_steps}
    first_gathers = _gathers_read([step for step in all_steps if int(step["step"]) in first])
    declared = next(d for d in editable_outputs(plan_json) if d.get("step") == pause)
    spec = declared["editable"]
    position = str(declared["output"])
    needed: dict[str, dict[str, Any]] = {}

    def need(source: dict[str, Any]) -> str:
        name = resume_arg(source)
        if "gather" in source:
            item = {"arg": name, "kind": "gather", "gather": str(source["gather"])}
        else:
            number = int(source["step"])
            ids = tapis.flow_output_ids(steps_by_number[number]) or {"outputs": {}, "values": {}}
            output_id = (ids["values"].get(str(source["value"])) if "value" in source
                         else ids["outputs"].get(str(source["output"])))
            if output_id is None:
                raise ValueError(f"step {number} has no output {source.get('value', source.get('output'))}")
            item = {"arg": name, "kind": "step", "step": number, "output_id": output_id}
        needed[name] = item
        return name

    carried_arg = need({"step": pause, "output": position}) if merge_key else None
    steps: list[dict[str, Any]] = []
    for step in all_steps:
        if int(step["step"]) in first:
            continue
        later = copy.deepcopy(step)
        later["depends_on"] = [dep for dep in (step.get("depends_on") or []) if int(dep) not in first]
        wires = []
        for wire in step.get("wires") or []:
            source = wire.get("from") or {}
            if "step" in source and int(source["step"]) in first:
                if int(source["step"]) == pause and str(source.get("output")) == position:
                    # The paused step's editable output: the edited file.
                    source = {"gather": EDIT_GATHER_ID, "gather_output": "carried" if merge_key else "result"}
                else:
                    source = {"resume": need(source)}
            elif source.get("gather") in first_gathers:
                source = {"resume": need(source)}
            wires.append({**wire, "from": source})
        later["wires"] = wires
        steps.append(later)

    collections = [copy.deepcopy(collection) for collection in (plan_json.get("flow") or {}).get("collections") or []
                   if collection.get("gather") not in first_gathers and collection.get("gather") in _gathers_read(steps)]
    collections.append({
        "input": "edit", "label": f"Edited {spec['file']}", "gather": EDIT_GATHER_ID, "single": True,
        "resources": [], "url_arg": EDIT_URL_ARG,
        "max_bytes": int(settings.flow_edit_max_bytes),
        "check": spec.get("check") or "",
        **({"merge": {"key": merge_key, "carried_arg": carried_arg}} if merge_key else {}),
    })
    parameters = list(plan_json.get("parameters") or [])
    known = {parameter.get("name") for parameter in parameters}
    parameters.extend({"name": name, "type": "string", "required": True, "managed": True,
                       "managed_source": "resume",
                       "description": "What an earlier segment of this run reported; set when the run resumes"}
                      for name in [*needed, EDIT_URL_ARG] if name not in known)
    plan = {**plan_json, "steps": steps, "parameters": parameters, "flow": _flow(plan_json, collections=collections)}
    return plan, list(needed.values())


def segment_pipeline_id(plan_id: str, number: int) -> str:
    """Each segment is its own registered pipeline, so a later registration cannot
    replace one that is still running."""
    return f"{plan_id}-seg{number}"


def summary_of(value: Any) -> dict[str, Any] | None:
    """The JSON object a step reported as its value, or None."""
    if not isinstance(value, str):
        return None
    try:
        summary = json.loads(value)
    except (TypeError, ValueError):
        return None
    return summary if isinstance(summary, dict) else None


def merge_key_for(plan_json: dict[str, Any], pause: int, reported: Any) -> str | None:
    """The summary key to point at the edit: only when the paused step reported a
    summary that names the file under the editable's ``key``."""
    declared = next((d for d in editable_outputs(plan_json) if d.get("step") == pause), None)
    key = (declared or {}).get("editable", {}).get("key")
    summary = summary_of(reported)
    return key if key and summary is not None and isinstance(summary.get(key), str) else None


def resume_values(
    plan_json: dict[str, Any], needed: list[dict[str, Any]], detail: dict[str, Any],
) -> tuple[dict[str, str], list[str]]:
    """Fill each needed argument from what segment 1's tasks printed.

    ``detail`` is segment 1's run detail. Returns ``(values, missing)``: ``missing``
    names the arguments whose task reported nothing usable (a value over the report
    limit is lost, as it is in the flow view).
    """
    tasks = {str(task.get("task_id")): task for task in detail.get("tasks") or [] if isinstance(task, dict)}
    steps = {int(step["step"]): step for step in plan_json.get("steps") or []}
    values: dict[str, str] = {}
    missing: list[str] = []
    for item in needed:
        if item["kind"] == "gather":
            reported = flow_run.reported_outputs((tasks.get(item["gather"]) or {}).get("stdout")).get("result")
        else:
            task = tasks.get(flow_run.task_id(steps[item["step"]])) or {}
            reported = flow_run.reported_outputs(task.get("stdout")).get(item["output_id"])
        if isinstance(reported, str) and reported and len(reported) <= flow_run.MAX_VALUE:
            values[item["arg"]] = reported
        else:
            missing.append(item["arg"])
    return values, missing


def merged_detail(*details: dict[str, Any]) -> dict[str, Any]:
    """One run detail made of several segments' task lists, for the flow view."""
    tasks = [task for detail in details for task in (detail or {}).get("tasks") or []]
    return {**(details[-1] if details else {}), "tasks": tasks}


def reserved_parameters(plan_json: dict[str, Any]) -> list[str]:
    """User-facing parameters whose names the resume uses for its own arguments."""
    return sorted(str(p.get("name")) for p in plan_json.get("parameters") or []
                  if str(p.get("name") or "").startswith(RESERVED_PREFIX))


def refused_values(values: dict[str, str], needed: list[dict[str, Any]]) -> list[str]:
    """Names of replayed values that must not be passed on. What segment 1 printed is
    data from a piece, so each is checked before it becomes an argument: nothing that
    looks like a credential, and every location it names must be one the gather rules
    allow (an https or tapis:// address with no user name, fragment or control
    character). A summary is checked key by key; a plain data output is a location;
    a named value (``value_*``) is free text and is only checked for a credential."""
    free_text = {item["arg"] for item in needed if str(item.get("output_id", "")).startswith("value_")}
    bad: list[str] = []
    for name, value in values.items():
        summary = summary_of(value)
        locations = ([v for k, v in summary.items()
                      if isinstance(v, str) and (str(k).endswith("_uri") or "://" in v)]
                     if summary is not None else [] if name in free_text else [value])
        try:
            ok = not run_tokens.looks_like_secret(value) and all(
                gather_fetch.check_url(item) for item in locations)
        except ValueError:
            ok = False
        if not ok:
            bad.append(name)
    return sorted(bad)
