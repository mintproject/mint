"""The planner — the reason this service exists.

Two responsibilities:

1. compatibility(): compare a source DataObjectContract against a target
   (model-input) DataObjectContract across SIX independent dimensions. A
   matching SVO is necessary but NOT sufficient — units, spatial (grid/CRS),
   temporal resolution, format/schema, and file accessibility are each checked
   separately. This separation is a hard requirement of the design.

2. find_path(): when not ready, search the transform registry for an ordered
   chain of transforms whose contracts carry the source contract to the target
   contract, producing a workflow plan (DAG).
"""
from __future__ import annotations

from collections import deque
from typing import Any

from .models import (
    CompatibilityDimension,
    DataObjectContract,
    DimensionResult,
    ReadinessResult,
    ReadinessStatus,
)
from .etl_contract import canonical_key, normalize_env_from_args


def _normalize_unit(u: str | None) -> str | None:
    """Reduce a unit value to a comparable token.

    Handles both short abbreviations ("m", "ft") and full URIs
    ("http://qudt.org/vocab/unit/M", "https://w3id.org/okn/i/mint/ft") so
    MINT-sourced contracts (URI) and hand-registered data objects (abbrev)
    match without requiring identical representations.
    """
    if u is None:
        return None
    token = u.rsplit("/", 1)[-1].rsplit("#", 1)[-1].strip().lower()
    # QUDT capitalises unit symbols (M, FT) — normalise to lowercase
    return token


def _eq(a: str | None, b: str | None) -> bool:
    if a is None or b is None:
        # Unspecified on either side = no constraint to violate.
        return True
    return a.strip().lower() == b.strip().lower()


# ---------------------------------------------------------------------------
# Per-dimension checks. Each returns a DimensionResult; none short-circuits the
# others, so the report always covers all six dimensions.
# ---------------------------------------------------------------------------
def _check_semantic(src: DataObjectContract, tgt: DataObjectContract) -> DimensionResult:
    # Target null = no SVO requirement → any source passes.
    # Source null = opaque file (no declared variable type); compatible only when
    # the target also has no SVO requirement.  An opaque source must go through a
    # transform (e.g. budget_extract) before it can satisfy a specific SVO target.
    if tgt.standard_variable_uri is None:
        ok = True
    else:
        ok = src.standard_variable_uri is not None and _eq(
            src.standard_variable_uri, tgt.standard_variable_uri
        )
    return DimensionResult(
        dimension=CompatibilityDimension.semantic,
        compatible=ok,
        detail="SVO / standard variable match" if ok else "standard variable differs",
        source=src.standard_variable_uri,
        target=tgt.standard_variable_uri,
    )


def _check_unit(src: DataObjectContract, tgt: DataObjectContract) -> DimensionResult:
    ok = _eq(_normalize_unit(src.unit), _normalize_unit(tgt.unit))
    return DimensionResult(
        dimension=CompatibilityDimension.unit,
        compatible=ok,
        detail="units equal" if ok else "unit conversion required",
        source=src.unit,
        target=tgt.unit,
    )


def _check_spatial(src: DataObjectContract, tgt: DataObjectContract) -> DimensionResult:
    crs_ok = _eq(src.crs, tgt.crs)
    grid_ok = _eq(src.spatial_type, tgt.spatial_type) and _eq(src.grid_id, tgt.grid_id)
    ok = crs_ok and grid_ok
    if ok:
        detail = "CRS and grid compatible"
    elif not crs_ok:
        detail = "reprojection required"
    else:
        detail = "regrid / interpolation required"
    return DimensionResult(
        dimension=CompatibilityDimension.spatial,
        compatible=ok,
        detail=detail,
        source=f"{src.spatial_type}/{src.crs}/{src.grid_id}",
        target=f"{tgt.spatial_type}/{tgt.crs}/{tgt.grid_id}",
    )


def _check_temporal(src: DataObjectContract, tgt: DataObjectContract) -> DimensionResult:
    ok = _eq(src.temporal_resolution, tgt.temporal_resolution)
    return DimensionResult(
        dimension=CompatibilityDimension.temporal,
        compatible=ok,
        detail="temporal resolution matches" if ok else "temporal aggregation/resampling required",
        source=src.temporal_resolution,
        target=tgt.temporal_resolution,
    )


