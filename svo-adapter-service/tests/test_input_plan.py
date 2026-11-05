"""plan_model_inputs: which input-side ETL steps a model run needs, derived from
the catalog's app-input binding (design 2026-11-05-app-input-binding.md section 4)."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).parent))

import pytest  # noqa: E402

from app.input_plan import InputPlanError, plan_model_inputs  # noqa: E402
from input_stage_fixtures import AOI_VAR, model_row  # noqa: E402

AOI_SPEC = json.loads((ROOT / "examples" / "aoi_transforms.json").read_text())["transform_specs"][0]
COUNTY = "https://w3id.org/okn/i/mint/county__boundary"
SQUARE = {"type": "Polygon", "coordinates": [[[-97.3, 31.4], [-96.9, 31.4], [-96.9, 31.7], [-97.3, 31.7], [-97.3, 31.4]]]}
GEO = {"kind": "geojson", "geometry": SQUARE}
BBOX = {"kind": "bbox", "bbox": [-97.3, 31.4, -96.9, 31.7]}


def registry(*models):
    return [{**AOI_SPEC, "id": AOI_SPEC.get("id") or "ts-aoi-from-boundary"}, *models]


def plan(models=None, sources=None, filled=(), config="cfg-1"):
    models = [model_row()] if models is None else models
    return plan_model_inputs(registry(*models), None, config, sources or [BBOX], filled)


def outcomes(result):
    return [(c["app_input_name"], c["outcome"], c["blocking"]) for c in result["considered"]]


def test_a_bound_unfilled_reachable_input_gets_one_step_even_with_two_presentations():
    row = model_row(inputs=[("aoi-geojson", True, "ds-aoi", COUNTY, "geojson"),
                            ("aoi-geojson", True, "ds-aoi", AOI_VAR, "geojson")])
    result = plan([row])
    assert result["registry"] == "ok" and result["registry_synced_at"] == row["mint_synced_at"]
    [step] = result["input_steps"]
    assert step["name"] == step["app_input_name"] == "aoi-geojson"
    assert [s["transform_type"] for s in step["steps"]] == ["aoi_from_boundary"]
    assert step["source"] == BBOX and step["extension"] == "geojson"
    assert step["params"]["max_area_km2"] == 160000
    assert outcomes(result) == [("aoi-geojson", "planned", False)]
    assert result["considered"][0]["standard_variable_uri"] == AOI_VAR


def test_a_filled_input_is_skipped():
    result = plan(filled=["aoi-geojson"])
    assert result["input_steps"] == [] and outcomes(result) == [("aoi-geojson", "filled", False)]


def test_unbound_inputs_are_reported_once_per_dataset_specification():
    unbound = model_row(inputs=[(None, True, "ds-a", AOI_VAR, "geojson"), (None, True, "ds-a", COUNTY, "geojson"),
                                (None, False, "ds-b", AOI_VAR, "geojson")])
    result = plan([unbound])
    assert result["input_steps"] == []
    assert outcomes(result) == [(None, "unbound", False)] * 2


def test_no_path_is_non_blocking_when_optional_and_blocking_when_required():
    optional = plan([model_row(inputs=[("x", True, "ds", COUNTY, "geojson")])])
    required = plan([model_row(inputs=[("x", False, "ds", COUNTY, "geojson")])])
    assert outcomes(optional) == [("x", "no_path", False)] and optional["input_steps"] == []
    assert outcomes(required) == [("x", "no_path", True)]


def test_a_model_missing_from_the_registry_is_reported_not_raised():
    result = plan(config="cfg-other")
    assert result["registry"] == "missing" and result["input_steps"] == [] and result["considered"] == []


@pytest.mark.parametrize("source,code", [
    ({"kind": "wkt"}, "INPUT_SOURCE_INVALID"),
    ({"kind": "geojson", "geometry": {"type": "Point", "coordinates": [0, 0]}}, "INPUT_SOURCE_INVALID"),
    ({"kind": "geojson", "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]]]}},
     "INPUT_SOURCE_INVALID"),
    ({"kind": "geojson", "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [float("nan"), 1], [0, 0]]]}},
     "INPUT_SOURCE_INVALID"),
    ({"kind": "bbox", "bbox": [1, 2, 3]}, "INPUT_SOURCE_INVALID"),
    ({"kind": "bbox", "bbox": [1, 2, float("inf"), 4]}, "INPUT_SOURCE_INVALID"),
    ({"kind": "bbox", "bbox": [-120, 20, -80, 45]}, "AOI_REGION_TOO_LARGE"),
])
def test_bad_sources_raise_the_right_code(source, code):
    with pytest.raises(InputPlanError) as excinfo:
        plan(sources=[source])
    assert excinfo.value.code == code and excinfo.value.message


def test_too_many_polygons_or_vertices_are_rejected():
    ring = [[0, 0], [0.1, 0], [0.1, 0.1], [0, 0]]
    many_polygons = {"type": "MultiPolygon", "coordinates": [[ring]] * 501}
    many_vertices = {"type": "Polygon", "coordinates": [[[i / 1e6, 0] for i in range(50_000)] + [[0, 0.1], [0, 0]]]}
    for geometry in (many_polygons, many_vertices):
        with pytest.raises(InputPlanError) as excinfo:
            plan(sources=[{"kind": "geojson", "geometry": geometry}])
        assert excinfo.value.code == "INPUT_SOURCE_INVALID"


def test_the_digest_is_stable_and_follows_the_steps():
    first, again = plan(), plan()
    assert first["steps_digest"] == again["steps_digest"] and len(first["steps_digest"]) == 64
    assert plan(sources=[GEO])["steps_digest"] != first["steps_digest"]
    assert plan(filled=["aoi-geojson"])["steps_digest"] != first["steps_digest"]


@pytest.mark.parametrize("fmt,ext", [("geojson", "geojson"), ("json", "json"), ("csv", "csv"), ("netcdf", "nc"),
                                     ("geotiff", "tif"), ("tiff", "tif"), ("shapefile", "dat"), (None, "dat")])
def test_the_extension_follows_the_target_format(fmt, ext):
    # Only geojson is reachable from the AOI piece, so the mapping is checked directly.
    from app.input_plan import _extension
    assert _extension({"format": fmt}) == ext


def test_ties_break_on_source_order():
    first = plan(sources=[GEO, BBOX])["input_steps"][0]["source"]
    second = plan(sources=[BBOX, GEO])["input_steps"][0]["source"]
    assert first["kind"] == "geojson" and second["kind"] == "bbox"


def test_the_model_row_is_never_an_intermediate_step():
    # A model that consumes the AOI and "produces" the AOI would otherwise chain from itself.
    looping = model_row(inputs=[("aoi-geojson", True, "ds-aoi", AOI_VAR, "geojson")])
    looping["contracts"][-1] = {"id": "loop-out", "role": "output", "standard_variable_uri": AOI_VAR, "format": "geojson"}
    result = plan([looping])
    assert [s["transform_type"] for s in result["input_steps"][0]["steps"]] == ["aoi_from_boundary"]
