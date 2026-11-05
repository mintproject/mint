"""Shared plan fixtures for the input-side ETL tests."""

# A representative composite plan with no input steps; its generated pipeline is
# pinned in tests/golden/composite_pipeline_no_inputs.json.
GOLDEN_PLAN = {
    "id": "golden-plan",
    "plan_json": {
        "steps": [
            {"step": 0, "name": "budget-extract", "transform_type": "budget_extract_drain",
             "env_from_args": {"SOURCE_URI": "source_uri", "TAPIS_TOKEN": "tapis_token"}},
            {"step": 1, "name": "convert", "transform_type": "unit_convert", "depends_on": [0],
             "env_from_args": {"SOURCE_UNIT": "source_unit", "TARGET_UNIT": "target_unit"}},
        ],
        "parameters": [{"name": "source_uri", "required": True}],
        "model_task": {
            "stage_id": "model",
            "output_name": "cbb",
            "output_format": "cbc",
            "max_minutes": 5,
            "job_definition": {
                "name": "mint-workflow-model-x",
                "appId": "modflow6-simulation",
                "appVersion": "0.0.test",
                "archiveSystemId": "ls6",
                "fileInputs": [],
                "parameterSet": {"appArgs": []},
            },
        },
    },
}


AOI_VAR = "https://w3id.org/okn/i/mint/area_of_interest__boundary"


def model_row(configuration_id="cfg-1", tapis_app_id="app", inputs=None, row_id="model-row"):
    """A synced model registry row. ``inputs`` are (app_input_name, optional,
    dataset_specification_id, standard_variable_uri, format) tuples, one contract
    each, as mint_sync builds them."""
    inputs = inputs if inputs is not None else [("aoi-geojson", True, "ds-aoi", AOI_VAR, "geojson")]
    contracts = [
        {"id": f"{row_id}-in{i}", "role": "input", "standard_variable_uri": sv, "format": fmt,
         "metadata_json": {"app_input_name": name, "is_optional": optional, "dataset_specification_id": ds}}
        for i, (name, optional, ds, sv, fmt) in enumerate(inputs)]
    contracts.append({"id": f"{row_id}-out", "role": "output", "format": "cbc",
                      "standard_variable_uri": "https://w3id.org/okn/i/mint/head"})
    return {"id": row_id, "name": "model", "transform_type": "tapis_job", "method": "tapis_job",
            "mint_model_config_id": configuration_id, "tapis_app_id": tapis_app_id,
            "mint_synced_at": "2026-11-05T12:00:00+00:00", "contracts": contracts}
