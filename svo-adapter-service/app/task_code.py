"""Per-transform-type OWE function task code builders.

Called by generate_tapis_workflow when a transform spec has no tapis_app_id
(i.e. it runs as a hosted OWE function task rather than a batch Tapis job).

Each builder returns a Python source string that will execute inside the OWE
function task runtime (Python 3.11, no pip install — heavy deps go through
the geo_actor Tapis Abaco actor instead). The code reads env vars that the
pipeline injects via env_from_args, performs its transform, and prints a JSON
result to stdout (which OWE captures as the task output).

Env vars the OWE runtime always makes available (via STANDARD_PARAMS or
env_from_args wiring):
  SOURCE_URI      — Tapis or CKAN URI of the input file
  LAT / LON       — point location for spatial extraction
  GEO_ACTOR_ID    — Tapis Abaco actor ID for the dso-geo GDAL/MODFLOW actor
  TAPIS_BASE_URL  — Tapis base URL (default https://portals.tapis.io)
  TAPIS_TOKEN     — caller's bearer token (actor auth + Tapis file retrieval)
  SOURCE_UNIT     — input unit string (e.g. "m")
  TARGET_UNIT     — output unit string (e.g. "ft")
  VARIABLE_NAME   — variable name to extract from the file
  BUDGET_PACKAGE_CANDIDATES — JSON list of exact CBC labels to try in order
"""
from __future__ import annotations

import base64
import json
import textwrap

_INPUT_HELPER = """\
import json, os
try:
    from owe_python_sdk.runtime import execution_context as _ctx
except Exception:
    _ctx = None

def _input(name, default=""):
    value = None
    if _ctx is not None:
        try:
            value = _ctx.get_input(name)
        except Exception:
            value = None
    if value in (None, ""):
        value = os.environ.get(name, default)
    return default if value in (None, "") else value

def _input_alias(canonical, *legacy, default=""):
    # Read canonical task input first, then historical environment names.
    for name in (canonical, *legacy):
        value = _input(name, "")
        if value not in (None, ""):
            return value
    return default

def _emit_result(result):
    # Keep stdout as a bounded, inspectable record while also publishing the
    # same value through the Workflows function-task output contract. The
    # latter is the typed handoff consumed by downstream tasks.
    text = json.dumps(result)
    if _ctx is not None:
        try:
            _ctx.set_output("result", text)
        except Exception:
            pass
    print(text)

def _die(message):
    # Keep task failures structured so Workflows and the facilitator UI can
    # distinguish a failed transform from a successful JSON result.
    text = json.dumps({"schema_version": 1, "status": "error", "message": message})
    if _ctx is not None:
        try:
            _ctx.set_output("result", text)
        except Exception:
            pass
    print(text)
    raise SystemExit(1)
"""

_ACTOR_HELPER = """\
import json, socket, time, urllib.error as _ue, urllib.request as _ur

def _actor_run(msg):
    _base = _input("TAPIS_BASE_URL", "https://portals.tapis.io").rstrip("/")
    _aid  = _input("GEO_ACTOR_ID", "").strip()
    _tok  = _input("TAPIS_TOKEN", "").strip()
    if not _aid:
        _die("GEO_ACTOR_ID is required for geo_actor-backed DFC transforms")
    if not _tok:
        _die("TAPIS_TOKEN is required so the geo_actor can read Tapis/CKAN inputs")
    _hdr  = {"X-Tapis-Token": _tok, "Content-Type": "application/json"}
    def _req(method, url, body=None, attempts=1):
        d = json.dumps(body).encode() if body else None
        raw = ""
        for _attempt in range(1, attempts + 1):
            r = _ur.Request(url, data=d, headers=_hdr, method=method)
            try:
                raw = _ur.urlopen(r, timeout=90).read().decode()
                break
            except _ue.HTTPError as exc:
                err = exc.read().decode(errors="replace")[:800]
                _die(f"Tapis geo_actor API {method} failed with HTTP {exc.code}: {err}")
            except (_ue.URLError, TimeoutError, socket.timeout) as exc:
                if _attempt >= attempts:
                    _die(f"Tapis geo_actor API {method} failed after {attempts} attempts: {type(exc).__name__}: {exc}")
                time.sleep(min(2 ** _attempt, 20))
            except Exception as exc:
                _die(f"Tapis geo_actor API {method} failed: {type(exc).__name__}: {exc}")
        try:
            return json.loads(raw)
        except Exception:
            _die(f"Tapis geo_actor API {method} returned non-JSON: {raw[:800]}")
    sub  = _req("POST", f"{_base}/v3/actors/{_aid}/messages", {"message": json.dumps(msg)}, attempts=3)
    eid  = sub["result"]["execution_id"]
    st = "SUBMITTED"
    for _ in range(60):
        st = _req("GET", f"{_base}/v3/actors/{_aid}/executions/{eid}", attempts=5)["result"]["status"]
        if st in ("COMPLETE", "FAILED", "ERROR"):
            break
        time.sleep(5)
    logs = _req("GET", f"{_base}/v3/actors/{_aid}/executions/{eid}/logs", attempts=5)["result"]["logs"]
    if st != "COMPLETE":
        _die(f"geo_actor execution {eid} ended with {st}: {str(logs)[:1200]}")
    try:
        return json.loads(logs)
    except Exception:
        for _line in reversed(str(logs).splitlines()):
            _line = _line.strip()
            if not _line.startswith("{"):
                continue
            try:
                return json.loads(_line)
            except Exception:
                pass
        _die(f"geo_actor execution {eid} completed but logs were not JSON: {str(logs)[:1200]}")

def _die(message):
    print(json.dumps({"schema_version": 1, "status": "error", "message": message}))
    raise SystemExit(1)
"""
_ACTOR_HELPER = _INPUT_HELPER + _ACTOR_HELPER

_GEO_ACTOR_SNIPPET = _ACTOR_HELPER + """\
_source_uri = _input("SOURCE_URI", "")
_lat = float(_input("LAT", "0"))
_lon = float(_input("LON", "0"))
result = _actor_run({
    "operation": "extract_point",
    "input_url": _source_uri,
    "read_token": _input("TAPIS_TOKEN", ""),
    "params": {"lat": _lat, "lon": _lon, "band": 1},
})
_emit_result(result)
"""

