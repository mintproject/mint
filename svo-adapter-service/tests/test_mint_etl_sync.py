from app.mint_sync import _build_env_from_args, etl_process_to_spec_row


def test_spatial_mint_labels_use_canonical_args_and_preserve_two_uri_etls():
    warnings = []
    env = _build_env_from_args([
        {"parameter": {"label": "gma boundary uri"}},
        {"parameter": {"label": "dfc area boundary uri"}},
        {"parameter": {"label": "gma_id"}},
        {"parameter": {"label": "model_layer"}},
    ], "config-1", warnings)

    assert env["GEOMETRY_SOURCE_URI"] == "geometry_source_uri"
    assert env["DFC_AREA_BOUNDARY_URI"] == "dfc_area_boundary_uri"
    assert env["SPATIAL_SCOPE_ID"] == "spatial_scope_id"
    assert env["MODEL_LAYER"] == "model_layer"
    assert not warnings

    warnings = []
    reversed_env = _build_env_from_args([
        {"parameter": {"label": "dfc area boundary uri"}},
        {"parameter": {"label": "gma boundary uri"}},
    ], "config-1", warnings)
    assert reversed_env["GEOMETRY_SOURCE_URI"] == "geometry_source_uri"
    assert reversed_env["DFC_AREA_BOUNDARY_URI"] == "dfc_area_boundary_uri"
    assert not warnings


def test_etl_process_maps_inline_python_and_contracts():
    warnings = []
    row = etl_process_to_spec_row(
        {
            "id": "https://w3id.org/okn/i/mint/etl/normalize",
            "label": "Normalize observations",
            "version": "1.0.0",
            "runtime_kind": "tapis_function",
            "runtime_json": {
                "language": "python",
                "entrypoint": "main",
                "source": "def main(inputs): return inputs",
            },
            "contracts": [
                {"role": "input", "position": 0, "standard_variable_uri": "https://example.org/raw", "format": "csv"},
                {"role": "output", "position": 1, "standard_variable_uri": "https://example.org/normalized", "format": "csv"},
            ],
        },
        warnings,
    )

    assert not warnings
    assert row["id"].endswith("/normalize")
    assert row["method"] == "tapis_function"
    assert row["transform_type"] == "etl_process"
    assert row["parameters_schema_json"]["metadata"]["runtime"]["source"].startswith("def main")
    assert len(row["contracts"]["data"]) == 2
    assert all("position" not in contract for contract in row["contracts"]["data"])
    assert row["contracts"]["data"][0]["metadata_json"] == {"mint_position": 0}


def test_etl_process_requires_both_contract_directions():
    warnings = []
    row = etl_process_to_spec_row(
        {"id": "etl-only-input", "runtime_json": {}, "contracts": [{"role": "input"}]},
        warnings,
    )
    assert row is None
    assert "requires input and output contracts" in warnings[0]


def _junction(spec_id, name, optional, *sv_uris):
    return {
        "is_optional": optional,
        "app_input_name": name,
        "input": {
            "id": spec_id,
            "has_format": "geojson",
            "presentations": [{"presentation": {"standard_variable": {"id": uri}}} for uri in sv_uris],
        },
    }


def test_input_contracts_carry_the_app_input_binding_for_every_presentation():
    from app.mint_sync import mint_config_to_spec_row

    warnings = []
    row = mint_config_to_spec_row({
        "id": "cfg-1",
        "label": "model",
        "inputs": [
            _junction("ds-aoi", "aoi-geojson", True, "https://example.org/a", "https://example.org/b"),
            _junction("ds-free", None, False, "https://example.org/c"),
        ],
        "outputs": [{"output": {"id": "ds-out", "has_format": "tif", "presentations": [
            {"presentation": {"standard_variable": {"id": "https://example.org/o"}}}]}}],
    }, warnings)

    inputs = [c for c in row["contracts"]["data"] if c["role"] == "input"]
    assert [c["metadata_json"] for c in inputs] == [
        {"app_input_name": "aoi-geojson", "is_optional": True, "dataset_specification_id": "ds-aoi"},
        {"app_input_name": "aoi-geojson", "is_optional": True, "dataset_specification_id": "ds-aoi"},
        {"app_input_name": None, "is_optional": False, "dataset_specification_id": "ds-free"},
    ]
    assert all("metadata_json" not in c for c in row["contracts"]["data"] if c["role"] == "output")
    assert not warnings


def test_two_dataset_specifications_binding_one_app_input_warn():
    from app.mint_sync import mint_config_to_spec_row

    warnings = []
    mint_config_to_spec_row({
        "id": "cfg-1",
        "inputs": [_junction("ds-a", "aoi-geojson", True, "https://example.org/a"),
                   _junction("ds-b", "aoi-geojson", True, "https://example.org/b")],
    }, warnings)
    assert len(warnings) == 1 and "aoi-geojson" in warnings[0] and "ds-a" in warnings[0] and "ds-b" in warnings[0]
