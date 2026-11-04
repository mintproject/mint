"""The `catalog` marker round-trips through MINT's ETL contract table.

MINT's modelcatalog_etl_process_contract has no catalog column, so the marker
is written into schema_requirement_json["_svo"] by register_existing_etl_pieces
and lifted into metadata_json["catalog"] by mint_sync.etl_process_to_spec_row,
where the planner reads it. Rows here are MINT-shaped (fixtures -> to_object ->
etl_process_to_spec_row), not the raw fixtures.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.mint_sync import etl_process_to_spec_row  # noqa: E402
from app.models import DataObjectContract  # noqa: E402
from app.planner import _catalogs, find_path  # noqa: E402

_SCRIPT = ROOT / "scripts" / "register_existing_etl_pieces.py"
_spec = importlib.util.spec_from_file_location("register_existing_etl_pieces", _SCRIPT)
register = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(register)

EXAMPLES = ROOT / "examples"
DISPLACEMENT = "https://www.geoscienceontology.org/svo/svl/variable/land_surface__displacement"


def _sync(process: dict) -> dict:
    warnings: list[str] = []
    row = etl_process_to_spec_row(process, warnings)
    assert row is not None and not warnings
    return row


def _process(contracts: list[dict]) -> dict:
    return {"id": "etl-x", "label": "x", "contracts": contracts}


def test_sync_lifts_catalog_marker_and_strips_it_from_schema():
    row = _sync(_process([
        {"role": "input", "position": 0},
        {"role": "output", "position": 0,
         "schema_requirement_json": {"x": 1, "_svo": {"catalog": "ckan+stac"}}},
    ]))
    out = row["contracts"]["data"][1]
    assert out["metadata_json"] == {"mint_position": 0, "catalog": "ckan+stac"}
    assert out["schema_requirement_json"] == {"x": 1}


def test_sync_rows_without_marker_are_unchanged():
    row = _sync(_process([
        {"role": "input", "position": 0},
        {"role": "output", "position": 1, "schema_requirement_json": {"x": 1}},
    ]))
    out = row["contracts"]["data"][1]
    assert out["schema_requirement_json"] == {"x": 1}
    assert out["metadata_json"] == {"mint_position": 1}


def test_to_object_merges_marker_without_dropping_schema_keys():
    spec = {"name": "p", "contracts": [
        {"role": "output", "catalog": "ckan+stac", "schema_requirement_json": {"keep": True}},
        {"role": "input", "schema_requirement_json": {"keep": True}},
        {"role": "input"},
    ]}
    data = register.to_object(spec)["contracts"]["data"]
    assert data[0]["schema_requirement_json"] == {"keep": True, "_svo": {"catalog": "ckan+stac"}}
    assert data[1]["schema_requirement_json"] == {"keep": True}
    assert data[2]["schema_requirement_json"] is None
    # the source spec is not mutated
    assert spec["contracts"][0]["schema_requirement_json"] == {"keep": True}


def test_catalogs_ignores_org_scope():
    assert _catalogs("ckan+stac:stac-datasets") == _catalogs("ckan+stac") == {"ckan", "stac"}


def _mint_registry(*fixture_names: str) -> list[dict]:
    """Fixture transform_specs pushed through the MINT write/read path."""
    entries = []
    for name in fixture_names:
        payload = json.loads((EXAMPLES / name).read_text())
        entries += [(name, s) for s in payload["transform_specs"]]
    registry = []
    for obj in register.unique_rows(entries):
        process = {**obj, "contracts": obj["contracts"]["data"]}
        row = _sync(process)
        # The registry query returns contracts as a plain list, not insert-input form.
        registry.append({**row, "contracts": row["contracts"]["data"]})
    return registry


def _h2i_case(target_key: str):
    data = json.loads((EXAMPLES / "subside_h2i_transforms.json").read_text())
    var = data["source_data_object"]["variables"][0]
    source = DataObjectContract(
        standard_variable_uri=var["standard_variable_uri"], unit=var["unit"],
        format=data["source_data_object"]["format"], spatial_type=var["spatial_type"],
        crs=var["crs"], temporal_resolution=var["temporal_resolution"],
        resource_uri=data["source_data_object"]["resource_uri"],
    )
    target = DataObjectContract(**{k: v for k, v in data[target_key].items() if not k.startswith("_")})
    return source, target


def test_cataloged_h2i_target_plans_stac_publish_from_mint_shaped_rows():
    registry = _mint_registry("subside_h2i_transforms.json", "subside_werc_transforms.json")
    source, cataloged = _h2i_case("target_model_input_cataloged")
    # The target-side marker lives on the target itself (a plain target has none).
    assert cataloged.catalog == "ckan+stac"
    path = find_path(source, cataloged, registry)
    assert path is not None
    assert [s["name"] for s in path] == ["run-h2i", "stac-publish"]

    _, plain = _h2i_case("target_model_input")
    assert plain.catalog is None
    assert [s["name"] for s in find_path(source, plain, registry)] == ["run-h2i"]


def test_displacement_m_to_mm_plans_one_unit_convert_step():
    registry = _mint_registry("subside_units_transforms.json")
    def contract(unit):
        return DataObjectContract(standard_variable_uri=DISPLACEMENT, unit=unit,
                                  format="geotiff", resource_uri="tapis://x/y.tif")
    path = find_path(contract("m"), contract("mm"), registry)
    assert [s["name"] for s in path] == ["displacement-m-to-mm"]
    assert len(path) == 1
    back = find_path(contract("mm"), contract("m"), registry)
    assert [s["name"] for s in back] == ["displacement-mm-to-m"]