_UNIT_CONVERT_SNIPPET = _INPUT_HELPER + """\
_raw_source_result = _input_alias("SOURCE_RESULT", "INTERMEDIATE_RESULT")
if not _raw_source_result:
    _die("SOURCE_RESULT is required for modular unit conversion")
try:
    _source_payload = json.loads(_raw_source_result) if isinstance(_raw_source_result, str) else _raw_source_result
except Exception as exc:
    _die(f"SOURCE_RESULT must be JSON: {exc}")
if isinstance(_source_payload, dict) and isinstance(_source_payload.get("result"), dict):
    _source_payload = _source_payload["result"]
if isinstance(_source_payload, dict) and str(_source_payload.get("status") or "").lower() == "error":
    _die(_source_payload.get("message") or "upstream transform failed")
if not isinstance(_source_payload, dict):
    _die("SOURCE_RESULT must be a JSON object containing a numeric value")
_source_value = _source_payload.get("value")
if isinstance(_source_value, bool) or not isinstance(_source_value, (int, float)):
    for _key in ("spring_flow", "stream_flow", "baseflow", "flow", "total_flow", "mean", "average", "average_value"):
        _candidate = _source_payload.get(_key)
        if not isinstance(_candidate, bool) and isinstance(_candidate, (int, float)):
            _source_value = _candidate
            break
if isinstance(_source_value, bool) or not isinstance(_source_value, (int, float)):
    _die("SOURCE_RESULT did not contain a numeric value")
_src_unit = str(_source_payload.get("unit") or _source_payload.get("units") or _input("SOURCE_UNIT", "m"))
_tgt_unit = _input("TARGET_UNIT", "ft")
# Linear factor table — extend as needed.
_FACTORS: dict[tuple[str, str], float] = {
    ("m", "ft"): 3.28084,
    ("ft", "m"): 0.3048,
    ("m", "cm"): 100.0,
    ("cm", "m"): 0.01,
    ("m", "mm"): 1000.0,
    ("mm", "m"): 0.001,
    ("degc", "degf"): None,  # non-linear — handled below
    ("degf", "degc"): None,
    # Flow conversions — GMA spring/stream flow DFC targets
    # 1 cfs = 0.028317 m³/s; 1 mgd = 0.043813 m³/s; 1 af/month ≈ 0.0004691 m³/s (30.44-day avg month)
    ("cfs", "m3s"):      0.028317,
    ("m3s", "cfs"):      35.3147,
    ("mgd", "m3s"):      0.043813,
    ("m3s", "mgd"):      22.8245,
    ("cfs", "mgd"):      0.64632,
    ("mgd", "cfs"):      1.5472,
    ("cfs", "af_month"): 60.376,
    ("af_month", "cfs"): 0.016562,
    ("m3s", "af_month"): 2131.7,
    ("af_month", "m3s"): 0.0004691,
}
_key = (_src_unit.lower(), _tgt_unit.lower())
_factor = _FACTORS.get(_key)
if _factor is None and _key == ("degc", "degf"):
    def _convert(v): return v * 9 / 5 + 32
elif _factor is None and _key == ("degf", "degc"):
    def _convert(v): return (v - 32) * 5 / 9
elif _factor is not None:
    def _convert(v): return v * _factor
else:
    raise RuntimeError(f"No unit conversion defined for {_src_unit!r} -> {_tgt_unit!r}")
_converted = _convert(_source_value)
result = {
    "schema_version": 1,
    "status": "ok",
    "operation": "unit_convert",
    "value": _converted,
    "source_unit": _src_unit,
    "unit": _tgt_unit,
    "conversion_factor": _factor,
}
_emit_result(result)
"""

_POINT_EXTRACT_SNIPPET = _GEO_ACTOR_SNIPPET

_BOUNDARY_QUERY_HELPER = _INPUT_HELPER + """\
import json, urllib.parse as _up, urllib.request as _ur

def _arcgis_where(field, value):
    value = str(value or "").strip()
    if not value:
        raise RuntimeError(f"missing boundary query value for {field}")
    if value.isdigit():
        return f"{field}={int(value)}"
    escaped = value.replace("'", "''")
    return f"{field}='{escaped}'"

def _run(field, value, boundary_type):
    source_uri = _input_alias("GEOMETRY_SOURCE_URI", "SOURCE_URI").rstrip("/")
    if not source_uri:
        raise RuntimeError("SOURCE_URI is required for ArcGIS boundary query")
    params = _up.urlencode({
        "where": _arcgis_where(field, value),
        "outFields": "*",
        "returnGeometry": "true",
        "f": "geojson",
    })
    url = f"{source_uri}/query?{params}"
    req = _ur.Request(url, headers={"User-Agent": "svo-adapter-dfc-boundary/1.0"})
    data = json.loads(_ur.urlopen(req, timeout=120).read())
    result = {
        "status": "ok",
        "operation": "arcgis_boundary_query",
        "boundary_type": boundary_type,
        "query_field": field,
        "query_value": str(value),
        "query_url": url,
        "feature_count": len(data.get("features", [])),
        "geojson": data,
    }
    _emit_result(result)
"""

_GMA_BOUNDARY_QUERY_SNIPPET = _BOUNDARY_QUERY_HELPER + """\
_run(_input_alias("GEOMETRY_FILTER_FIELD", "BOUNDARY_QUERY_FIELD", default="GMAnum"),
     _input_alias("GEOMETRY_FILTER_VALUE", "SPATIAL_SCOPE_ID", "GMA_ID", "BOUNDARY_QUERY_VALUE"), "gma")
"""

_GCD_BOUNDARY_QUERY_SNIPPET = _BOUNDARY_QUERY_HELPER + """\
_run(_input_alias("GEOMETRY_FILTER_FIELD", "BOUNDARY_QUERY_FIELD", default="DistrictName"),
     _input_alias("GEOMETRY_FILTER_VALUE", "SPATIAL_SCOPE_NAME", "GCD_NAME", "BOUNDARY_QUERY_VALUE"), "gcd")
"""

