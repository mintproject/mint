"""Propose what fits in a flow, exactly, from the pieces' declared contracts.

Pure, like ``flow_graph``: it is given the flow as far as it is built and the pieces
the caller may see, and answers one question about it. Nothing is read or stored.

"Exact" means the fit rule the flow check itself uses, ``planner.compatibility``
being ``ready``. A proposal that the check would refuse cannot appear. There is no
ranking: the order is the length of the chain, then the piece id.

Three questions, set by ``purpose``:

- ``{"step": n, "input": k}``: what can feed input ``k`` of step ``n``: the flow
  inputs and the outputs of earlier steps that fit, else the shortest chains of
  single-input pieces that carry one of them to a fit;
- ``{"step": n, "output": j}``: the pieces that can take output ``j`` of step ``n``;
- ``{"contract": {...}}``: the pieces that produce a wanted result, and what each
  of their inputs still needs.

The search is bounded: chains are at most ``MAX_CHAIN`` pieces, the whole request
tries at most ``MAX_EXPANSIONS`` pieces against a state, and at most
``MAX_RESULTS`` of each list come back. When a bound stopped the search the answer
says so (``cut``).

Providers. An input nothing in the flow or the pieces can meet may still be provided
by something that is not a piece: a model configuration that declares an output
fitting it ("run model X first") or a data object the caller may use whose contract
fits it ("use dataset Y as a flow input"). Each unmet need carries
``providers: {"models": [...], "datasets": [...]}``, found with the same ``_fits``
rule and bounded the same way. Providers are suggestions only: a model is not a flow
step today, so a provider never makes a need ``met`` or a piece ``complete``. The
candidates are given by the caller, who has already limited them to what the user
may see; this module reads nothing.
"""
from __future__ import annotations

from typing import Any

from . import flow_graph
from .models import DataObjectContract, ReadinessStatus
from .planner import _apply_transform, _contract_from_registry, _transform_accepts, compatibility

MAX_CHAIN = 3
MAX_EXPANSIONS = 2000
MAX_RESULTS = 20
MAX_CANDIDATES = 1000  # models, and datasets, looked at per request

# A contract left blank on these is a wildcard for the fit rule, so it offers too much.
_WILDCARD_FIELDS = ("standard_variable_uri", "format")


