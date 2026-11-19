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

from dataclasses import dataclass, field
from typing import Any, Iterable

from .models import DataObjectContract, ReadinessStatus
from .planner import _contract_from_registry, compatibility

MAX_STEPS = 24

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
    for item in declared or []:
        name = item.get("name") if isinstance(item, dict) else item
        if isinstance(name, str) and name:
            names.add(name)
    return names


def _contracts(piece: dict[str, Any], role: str) -> dict[int, dict[str, Any]]:
    found: dict[int, dict[str, Any]] = {}
    for contract in piece.get("contracts") or []:
        if contract.get("role") == role and isinstance(contract.get("position"), int):
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


_TO_SHAPES = (frozenset(), frozenset({"input"}), frozenset({"setting"}))
_FROM_SHAPES = (frozenset({"flow_input"}), frozenset({"flow_parameter"}), frozenset({"step"}),
                frozenset({"step", "output"}), frozenset({"step", "value"}))


def check(
    flow: dict[str, Any],
    *,
    refused_settings: Iterable[str] = (),
) -> Checked:
    """Check a flow against its pieces.

    ``flow`` holds:

    - ``inputs``: ``[{"id": ..., "contract": {...}}]``, the datasets the flow takes;
    - ``parameters``: ``[{"id": ...}]``, flow-level settings a wire may read;
    - ``steps``: ``[{"position", "piece", "settings", "wires"}]`` where ``piece`` is
      the piece's catalog row with its contracts, or ``None`` when it was deleted;
    - ``outputs``: which step outputs are the flow's outputs;
    - ``thread_bindings``: which inputs and parameters the thread's region and
      dates fill in.

    ``refused_settings`` are argument names a flow may neither set nor wire: the
    ones the adapter manages and the ones that carry a secret.
    """
    result = Checked()
    problems = result.problems
    refused = set(refused_settings)

    flow_inputs: dict[str, DataObjectContract] = {}
    for item in flow.get("inputs") or []:
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            flow_inputs[item["id"]] = _addressable(
                _contract_from_registry(item.get("contract") or {}), f"input/{item['id']}")
    flow_parameters = {item["id"] for item in flow.get("parameters") or []
                       if isinstance(item, dict) and isinstance(item.get("id"), str)}

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
        if not isinstance(position, int) or isinstance(position, bool) or not 1 <= position <= MAX_STEPS:
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

        for index, wire in enumerate(step.get("wires") or []):
            to_shape = _one_key((wire or {}).get("to"), _TO_SHAPES) if isinstance(wire, dict) else None
            from_shape = _one_key((wire or {}).get("from"), _FROM_SHAPES) if isinstance(wire, dict) else None
            if to_shape is None or from_shape is None:
                problems.append(Problem("FLOW_WIRE_SHAPE", "this link is not in a known form", position, index))
                continue
            to, source = wire["to"], wire["from"]

            # --- where it comes from -------------------------------------
            # Data when the link carries a dataset; None when it carries a value.
            data: DataObjectContract | None = None
            if "step" in source:
                source_position = source["step"]
                if (not isinstance(source_position, int) or isinstance(source_position, bool)
                        or source_position not in by_position):
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
                if isinstance(to["input"], int):
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
                if name in refused:
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
            elif name in refused:
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

    _check_outputs(flow, by_position, result)
    _check_thread_bindings(flow, flow_inputs, flow_parameters, problems)
    return result


def _check_outputs(flow: dict[str, Any], by_position: dict[int, dict[str, Any]], result: Checked) -> None:
    for index, output in enumerate(flow.get("outputs") or []):
        position = output.get("step") if isinstance(output, dict) else None
        piece = (by_position.get(position) or {}).get("piece") if isinstance(position, int) else None
        kinds = [key for key in ("output", "value", "record") if isinstance(output, dict) and key in output]
        if not isinstance(piece, dict) or len(kinds) != 1:
            result.problems.append(Problem(
                "FLOW_OUTPUT", f"flow output {index} names a step and one of its outputs, values or records"))
            continue
        kind = kinds[0]
        if kind == "output" and output["output"] not in result.outputs.get(position, {}):
            result.problems.append(Problem("FLOW_OUTPUT", f"flow output {index}: the step has no such output", position))
        elif kind == "value" and output["value"] not in piece_values(piece):
            result.problems.append(Problem("FLOW_OUTPUT", f"flow output {index}: the step returns no such value", position))


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
    for role, target in sorted(bindings.items()):
        known = isinstance(target, dict) and (
            (set(target) == {"input"} and target["input"] in flow_inputs)
            or (set(target) == {"parameter"} and target["parameter"] in flow_parameters))
        if role not in _THREAD_ROLES or not known:
            problems.append(Problem(
                "FLOW_THREAD_BINDING",
                f"{role}: a thread binding is one of {', '.join(_THREAD_ROLES)} and names a flow input or parameter"))