_COUNTY_BOUNDARY_QUERY_SNIPPET = _BOUNDARY_QUERY_HELPER + """\
_run(_input_alias("GEOMETRY_FILTER_FIELD", "BOUNDARY_QUERY_FIELD", default="Name"),
     _input_alias("GEOMETRY_FILTER_VALUE", "SPATIAL_SCOPE_NAME", "COUNTY_NAME", "BOUNDARY_QUERY_VALUE"), "county")
"""

_BOUNDARY_NORMALIZE_SNIPPET = _ACTOR_HELPER + """\
_source_uri = _input_alias("GEOMETRY_SOURCE_URI", "SOURCE_URI")
_token = _input("TAPIS_TOKEN", "")
result = _actor_run({
    "operation": "boundary_to_geojson",
    "input_url": _source_uri,
    "read_token": _token,
    "params": {"target_crs": "EPSG:4326"},
})
_emit_result(result)
"""

_BOUNDARY_INTERSECT_SNIPPET = _ACTOR_HELPER + """\
_token = _input("TAPIS_TOKEN", "")
result = _actor_run({
    "operation": "intersect_boundaries",
    "read_token": _token,
    "params": {
        "gma_boundary_uri": _input_alias("GEOMETRY_SOURCE_URI", "GMA_BOUNDARY_URI"),
        "county_name": _input_alias("SPATIAL_SCOPE_NAME", "COUNTY_NAME"),
        "gcd_name": _input_alias("SPATIAL_SCOPE_NAME", "GCD_NAME"),
        "aquifer": _input("AQUIFER", "") or _input_alias("SPATIAL_SCOPE_NAME"),
    },
})
_emit_result(result)
"""

_PASSTHROUGH_SNIPPET = _INPUT_HELPER + """\
import json
result = {k: _input(k, "") for k in ("SOURCE_URI", "VARIABLE_NAME")}
result["status"] = "passthrough"
_emit_result(result)
"""

_GEO_AGGREGATE_SNIPPET = _ACTOR_HELPER + """\
_source_uri   = _input("SOURCE_URI", "")
_gma_id       = _input_alias("SPATIAL_SCOPE_ID", "GMA_ID")
_boundary_uri = _input("DFC_AREA_BOUNDARY_URI", "") or _input_alias("GEOMETRY_SOURCE_URI", "GMA_BOUNDARY_URI")
_area         = _input_alias("SPATIAL_SCOPE_NAME", "AREA")
_token        = _input("TAPIS_TOKEN", "")
result = _actor_run({
    "operation": "aggregate_gma",
    "input_url": _source_uri,
    "read_token": _token,
    "params": {"gma_id": _gma_id, "area": _area, "boundary_uri": _boundary_uri, "band": 1},
})
if isinstance(result, dict):
    result["area"] = _area
    result["scope"] = "gma" if (not _area or _area.lower().startswith("gma")) else "area"
_emit_result(result)
"""

_DFC_COMPLIANCE_SNIPPET = _INPUT_HELPER + """\
import csv, io, json, re, sys, urllib.request

_source_uri = _input("SOURCE_URI", "")
_modeled_json = _input("MODELED_SCALAR_JSON", "")
_targets_json = _input("DFC_TARGETS_JSON", "")
_targets_uri = _input("DFC_TARGETS_URI", "")
_gma_id = _input_alias("SPATIAL_SCOPE_ID", "GMA_ID")
_aquifer = _input("AQUIFER", "") or _input_alias("SPATIAL_SCOPE_NAME")
_area = _input_alias("SPATIAL_SCOPE_NAME", "AREA")
_baseline_year = _input("BASELINE_YEAR", "")
_target_year = _input("TARGET_YEAR", "")

def _die(message):
    print(json.dumps({
        "status": "error",
        "operation": "dfc_compliance",
        "error": message,
        "gma_id": _gma_id,
        "aquifer": _aquifer,
        "area": _area,
        "target_year": _target_year,
    }))
    sys.exit(2)

def _norm(value):
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()

def _read_text(uri):
    if not uri:
        return ""
    if uri.strip().startswith(("{", "[")):
        return uri
    if uri.startswith(("http://", "https://")):
        return urllib.request.urlopen(uri, timeout=60).read().decode("utf-8")
    if uri.startswith("file://"):
        uri = uri[7:]
    if uri.startswith("tapis://"):
        _die("dfc_compliance cannot read tapis:// target/model artifacts directly; pass resolved JSON or run through geo_actor/Tapis with staged inputs")
    with open(uri, "r", encoding="utf-8") as f:
        return f.read()

def _load_json(value, label):
    text = _read_text(value)
    if not text:
        _die(f"missing {label}; provide inline JSON or a readable URI")
    try:
        return json.loads(text)
    except Exception as exc:
        _die(f"invalid {label} JSON: {exc}")

def _load_targets():
    if _targets_json or _targets_uri:
        text = _read_text(_targets_json or _targets_uri)
        if text.strip().startswith(("{", "[")):
            data = json.loads(text)
            return data.get("records", data) if isinstance(data, dict) else data
        rows = list(csv.DictReader(io.StringIO(text)))
        if rows:
            return rows
    _die("missing DFC targets; provide DFC_TARGETS_JSON or DFC_TARGETS_URI")

def _modeled_value(payload):
    node = payload.get("result", payload) if isinstance(payload, dict) else payload
    if not isinstance(node, dict):
        _die("modeled scalar must be a JSON object")
    for key in ("modeled_value", "value", "average_value_ft", "average_value", "mean", "average", "total_flow", "flow"):
        value = node.get(key)
        if isinstance(value, (int, float)):
            return float(value), node.get("unit") or node.get("units") or payload.get("unit")
    _die("modeled scalar JSON did not contain a numeric modeled value")

def _target_value(record):
    values = record.get("target_values") or []
    if isinstance(values, str):
        try:
            values = json.loads(values)
        except Exception:
            values = []
    if values:
        value = values[0]
        if "value" in value:
            return float(value["value"]), value.get("unit")
        if "min" in value and "max" in value:
            return (float(value["min"]) + float(value["max"])) / 2.0, value.get("unit")
    for key in ("target_value", "dfc_target", "value"):
        if record.get(key) not in (None, ""):
            return float(record[key]), record.get("unit")
    return None, None

def _record_year(record):
    period = record.get("period") or {}
    if isinstance(period, str):
        try:
            period = json.loads(period)
        except Exception:
            period = {}
    return str(period.get("target_year") or record.get("target_year") or "")

def _matches(record):
    if _gma_id:
        rec_gma = str(record.get("gma") or record.get("gma_id") or "")
        if re.sub(r"\\D+", "", rec_gma) != re.sub(r"\\D+", "", _gma_id):
            return False
    if _aquifer and _norm(record.get("aquifer")) != _norm(_aquifer):
        return False
    if _area and _norm(record.get("area")) != _norm(_area):
        return False
    if _target_year and _record_year(record) and _record_year(record) != str(_target_year):
        return False
    return True

modeled_payload = _load_json(_modeled_json or _source_uri, "modeled scalar")
modeled, modeled_unit = _modeled_value(modeled_payload)
records = [r for r in _load_targets() if isinstance(r, dict) and _matches(r)]
if not records:
    _die("no DFC target records matched the provided GMA/aquifer/area/year")

rows = []
for record in records:
    target, target_unit = _target_value(record)
    if target is None:
        rows.append({"record_id": record.get("id"), "status": "no_target_value", "record": record})
        continue
    metric = record.get("metric") or ""
    diff = modeled - target
    if metric == "drawdown":
        status = "MEETS" if diff <= 0 else "EXCEEDS"
    elif metric in ("saturated_thickness_or_storage", "water_level", "spring_or_stream_flow"):
        status = "MEETS" if diff >= 0 else "BELOW"
    else:
        status = "UNKNOWN_METRIC"
    rows.append({
        "record_id": record.get("id"),
        "gma_id": record.get("gma") or record.get("gma_id"),
        "area": record.get("area"),
        "aquifer": record.get("aquifer"),
        "metric": metric,
        "target_value": target,
        "target_unit": target_unit,
        "modeled_value": modeled,
        "modeled_unit": modeled_unit,
        "status": status,
        "margin": diff,
        "source": record.get("source"),
    })

result = {
    "schema_version": 1,
    "status": "ok",
    "operation": "dfc_compliance",
    "source_uri": _source_uri,
    "gma_id": _gma_id,
    "aquifer": _aquifer,
    "area": _area,
    "baseline_year": _baseline_year,
    "target_year": _target_year,
    "modeled_value": modeled,
    "modeled_unit": modeled_unit,
    "results": rows,
}
_emit_result(result)
"""

