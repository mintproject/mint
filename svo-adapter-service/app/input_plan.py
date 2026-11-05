"""Plan the input-side ETL steps of a model run from the catalog's app-input binding.

A model's input contracts (synced from the catalog, see mint_sync) carry
``metadata_json.app_input_name``: the Tapis file input that dataset
specification feeds. For every bound input the caller has not filled, this
module searches the transform registry for a chain from the caller's source
(for example the thread's region) to that input's contract, and returns one
``InputStep`` per input in the shape ``tapis._input_stage_tasks`` consumes.

The function is pure so ``POST /plans/model-inputs`` (preview) and
``POST /workflows/submit`` derive identical steps from the same registry.
Design: docs/design/2026-11-05-app-input-binding.md section 4.
"""
from __future__ import annotations

import hashlib
import json
import math
from typing import Any

from . import tapis
from .models import DataObjectContract
from .planner import _contract_from_registry, build_plan_json, find_path

# Transform types a run may execute as an input-side ETL step.
INPUT_STEP_TRANSFORM_TYPES = {"aoi_from_boundary"}

MAX_AOI_AREA_KM2 = 160_000
MAX_POLYGONS = 500
MAX_VERTICES = 50_000
MAX_SOURCE_CHARS = 200_000
_KM_PER_DEG = math.pi / 180 * 6371.0088

_EXTENSIONS = {"geojson": "geojson", "json": "json", "csv": "csv", "netcdf": "nc",
               "geotiff": "tif", "tiff": "tif"}


class InputPlanError(Exception):
    """A request the planner refuses; the API maps it to a 422 {code, message}."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# --- source validation --------------------------------------------------------------
def _invalid(message: str) -> InputPlanError:
    return InputPlanError("INPUT_SOURCE_INVALID", message)


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _ring_vertices(ring: Any, where: str) -> list[list[float]]:
    if not isinstance(ring, list) or len(ring) < 4:
        raise _invalid(f"{where}: a ring needs at least 4 positions")
    for pos in ring:
        if not (isinstance(pos, list) and len(pos) >= 2 and all(_number(v) for v in pos)):
            raise _invalid(f"{where}: positions must be lists of finite numbers")
    if ring[0][:2] != ring[-1][:2]:
        raise _invalid(f"{where}: ring is not closed")
    return ring


def _polygon_vertices(polygon: Any, where: str) -> list[list[float]]:
    if not isinstance(polygon, list) or not polygon:
        raise _invalid(f"{where}: a polygon needs at least one ring")
    out: list[list[float]] = []
    for r, ring in enumerate(polygon):
        out.extend(_ring_vertices(ring, f"{where} ring {r}"))
    return out


def _area_km2(minx: float, miny: float, maxx: float, maxy: float) -> float:
    # Equirectangular at the mid latitude: an upper-bound guard, not geodesy.
    lat = math.radians((miny + maxy) / 2)
    return abs(maxx - minx) * _KM_PER_DEG * math.cos(lat) * abs(maxy - miny) * _KM_PER_DEG


def _validate_source(source: Any, k: int) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return ``(normalized source, measures)`` or raise InputPlanError."""
    where = f"sources[{k}]"
    if not isinstance(source, dict):
        raise _invalid(f"{where} must be an object")
    kind = source.get("kind")
    if kind == "geojson":
        geometry = source.get("geometry")
        if not isinstance(geometry, dict):
            raise _invalid(f"{where}.geometry must be a GeoJSON Polygon or MultiPolygon")
        gtype, coords = geometry.get("type"), geometry.get("coordinates")
        if gtype == "Polygon":
            polygons = [coords]
        elif gtype == "MultiPolygon" and isinstance(coords, list):
            polygons = coords
        else:
            raise _invalid(f"{where}.geometry must be a GeoJSON Polygon or MultiPolygon")
        if not 0 < len(polygons) <= MAX_POLYGONS:
            raise _invalid(f"{where}.geometry must have 1 to {MAX_POLYGONS} polygons")
        vertices: list[list[float]] = []
        for n, polygon in enumerate(polygons):
            vertices.extend(_polygon_vertices(polygon, f"{where}.geometry polygon {n}"))
            if len(vertices) > MAX_VERTICES:
                raise _invalid(f"{where}.geometry has more than {MAX_VERTICES} vertices")
        normalized = {"kind": "geojson", "geometry": {"type": gtype, "coordinates": coords}}
        xs, ys = [v[0] for v in vertices], [v[1] for v in vertices]
        measures = {"vertices_in": len(vertices), "area_km2": _area_km2(min(xs), min(ys), max(xs), max(ys))}
    elif kind == "bbox":
        bbox = source.get("bbox")
        if not (isinstance(bbox, list) and len(bbox) == 4 and all(_number(v) for v in bbox)):
            raise _invalid(f"{where}.bbox must be 4 finite numbers [minx, miny, maxx, maxy]")
        area = _area_km2(*bbox)
        if area > MAX_AOI_AREA_KM2:
            raise InputPlanError(
                "AOI_REGION_TOO_LARGE",
                f"{where}.bbox covers about {area:,.0f} km2; the limit is {MAX_AOI_AREA_KM2:,} km2")
        normalized = {"kind": "bbox", "bbox": list(bbox)}
        measures = {"vertices_in": 4, "area_km2": area}
    else:
        raise _invalid(f"{where}.kind must be 'geojson' or 'bbox'")
    text = json.dumps(normalized, sort_keys=True, separators=(",", ":"))
    if len(text) > MAX_SOURCE_CHARS:
        raise _invalid(f"{where} is larger than {MAX_SOURCE_CHARS} characters")
    derivation = source.get("derivation")
    if derivation is not None and not isinstance(derivation, dict):
        raise _invalid(f"{where}.derivation must be an object")
    return normalized, {**measures, "bytes": len(text), "derivation": derivation or {}}