class ProposeError(ValueError):
    """The request cannot be answered: a malformed purpose or one that names
    something the flow does not have."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class _Budget:
    """How many pieces the request may still try against a state."""

    def __init__(self, expansions: int) -> None:
        self.left = expansions
        self.exhausted = False

    def take(self) -> bool:
        if self.left <= 0:
            self.exhausted = True
            return False
        self.left -= 1
        return True


_NO_PROVIDERS = {"models": [], "datasets": []}


def humanize_variable(uri: str | None) -> str:
    """A standard variable's machine name as a readable label, by the
    ``object__quantity`` grammar: ``groundwater__hydraulic_head`` becomes
    ``Groundwater — hydraulic head``."""
    name = (uri or "").rsplit("/", 1)[-1]
    obj, sep, qty = name.partition("__")
    obj = obj.replace("_", " ").strip()
    qty = qty.replace("_", " ").strip()
    if sep and obj and qty:
        return f"{obj[:1].upper()}{obj[1:]} — {qty}"
    return (qty or obj or name).replace("_", " ").capitalize()


def _output_label(contract: dict[str, Any]) -> str | None:
    """What a model's output is called: the label synced from the catalog (the
    presentation's, else the dataset specification's), else its variable's label.
    None when it names neither; the form then falls back to the format."""
    label = (contract.get("metadata_json") or {}).get("label")
    if isinstance(label, str) and label.strip():
        return label.strip()
    uri = contract.get("standard_variable_uri")
    return humanize_variable(uri) if uri else None


def _is_uri(text: str) -> bool:
    return "://" in text or text.startswith("urn:")


def dataset_name(row: dict[str, Any]) -> str:
    """A name a person can read for a data object. Rows synced from CKAN take the
    resource's name as their label, and that is sometimes the variable's URI (or
    blank); such a label is not a name. Falls back to the description (the CKAN
    resource description, else its dataset title), the file name in the location,
    the CKAN dataset the row came from, and last the id."""
    label = str(row.get("label") or "").strip()
    if label and not _is_uri(label):
        return label
    description = str(row.get("description") or "").strip()
    if description and not _is_uri(description):
        return description if len(description) <= 120 else description[:117] + "..."
    location = str(row.get("resource_uri") or "").split("?", 1)[0].rstrip("/")
    leaf = location.rsplit("/", 1)[-1] if _is_uri(location) else ""
    if leaf and not _is_uri(leaf):
        return leaf
    catalog = str(row.get("source_catalog") or "")
    if catalog.startswith("ckan:") and catalog[5:]:
        return catalog[5:].replace("_", " ").replace("-", " ")
    return str(row.get("data_object_id") or row.get("id") or "")

Source = tuple[dict[str, Any], DataObjectContract]


def _fits(source: DataObjectContract, target: DataObjectContract) -> bool:
    return compatibility(source, target).status == ReadinessStatus.ready


def _state_key(state: DataObjectContract) -> tuple:
    return (state.standard_variable_uri, state.unit, state.format,
            state.spatial_type, state.crs, state.temporal_resolution, state.catalog)


def _sources(flow: dict[str, Any], checked: flow_graph.Checked, before: int | None) -> list[Source]:
    """Every flow input, then every output of a step below ``before`` (all steps
    when it is None), each as the next step would see it."""
    found: list[Source] = []
    for item in flow.get("inputs") or []:
        if not (isinstance(item, dict) and flow_graph._is_name(item.get("id"))):
            continue
        contract = item.get("contract") or {}
        if not isinstance(contract, (dict, DataObjectContract)):
            continue
        contract = contract if isinstance(contract, DataObjectContract) else _contract_from_registry(contract)
        found.append(({"kind": "flow_input", "id": item["id"]},
                      flow_graph._addressable(contract, f"input/{item['id']}")))
    for position in sorted(checked.outputs):
        if before is not None and position >= before:
            continue
        for output in sorted(checked.outputs[position]):
            found.append(({"kind": "step_output", "step": position, "output": output},
                          checked.outputs[position][output]))
    return found


def _wire_from(ref: dict[str, Any]) -> dict[str, Any]:
    if ref["kind"] == "flow_input":
        return {"flow_input": ref["id"]}
    return {"step": ref["step"], "output": ref["output"]}


class _Context:
    def __init__(self, pieces: dict[str, dict[str, Any]], approvals: dict[str, str | None],
                 budget: _Budget, max_chain: int, max_results: int,
                 models: list[dict[str, Any]] | None = None,
                 datasets: list[dict[str, Any]] | None = None) -> None:
        self.pieces = pieces
        self.cut = len(models or []) > MAX_CANDIDATES or len(datasets or []) > MAX_CANDIDATES
        self.models = _candidates(models, "configuration_id")
        self.datasets = _candidates(datasets, "data_object_id")
        self.approvals = approvals
        self.budget = budget
        self.max_chain = max_chain
        self.max_results = max_results
        self.warnings: dict[tuple[str, int], dict[str, Any]] = {}
        # Pieces a chain may use: one input in, a first output out (the rule of
        # planner._apply_transform), in a stable order.
        self.singles = [piece for _, piece in sorted(pieces.items())
                        if len(flow_graph.piece_inputs(piece)) == 1 and flow_graph.piece_outputs(piece)]

    def label(self, piece_id: str) -> str | None:
        piece = self.pieces.get(piece_id) or {}
        return piece.get("label")

    def piece_ref(self, piece_id: str) -> dict[str, Any]:
        return {"piece": piece_id, "label": self.label(piece_id), "approval": self.approvals.get(piece_id)}

    def warn_blank(self, piece_id: str, position: int, contract: dict[str, Any]) -> None:
        fields = [name for name in _WILDCARD_FIELDS if not contract.get(name)]
        if fields:
            self.warnings.setdefault((piece_id, position), {
                "code": "BLANK_CONTRACT", "piece": piece_id, "input": position, "fields": fields})

    def trim(self, items: list[Any]) -> list[Any]:
        if len(items) > self.max_results:
            self.cut = True
        return items[:self.max_results]


def _candidates(items: list[dict[str, Any]] | None, key: str) -> list[dict[str, Any]]:
    """The first ``MAX_CANDIDATES`` of ``items`` in a stable order (by ``key``)."""
    usable = [item for item in items or [] if isinstance(item, dict) and item.get(key)]
    return sorted(usable, key=lambda item: str(item[key]))[:MAX_CANDIDATES]


def _providers(ctx: _Context, contract: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Models and datasets whose declared contract fits ``contract`` exactly. These
    do not make a need met (see the module docstring)."""
    target = _contract_from_registry(contract)
    models: list[dict[str, Any]] = []
    for model in ctx.models:
        for position, out in sorted((model.get("outputs") or {}).items()):
            made = flow_graph._addressable(_contract_from_registry(out), f"model/{model['configuration_id']}/{position}")
            if _fits(made, target):
                models.append({"configuration_id": model["configuration_id"], "label": model.get("label"),
                               "output": position, "format": out.get("format"),
                               "variable": out.get("standard_variable_uri"),
                               "output_label": _output_label(out)})
    datasets: list[dict[str, Any]] = []
    for dataset in ctx.datasets:
        if any(_fits(have, target) for have in dataset.get("contracts") or []):
            datasets.append({"data_object_id": dataset["data_object_id"], "label": dataset.get("label"),
                             "name": dataset_name(dataset), "url": dataset.get("resource_uri"),
                             "format": dataset.get("format")})
    return {"models": ctx.trim(models), "datasets": ctx.trim(datasets)}