# Submits extract_budget_gma to the dso-geo Tapis actor.  The actor resolves
# these ordered aliases against the CBC file's actual record names.
_BUDGET_EXTRACT_DRAIN_SNIPPET = _ACTOR_HELPER + """\
def _budget_candidates(default):
    raw = _input("BUDGET_PACKAGE_CANDIDATES", "")
    if not raw:
        return default
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        parsed = [part.strip() for part in str(raw).split(",")]
    if isinstance(parsed, str):
        parsed = [parsed]
    if not isinstance(parsed, list) or not parsed or len(parsed) > 8:
        _die("BUDGET_PACKAGE_CANDIDATES must be a non-empty list of at most 8 labels")
    candidates = [str(item).strip().upper() for item in parsed]
    if any(not item or len(item) > 64 for item in candidates):
        _die("BUDGET_PACKAGE_CANDIDATES contains an invalid label")
    return list(dict.fromkeys(candidates))

_source_uri   = _input("SOURCE_URI", "")
_gma_id       = _input_alias("SPATIAL_SCOPE_ID", "GMA_ID")
_area         = _input_alias("SPATIAL_SCOPE_NAME", "AREA")
_boundary_uri = _input("DFC_AREA_BOUNDARY_URI", "") or _input_alias("GEOMETRY_SOURCE_URI", "GMA_BOUNDARY_URI")
_token        = _input("TAPIS_TOKEN", "")
_packages     = _budget_candidates(["DRN", "DRAINS"])
result = _actor_run({
    "operation": "extract_budget_gma",
    "input_url": _source_uri,
    "read_token": _token,
    "params": {"package": _packages[0], "packages": _packages, "gma_id": _gma_id, "area": _area, "boundary_uri": _boundary_uri},
})
_emit_result(result)
"""

# Same as drain but candidate labels are for river-leakage / stream-baseflow.
_BUDGET_EXTRACT_RIVER_SNIPPET = _ACTOR_HELPER + """\
def _budget_candidates(default):
    raw = _input("BUDGET_PACKAGE_CANDIDATES", "")
    if not raw:
        return default
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        parsed = [part.strip() for part in str(raw).split(",")]
    if isinstance(parsed, str):
        parsed = [parsed]
    if not isinstance(parsed, list) or not parsed or len(parsed) > 8:
        _die("BUDGET_PACKAGE_CANDIDATES must be a non-empty list of at most 8 labels")
    candidates = [str(item).strip().upper() for item in parsed]
    if any(not item or len(item) > 64 for item in candidates):
        _die("BUDGET_PACKAGE_CANDIDATES contains an invalid label")
    return list(dict.fromkeys(candidates))

_source_uri   = _input("SOURCE_URI", "")
_gma_id       = _input_alias("SPATIAL_SCOPE_ID", "GMA_ID")
_area         = _input_alias("SPATIAL_SCOPE_NAME", "AREA")
_boundary_uri = _input("DFC_AREA_BOUNDARY_URI", "") or _input_alias("GEOMETRY_SOURCE_URI", "GMA_BOUNDARY_URI")
_token        = _input("TAPIS_TOKEN", "")
_packages     = _budget_candidates(["RIV", "RIVER LEAKAGE"])
result = _actor_run({
    "operation": "extract_budget_gma",
    "input_url": _source_uri,
    "read_token": _token,
    "params": {"package": _packages[0], "packages": _packages, "gma_id": _gma_id, "area": _area, "boundary_uri": _boundary_uri},
})
_emit_result(result)
"""