def _check_format(src: DataObjectContract, tgt: DataObjectContract) -> DimensionResult:
    # Target null = no format requirement → any source format passes.
    # Source null = format undeclared; compatible only when target also has no requirement.
    # A source with no declared format cannot satisfy a specific format target
    # (e.g. a head file with format=None does not match a cbc-mf6 input requirement).
    if tgt.format is None:
        ok = True
    else:
        ok = src.format is not None and _eq(src.format, tgt.format)
    return DimensionResult(
        dimension=CompatibilityDimension.format,
        compatible=ok,
        detail="format/schema compatible" if ok else "format conversion required",
        source=src.format,
        target=tgt.format,
    )


def _check_accessibility(src: DataObjectContract, tgt: DataObjectContract) -> DimensionResult:
    ok = bool(src.resource_uri)
    return DimensionResult(
        dimension=CompatibilityDimension.accessibility,
        compatible=ok,
        detail="resource URI present" if ok else "no resource URI — file not addressable",
        source=src.resource_uri,
        target=None,
    )


def _catalogs(value: str | None) -> set[str]:
    """Split a catalog spec ("ckan+stac", "ckan, stac") into a set of catalog ids.

    A trailing ":<org>" scope ("ckan+stac:stac-datasets", as qaqc writes it) is
    dropped: the requirement is the catalogs, not the organisation."""
    if not value:
        return set()
    value = value.split(":", 1)[0]
    return {tok.strip().lower() for tok in value.replace("/", "+").replace(",", "+").split("+") if tok.strip()}


def _check_catalog(src: DataObjectContract, tgt: DataObjectContract) -> DimensionResult:
    """Is the product registered in every catalog the target requires? An empty
    requirement is no constraint; otherwise the source must already be in all of
    them (a catalog_register transform — stac-publish — closes the gap)."""
    required = _catalogs(tgt.catalog)
    have = _catalogs(src.catalog)
    ok = required.issubset(have)
    return DimensionResult(
        dimension=CompatibilityDimension.catalog,
        compatible=ok,
        detail="registered in required catalog(s)" if ok else "catalog registration required (CKAN / STAC)",
        source=src.catalog,
        target=tgt.catalog,
    )


_DIMENSION_CHECKS = (
    _check_semantic,
    _check_unit,
    _check_spatial,
    _check_temporal,
    _check_format,
    _check_accessibility,
    _check_catalog,
)


def compatibility(src: DataObjectContract, tgt: DataObjectContract) -> ReadinessResult:
    """Full six-dimension readiness assessment."""
    dims = [check(src, tgt) for check in _DIMENSION_CHECKS]
    missing = [f"{d.dimension.value}: {d.detail}" for d in dims if not d.compatible]

    semantic_ok = next(d for d in dims if d.dimension == CompatibilityDimension.semantic).compatible
    access_ok = next(d for d in dims if d.dimension == CompatibilityDimension.accessibility).compatible

    if not missing:
        status = ReadinessStatus.ready
    elif not semantic_ok or not access_ok:
        # Wrong variable entirely, or unreachable bytes -> no transform fixes it here.
        status = ReadinessStatus.incompatible
    else:
        status = ReadinessStatus.transform_required

    return ReadinessResult(status=status, dimensions=dims, missing_requirements=missing)


# ---------------------------------------------------------------------------
# Path search over the transform registry.
# ---------------------------------------------------------------------------
def _contract_from_registry(c: dict[str, Any]) -> DataObjectContract:
    # `catalog` has no column; it round-trips via metadata_json (Hasura) or
    # top-level (fixtures consumed directly by tests).
    catalog = c.get("catalog") or (c.get("metadata_json") or {}).get("catalog")
    return DataObjectContract(
        standard_variable_uri=c.get("standard_variable_uri"),
        unit=c.get("unit"),
        format=c.get("format"),
        dimensionality=c.get("dimensionality"),
        spatial_type=c.get("spatial_type"),
        crs=c.get("crs_requirement"),
        temporal_resolution=c.get("temporal_resolution"),
        schema_json=c.get("schema_requirement_json"),
        catalog=catalog,
    )


def _transform_accepts(spec: dict[str, Any], state: DataObjectContract) -> bool:
    inputs = [c for c in spec.get("contracts", []) if c.get("role") == "input"]
    for c in inputs:
        req = _contract_from_registry(c)
        if compatibility(state, req).status == ReadinessStatus.ready:
            return True
    return False


def _apply_transform(spec: dict[str, Any], state: DataObjectContract) -> DataObjectContract:
    """Project the current state through a transform's output contract.

    Only fields the transform declares it produces are overwritten; everything
    else carries forward unchanged.
    """
    outputs = [c for c in spec.get("contracts", []) if c.get("role") == "output"]
    if not outputs:
        return state
    out = _contract_from_registry(outputs[0])
    merged = state.model_copy()
    for field in ("standard_variable_uri", "unit", "format", "dimensionality",
                  "spatial_type", "crs", "temporal_resolution", "catalog"):
        val = getattr(out, field)
        if val is not None:
            setattr(merged, field, val)
    return merged