def _direct(ctx: _Context, sources: list[Source], piece_id: str, position: int,
            contract: dict[str, Any]) -> list[dict[str, Any]]:
    target = _contract_from_registry(contract)
    found = [{"source": ref, "fits": True, "wire": {"to": {"input": position}, "from": _wire_from(ref)}}
             for ref, state in sources if _fits(state, target)]
    if found:
        ctx.warn_blank(piece_id, position, contract)
    return ctx.trim(found)


def _chains(ctx: _Context, sources: list[Source], contract: dict[str, Any]) -> list[dict[str, Any]]:
    """The shortest chains of single-input pieces that carry one of ``sources`` to
    a fit for ``contract``. Breadth first, so every chain of the first length that
    has any is found, and none longer. Reuses ``planner._transform_accepts`` and
    ``_apply_transform`` for each step; ``find_path`` itself returns one chain and
    cannot be given a budget, so the loop is here."""
    target = _contract_from_registry(contract)
    found: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    seen: set[tuple] = set()
    frontier: list[tuple[DataObjectContract, list[dict[str, Any]], dict[str, Any]]] = [
        (state, [], ref) for ref, state in sources]
    for depth in range(1, ctx.max_chain + 1):
        grown: list[tuple[DataObjectContract, list[dict[str, Any]], dict[str, Any]]] = []
        for state, chain, ref in frontier:
            used = {piece["id"] for piece in chain}
            for piece in ctx.singles:
                if piece["id"] in used:
                    continue
                if not ctx.budget.take():
                    ctx.cut = True
                    break
                if not _transform_accepts(piece, state):
                    continue
                reached = _apply_transform(piece, state)
                longer = chain + [piece]
                if _fits(reached, target):
                    found.append((ref, longer))
                elif depth < ctx.max_chain and _state_key(reached) not in seen:
                    seen.add(_state_key(reached))
                    grown.append((reached, longer, ref))
            if ctx.budget.exhausted:
                break
        if found or ctx.budget.exhausted:
            break
        frontier = grown

    found.sort(key=lambda item: (len(item[1]), [piece["id"] for piece in item[1]]))
    out = []
    for ref, chain in ctx.trim(found):
        steps = []
        for piece in chain:
            position = min(flow_graph.piece_inputs(piece))
            ctx.warn_blank(piece["id"], position, flow_graph.piece_inputs(piece)[position])
            steps.append({**ctx.piece_ref(piece["id"]), "position": position,
                          "output": min(flow_graph.piece_outputs(piece))})
        out.append({"from": ref, "pieces": steps, "length": len(chain),
                    "lossy": any(piece.get("lossy") for piece in chain)})
    return out


def _find_step(flow: dict[str, Any], position: Any) -> dict[str, Any]:
    for step in flow.get("steps") or []:
        if isinstance(step, dict) and flow_graph._is_position(position) and step.get("position") == position:
            if isinstance(step.get("piece"), dict):
                return step
            raise ProposeError("FLOW_PROPOSE_STEP", f"step {position} has no piece you can see")
    raise ProposeError("FLOW_PROPOSE_STEP", "the flow has no such step")