# Submits extract_satthk_gma to the dso-geo actor (returns mean head as proxy;
# full sat-thickness requires DIS geometry — see actor note in response).
_SAT_THICKNESS_SNIPPET = _ACTOR_HELPER + """\
_source_uri = _input("SOURCE_URI", "")
_gma_id     = _input_alias("SPATIAL_SCOPE_ID", "GMA_ID")
_area       = _input_alias("SPATIAL_SCOPE_NAME", "AREA")
_boundary_uri = _input("DFC_AREA_BOUNDARY_URI", "") or _input_alias("GEOMETRY_SOURCE_URI", "GMA_BOUNDARY_URI")
_layer      = int(_input_alias("MODEL_LAYER", "LAYER", default="1"))
_token      = _input("TAPIS_TOKEN", "")
result = _actor_run({
    "operation": "extract_satthk_gma",
    "input_url": _source_uri,
    "read_token": _token,
    "params": {"layer": _layer, "gma_id": _gma_id, "area": _area, "boundary_uri": _boundary_uri},
})
_emit_result(result)
"""

# Submits hds_to_geotiff to the dso-geo actor. Shared by all four MODFLOW-version
# format_convert specs; the version distinction lives in the input contract's format tag.
_FORMAT_CONVERT_SNIPPET = _ACTOR_HELPER + """\
_source_uri = _input("SOURCE_URI", "")
_layer      = int(_input_alias("MODEL_LAYER", "LAYER", default="1"))
_sp         = int(_input("STRESS_PERIOD", "1"))
_ts         = int(_input("TIMESTEP", "1"))
_token      = _input("TAPIS_TOKEN", "")
result = _actor_run({
    "operation": "hds_to_geotiff",
    "input_url": _source_uri,
    "output_name": "head_output.tif",
    "read_token": _token,
    "params": {"layer": _layer, "stress_period": _sp, "timestep": _ts},
})
_emit_result(result)
"""


# Submits rasterize_points to the dso-geo actor: burns a numeric field from a
# point/polygon vector layer (e.g. a GeoParquet of per-model-cell values, such
# as MODFLOW storativity keyed by row/col/layer) onto a regular grid.
# ATTRIBUTE_FILTER (optional) selects one layer/slice out of a stacked
# multi-layer dataset via a single "<field> = <number>" equality.
_RASTERIZE_POINTS_SNIPPET = _ACTOR_HELPER + """\
_source_uri = _input("SOURCE_URI", "")
_value_field = _input("VALUE_FIELD", "")
_pixel_size = float(_input("PIXEL_SIZE", "1"))
_attribute_filter = _input("ATTRIBUTE_FILTER") or None
_token = _input("TAPIS_TOKEN", "")
result = _actor_run({
    "operation": "rasterize_points",
    "input_url": _source_uri,
    "output_name": "rasterized.tif",
    "read_token": _token,
    "params": {"value_field": _value_field, "pixel_size": _pixel_size,
               "attribute_filter": _attribute_filter},
})
_emit_result(result)
"""

# Submits dis_top_to_geotiff to the dso-geo actor: parses a MODFLOW 6 text DIS
# package's `top` array + grid geometry (XORIGIN/YORIGIN/ANGROT/delr/delc) and
# writes a rotation-aware georeferenced GeoTIFF of land-surface elevation.
_DIS_TOP_TO_GEOTIFF_SNIPPET = _ACTOR_HELPER + """\
_source_uri = _input("SOURCE_URI", "")
_crs_wkt = _input("CRS_WKT") or None
_token = _input("TAPIS_TOKEN", "")
result = _actor_run({
    "operation": "dis_top_to_geotiff",
    "input_url": _source_uri,
    "output_name": "dis_top.tif",
    "read_token": _token,
    "params": {"crs_wkt": _crs_wkt},
})
_emit_result(result)
"""