def find_path(
    source: DataObjectContract,
    target: DataObjectContract,
    registry: list[dict[str, Any]],
    max_depth: int = 6,
    edge_map: "dict[str, list[dict[str, Any]]] | None" = None,
) -> list[dict[str, Any]] | None:
    """BFS over transforms. Returns the shortest ordered list of transform specs
    that carries `source` to a state that is `ready` for `target`, or None.

    When `edge_map` is provided (built by edges.build_edge_map), subsequent BFS
    steps after the first transform use the pre-indexed output→input pairs instead
    of scanning the whole registry. Correctness is preserved: _transform_accepts is
    still called on every candidate so stale edges are silently skipped.
    """
    if compatibility(source, target).status == ReadinessStatus.ready:
        return []

    seen: set[tuple] = set()
    # (state, path, last_output_contract_id or None)
    queue: deque[tuple[DataObjectContract, list[dict[str, Any]], "str | None"]] = deque(
        [(source, [], None)]
    )

    while queue:
        state, path, last_out_id = queue.popleft()
        if len(path) >= max_depth:
            continue

        # Fast path: when the prior transform's output_contract_id is known and we
        # have precomputed edges, only check the pre-filtered candidates. Fall back
        # to the full registry for the first step or when no edge_map is available.
        if edge_map is not None and last_out_id is not None:
            candidates = edge_map.get(last_out_id, [])
        else:
            candidates = registry

        for spec in candidates:
            # Guard against stale edges (registry changed since last recompute).
            if not _transform_accepts(spec, state):
                continue
            nxt = _apply_transform(spec, state)
            key = (nxt.standard_variable_uri, nxt.unit, nxt.format,
                   nxt.spatial_type, nxt.crs, nxt.temporal_resolution, nxt.catalog)
            if key in seen:
                continue
            seen.add(key)
            new_path = path + [spec]
            # Track the output contract id for the next BFS step's edge lookup.
            out_ids = [c["id"] for c in spec.get("contracts", [])
                       if c.get("role") == "output" and c.get("id")]
            new_out_id = out_ids[0] if out_ids else None
            if compatibility(nxt, target).status == ReadinessStatus.ready:
                return new_path
            queue.append((nxt, new_path, new_out_id))
    return None


def reachable_variables(
    source: DataObjectContract,
    registry: list[dict[str, Any]],
    max_depth: int = 6,
) -> list[dict[str, Any]]:
    """Forward BFS from `source` over SINGLE-input transforms (conversions): which
    target REPRESENTATIONS — (standard variable, unit, format) — can this source
    become, and via the shortest chain?

    Keyed by (svo, unit, format) rather than svo alone, so a unit/format change
    (e.g. head m -> head ft via head-m-to-ft-msl) shows up as a distinct, real
    option instead of collapsing to 'no transform needed'. Multi-input transforms
    (model runs) are excluded (they belong to plan_model_run). The source's own
    representation is included with an empty path (identity).
    """
    single = [t for t in registry
              if len([c for c in t.get("contracts", []) if c.get("role") == "input"]) <= 1]
    reached: dict[tuple, dict[str, Any]] = {}

    def _record(state: DataObjectContract, path: list[dict[str, Any]]) -> None:
        svo = state.standard_variable_uri
        if not svo:
            return
        key = (svo, state.unit, state.format)
        if key not in reached or len(path) < len(reached[key]["path"]):
            reached[key] = {"standard_variable_uri": svo, "unit": state.unit,
                            "format": state.format, "path": path}

    _record(source, [])
    seen: set[tuple] = set()
    queue: deque[tuple[DataObjectContract, list[dict[str, Any]]]] = deque([(source, [])])
    while queue:
        state, path = queue.popleft()
        if len(path) >= max_depth:
            continue
        for spec in single:
            if not _transform_accepts(spec, state):
                continue
            nxt = _apply_transform(spec, state)
            key = (nxt.standard_variable_uri, nxt.unit, nxt.format,
                   nxt.spatial_type, nxt.crs, nxt.temporal_resolution, nxt.catalog)
            if key in seen:
                continue
            seen.add(key)
            new_path = path + [spec]
            _record(nxt, new_path)
            queue.append((nxt, new_path))
    return list(reached.values())


