"""What a run of a flow reports: each step's status and where each output is."""
from __future__ import annotations

import json
import os
import sys
import types
from pathlib import Path

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import flow_run  # noqa: E402
from app.stored_source import runnable_code  # noqa: E402


def step(number, outputs=(1,), values=(), depends_on=()):
    return {"step": number, "name": f"piece {number}", "transform_type": "custom",
            "depends_on": list(depends_on), "wires": [],
            "flow_outputs": {"outputs": list(outputs), "values": list(values)}}


PLAN = {
    "steps": [step(1, outputs=(1, 2), values=("job_uuid",)), step(2, depends_on=(1,))],
    "flow": {"configuration_id": "cfg", "outputs": [
        {"step": 2, "output": 1, "output_id": "cfg_output_1"},
        {"step": 1, "output": 2, "output_id": "cfg_output_2"},
        {"step": 1, "value": "job_uuid"},
        {"step": 2, "record": "catalog"},
    ]},
}


def report(**outputs):
    return "some log line\n" + json.dumps({"svo_flow_outputs": outputs}) + "\n"


def test_a_chain_plan_has_no_flow_view():
    assert flow_run.view({"steps": [step(1)]}, {"tasks": []}) is None


def test_each_step_is_listed_with_its_status_and_what_it_waits_for():
    detail = {"tasks": [{"task_id": "step-1-custom", "status": "completed", "last_message": "done"},
                        {"task_id": "step-2-custom", "status": "active"}]}
    steps = flow_run.view(PLAN, detail)["steps"]
    assert [(s["step"], s["status"], s["depends_on"]) for s in steps] == [(1, "completed", []), (2, "running", [1])]
    assert steps[0]["message"] == "done" and steps[0]["task_id"] == "step-1-custom"


def test_a_step_tapis_has_not_started_is_pending():
    steps = flow_run.view(PLAN, {"tasks": []})["steps"]
    assert [s["status"] for s in steps] == ["pending", "pending"]
    assert flow_run.view(PLAN, {"tasks_error": "boom"})["steps"][0]["status"] == "pending"


def test_each_flow_output_is_found_from_what_its_step_reported():
    detail = {"tasks": [
        {"task_id": "step-1-custom", "status": "completed",
         "stdout": report(result="tapis://s/a", result_2="tapis://s/b", value_job_uuid="job-1")},
        {"task_id": "step-2-custom", "status": "completed", "stdout": report(result="tapis://s/report.md")},
    ]}
    outputs = flow_run.view(PLAN, detail)["outputs"]
    assert [(o.get("output_id"), o["value"]) for o in outputs] == [
        ("cfg_output_1", "tapis://s/report.md"), ("cfg_output_2", "tapis://s/b"), (None, "job-1"), (None, None)]
    assert outputs[3]["record"] == "catalog"


def test_an_output_whose_step_has_not_reported_has_no_value():
    detail = {"tasks": [{"task_id": "step-1-custom", "status": "active", "stdout": "working...\n"}]}
    assert [o["value"] for o in flow_run.view(PLAN, detail)["outputs"]] == [None, None, None, None]


def test_the_last_report_line_is_the_one_that_counts():
    # A piece could print a line that looks like a report. The adapter's wrapper
    # prints the real one after the piece's code has finished.
    stdout = report(result="tapis://evil/x") + "more output\n" + report(result="tapis://s/real")
    assert flow_run.reported_outputs(stdout) == {"result": "tapis://s/real"}
    assert flow_run.reported_outputs("not json\n{broken\n") == {}
    assert flow_run.reported_outputs(None) == {}
    assert flow_run.reported_outputs(json.dumps({"svo_flow_outputs": "nope"})) == {}


def test_a_report_a_piece_made_unreadable_is_ignored_not_raised():
    # Nested past what json reads, or too long to be a report: skipped, so the
    # poll still answers and an earlier, readable line is used.
    deep = '{"svo_flow_outputs": ' + "[" * 100_000 + "]" * 100_000 + "}"
    assert flow_run.reported_outputs(deep) == {}
    long = json.dumps({"svo_flow_outputs": {"result": "x" * 200_000}})
    assert flow_run.reported_outputs(report(result="tapis://s/real") + long + "\n") == {"result": "tapis://s/real"}


def test_an_overlong_location_is_not_an_output():
    detail = {"tasks": [{"task_id": "step-2-custom", "status": "completed",
                         "stdout": report(result="tapis://s/" + "x" * 3000)}]}
    assert flow_run.view(PLAN, detail)["outputs"][0]["value"] is None


def _run(source, output_ids, monkeypatch, capsys):
    outputs: dict[str, str] = {}
    context = types.SimpleNamespace(get_input=lambda name: None,
                                    set_output=lambda name, value: outputs.__setitem__(name, value))
    runtime = types.ModuleType("owe_python_sdk.runtime")
    runtime.execution_context = context
    monkeypatch.setitem(sys.modules, "owe_python_sdk", types.ModuleType("owe_python_sdk"))
    monkeypatch.setitem(sys.modules, "owe_python_sdk.runtime", runtime)
    exec(compile(runnable_code(source, "run", [], output_ids), "<piece>", "exec"), {})
    return outputs, capsys.readouterr().out


IDS = {"outputs": {"1": "result", "2": "result_2"}, "values": {"job": "value_job"}}


def test_a_flow_step_prints_what_it_set_so_the_adapter_can_read_it_back(monkeypatch, capsys):
    source = "def run():\n    print('piece log')\n    return {'svo_flow': {'outputs': {1: 'tapis://a', 2: 'tapis://b'}, 'values': {'job': 'j'}}}\n"
    outputs, stdout = _run(source, IDS, monkeypatch, capsys)
    assert flow_run.reported_outputs(stdout) == outputs == {
        "result": "tapis://a", "result_2": "tapis://b", "value_job": "j"}


def test_a_flow_step_written_for_a_chain_reports_its_one_result(monkeypatch, capsys):
    outputs, stdout = _run("def run():\n    return 'tapis://a'\n", {"outputs": {"0": "result"}, "values": {}}, monkeypatch, capsys)
    assert flow_run.reported_outputs(stdout) == outputs == {"result": "tapis://a"}


def test_a_chain_step_prints_nothing_extra(monkeypatch, capsys):
    outputs, stdout = _run("def run():\n    return 'tapis://a'\n", None, monkeypatch, capsys)
    assert outputs == {"result": "tapis://a"} and stdout == ""