_FUSED_DFC_CHAIN_SNIPPET = _ACTOR_HELPER + """\
import base64 as _b64, os, json

_STEPS = json.loads(_b64.b64decode(_DFC_STEPS_B64))
_source_uri = _input("SOURCE_URI", "")
_gma_id = _input_alias("SPATIAL_SCOPE_ID", "GMA_ID")
_boundary_uri = _input("DFC_AREA_BOUNDARY_URI", "") or _input_alias("GEOMETRY_SOURCE_URI", "GMA_BOUNDARY_URI")
_area = _input_alias("SPATIAL_SCOPE_NAME", "AREA")
_token = _input("TAPIS_TOKEN", "")
_grid_uri = _input("GRID_URI", "")
_current_source = _source_uri
_last_result = None
_last_kind = ""
_hds_convert = None
_pending_factor = 1.0
_pending_unit = ""
_outputs = []

def _checked_actor_run(msg):
    result = _actor_run(msg)
    if isinstance(result, dict) and str(result.get("status") or "").lower() == "error":
        _die(f"geo_actor {msg.get('operation')} failed: {result.get('message') or result}")
    return result

def _unit_factor_for_step(step):
    text = f"{step.get('name') or ''} {step.get('stage') or ''}".lower()
    factors = [
        ("head-m-to-ft", 3.28084, "ft"),
        ("head-ft-to-m", 0.3048, "m"),
        ("satthk-m-to-ft", 3.28084, "ft"),
        ("satthk-ft-to-m", 0.3048, "m"),
        ("thickness-m-to-ft", 3.28084, "ft"),
        ("thickness-ft-to-m", 0.3048, "m"),
        ("displacement-m-to-mm", 1000.0, "mm"),
        ("displacement-mm-to-m", 0.001, "m"),
        ("m3s-to-af-month", 2131.7, "af_month"),
        ("m3s-to-cfs", 35.3147, "cfs"),
        ("cfs-to-af-month", 60.376, "af_month"),
        ("af-month-to-cfs", 0.016562, "cfs"),
        ("cfs-to-m3s", 0.028317, "m3s"),
        ("m3s-to-mgd", 22.8245, "mgd"),
        ("mgd-to-m3s", 0.043813, "m3s"),
        ("cfs-to-mgd", 0.64632, "mgd"),
        ("mgd-to-cfs", 1.5472, "cfs"),
    ]
    for marker, factor, unit in factors:
        if marker in text:
            return factor, unit
    return 1.0, ""

def _scale_payload(payload, factor, unit):
    if factor == 1.0:
        return payload
    if isinstance(payload, (int, float)):
        return {"value": payload * factor, "unit": unit, "conversion_factor_applied": factor}
    if not isinstance(payload, dict):
        return payload
    out = dict(payload)
    numeric_keys = {
        "value", "mean", "average", "average_value", "average_head",
        "min", "max", "median", "total", "total_flow", "flow",
        "spring_flow", "stream_flow", "baseflow", "head",
    }
    scaled = False
    for key in numeric_keys:
        value = out.get(key)
        if isinstance(value, (int, float)):
            out[key] = value * factor
            scaled = True
    for key in ("result", "results", "statistics", "stats", "properties"):
        value = out.get(key)
        if isinstance(value, dict):
            out[key] = _scale_payload(value, factor, unit)
    if scaled:
        out["unit"] = unit
        out["conversion_factor_applied"] = factor
    return out

for _step in _STEPS:
    _kind = (_step.get("transform_type") or "").lower()
    if _kind == "format_convert":
        _layer = int(_input_alias("MODEL_LAYER", "LAYER", default="1"))
        _sp = int(_input("STRESS_PERIOD", "1"))
        _ts = int(_input("TIMESTEP", "1"))
        _hds_convert = {"layer": _layer, "stress_period": _sp, "timestep": _ts}
        _last_result = {
            "status": "pending_actor_side_hds_aggregate",
            "source_uri": _current_source,
            **_hds_convert,
        }
        _last_kind = _kind
        _outputs.append({"step": _step.get("step"), "name": _step.get("name"), "status": "pending_actor_side_hds_aggregate"})
    elif _kind == "unit_convert":
        _factor, _unit = _unit_factor_for_step(_step)
        if _factor == 1.0 and not _unit:
            _die(f"no unit conversion rule matched {_step.get('name')!r}")
        if _last_result is not None and _last_kind in {
            "geo_aggregate", "budget_extract_drain", "budget_extract_river", "sat_thickness_extract"
        }:
            _last_result = _scale_payload(_last_result, _factor, _unit)
            _outputs.append({"step": _step.get("step"), "name": _step.get("name"), "status": "applied", "conversion_factor": _factor, "target_unit": _unit})
        else:
            _pending_factor *= _factor
            _pending_unit = _unit
            _outputs.append({"step": _step.get("step"), "name": _step.get("name"), "status": "pending", "conversion_factor": _factor, "target_unit": _unit})
        _last_kind = _kind
    elif _kind == "geo_aggregate":
        if _hds_convert:
            _last_result = _checked_actor_run({
                "operation": "hds_aggregate_gma",
                "input_url": _current_source,
                "read_token": _token,
                "params": {
                    "gma_id": _gma_id,
                    "area": _area,
                    "boundary_uri": _boundary_uri,
                    "grid_uri": _grid_uri,
                    "band": 1,
                    **_hds_convert,
                },
            })
        else:
            _last_result = _checked_actor_run({
                "operation": "aggregate_gma",
                "input_url": _current_source,
                "read_token": _token,
                "params": {"gma_id": _gma_id, "area": _area, "boundary_uri": _boundary_uri, "band": 1},
            })
        if _pending_factor != 1.0:
            _last_result = _scale_payload(_last_result, _pending_factor, _pending_unit)
            _pending_factor = 1.0
            _pending_unit = ""
        _last_kind = _kind
        _outputs.append({"step": _step.get("step"), "name": _step.get("name"), "status": "ok", "result": _last_result})
    elif _kind in ("budget_extract_drain", "budget_extract_river"):
        _default_packages = ["DRN", "DRAINS"] if _kind == "budget_extract_drain" else ["RIV", "RIVER LEAKAGE"]
        _raw_packages = _input("BUDGET_PACKAGE_CANDIDATES", "")
        if _raw_packages:
            try:
                _packages = json.loads(_raw_packages) if isinstance(_raw_packages, str) else _raw_packages
            except (TypeError, ValueError):
                _packages = [part.strip() for part in str(_raw_packages).split(",")]
        else:
            _packages = _default_packages
        if isinstance(_packages, str):
            _packages = [_packages]
        if not isinstance(_packages, list) or not _packages or len(_packages) > 8:
            _die("BUDGET_PACKAGE_CANDIDATES must be a non-empty list of at most 8 labels")
        _packages = list(dict.fromkeys(str(item).strip().upper() for item in _packages))
        if any(not item or len(item) > 64 for item in _packages):
            _die("BUDGET_PACKAGE_CANDIDATES contains an invalid label")
        _last_result = _checked_actor_run({
            "operation": "extract_budget_gma",
            "input_url": _current_source,
            "read_token": _token,
            "params": {"package": _packages[0], "packages": _packages, "gma_id": _gma_id, "area": _area, "boundary_uri": _boundary_uri},
        })
        _last_kind = _kind
        _outputs.append({"step": _step.get("step"), "name": _step.get("name"), "status": "ok", "result": _last_result})
    elif _kind == "sat_thickness_extract":
        _layer = int(_input_alias("MODEL_LAYER", "LAYER", default="1"))
        _last_result = _checked_actor_run({
            "operation": "extract_satthk_gma",
            "input_url": _current_source,
            "read_token": _token,
            "params": {"layer": _layer, "gma_id": _gma_id, "area": _area, "boundary_uri": _boundary_uri},
        })
        _last_kind = _kind
        _outputs.append({"step": _step.get("step"), "name": _step.get("name"), "status": "ok", "result": _last_result})
    else:
        _die(f"unsupported fused DFC transform type: {_kind}")

if _pending_factor != 1.0 and _last_result is not None:
    _last_result = _scale_payload(_last_result, _pending_factor, _pending_unit)

print(json.dumps({
    "schema_version": 1,
    "status": "ok",
    "operation": "dfc_transform_chain",
    "source_uri": _source_uri,
    "steps": _outputs,
    "result": _last_result,
}))
"""


