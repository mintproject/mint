"""How a flow's steps become Tapis Workflows tasks: several sources in, several
named results out, links that only set order."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from app import tapis  # noqa: E402
from app.stored_source import runnable_code  # noqa: E402

SOURCE = "def run(inputs):\n    return 'tapis://sys/out'\n"


def _step(number, *, wires, outputs=(1,), values=(), env=None, depends_on=()):
    return {
        "step": number, "name": f"piece {number}", "transform_type": "custom", "method": "tapis_function",
        "python_source": SOURCE, "python_entrypoint": "run",
        "env_from_args": env or {"TAPIS_TOKEN": "tapis_token"},
        "parameters_schema_json": {"properties": {"manifest_name": {"type": "string"}}},
        "wires": wires, "depends_on": list(depends_on),
        "flow_outputs": {"outputs": list(outputs), "values": list(values)},
    }


def _tasks(steps):
    pipeline = tapis.generate_tapis_workflow({"id": "plan-1", "plan_json": {"steps": steps}})
    return {task["id"]: task for task in pipeline["tasks"]}, pipeline


def _from(task, name):
    return task["input"][name]["value_from"]


@pytest.fixture
def flow():
    return [
        _step(1, outputs=(1, 2), values=("manifest_name",),
              wires=[{"to": {"input": 1}, "from": {"arg": "source_uri"}}]),
        _step(2, depends_on=(1,),
              wires=[{"to": {"input": 1}, "from": {"step": 1, "output": 2}},
                     {"to": {"input": 2}, "from": {"arg": "source_uri_2"}}]),
        _step(3, depends_on=(1, 2), outputs=(),
              env={"TAPIS_TOKEN": "tapis_token", "MANIFEST": "manifest_name"},
              wires=[{"to": {"input": 1}, "from": {"step": 1, "output": 1}},
                     {"to": {"input": 2}, "from": {"step": 2, "output": 1}},
                     {"to": {"setting": "manifest_name"}, "from": {"step": 1, "value": "manifest_name"}},
                     {"to": {}, "from": {"step": 2}}]),
    ]


def test_a_step_declares_every_output_it_has(flow):
    tasks, _ = _tasks(flow)
    assert set(tasks["step-1-custom"]["output"]) == {"result", "result_2", "value_manifest_name"}
    assert set(tasks["step-2-custom"]["output"]) == {"result"}


def test_each_linked_input_arrives_under_its_own_name(flow):
    tasks, _ = _tasks(flow)
    assert _from(tasks["step-1-custom"], "SOURCE_1") == {"args": "source_uri"}
    second = tasks["step-2-custom"]
    assert _from(second, "SOURCE_1") == {"task_output": {"task_id": "step-1-custom", "output_id": "result_2"}}
    assert _from(second, "SOURCE_2") == {"args": "source_uri_2"}
    third = tasks["step-3-custom"]
    assert _from(third, "SOURCE_1") == {"task_output": {"task_id": "step-1-custom", "output_id": "result"}}
    assert _from(third, "SOURCE_2") == {"task_output": {"task_id": "step-2-custom", "output_id": "result"}}


def test_the_first_input_from_a_step_also_keeps_the_name_a_chain_uses(flow):
    tasks, _ = _tasks(flow)
    assert "SOURCE_RESULT" not in tasks["step-1-custom"]["input"]  # it comes from a flow input
    assert _from(tasks["step-2-custom"], "SOURCE_RESULT") == _from(tasks["step-2-custom"], "SOURCE_1")
    assert _from(tasks["step-3-custom"], "SOURCE_RESULT") == _from(tasks["step-3-custom"], "SOURCE_1")


def test_a_linked_setting_replaces_the_argument_the_piece_would_have_read(flow):
    tasks, _ = _tasks(flow)
    assert _from(tasks["step-3-custom"], "MANIFEST") == {
        "task_output": {"task_id": "step-1-custom", "output_id": "value_manifest_name"}}


def test_steps_wait_for_every_step_they_read_from_or_run_after(flow):
    tasks, _ = _tasks(flow)
    assert "depends_on" not in tasks["step-1-custom"]
    assert tasks["step-2-custom"]["depends_on"] == [{"id": "step-1-custom"}]
    assert tasks["step-3-custom"]["depends_on"] == [{"id": "step-1-custom"}, {"id": "step-2-custom"}]


def test_two_steps_with_no_link_between_them_can_run_together():
    tasks, _ = _tasks([
        _step(1, wires=[{"to": {"input": 1}, "from": {"arg": "source_uri"}}]),
        _step(2, wires=[{"to": {"input": 1}, "from": {"arg": "source_uri"}}]),
    ])
    assert "depends_on" not in tasks["step-2-custom"]


def test_every_flow_input_is_a_pipeline_argument(flow):
    _, pipeline = _tasks(flow)
    assert pipeline["params"]["source_uri_2"]["required"] is True
    assert "source_uri" in pipeline["params"]


def test_a_chain_step_is_built_exactly_as_before():
    chain = [{k: v for k, v in _step(n, wires=[]).items() if k not in ("wires", "flow_outputs")} for n in (0, 1)]
    chain[1]["depends_on"] = [0]
    tasks, _ = _tasks(chain)
    second = tasks["step-1-custom"]
    assert set(second["output"]) == {"result"}
    assert _from(second, "SOURCE_RESULT") == {"task_output": {"task_id": "step-0-custom", "output_id": "result"}}
    assert not any(name.startswith("SOURCE_") and name != "SOURCE_RESULT" for name in second["input"])
    assert second["code"] == runnable_code(SOURCE, "run", second["input"])


# --- the code a piece runs as -------------------------------------------------
class _Context:
    def __init__(self):
        self.outputs = {}

    def get_input(self, name):
        return None

    def set_output(self, name, value):
        self.outputs[name] = value


def _run(source, output_ids, monkeypatch):
    import types
    context = _Context()
    runtime = types.ModuleType("owe_python_sdk.runtime")
    runtime.execution_context = context
    monkeypatch.setitem(sys.modules, "owe_python_sdk", types.ModuleType("owe_python_sdk"))
    monkeypatch.setitem(sys.modules, "owe_python_sdk.runtime", runtime)
    exec(compile(runnable_code(source, "run", [], output_ids), "<piece>", "exec"), {})
    return context.outputs


IDS = {"outputs": {"1": "result", "2": "result_2"}, "values": {"job": "value_job"}}


def test_a_piece_returns_several_outputs_and_values(monkeypatch):
    source = ("def run():\n    return {'svo_flow': {'outputs': {1: 'tapis://a', 2: {'uri': 'tapis://b'}},"
              " 'values': {'job': 'j-1'}}}\n")
    outputs = _run(source, IDS, monkeypatch)
    assert outputs == {"result": "tapis://a", "result_2": json.dumps({"uri": "tapis://b"}), "value_job": "j-1"}


def test_a_piece_written_for_a_chain_still_returns_its_one_result(monkeypatch):
    assert _run("def run():\n    return 'tapis://a'\n", IDS, monkeypatch) == {"result": "tapis://a"}
    assert _run("def run():\n    return 'tapis://a'\n", None, monkeypatch) == {"result": "tapis://a"}


def test_a_piece_cannot_set_an_output_its_step_does_not_declare(monkeypatch):
    source = "def run():\n    return {'svo_flow': {'outputs': {3: 'tapis://c'}}}\n"
    with pytest.raises(ValueError, match="does not declare"):
        _run(source, IDS, monkeypatch)