def build_plan_json(path: list[dict[str, Any]]) -> dict[str, Any]:
    """Serialize a transform path into the stored plan_json DAG."""
    steps = []
    for i, spec in enumerate(path):
        step = {
            "step": i,
            "transform_spec_id": spec.get("id"),
            "name": spec.get("name"),
            "transform_type": spec.get("transform_type"),
            "is_lossy": spec.get("is_lossy", False),
            "method": spec.get("method"),
            "tapis_app_id": spec.get("tapis_app_id"),
            "depends_on": [i - 1] if i > 0 else [],
        }
        # Carry the Tapis job-shaping hints through to workflow generation when
        # the registered transform declares them (app version, STAGE selector,
        # and how the app's env vars / file inputs bind to pipeline run args).
        # Hints may be top-level (fixtures) or packed under
        # parameters_schema_json.tapis (how they round-trip through Hasura, which
        # has no dedicated columns for them).
        hints = (spec.get("parameters_schema_json") or {}).get("tapis") or {}
        for key in ("app_version", "stage", "env_from_args", "file_inputs"):
            val = spec.get(key)
            if val is None:
                val = hints.get(key)
            if val is not None:
                if key == "env_from_args":
                    val = normalize_env_from_args(val)
                step[key] = val
        schema = spec.get("parameters_schema_json") or {}
        if isinstance(schema, dict) and schema.get("properties"):
            step["parameters_schema_json"] = schema
        metadata = (spec.get("parameters_schema_json") or {}).get("metadata") or {}
        source = metadata.get("source")
        if isinstance(source, dict) and isinstance(source.get("code"), str):
            step["python_source"] = source["code"]
            if source.get("entrypoint"):
                step["python_entrypoint"] = source["entrypoint"]
        steps.append(step)
    return {
        "steps": steps,
        "lossy": any(s["is_lossy"] for s in steps),
        "parameters": parameter_definitions(steps),
    }


