"""Stored source travels from a catalog row to a runnable function task: the
planner finds it in every stored shape, the generator appends a call to its
entrypoint, wires its inputs, and the appended call actually works."""
from __future__ import annotations

import os
import sys
import types

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config

import pytest  # noqa: E402

from app.config import settings  # noqa: E402
from app.mint_sync import etl_process_to_spec_row  # noqa: E402
from app.planner import build_plan_json  # noqa: E402
from app.stored_source import defines_function, runnable_code, source_sha256, stored_entrypoint  # noqa: E402
from app.tapis import generate_tapis_workflow  # noqa: E402

FUNCTION = "def transform(inputs):\n    return {'doubled': int(inputs['SOURCE_RESULT']) * 2}\n"
SCRIPT = "from owe_python_sdk.runtime import execution_context as ctx\nctx.set_output('result', 'done')\n"


def catalog_row(runtime_json, pid="https://w3id.org/okn/i/mint/etl/mine"):
    return {
        "id": pid, "label": pid.rsplit("/", 1)[-1], "version": "1.0.0",
        "owner_username": "alice", "visibility": "private", "runtime_kind": "tapis_function",
        "runtime_json": runtime_json,
        "contracts": [
            {"role": "input", "position": 0, "standard_variable_uri": "https://example.org/a"},
            {"role": "output", "position": 0, "standard_variable_uri": "https://example.org/b"},
        ],
    }


UI_SHAPE = {"language": "python", "entrypoint": "transform",
            "source": {"language": "python", "code": FUNCTION}}
STRING_SHAPE = {"language": "python", "entrypoint": "main",
                "source": "def main(inputs):\n    return inputs\n"}


def function_tasks(steps):
    pipeline = generate_tapis_workflow({"id": "p", "plan_json": {"steps": steps}})
    return [t for t in pipeline["tasks"] if t["type"] == "function" and str(t["id"]).startswith("step-")]


# --- catalog row -> sync -> planner -> task --------------------------------

@pytest.mark.parametrize("runtime_json,entrypoint", [(UI_SHAPE, "transform"), (STRING_SHAPE, "main")])
def test_catalog_source_reaches_the_generated_task(runtime_json, entrypoint):
    spec = etl_process_to_spec_row(catalog_row(runtime_json), [])
    assert stored_entrypoint(spec) == entrypoint
    (step,) = build_plan_json([spec])["steps"]
    source = runtime_json["source"]["code"] if isinstance(runtime_json["source"], dict) else runtime_json["source"]
    assert step["python_source"] == source
    assert step["python_entrypoint"] == entrypoint
    assert step["stored_source"]["sha256"] == source_sha256(source)
    assert step["stored_source"]["owner_username"] == "alice"

    (task,) = function_tasks([step])
    assert task["code"].startswith(source.rstrip("\n"))
    assert f"_svo_fn = {entrypoint}" in task["code"]
    assert "entrypoint" not in task


def test_the_recorded_hash_is_of_the_authors_source_not_the_wrapped_code():
    spec = etl_process_to_spec_row(catalog_row(UI_SHAPE), [])
    (step,) = build_plan_json([spec])["steps"]
    (task,) = function_tasks([step])
    assert step["stored_source"]["sha256"] == source_sha256(FUNCTION) != source_sha256(task["code"])


def test_a_script_is_passed_through_unchanged():
    spec = etl_process_to_spec_row(catalog_row({"source": {"code": SCRIPT}}), [])
    (step,) = build_plan_json([spec])["steps"]
    assert "python_entrypoint" not in step
    (task,) = function_tasks([step])
    assert task["code"] == SCRIPT


def test_an_entrypoint_the_source_does_not_define_leaves_the_script_alone():
    assert runnable_code(SCRIPT, "transform", []) == SCRIPT
    assert runnable_code("def other(): pass\n", "transform", []) == "def other(): pass\n"
    assert runnable_code("def transform(:\n", "transform", []) == "def transform(:\n"
    assert runnable_code(FUNCTION, "not an identifier", []) == FUNCTION
    assert not defines_function("x = 1\ndef f():\n    def transform(): pass\n", "transform")  # nested only


