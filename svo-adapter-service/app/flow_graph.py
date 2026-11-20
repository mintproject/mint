"""Check a flow: a graph of ETL pieces stored on a model configuration.

A flow has any number of inputs. Each step runs one piece. A step receives what
its ``wires`` say: an input of the piece from a flow input or from an output of
an earlier step, a setting of the piece from a flow parameter or from a value an
earlier step returned, or nothing at all ("runs after").

Steps are numbered in an order they can run in. A step reads only from steps
with a lower position, so a flow cannot contain a loop.

This module is pure: it is given the flow and the pieces and returns the
problems it finds and the facts the pipeline builder needs. It does not read the
catalog, decide who may run a piece, or build a pipeline.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Iterable

from . import flow_settings, gather_fetch
from .models import DataObjectContract, ReadinessStatus
from .planner import _contract_from_registry, compatibility

MAX_STEPS = 24
MAX_LINKS = 64      # per step, and flow outputs
MAX_INPUTS = 64     # flow inputs, and flow parameters

# A value name becomes a task output id, so it is kept to a plain identifier.
_VALUE_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")


def _is_position(value: Any) -> bool:
    """A whole number, and not a boolean or a float that happens to equal one."""
    return type(value) is int


def _is_name(value: Any) -> bool:
    return isinstance(value, str) and bool(value)

_CONTRACT_FIELDS = ("standard_variable_uri", "unit", "format", "dimensionality",
                    "spatial_type", "crs", "temporal_resolution", "catalog")


@dataclass(frozen=True)
class Problem:
    code: str
    message: str
    step: int | None = None
    wire: int | None = None

    def as_dict(self) -> dict[str, Any]:
        return {key: value for key, value in (
            ("code", self.code), ("message", self.message),
            ("step", self.step), ("wire", self.wire)) if value is not None}


@dataclass
class Checked:
    """What a flow that checked out tells the pipeline builder."""
    problems: list[Problem] = field(default_factory=list)
    # step position -> positions of the steps it must run after
    depends_on: dict[int, list[int]] = field(default_factory=dict)
    # step position -> the data contract of each of its outputs, by output position
    outputs: dict[int, dict[int, DataObjectContract]] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.problems


def piece_inputs(piece: dict[str, Any]) -> dict[int, dict[str, Any]]:
    return _contracts(piece, "input")


def piece_outputs(piece: dict[str, Any]) -> dict[int, dict[str, Any]]:
    return _contracts(piece, "output")


def piece_arguments(piece: dict[str, Any]) -> set[str]:
    """The run arguments a piece declares."""
    return set(((piece.get("parameters_schema_json") or {}).get("properties") or {}))


def piece_values(piece: dict[str, Any]) -> set[str]:
    """Names of the values a piece returns beside its data outputs."""
    declared = piece.get("value_outputs")
    if declared is None:
        declared = (piece.get("parameters_schema_json") or {}).get("value_outputs")
    names: set[str] = set()
    for item in declared if isinstance(declared, list) else []:
        name = item.get("name") if isinstance(item, dict) else item
        if isinstance(name, str) and _VALUE_NAME.match(name):
            names.add(name)
    return names


def _contracts(piece: dict[str, Any], role: str) -> dict[int, dict[str, Any]]:
    found: dict[int, dict[str, Any]] = {}
    for contract in piece.get("contracts") or []:
        if isinstance(contract, dict) and contract.get("role") == role and _is_position(contract.get("position")):
            found[contract["position"]] = contract
    return found


def _through(output: DataObjectContract, base: DataObjectContract | None) -> DataObjectContract:
    """An output as the next piece sees it: what the piece declares it produces,
    over what its first input carried in. Same rule as a planned chain."""
    if base is None:
        return output
    merged = base.model_copy()
    for name in _CONTRACT_FIELDS:
        value = getattr(output, name)
        if value is not None:
            setattr(merged, name, value)
    return merged


def _addressable(contract: DataObjectContract, where: str) -> DataObjectContract:
    """A flow is checked before any data exists. The planner's comparison asks that
    a source can be reached, so every flow input and step output is given a
    stand-in location for the check."""
    if contract.resource_uri:
        return contract
    located = contract.model_copy()
    located.resource_uri = f"flow://{where}"
    return located


def _one_key(value: Any, allowed: Iterable[frozenset[str]]) -> frozenset[str] | None:
    if not isinstance(value, dict):
        return None
    keys = frozenset(value)
    return keys if keys in set(allowed) else None


# What each key of a link must hold. A flow is free-form JSON written by a user,
# so nothing is used as a key or an index before its type is known.
_KEY_TYPES = {
    "input": _is_position, "output": _is_position, "step": _is_position,
    "setting": _is_name, "value": _is_name, "flow_input": _is_name, "flow_parameter": _is_name,
}


def _well_typed(part: dict[str, Any]) -> bool:
    return all(_KEY_TYPES[key](value) for key, value in part.items())


_TO_SHAPES = (frozenset(), frozenset({"input"}), frozenset({"setting"}))
_FROM_SHAPES = (frozenset({"flow_input"}), frozenset({"flow_parameter"}), frozenset({"step"}),
                frozenset({"step", "output"}), frozenset({"step", "value"}))


def check(
    flow: dict[str, Any],
    *,
    refused_settings: Iterable[str] = (),
) -> Checked:
    """Check a flow against its pieces. Never raises: a flow this module cannot
    read is reported as a problem, not as a server error for whoever plans it."""
    try:
        return _check(flow, refused_settings)
    except Exception as error:  # noqa: BLE001 — a flow is user-written JSON
        return Checked(problems=[Problem(
            "FLOW_MALFORMED", f"the flow could not be read: {type(error).__name__}")])


def _check(flow: dict[str, Any], refused_settings: Iterable[str]) -> Checked:
    """Check a flow against its pieces.

    ``flow`` holds:

    - ``inputs``: ``[{"id": ..., "contract": {...}}]``, the datasets the flow takes.
      The contract is a registry-style dict, or a ``DataObjectContract`` when the
      flow is checked against real data;
    - ``parameters``: ``[{"id": ...}]``, flow-level settings a wire may read;
    - ``steps``: ``[{"position", "piece", "settings", "wires"}]`` where ``piece`` is
      the piece's catalog row with its contracts, or ``None`` when it was deleted;
    - ``outputs``: which step outputs are the flow's outputs;
    - ``thread_bindings``: which inputs and parameters the thread's region and
      dates fill in, and ``collections``, the inputs that each take a collection;
    - ``settings``: what the author decided about each setting (see ``flow_settings``).

    ``refused_settings`` are argument names a flow may neither set nor wire: the
    ones the adapter manages and the ones that carry a secret.
    """
    result = Checked()
    problems = result.problems
    wired_by_position: dict[int, set[str]] = {}
    # Compared without regard to case: TAPIS_TOKEN is refused as tapis_token is.
    refused = {str(name).lower() for name in refused_settings}

    for key, limit in (("inputs", MAX_INPUTS), ("parameters", MAX_INPUTS), ("outputs", MAX_LINKS)):
        if len(flow.get(key) or []) > limit:
            problems.append(Problem("FLOW_TOO_LONG", f"a flow has at most {limit} {key}"))
            return result

    flow_inputs: dict[str, DataObjectContract] = {}
    for item in flow.get("inputs") or []:
        if isinstance(item, dict) and _is_name(item.get("id")):
            contract = item.get("contract") or {}
            if not isinstance(contract, (dict, DataObjectContract)):
                problems.append(Problem("FLOW_MALFORMED", f"the contract of flow input {item['id']} is not an object"))
                continue
            flow_inputs[item["id"]] = _addressable(
                contract if isinstance(contract, DataObjectContract) else _contract_from_registry(contract),
                f"input/{item['id']}")
    flow_parameters = {item["id"] for item in flow.get("parameters") or []
                       if isinstance(item, dict) and _is_name(item.get("id"))}

    steps = flow.get("steps") or []
    if not steps:
        problems.append(Problem("FLOW_EMPTY", "a flow needs at least one step"))
        return result
    if len(steps) > MAX_STEPS:
        problems.append(Problem("FLOW_TOO_LONG", f"a flow has at most {MAX_STEPS} steps"))
        return result

    by_position: dict[int, dict[str, Any]] = {}
    for step in steps:
        position = step.get("position")
        if not isinstance(step, dict):
            problems.append(Problem("FLOW_MALFORMED", "a step is an object"))
            continue
        if not _is_position(position) or not 1 <= position <= MAX_STEPS:
            problems.append(Problem("FLOW_STEP_POSITION", f"a step position is a whole number from 1 to {MAX_STEPS}"))
            continue
        if position in by_position:
            problems.append(Problem("FLOW_STEP_POSITION", "two steps share this position", step=position))
            continue
        by_position[position] = step
    if problems:
        return result

    for position in sorted(by_position):
        step = by_position[position]
        piece = step.get("piece")
        if not isinstance(piece, dict):
            problems.append(Problem(
                "FLOW_STEP_EMPTY", "the piece for this step was deleted or is not visible to you", step=position))
            continue

        inputs = piece_inputs(piece)
        arguments = piece_arguments(piece)
        wired_inputs: dict[int, DataObjectContract] = {}
        wired_settings: set[str] = set()
        # Inputs a link aimed at, whether or not it fitted: a link that failed is
        # reported once, not again as an input with nothing linked.
        aimed_inputs: set[int] = set()
        after: set[int] = set()

        wires = step.get("wires") or []
        if not isinstance(wires, list) or len(wires) > MAX_LINKS:
            problems.append(Problem("FLOW_TOO_LONG", f"a step has at most {MAX_LINKS} links", position))
            continue
        for index, wire in enumerate(wires):
            to_shape = _one_key((wire or {}).get("to"), _TO_SHAPES) if isinstance(wire, dict) else None
            from_shape = _one_key((wire or {}).get("from"), _FROM_SHAPES) if isinstance(wire, dict) else None
            if (to_shape is None or from_shape is None
                    or not _well_typed(wire["to"]) or not _well_typed(wire["from"])):
                problems.append(Problem("FLOW_WIRE_SHAPE", "this link is not in a known form", position, index))
                continue
            to, source = wire["to"], wire["from"]

            # --- where it comes from -------------------------------------
            # Data when the link carries a dataset; None when it carries a value.
            data: DataObjectContract | None = None
            if "step" in source:
                source_position = source["step"]
                if source_position not in by_position:
                    problems.append(Problem("FLOW_WIRE_SOURCE", "this link reads from a step that does not exist", position, index))
                    continue
                if source_position >= position:
                    problems.append(Problem(
                        "FLOW_WIRE_FORWARD", "a step may read only from steps before it", position, index))
                    continue
                after.add(source_position)
                source_piece = by_position[source_position].get("piece")
                if not isinstance(source_piece, dict):
                    # Reported once, on the empty step itself.
                    continue
                if "output" in source:
                    data = result.outputs.get(source_position, {}).get(source["output"])
                    if data is None:
                        problems.append(Problem(
                            "FLOW_WIRE_SOURCE", "the earlier step has no such output", position, index))
                        continue
                elif "value" in source:
                    if source["value"] not in piece_values(source_piece):
                        problems.append(Problem(
                            "FLOW_WIRE_SOURCE", "the earlier step returns no such value", position, index))
                        continue
            elif "flow_input" in source:
                data = flow_inputs.get(source["flow_input"])
                if data is None:
                    problems.append(Problem("FLOW_WIRE_SOURCE", "the flow has no such input", position, index))
                    continue
            else:
                if source["flow_parameter"] not in flow_parameters:
                    problems.append(Problem("FLOW_WIRE_SOURCE", "the flow has no such parameter", position, index))
                    continue

            # --- where it goes -------------------------------------------
            if not to:
                if from_shape != frozenset({"step"}):
                    problems.append(Problem(
                        "FLOW_WIRE_SHAPE", "a link that carries nothing names only the step to run after", position, index))
                continue
            if from_shape == frozenset({"step"}):
                problems.append(Problem(
                    "FLOW_WIRE_SHAPE", "a link into an input or a setting names what it carries", position, index))
                continue
            if "input" in to:
                aimed_inputs.add(to["input"])
                target = inputs.get(to["input"])
                if target is None:
                    problems.append(Problem("FLOW_WIRE_TARGET", "the piece has no such input", position, index))
                    continue
                if to["input"] in wired_inputs:
                    problems.append(Problem("FLOW_WIRE_TARGET", "this input is already linked", position, index))
                    continue
                if data is None:
                    problems.append(Problem(
                        "FLOW_WIRE_DOES_NOT_FIT", "an input takes data, not a value", position, index))
                    continue
                readiness = compatibility(data, _contract_from_registry(target))
                if readiness.status != ReadinessStatus.ready:
                    reasons = "; ".join(readiness.missing_requirements) or readiness.status.value
                    problems.append(Problem(
                        "FLOW_WIRE_DOES_NOT_FIT", f"what this link carries does not fit the input: {reasons}",
                        position, index))
                    continue
                wired_inputs[to["input"]] = data
            else:
                name = to["setting"]
                if name not in arguments:
                    problems.append(Problem("FLOW_WIRE_TARGET", f"the piece has no setting named {name}", position, index))
                    continue
                if name.lower() in refused:
                    problems.append(Problem(
                        "FLOW_SETTING_REFUSED", f"{name} is managed by the adapter or carries a secret", position, index))
                    continue
                if name in wired_settings:
                    problems.append(Problem("FLOW_WIRE_TARGET", f"the setting {name} is already linked", position, index))
                    continue
                # A data output may feed a setting too: the piece is handed its location.
                wired_settings.add(name)

        for input_position in sorted(set(inputs) - set(wired_inputs) - aimed_inputs):
            problems.append(Problem(
                "FLOW_INPUT_UNWIRED", f"input {input_position} of this piece is not linked to anything", position))

        settings = step.get("settings") or {}
        if not isinstance(settings, dict):
            problems.append(Problem("FLOW_SETTING_REFUSED", "a step's settings are an object of names and values", position))
            settings = {}
        for name in sorted(settings):
            if name not in arguments:
                problems.append(Problem("FLOW_SETTING_REFUSED", f"the piece has no setting named {name}", position))
            elif str(name).lower() in refused:
                problems.append(Problem(
                    "FLOW_SETTING_REFUSED", f"{name} is managed by the adapter or carries a secret", position))
            elif name in wired_settings:
                problems.append(Problem(
                    "FLOW_SETTING_REFUSED", f"{name} is linked to an earlier step and cannot also have a default", position))

        base = wired_inputs[min(wired_inputs)] if wired_inputs else None
        result.outputs[position] = {
            output_position: _addressable(
                _through(_contract_from_registry(contract), base), f"step/{position}/{output_position}")
            for output_position, contract in piece_outputs(piece).items()
        }
        result.depends_on[position] = sorted(after)
        wired_by_position[position] = wired_settings

    _check_settings(flow, by_position, wired_by_position, problems, refused)
    _check_outputs(flow, by_position, result)
    _check_pause(flow, by_position, result)
    _check_thread_bindings(flow, flow_inputs, flow_parameters, problems)
    return result


def _check_settings(
    flow: dict[str, Any],
    by_position: dict[int, dict[str, Any]],
    wired_by_position: dict[int, set[str]],
    problems: list[Problem],
    refused: set[str],
) -> None:
    """The author's decisions about settings, and what the pieces say about them.

    - a setting may not be described two ways by the pieces that share its name;
    - no credential-like setting may have a value, since a flow's settings are readable
      even when hidden;
    - decisions must name settings of the flow's pieces;
    - a setting that is hidden or fixed must still have a value to run on, and must not
      be one the thread fills in (a runner cannot change what a thread fills in either).
    """
    rules = flow.get("settings")
    pieces = {position: step["piece"] for position, step in by_position.items()
              if isinstance(step.get("piece"), dict)}

    seen: dict[str, tuple[int, tuple[Any, ...]]] = {}
    for position in sorted(pieces):
        properties = (pieces[position].get("parameters_schema_json") or {}).get("properties") or {}
        for name in sorted(properties):
            key = flow_settings.description_key(properties[name])
            first = seen.setdefault(name, (position, key))
            if first[1] != key:
                problems.append(Problem(
                    "FLOW_SETTING_CONFLICT",
                    f"{name} has different choices or limits in step {first[0]} and step {position}, "
                    "but a setting with one name is one setting of the flow", position))
    for position in sorted(by_position):
        values = by_position[position].get("settings")
        for name in sorted(values if isinstance(values, dict) else {}, key=str):
            if flow_settings.looks_secret(name) and str(name).lower() not in refused:
                problems.append(Problem(
                    "FLOW_SETTING_LOOKS_SECRET",
                    f"{name} looks like a credential. A flow's settings can be read by anyone who can "
                    "read the flow, even a hidden one: use a stored credential the piece declares instead",
                    position))

    known = {name for piece in pieces.values() for name in piece_arguments(piece)}
    shape = flow_settings.rules_problems(rules, known)
    for message in shape:
        problems.append(Problem("FLOW_SETTING_INVALID", message))
    if shape or not rules:
        return
    given = {name for step in by_position.values() if isinstance(step.get("settings"), dict)
             for name in step["settings"]}
    for position in sorted(pieces):
        wired = wired_by_position.get(position, set())
        for name in flow_settings.hidden_without_value(rules, pieces[position], given, wired):
            problems.append(Problem(
                "FLOW_SETTING_HIDDEN_WITHOUT_VALUE",
                f"The setting {name} (step {position}) is hidden from the runner, but the piece needs it "
                "and nothing gives it a value: set a value or a default, or show it", position))
    thread_bound = flow_settings.comparable(
        [*flow_settings.thread_bound_names(flow.get("thread_bindings")),
         *(n for n in flow.get("thread_settings") or [] if isinstance(n, str))])
    for name in sorted(n for n in rules if flow_settings.is_fixed(rules, n)):
        has_value = name in given or any(
            flow_settings.piece_default(piece, name) is not None for piece in pieces.values())
        if not has_value:
            problems.append(Problem(
                "FLOW_SETTING_FIXED_WITHOUT_VALUE", f"{name} is fixed but has no value to fix it to"))
    for name in sorted(rules):
        if ((flow_settings.is_fixed(rules, name) or flow_settings.visibility_of(rules, name) == "hidden")
                and flow_settings.comparable([name]) & thread_bound):
            problems.append(Problem(
                "FLOW_THREAD_BINDING_FIXED",
                f"{name} is filled in by the thread (a date), so it cannot also be fixed or hidden"))


def _check_outputs(flow: dict[str, Any], by_position: dict[int, dict[str, Any]], result: Checked) -> None:
    for index, output in enumerate(flow.get("outputs") or []):
        position = output.get("step") if isinstance(output, dict) else None
        piece = (by_position.get(position) or {}).get("piece") if _is_position(position) else None
        kinds = [key for key in ("output", "value", "record") if isinstance(output, dict) and key in output]
        typed = len(kinds) == 1 and (_is_position(output[kinds[0]]) if kinds[0] == "output"
                                     else _is_name(output[kinds[0]]))
        if not isinstance(piece, dict) or not typed:
            result.problems.append(Problem(
                "FLOW_OUTPUT", f"flow output {index} names a step and one of its outputs, values or records"))
            continue
        kind = kinds[0]
        if kind == "output" and output["output"] not in result.outputs.get(position, {}):
            result.problems.append(Problem("FLOW_OUTPUT", f"flow output {index}: the step has no such output", position))
        elif kind == "value" and output["value"] not in piece_values(piece):
            result.problems.append(Problem("FLOW_OUTPUT", f"flow output {index}: the step returns no such value", position))


_EDIT_KEY = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def editable_problem(spec: Any) -> str | None:
    """Why ``editable`` on a flow output is malformed, or None. It names the file the
    person edits (``file``, a plain name), may name a check the edited file must pass
    (``check``) and the key of the step's reported summary that names the file
    (``key``)."""
    if not isinstance(spec, dict) or set(spec) - {"file", "check", "key"}:
        return "editable is an object with a file, and optionally a check and a key"
    name = spec.get("file")
    if (not isinstance(name, str) or not name or "/" in name or "\\" in name or name.startswith(".")
            or len(name) > gather_fetch.MAX_NAME):
        return "editable.file must be a plain file name"
    if spec.get("check") not in (None, "", *gather_fetch.EDIT_CHECKS):
        return f"editable.check must be one of {', '.join(gather_fetch.EDIT_CHECKS)}"
    if spec.get("key") is not None and not (isinstance(spec["key"], str) and _EDIT_KEY.match(spec["key"])):
        return "editable.key must be a lower-case name such as lexicon_uri"
    return None


def _check_pause(flow: dict[str, Any], by_position: dict[int, dict[str, Any]], result: Checked) -> None:
    """A flow may stop after a step for the person to edit one of its files. The
    first cut: one pause, one editable file output on the paused step, and a later
    step that reads it."""
    problems = result.problems
    pauses = sorted(position for position, step in by_position.items() if step.get("pause_after") is True)
    outputs = [o for o in flow.get("outputs") or [] if isinstance(o, dict) and "editable" in o]
    for output in outputs:
        why = editable_problem(output["editable"])
        if why:
            problems.append(Problem("FLOW_PAUSE", why, output.get("step") if _is_position(output.get("step")) else None))
    if not pauses:
        if outputs:
            problems.append(Problem("FLOW_PAUSE", "an output is marked editable but no step pauses"))
        return
    if len(pauses) > 1:
        problems.append(Problem("FLOW_PAUSE", "a flow may pause only once", pauses[1]))
        return
    pause = pauses[0]
    here = [o for o in outputs if o.get("step") == pause and "output" in o]
    if len(here) != 1 or len(outputs) != 1:
        problems.append(Problem(
            "FLOW_PAUSE", "a paused step needs exactly one file output marked editable, naming the file to edit; "
                          "no other output may be editable", pause))
        return
    ancestors: set[int] = set()
    todo = [pause]
    while todo:
        number = todo.pop()
        if number not in ancestors:
            ancestors.add(number)
            todo.extend(result.depends_on.get(number, []))
    later = [position for position in by_position if position not in ancestors]
    if not later:
        problems.append(Problem("FLOW_PAUSE", "no step runs after the pause", pause))
        return
    reads = any(
        isinstance(wire, dict) and (wire.get("from") or {}).get("step") == pause
        and (wire.get("from") or {}).get("output") == here[0]["output"]
        for position in later for wire in by_position[position].get("wires") or [])
    if not reads:
        problems.append(Problem("FLOW_PAUSE", "no step after the pause reads the editable output", pause))


_THREAD_ROLES = ("region", "start_date", "end_date")


def _check_thread_bindings(
    flow: dict[str, Any],
    flow_inputs: dict[str, DataObjectContract],
    flow_parameters: set[str],
    problems: list[Problem],
) -> None:
    bindings = flow.get("thread_bindings") or {}
    if not isinstance(bindings, dict):
        problems.append(Problem("FLOW_THREAD_BINDING", "thread bindings are an object"))
        return
    # Not a role: the flow inputs that each take a collection of files.
    collections = bindings.get("collections", [])
    if not (isinstance(collections, list) and len(set(map(str, collections))) == len(collections)
            and all(_is_name(item) and item in flow_inputs for item in collections)):
        problems.append(Problem(
            "FLOW_THREAD_BINDING", "collections: a list of the flow's inputs, each named once"))
    for role, target in sorted((r, t) for r, t in bindings.items() if r != "collections"):
        known = isinstance(target, dict) and (
            (set(target) == {"input"} and _is_name(target["input"]) and target["input"] in flow_inputs)
            or (set(target) == {"parameter"} and _is_name(target["parameter"])
                and target["parameter"] in flow_parameters))
        if role not in _THREAD_ROLES or not known:
            problems.append(Problem(
                "FLOW_THREAD_BINDING",
                f"{role}: a thread binding is one of {', '.join(_THREAD_ROLES)} and names a flow input or parameter"))