def parameter_definitions(
    steps: list[dict[str, Any]],
    standard_params: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Return the typed, plan-scoped arguments required by a transform path.

    Transform registry rows predate a single parameter contract: some declare
    JSON Schema properties while older rows only expose ``env_from_args`` or
    ``file_inputs``.  This function normalizes both forms into the contract
    stored with a plan.  ``standard_params`` is supplied by the workflow
    backend so pipeline-wide arguments (for example ``allocation``) are
    represented alongside transform-specific arguments.
    """
    definitions: dict[str, dict[str, Any]] = {}

    # These values are supplied by the service/coordinator, never by a modeler.
    # Keep source_uri in the immutable plan contract so the workflow generator
    # can wire it, but mark it managed so clients do not render it as an input.
    managed_params = {
        "allocation": "adapter_service",
        "budget_drain_package_candidates": "adapter_service",
        "budget_river_package_candidates": "adapter_service",
        "geo_actor_id": "adapter_service",
        "source_uri": "execution_handoff",
        "tapis_base_url": "adapter_service",
        "tapis_token": "authorization",
    }

    def add(name: str, definition: dict[str, Any], transform: dict[str, Any]) -> None:
        if name == "tapis_token":
            return
        current = definitions.setdefault(name, {
            "name": name,
            "type": "string",
            "required": True,
        })
        current.update({k: v for k, v in definition.items() if v is not None})
        current["name"] = name
        current["source_transform"] = current.get("source_transform") or transform.get("name")
        current["transform_spec_id"] = current.get("transform_spec_id") or transform.get("transform_spec_id")
        if name in managed_params:
            current["managed"] = True
            current["managed_source"] = managed_params[name]

    for step in steps:
        schema = step.get("parameters_schema_json") or {}
        properties = schema.get("properties") if isinstance(schema, dict) else None
        required = {
            canonical_key(str(name)) or str(name)
            for name in (schema.get("required") or [])
        } if isinstance(schema, dict) else set()
        if isinstance(properties, dict):
            for raw_name, prop in properties.items():
                name = canonical_key(str(raw_name)) or str(raw_name)
                if not isinstance(prop, dict):
                    prop = {}
                definition = {
                    "type": prop.get("type", "string"),
                    "required": name in required,
                    "description": prop.get("description"),
                    "default": prop.get("default"),
                    "allowed_values": prop.get("enum"),
                    "minimum": prop.get("minimum"),
                    "maximum": prop.get("maximum"),
                }
                add(name, definition, step)

        env_from_args = normalize_env_from_args(step.get("env_from_args") or {}) or {}
        for arg in env_from_args.values():
            add(str(arg), {}, step)
        for file_input in step.get("file_inputs") or []:
            arg = file_input.get("from_arg")
            if arg:
                add(str(arg), {"type": "string"}, step)

    for name, definition in (standard_params or {}).items():
        # Keep the backend's system token out of the user-facing parameter
        # form.  It is injected from the caller's bearer token at submission.
        if name == "tapis_token":
            continue
        if name in definitions:
            definitions[name].update({
                k: v for k, v in definition.items()
                if k in {"type", "required", "default", "description"} and v is not None
            })
        elif name == "allocation":
            add(name, definition, {"name": "workflow"})

    return [definitions[name] for name in sorted(definitions)]


# ---------------------------------------------------------------------------
# Multi-input model runs. A model (e.g. the SUBSIDE forecast) is a transform with
# SEVERAL input contracts that ALL must be satisfied — unlike the single-chain
# find_path above. plan_model_run resolves every input from the available sources
# (each via its own conversion chain) and converges them on a final run step.
# ---------------------------------------------------------------------------
def _step_from_spec(idx: int, spec: dict[str, Any], depends_on: list[int]) -> dict[str, Any]:
    step = {
        "step": idx,
        "transform_spec_id": spec.get("id"),
        "name": spec.get("name"),
        "transform_type": spec.get("transform_type"),
        "is_lossy": spec.get("is_lossy", False),
        "method": spec.get("method"),
        "tapis_app_id": spec.get("tapis_app_id"),
        "depends_on": depends_on,
    }
    hints = (spec.get("parameters_schema_json") or {}).get("tapis") or {}
    for key in ("app_version", "stage", "env_from_args", "file_inputs"):
        val = spec.get(key) if spec.get(key) is not None else hints.get(key)
        if val is not None:
            if key == "env_from_args":
                val = normalize_env_from_args(val)
            step[key] = val
    schema = spec.get("parameters_schema_json") or {}
    if isinstance(schema, dict) and schema.get("properties"):
        step["parameters_schema_json"] = schema
    metadata = (spec.get("parameters_schema_json") or {}).get("metadata") or {}
    source = metadata.get("source")
    if isinstance(source, dict) and isinstance(source.get("code"), str):
        step["python_source"] = source["code"]
        if source.get("entrypoint"):
            step["python_entrypoint"] = source["entrypoint"]
    return step


def plan_model_run(
    run_spec: dict[str, Any],
    sources: list[DataObjectContract],
    registry: list[dict[str, Any]],
    max_depth: int = 6,
    edge_map: "dict[str, list[dict[str, Any]]] | None" = None,
) -> dict[str, Any] | None:
    """Plan an ETL DAG that satisfies EVERY input contract of `run_spec` (a model
    run) from `sources`, then runs the model.

    For each input contract, pick the source with the shortest transform chain
    that carries it to that contract. Returns a per-input resolution report, or
    None if any input cannot be sourced (so callers can see what's missing).
    """
    inputs = [c for c in run_spec.get("contracts", []) if c.get("role") == "input"]
    others = [t for t in registry if t.get("id") != run_spec.get("id")]
    branches: list[dict[str, Any]] = []
    for ic in inputs:
        req = _contract_from_registry(ic)
        best: dict[str, Any] | None = None
        for src in sources:
            path = find_path(src, req, others, max_depth, edge_map=edge_map)
            if path is not None and (best is None or len(path) < len(best["path"])):
                best = {"input_id": ic.get("id"), "source": src, "path": path,
                        "standard_variable_uri": ic.get("standard_variable_uri")}
        branches.append(best or {"input_id": ic.get("id"),
                                 "standard_variable_uri": ic.get("standard_variable_uri"),
                                 "source": None, "path": None})
    return {"run_spec": run_spec, "branches": branches,
            "complete": all(b["source"] is not None for b in branches)}


def build_model_run_plan_json(plan: dict[str, Any]) -> dict[str, Any]:
    """Serialize a plan_model_run result into a converging DAG: each input's
    conversion chain, then a final run step depending on every branch tail."""
    steps: list[dict[str, Any]] = []
    idx = 0
    tails: list[int] = []
    for b in plan["branches"]:
        if not b.get("source"):
            continue
        prev: int | None = None
        for spec in b["path"]:
            steps.append({**_step_from_spec(idx, spec, [prev] if prev is not None else []),
                          "for_input": b["input_id"],
                          "source": getattr(b["source"], "resource_uri", None)})
            prev = idx
            idx += 1
        if prev is not None:
            tails.append(prev)  # this branch needed conversion(s)
    run = _step_from_spec(idx, plan["run_spec"], sorted(tails))
    steps.append(run)
    return {
        "steps": steps,
        "lossy": any(s["is_lossy"] for s in steps),
        "parameters": parameter_definitions(steps),
        "multi_input": True,
        "complete": plan["complete"],
    }