def propose(
    flow: dict[str, Any],
    pieces: dict[str, dict[str, Any]],
    purpose: Any,
    *,
    approvals: dict[str, str | None] | None = None,
    max_chain: int = MAX_CHAIN,
    max_results: int = MAX_RESULTS,
    max_expansions: int = MAX_EXPANSIONS,
    models: list[dict[str, Any]] | None = None,
    datasets: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Answer ``purpose`` for ``flow``. ``pieces`` are the pieces the caller may see,
    by id (each as ``main._piece_view`` gives it, with a ``label``). ``models`` are
    ``{"configuration_id", "label", "outputs": {position: contract}}`` and
    ``datasets`` are ``{"data_object_id", "label", "format", "contracts":
    [DataObjectContract]}``, both already limited to what the caller may see; they
    only feed ``providers`` and never make a need met. Raises
    ``ProposeError`` for a purpose it cannot read; never any other error."""
    try:
        return _propose(flow, pieces, purpose, approvals or {}, max_chain, max_results, max_expansions,
                        models, datasets)
    except ProposeError:
        raise
    except Exception as error:  # noqa: BLE001 — the flow is user-written JSON
        raise ProposeError("FLOW_MALFORMED", f"the flow could not be read: {type(error).__name__}") from error


def _propose(flow, pieces, purpose, approvals, max_chain, max_results, max_expansions,
             models=None, datasets=None) -> dict[str, Any]:
    ctx = _Context(pieces, approvals, _Budget(max(0, min(int(max_expansions), MAX_EXPANSIONS))),
                   max(1, min(int(max_chain), MAX_CHAIN)), max(1, min(int(max_results), MAX_RESULTS)), models, datasets)
    checked = flow_graph.check(flow)
    result: dict[str, Any] = {"purpose": purpose, "direct": [], "chains": [], "next": [], "produces": []}

    if purpose is None:
        pass
    elif not isinstance(purpose, dict):
        raise ProposeError("FLOW_PROPOSE_PURPOSE", "purpose is null or an object")
    elif set(purpose) == {"step", "input"}:
        step = _find_step(flow, purpose["step"])
        piece = step["piece"]
        position = purpose["input"]
        contract = flow_graph.piece_inputs(piece).get(position) if flow_graph._is_position(position) else None
        if contract is None:
            raise ProposeError("FLOW_PROPOSE_PURPOSE", "the piece has no such input")
        sources = _sources(flow, checked, before=step["position"])
        result["direct"] = _direct(ctx, sources, str(piece.get("id")), position, contract)
        if not result["direct"]:
            result["chains"] = _chains(ctx, sources, contract)
        result["providers"] = _providers(ctx, contract) if not (result["direct"] or result["chains"]) \
            else dict(_NO_PROVIDERS)
    elif set(purpose) == {"step", "output"}:
        step = _find_step(flow, purpose["step"])
        source = checked.outputs.get(step["position"], {}).get(purpose["output"]) \
            if flow_graph._is_position(purpose["output"]) else None
        if source is None:
            raise ProposeError("FLOW_PROPOSE_PURPOSE", "the step has no such output")
        for piece_id, piece in sorted(pieces.items()):
            for position, contract in sorted(flow_graph.piece_inputs(piece).items()):
                if _fits(source, _contract_from_registry(contract)):
                    ctx.warn_blank(piece_id, position, contract)
                    result["next"].append({**ctx.piece_ref(piece_id), "input": position})
        result["next"] = ctx.trim(result["next"])
    elif set(purpose) == {"contract"}:
        if not isinstance(purpose["contract"], dict):
            raise ProposeError("FLOW_PROPOSE_PURPOSE", "a wanted contract is an object")
        wanted = _contract_from_registry(purpose["contract"])
        sources = _sources(flow, checked, before=None)
        produces = []
        for piece_id, piece in sorted(pieces.items()):
            for out_position, out in sorted(flow_graph.piece_outputs(piece).items()):
                made = flow_graph._addressable(_contract_from_registry(out), f"piece/{piece_id}/{out_position}")
                if not _fits(made, wanted):
                    continue
                needs = []
                for in_position, contract in sorted(flow_graph.piece_inputs(piece).items()):
                    direct = _direct(ctx, sources, piece_id, in_position, contract)
                    chains = [] if direct else _chains(ctx, sources, contract)
                    met = bool(direct or chains)
                    needs.append({"input": in_position, "direct": direct, "chains": chains, "met": met,
                                  "variable": contract.get("standard_variable_uri"),
                                  "variable_label": humanize_variable(contract.get("standard_variable_uri"))
                                  if contract.get("standard_variable_uri") else None,
                                  "format": contract.get("format"), "unit": contract.get("unit"),
                                  "providers": dict(_NO_PROVIDERS) if met else _providers(ctx, contract)})
                variable = out.get("standard_variable_uri")
                produces.append({**ctx.piece_ref(piece_id), "output": out_position, "inputs": needs,
                                 "output_variable": variable, "output_label": humanize_variable(variable) if variable else None,
                                 "output_format": out.get("format"), "output_unit": out.get("unit"),
                                 # Same variable in and out: it converts, it does not make.
                                 "converter": bool(variable) and any(
                                     need["variable"] == variable for need in needs),
                                 "complete": all(need["met"] for need in needs)})
        result["produces"] = ctx.trim(produces)
    else:
        raise ProposeError("FLOW_PROPOSE_PURPOSE",
                           "purpose names an input or an output of a step, or a wanted contract")

    result["cut"] = ctx.cut or ctx.budget.exhausted
    result["warnings"] = [ctx.warnings[key] for key in sorted(ctx.warnings)]
    return result
