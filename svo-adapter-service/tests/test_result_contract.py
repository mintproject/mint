from app.result_contract import scalar_result, task_result


def test_scalar_result_preserves_zero_and_unit():
    assert scalar_result({"result": {"value": 0, "unit": "cfs"}}) == {
        "schema_version": 1,
        "status": "ok",
        "value": 0,
        "unit": "cfs",
    }


def test_task_result_extracts_nested_spring_flow_from_completed_task():
    result, error = task_result(
        {
            "tasks": [
                {
                    "task_id": "step-0-dfc-transform-chain",
                    "stdout": '{"status":"ok","result":{"spring_flow":49.7,"unit":"cfs"}}',
                }
            ]
        }
    )

    assert error is None
    assert result == {
        "schema_version": 1,
        "status": "ok",
        "value": 49.7,
        "unit": "cfs",
    }


def test_task_result_turns_json_error_stdout_into_bounded_failure():
    result, error = task_result(
        {
            "tasks": [
                {
                    "task_id": "step-0-budget_extract_drain",
                    "stdout": '{"schema_version":1,"status":"error","message":"GEO_ACTOR_ID is required"}',
                }
            ]
        }
    )

    assert result is None
    assert error == "step-0-budget_extract_drain: GEO_ACTOR_ID is required"


def test_task_result_preserves_output_discovery_diagnostics():
    result, error = task_result(
        {
            "tasks": [
                {
                    "task_id": "output-handoff",
                    "stdout": (
                        '{"schema_version":1,"status":"error",'
                        '"code":"MODEL_OUTPUT_DISCOVERY_FAILED",'
                        '"message":"completed model job was not discoverable",'
                        '"attempts":['
                        '{"method":"files_archive","status":404,"candidate_count":0},'
                        '{"method":"jobs_list","status":200,"candidate_count":0}],'
                        '"details":{"job_name":"mint-workflow-model-test"}}'
                    ),
                }
            ]
        }
    )

    assert result is None
    assert error == (
        "output-handoff: [MODEL_OUTPUT_DISCOVERY_FAILED] completed model job was not discoverable; "
        "attempts: files_archive=404, candidates=0, jobs_list=200, candidates=0; "
        "details: job_name=mint-workflow-model-test"
    )


def test_task_result_reports_the_missing_output_binding():
    result, error = task_result({"tasks": [{"task_id": "model", "stdout": (
        '{"status":"error","code":"MODEL_OUTPUT_MISSING","message":"not found","details":'
        '{"output_file":"a.tif","candidates":["b.tif","c.tif"],"hint":"re-register the binding"}}')}]})
    assert result is None
    assert "[MODEL_OUTPUT_MISSING]" in error
    assert "output_file=a.tif" in error and "candidates=b.tif,c.tif" in error
    assert "hint=re-register the binding" in error