# --- inputs, chaining, time limit ------------------------------------------

def stored_step(idx, depends_on=(), **over):
    step = {"step": idx, "transform_type": "etl_process", "name": f"piece-{idx}",
            "python_source": FUNCTION, "python_entrypoint": "transform", "depends_on": list(depends_on)}
    step.update(over)
    return step


def test_a_second_stored_step_receives_the_first_ones_result():
    first, second = function_tasks([stored_step(0), stored_step(1, depends_on=[0])])
    assert "SOURCE_RESULT" not in (first.get("input") or {})
    assert second["input"]["SOURCE_RESULT"]["value_from"]["task_output"] == {
        "task_id": first["id"], "output_id": "result"}
    assert '["SOURCE_RESULT"]' in second["code"]


def test_a_chained_stored_step_keeps_its_bound_source_uri():
    _, second = function_tasks([
        stored_step(0), stored_step(1, depends_on=[0], env_from_args={"SOURCE_URI": "source_uri"})])
    assert {"SOURCE_URI", "SOURCE_RESULT"} <= set(second["input"])


def test_stored_steps_get_an_explicit_time_limit_and_built_ins_do_not():
    (stored,) = function_tasks([stored_step(0)])
    assert stored["execution_profile"] == {
        "max_retries": 0, "max_exec_time": settings.stored_source_max_exec_seconds}
    (builtin,) = function_tasks([{"step": 0, "transform_type": "unit_convert", "name": "u"}])
    assert "execution_profile" not in builtin


def test_built_in_code_is_unchanged():
    from app import task_code
    (builtin,) = function_tasks([{"step": 0, "transform_type": "unit_convert", "name": "u"}])
    assert builtin["code"] == task_code.get_code("unit_convert")


# --- the appended call really works ----------------------------------------

@pytest.fixture
def run(monkeypatch):
    """Execute generated code against a stand-in for the Workflows execution context."""
    def _run(code, inputs):
        outputs = {}
        ctx = types.SimpleNamespace(get_input=inputs.get, set_output=outputs.__setitem__)
        runtime = types.ModuleType("owe_python_sdk.runtime")
        runtime.execution_context = ctx
        monkeypatch.setitem(sys.modules, "owe_python_sdk", types.ModuleType("owe_python_sdk"))
        monkeypatch.setitem(sys.modules, "owe_python_sdk.runtime", runtime)
        exec(compile(code, "entrypoint.py", "exec"), {"__name__": "__main__"})
        return outputs
    return _run


def test_entrypoint_gets_its_inputs_and_its_return_value_becomes_the_result(run):
    code = runnable_code(FUNCTION, "transform", ["SOURCE_RESULT", "PROBE"])
    assert run(code, {"SOURCE_RESULT": "21", "PROBE": "x"}) == {"result": '{"doubled": 42}'}


def test_a_string_return_is_passed_through_as_is(run):
    code = runnable_code("def transform(inputs):\n    return 'plain'\n", "transform", [])
    assert run(code, {}) == {"result": "plain"}


def test_an_entrypoint_without_parameters_is_called_with_none(run):
    code = runnable_code("def transform():\n    return [1, 2]\n", "transform", ["SOURCE_RESULT"])
    assert run(code, {"SOURCE_RESULT": "ignored"}) == {"result": "[1, 2]"}


def test_returning_nothing_sets_no_output(run):
    code = runnable_code("def transform(inputs):\n    pass\n", "transform", [])
    assert run(code, {}) == {}


def test_an_async_entrypoint_is_rejected(run):
    code = runnable_code("async def transform(inputs):\n    return 1\n", "transform", [])
    with pytest.raises(TypeError, match="plain function"):
        run(code, {})


def test_a_script_runs_as_written(run):
    assert run(runnable_code(SCRIPT, None, []), {}) == {"result": "done"}
