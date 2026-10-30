from app.config import settings
from app.tapis import generate_tapis_workflow


def test_composite_workflow_runs_model_and_preserves_modular_adapter_tasks():
    workflow = generate_tapis_workflow({
        "id": "deferred-plan-1",
        "plan_json": {
            "steps": [{
                "step": 0,
                "name": "budget-extract",
                "transform_type": "budget_extract_drain",
                "env_from_args": {"SOURCE_URI": "source_uri"},
            }],
            "parameters": [{"name": "source_uri", "required": True}],
            "model_task": {
                "stage_id": "model",
                "output_uri": "tapis://ls6/mint-workflow-output/ue-1/model/cbb",
                "output_name": "cbb",
                "output_format": "cbc",
                "max_minutes": 5,
                "job_definition": {
                    "appId": "modflow6-simulation",
                    "appVersion": "0.0.test",
                    "archiveSystemId": "ls6",
                    "fileInputs": [],
                    "parameterSet": {"appArgs": []},
                },
            },
        },
    })

    assert [task["id"] for task in workflow["tasks"]] == [
        "model",
        "step-0-budget_extract_drain",
    ]
    model_task, adapter_task = workflow["tasks"]
    assert model_task["type"] == "function"
    assert model_task["output"] == {
        "result": {"type": "string"},
        "token": {"type": "string"},
    }
    assert '_ctx.set_output("token"' in model_task["code"]
    assert "_renew_if_due(force=True)" in model_task["code"]
    assert model_task["input"]["TAPIS_TOKEN"] == {
        "type": "string",
        "value_from": {"args": "tapis_token"},
    }
    assert model_task["execution_profile"]["max_exec_time"] == settings.model_task_max_exec_seconds
    # Retrying is safe only because the task re-attaches to the job it already submitted.
    assert model_task["execution_profile"]["max_retries"] == settings.model_task_max_retries
    assert "/v3/jobs/list" in model_task["code"]
    assert "/v3/jobs/submit" in model_task["code"]
    assert "/v3/jobs/" in model_task["code"]
    assert "/output/list/" in model_task["code"]
    assert "TAPIS_WORKFLOWS_PIPELINE_RUN_UUID" not in model_task["code"]
    assert adapter_task["depends_on"] == [{"id": "model"}]
    assert adapter_task["input"]["SOURCE_URI"] == {
        "type": "string",
        "value_from": {
            "task_output": {"task_id": "model", "output_id": "result"}
        },
    }
    assert workflow["params"]["start_date"]["required"] is False
    assert workflow["params"]["end_date"]["required"] is False
    assert workflow["params"]["aoi_geojson_uri"]["required"] is False
    assert workflow["params"]["source_uri"]["required"] is False
    assert "Bearer " not in str(workflow)
    assert "super-secret-token" not in str(workflow)


def _composite_plan(env_from_args, depends_on=None):
    step = {
        "step": 0,
        "name": "budget-extract",
        "transform_type": "budget_extract_drain",
        "env_from_args": env_from_args,
    }
    if depends_on is not None:
        step["depends_on"] = depends_on
    return {
        "id": "deferred-plan-2",
        "plan_json": {
            "steps": [step],
            "parameters": [{"name": "source_uri", "required": True}],
            "model_task": {
                "stage_id": "model",
                "output_name": "cbb",
                "output_format": "cbc",
                "job_definition": {"appId": "modflow6-simulation", "appVersion": "0.0.test"},
            },
        },
    }


def test_stages_after_model_take_the_token_the_model_stage_ends_with():
    workflow = generate_tapis_workflow(_composite_plan(
        {"SOURCE_URI": "source_uri", "TAPIS_TOKEN": "tapis_token"}
    ))

    model_task, adapter_task = workflow["tasks"]
    # The model stage still reads the token the run was submitted with.
    assert model_task["input"]["TAPIS_TOKEN"]["value_from"] == {"args": "tapis_token"}
    assert adapter_task["input"]["TAPIS_TOKEN"] == {
        "type": "string",
        "value_from": {"task_output": {"task_id": "model", "output_id": "token"}},
    }
    assert {"id": "model"} in adapter_task["depends_on"]


def test_token_handoff_forces_a_model_dependency_for_explicit_dag_edges():
    workflow = generate_tapis_workflow(_composite_plan(
        {"TAPIS_TOKEN": "tapis_token"}, depends_on=[7]
    ))

    adapter_task = workflow["tasks"][1]
    assert adapter_task["input"]["TAPIS_TOKEN"]["value_from"] == {
        "task_output": {"task_id": "model", "output_id": "token"}
    }
    assert adapter_task["depends_on"] == [{"id": "model"}]


def test_workflow_without_model_stage_keeps_the_submitted_token():
    workflow = generate_tapis_workflow({
        "id": "plain-plan",
        "plan_json": {
            "steps": [{
                "step": 0,
                "name": "budget-extract",
                "transform_type": "budget_extract_drain",
                "env_from_args": {"TAPIS_TOKEN": "tapis_token"},
            }],
            "parameters": [{"name": "tapis_token", "required": True}],
        },
    })

    assert workflow["tasks"][0]["input"]["TAPIS_TOKEN"]["value_from"] == {"args": "tapis_token"}


def test_normal_completion_is_a_terminal_workflow_status():
    from app.poller import _terminal_update_set

    status, update = _terminal_update_set("NORMAL_COMPLETION", {"tasks": []})

    assert status == "completed"
    assert update["status"] == "completed"


def test_deferred_adapter_workflow_consumes_concrete_source_uri():
    workflow = generate_tapis_workflow({
        "id": "bound-deferred-plan-1",
        "plan_json": {
            "steps": [{
                "step": 0,
                "name": "cbc-to-spring-flow",
                "transform_type": "cbc-to-spring-flow",
                "tapis_app_id": "svo-cbc-adapter",
                "app_version": "0.0.1",
                "file_inputs": [{
                    "name": "model-output",
                    "from_arg": "source_uri",
                    "target_path": "input/model-output.cbc",
                }],
                "env_from_args": {"SOURCE_URI": "source_uri"},
            }],
            "parameters": [{"name": "source_uri", "required": True}],
        },
    })

    assert [task["id"] for task in workflow["tasks"]] == [
        "step-0-cbc-to-spring-flow"
    ]
    task = workflow["tasks"][0]
    assert "output-handoff" not in str(workflow)
    assert task["tapis_job_def"]["fileInputs"][0]["sourceUrl"] == "${args.source_uri}"
    assert {item["key"]: item["value"] for item in task["tapis_job_def"]["parameterSet"]["envVariables"]}["SOURCE_URI"] == "${args.source_uri}"
