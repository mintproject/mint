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