# Input-side AOI piece. SOURCE (read via _input) accepts:
#   * GeoJSON text: a Geometry, Feature or FeatureCollection;
#   * the Ensemble Manager's object form, {"kind": "geojson", "geometry": {...}} or
#     {"kind": "bbox", "bbox": [minx, miny, maxx, maxy]} (as JSON text);
#   * a bounding box, "minx miny maxx maxy" (commas or spaces) or a JSON list of 4 numbers;
#   * the `result` of a preceding boundary piece: JSON (or JSON text inside JSON,
#     e.g. a geo_actor blob) whose GeoJSON is nested anywhere below the top level.
# Coordinates must already be lon/lat (EPSG:4326). Output: ctx.set_output("result",
# <FeatureCollection text>) with exactly one (Multi)Polygon feature, sorted keys,
# 7-decimal coordinates. Stdlib only unless buffer_m/simplify_m > 0, when shapely and
# pyproj are pip-installed at task start. dissolve=true only merges several polygons
# into one MultiPolygon feature (concatenation, no union); a true union happens only
# on the shapely path (buffer_m/simplify_m > 0). Overlapping parts are not unioned otherwise.
_AOI_FROM_BOUNDARY_SNIPPET = _INPUT_HELPER + """\
import math, subprocess, sys, tempfile

_GEOJSON_TYPES = {"Polygon", "MultiPolygon", "Point", "MultiPoint", "LineString",
                  "MultiLineString", "GeometryCollection", "Feature", "FeatureCollection"}

def _num(name, default):
    try:
        return float(_input(name, default))
    except (TypeError, ValueError):
        _die(name + " must be a number")

def _flag(name, default):
    return str(_input(name, default)).strip().lower() in ("1", "true", "yes", "y", "on")

_buffer_m = _num("BUFFER_M", 0)
_simplify_m = _num("SIMPLIFY_M", 0)
_dissolve = _flag("DISSOLVE", "true")
_bbox_only = _flag("BBOX_ONLY", "false")
_max_area_km2 = _num("MAX_AREA_KM2", 160000)

def _find_geojson(value, depth=0):
    if isinstance(value, str):
        text = value.strip()
        if text[:1] not in ("{", "["):
            return None
        try:
            value = json.loads(text)
        except ValueError:
            return None
    if depth > 8:
        return None
    if isinstance(value, dict):
        if value.get("type") in _GEOJSON_TYPES:
            return value
        children = list(value.values())
    elif isinstance(value, list):
        if value and all(isinstance(i, dict) and i.get("type") in _GEOJSON_TYPES for i in value):
            return {"type": "FeatureCollection", "features": value}
        children = value
    else:
        return None
    for child in children:
        found = _find_geojson(child, depth + 1)
        if found is not None:
            return found
    return None

def _bbox_from(value):
    parts = value
    if isinstance(value, str):
        text = value.strip()
        if text[:1] == "[":
            try:
                parts = json.loads(text)
            except ValueError:
                return None
        else:
            parts = text.replace(",", " ").split()
    if not isinstance(parts, list) or len(parts) != 4:
        return None
    try:
        minx, miny, maxx, maxy = [float(p) for p in parts]
    except (TypeError, ValueError):
        return None
    if not (minx < maxx and miny < maxy):
        _die("bounding box must be minx miny maxx maxy with min < max")
    return [[[[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy], [minx, miny]]]]

def _collect(geom, out):
    kind = geom.get("type") if isinstance(geom, dict) else None
    if kind == "Polygon":
        out.append(geom.get("coordinates") or [])
    elif kind == "MultiPolygon":
        out.extend(geom.get("coordinates") or [])
    elif kind == "GeometryCollection":
        for child in geom.get("geometries") or []:
            _collect(child, out)
    elif kind == "Feature":
        if geom.get("geometry"):
            _collect(geom["geometry"], out)
    elif kind == "FeatureCollection":
        for child in geom.get("features") or []:
            _collect(child, out)
    else:
        _die("unsupported geometry type %r: the area of interest must be a polygon" % (kind,))

def _clean_ring(ring):
    points = []
    for point in ring:
        try:
            x, y = float(point[0]), float(point[1])
        except (TypeError, ValueError, IndexError):
            _die("malformed coordinate in the area of interest")
        if not (math.isfinite(x) and math.isfinite(y)):
            _die("non-finite coordinate in the area of interest")
        if abs(x) > 180 or abs(y) > 90:
            _die("coordinates look projected; the area of interest must be lon/lat EPSG:4326")
        points.append([round(x, 7), round(y, 7)])
    if points and points[0] != points[-1]:
        points.append(list(points[0]))
    if len(points) < 4:
        _die("a polygon ring needs at least 3 distinct points")
    return points

def _clean_polygons(polygons):
    return [[_clean_ring(ring) for ring in polygon] for polygon in polygons if polygon]

def _extent(polygons):
    xs = [p[0] for poly in polygons for ring in poly for p in ring]
    ys = [p[1] for poly in polygons for ring in poly for p in ring]
    return min(xs), min(ys), max(xs), max(ys)

def _area_km2(extent):
    minx, miny, maxx, maxy = extent
    mid = math.radians((miny + maxy) / 2.0)
    return (maxx - minx) * 111.32 * math.cos(mid) * (maxy - miny) * 110.574

def _shapely_pass(polygons):
    # buffer/simplify run in a local metric projection; shapely/pyproj are not in
    # the function runtime, so install them here (only when asked for).
    target = tempfile.mkdtemp(prefix="aoi-libs-")
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet",
                               "--target", target, "shapely", "pyproj"])
    except Exception as exc:
        _die("could not install shapely/pyproj for buffer/simplify: %s" % type(exc).__name__)
    sys.path.insert(0, target)
    import pyproj
    from shapely.geometry import shape
    from shapely.ops import transform, unary_union
    from shapely.validation import make_valid
    geom = unary_union([make_valid(shape({"type": "Polygon", "coordinates": p})) for p in polygons])
    centre = geom.centroid
    local = "+proj=aeqd +lat_0=%.6f +lon_0=%.6f +datum=WGS84 +units=m" % (centre.y, centre.x)
    forward = pyproj.Transformer.from_crs("EPSG:4326", local, always_xy=True).transform
    inverse = pyproj.Transformer.from_crs(local, "EPSG:4326", always_xy=True).transform
    metric = transform(forward, geom)
    if _buffer_m > 0:
        metric = metric.buffer(_buffer_m)
    if _simplify_m > 0:
        metric = metric.simplify(_simplify_m, preserve_topology=True)
    geom = make_valid(transform(inverse, metric))
    parts = [g for g in getattr(geom, "geoms", [geom]) if g.geom_type in ("Polygon", "MultiPolygon")]
    out = []
    for part in parts:
        for poly in getattr(part, "geoms", [part]):
            out.append([[list(c) for c in poly.exterior.coords]]
                       + [[list(c) for c in ring.coords] for ring in poly.interiors])
    return out

_source = _input("SOURCE", "")
if not str(_source).strip():
    _die("empty input: SOURCE must be GeoJSON, a bounding box, or a boundary result")

_polygons = None
_parsed = _source
if isinstance(_source, str) and _source.strip()[:1] == "{":
    try:
        _parsed = json.loads(_source)
    except ValueError:
        _parsed = _source
if isinstance(_parsed, dict) and _parsed.get("kind") == "bbox":
    # The Ensemble Manager's object form: {"kind": "bbox", "bbox": [minx, miny, maxx, maxy]}.
    _polygons = _bbox_from(_parsed.get("bbox"))
    if _polygons is None:
        _die("bbox source must hold four numbers: minx miny maxx maxy")
elif isinstance(_parsed, dict) and _parsed.get("kind") == "geojson":
    _source = _parsed.get("geometry")
else:
    _polygons = _bbox_from(_source)
if _polygons is None:
    _found = _find_geojson(_source)
    if _found is None:
        _die("SOURCE holds no GeoJSON polygon and is not a bounding box")
    _polygons = []
    _collect(_found, _polygons)
_polygons = _clean_polygons(_polygons)
if not _polygons:
    _die("empty input: no polygon in SOURCE")

if _buffer_m > 0 or _simplify_m > 0:
    _polygons = _clean_polygons(_shapely_pass(_polygons))
    if not _polygons:
        _die("the area of interest is empty after buffer/simplify")
if _bbox_only:
    _minx, _miny, _maxx, _maxy = _extent(_polygons)
    _polygons = [[[[_minx, _miny], [_maxx, _miny], [_maxx, _maxy], [_minx, _maxy], [_minx, _miny]]]]
if len(_polygons) > 1 and not _dissolve:
    _die("SOURCE has several polygons; set dissolve=true to merge them into one feature")

_area = _area_km2(_extent(_polygons))
if _area > _max_area_km2:
    _die("region too large (%.0f km2 > max_area_km2 %.0f); bind an AOI dataset or choose a smaller region"
         % (_area, _max_area_km2))

_geometry = ({"type": "Polygon", "coordinates": _polygons[0]} if len(_polygons) == 1
             else {"type": "MultiPolygon", "coordinates": _polygons})
_text = json.dumps({"type": "FeatureCollection",
                    "features": [{"type": "Feature", "properties": {}, "geometry": _geometry}]},
                   sort_keys=True, separators=(",", ":"))
if _ctx is not None:
    try:
        _ctx.set_output("result", _text)
    except Exception:
        pass
import hashlib
print("sha256=%s bytes=%d" % (hashlib.sha256(_text.encode()).hexdigest(), len(_text.encode())))
"""