# --- planning -----------------------------------------------------------------------
def _extension(contract: dict[str, Any]) -> str:
    return _EXTENSIONS.get(str(contract.get("format") or "").lower(), "dat")


def _meta(contract: dict[str, Any]) -> dict[str, Any]:
    return contract.get("metadata_json") or {}


def steps_digest(input_steps: list[dict[str, Any]]) -> str:
    return hashlib.sha256(json.dumps(input_steps, sort_keys=True).encode()).hexdigest()


def plan_model_inputs(
    registry: list[dict[str, Any]],
    edge_map: "dict[str, list[dict[str, Any]]] | None",
    configuration_id: str,
    sources: list[dict[str, Any]],
    filled_app_inputs: "list[str] | set[str]",
) -> dict[str, Any]:
    """Derive one input step per unfilled, bound, reachable model input."""
    checked = [_validate_source(source, k) for k, source in enumerate(sources)]
    model = next((s for s in registry if s.get("mint_model_config_id") == configuration_id), None)
    if model is None:
        return {"input_steps": [], "considered": [], "steps_digest": steps_digest([]),
                "registry": "missing", "registry_synced_at": None, "tapis_app_id": None}

    # Group the model's input contracts by the app input they feed; unbound
    # contracts are reported once per dataset specification.
    groups: dict[str, list[dict[str, Any]]] = {}
    unbound: dict[Any, list[dict[str, Any]]] = {}
    for contract in model.get("contracts") or []:
        if contract.get("role") != "input":
            continue
        name = _meta(contract).get("app_input_name")
        if name:
            groups.setdefault(name, []).append(contract)
        else:
            unbound.setdefault(_meta(contract).get("dataset_specification_id"), []).append(contract)

    # The model itself and pieces that may not run as input steps are never
    # intermediates: a chain must be made of hosted ETL pieces only.
    usable = [s for s in registry
              if s.get("id") != model.get("id") and s.get("transform_type") in INPUT_STEP_TRANSFORM_TYPES]
    usable_ids = {s.get("id") for s in usable}
    usable_edges = None if edge_map is None else {
        key: [s for s in specs if s.get("id") in usable_ids] for key, specs in edge_map.items()}

    filled = set(filled_app_inputs)
    input_steps: list[dict[str, Any]] = []
    considered: list[dict[str, Any]] = []
    for name, contracts in groups.items():
        optional = all(bool(_meta(c).get("is_optional")) for c in contracts)
        row = {"app_input_name": name, "standard_variable_uri": contracts[0].get("standard_variable_uri"),
               "optional": optional, "outcome": "no_path", "blocking": not optional}
        considered.append(row)
        if name in filled:
            row.update(outcome="filled", blocking=False)
            continue
        best: tuple[list[dict[str, Any]], int, dict[str, Any]] | None = None
        for k, (source, _) in enumerate(checked):
            origin = DataObjectContract(format="geojson", spatial_type="polygon",
                                        resource_uri=f"input-source:{source['kind']}")
            for contract in contracts:
                path = find_path(origin, _contract_from_registry(contract), usable, edge_map=usable_edges)
                # An empty path moves nothing, so it cannot produce the file.
                if path and (best is None or len(path) < len(best[0])):
                    best = (path, k, contract)
        if best is None:
            continue
        path, k, contract = best
        row.update(outcome="planned", blocking=False, standard_variable_uri=contract.get("standard_variable_uri"))
        input_steps.append(_input_step(name, path, checked[k], contract))

    for contracts in unbound.values():
        considered.append({"app_input_name": None, "standard_variable_uri": contracts[0].get("standard_variable_uri"),
                           "optional": all(bool(_meta(c).get("is_optional")) for c in contracts),
                           "outcome": "unbound", "blocking": False})

    try:  # name/extension safety is enforced where the pipeline is generated
        tapis._input_stage_tasks(input_steps, {})
    except ValueError as exc:
        raise InputPlanError("INPUT_STEPS_INVALID", str(exc))
    return {"input_steps": input_steps, "considered": considered, "steps_digest": steps_digest(input_steps),
            "registry": "ok", "registry_synced_at": model.get("mint_synced_at"),
            "tapis_app_id": model.get("tapis_app_id")}


def _input_step(
    name: str, path: list[dict[str, Any]], checked: tuple[dict[str, Any], dict[str, Any]],
    contract: dict[str, Any],
) -> dict[str, Any]:
    source, measures = checked
    plan = build_plan_json(path)
    for step in plan["steps"]:
        if step.get("transform_type") not in INPUT_STEP_TRANSFORM_TYPES:
            raise InputPlanError("INPUT_STEP_NOT_ALLOWED",
                                 f"{name}: {step.get('transform_type')} may not run as an input step")
    step = {"name": name, "app_input_name": name, "steps": plan["steps"], "source": source,
            "extension": _extension(contract)}
    local = {d["name"] for d in tapis._input_param_definitions(step)}
    step["params"] = {d["name"]: d["default"] for d in plan["parameters"]
                      if d["name"] in local and d.get("default") is not None and not d.get("managed")}
    kind = source["kind"]
    step["derivation"] = {
        "method": kind, **measures["derivation"],
        "vertices_in": measures["vertices_in"], "bytes": measures["bytes"],
        "area_km2": round(measures["area_km2"], 3)}
    return step
