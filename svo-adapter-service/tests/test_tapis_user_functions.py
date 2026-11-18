import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.tapis import generate_tapis_workflow


def test_generated_pipeline_mixes_user_function_and_tapis_job():
    pipeline = generate_tapis_workflow({
        "id": "mixed-pipeline",
        "plan_json": {"steps": [
            {"step": 0, "transform_type": "custom_python", "name": "small-piece",
             "python_source": "def transform():\n    return 1", "python_entrypoint": "transform"},
            {"step": 1, "transform_type": "heavy", "name": "heavy-piece",
             "tapis_app_id": "heavy-app", "app_version": "1.0.0"},
        ]},
    })

    assert [task["type"] for task in pipeline["tasks"]] == ["function", "tapis_job"]
    assert pipeline["tasks"][0]["code"].startswith("def transform")
    # Tapis Workflows ignores a task-level entrypoint, so the adapter appends the call.
    assert "entrypoint" not in pipeline["tasks"][0]
    assert "_svo_fn = transform" in pipeline["tasks"][0]["code"]
    assert pipeline["tasks"][1]["tapis_job_def"]["appId"] == "heavy-app"
    assert pipeline["tasks"][1]["depends_on"] == [{"id": "step-0-custom_python"}]