def _json_b64(value: object) -> str:
    return base64.b64encode(json.dumps(value).encode()).decode()


def get_fused_dfc_chain_code(steps: list[dict]) -> str:
    """Return the deprecated fused DFC compatibility task source.

    The normal workflow generator no longer calls this helper: modular chains
    use named task outputs and explicit task-output references. Keep the helper
    temporarily for persisted/legacy callers that still inspect or replay the
    old fused definition.
    """
    serializable = [
        {
            "step": step.get("step"),
            "name": step.get("name"),
            "stage": step.get("stage"),
            "transform_type": step.get("transform_type"),
        }
        for step in steps
    ]
    steps_b64 = _json_b64(serializable)
    code = f"_DFC_STEPS_B64 = {steps_b64!r}\n" + _FUSED_DFC_CHAIN_SNIPPET
    return textwrap.dedent(code)


def get_code(transform_type: str | None) -> str:
    """Return the Python source string for the given transform_type.

    Unknown transform types fail closed with a JSON error instead of emitting a
    successful placeholder, so generated workflows do not appear complete when
    no real code builder exists. The caller embeds this string directly in the
    OWE function task definition.
    """
    t = (transform_type or "").lower()
    if t == "point_extract":
        return textwrap.dedent(_POINT_EXTRACT_SNIPPET)
    if t == "gma_boundary_query":
        return textwrap.dedent(_GMA_BOUNDARY_QUERY_SNIPPET)
    if t == "gcd_boundary_query":
        return textwrap.dedent(_GCD_BOUNDARY_QUERY_SNIPPET)
    if t == "county_boundary_query":
        return textwrap.dedent(_COUNTY_BOUNDARY_QUERY_SNIPPET)
    if t == "boundary_normalize":
        return textwrap.dedent(_BOUNDARY_NORMALIZE_SNIPPET)
    if t == "boundary_intersect":
        return textwrap.dedent(_BOUNDARY_INTERSECT_SNIPPET)
    if t == "unit_convert":
        return textwrap.dedent(_UNIT_CONVERT_SNIPPET)
    if t == "passthrough":
        return textwrap.dedent(_PASSTHROUGH_SNIPPET)
    if t == "geo_aggregate":
        return textwrap.dedent(_GEO_AGGREGATE_SNIPPET)
    if t == "dfc_compliance":
        return textwrap.dedent(_DFC_COMPLIANCE_SNIPPET)
    if t == "budget_extract_drain":
        return textwrap.dedent(_BUDGET_EXTRACT_DRAIN_SNIPPET)
    if t == "budget_extract_river":
        return textwrap.dedent(_BUDGET_EXTRACT_RIVER_SNIPPET)
    if t == "sat_thickness_extract":
        return textwrap.dedent(_SAT_THICKNESS_SNIPPET)
    if t == "format_convert":
        return textwrap.dedent(_FORMAT_CONVERT_SNIPPET)
    if t == "rasterize_points":
        return textwrap.dedent(_RASTERIZE_POINTS_SNIPPET)
    if t == "dis_top_to_geotiff":
        return textwrap.dedent(_DIS_TOP_TO_GEOTIFF_SNIPPET)
    if t == "aoi_from_boundary":
        return textwrap.dedent(_AOI_FROM_BOUNDARY_SNIPPET)
    # Unknown transform code must fail closed. Returning a successful stub makes
    # a generated workflow look complete even though no real transform ran.
    return (
        "import json, sys\n"
        f"print(json.dumps({{'status': 'error', 'transform_type': {transform_type!r},"
        " 'message': 'no code builder for this transform_type'}))\n"
        "sys.exit(2)\n"
    )
