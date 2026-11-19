"""Framing arguments (time period, area) are required only when a piece reads
them, are listed apart in a plan, and are recorded with the run; a stored-source
run is recorded against the run it belongs to."""
from __future__ import annotations

import os

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main as main_module  # noqa: E402
from app import tapis  # noqa: E402
from app.config import settings  # noqa: E402
from app.main import _plan_with_parameters, app  # noqa: E402
from app.planner import build_plan_json  # noqa: E402
from app.store import STORE  # noqa: E402
from app.stored_source import source_sha256  # noqa: E402

client = TestClient(app)
CODE = "from owe_python_sdk.runtime import execution_context as ctx\nctx.set_output('result', '1')\n"
FRAMING = ("start_date", "end_date", "aoi_geojson_uri")


def piece(env_from_args=None, declared=("output_uri",)):
    return {
        "id": "p1", "name": "p1", "transform_type": "etl_process", "method": "tapis_function",
        "owner_username": "alice", "visibility": "private",
        "parameters_schema_json": {
            "properties": {name: {"type": "string"} for name in declared}, "required": list(declared),
            "metadata": {"source": {"language": "python", "code": CODE}}},
        "env_from_args": env_from_args or {"OUTPUT_URI": "output_uri", "TAPIS_TOKEN": "tapis_token"},
        "approved_source_sha256": None,
        "contracts": [],
    }


def plan_json(spec):
    return _plan_with_parameters(build_plan_json([spec]))


def by_name(parameters):
    return {p["name"]: p for p in parameters}


# --- the generated pipeline -------------------------------------------------

def test_framing_is_not_required_when_no_task_reads_it():
    pipeline = tapis.generate_tapis_workflow({"id": "p", "plan_json": plan_json(piece())})
    for name in FRAMING:
        assert pipeline["params"][name]["required"] is False, name
    assert pipeline["params"]["output_uri"]["required"] is True
    assert pipeline["params"]["tapis_token"]["required"] is True


def test_framing_stays_required_when_a_task_reads_it():
    spec = piece(env_from_args={"OUTPUT_URI": "output_uri", "START": "start_date"},
                 declared=("output_uri", "start_date"))
    pipeline = tapis.generate_tapis_workflow({"id": "p", "plan_json": plan_json(spec)})
    assert pipeline["params"]["start_date"]["required"] is True
    assert pipeline["params"]["end_date"]["required"] is False


# --- the plan's parameter list ----------------------------------------------

def test_plan_lists_framing_apart_from_the_pieces_own_arguments():
    params = by_name(plan_json(piece())["parameters"])
    assert params["output_uri"]["required"] is True and "framing" not in params["output_uri"]
    assert {name: params[name]["framing"] for name in FRAMING} == {
        "start_date": "time_period", "end_date": "time_period", "aoi_geojson_uri": "area"}
    assert params["lat"]["framing"] == params["lon"]["framing"] == "area"
    for name in (*FRAMING, "lat", "lon"):
        assert params[name]["required"] is False and params[name]["used_by_plan"] is False


def test_a_framing_argument_a_piece_reads_is_required_and_marked_used():
    spec = piece(env_from_args={"OUTPUT_URI": "output_uri", "START": "start_date"},
                 declared=("output_uri", "start_date"))
    start = by_name(plan_json(spec)["parameters"])["start_date"]
    assert start["required"] is True and start["used_by_plan"] is True and start["framing"] == "time_period"


def test_plan_and_pipeline_agree_on_what_a_run_must_supply():
    plan = plan_json(piece())
    pipeline = tapis.generate_tapis_workflow({"id": "p", "plan_json": plan})
    plan_required = {p["name"] for p in plan["parameters"] if p.get("required") and not p.get("managed")}
    server_supplied = {"tapis_token", "source_uri"}
    pipeline_required = {n for n, d in pipeline["params"].items() if d.get("required")} - server_supplied
    assert plan_required == pipeline_required == {"output_uri"}


# --- what a submit records ---------------------------------------------------

@pytest.fixture
def submit(monkeypatch):
    client.post("/admin/reset")
    main_module._CALLER_CACHE.clear()
    monkeypatch.setattr(settings, "stored_source_enabled", True)
    monkeypatch.setattr(tapis, "userinfo_username", lambda token: "alice")
    monkeypatch.setattr("app.main.tapis.submit_tapis_workflow",
                        lambda pipeline, args, **kw: {"uuid": "run-1", "pipelineId": pipeline["id"],
                                                      "tapisStatus": "submitted"})
    spec = piece()
    STORE.transform_spec["p1"] = spec
    STORE.plan["plan-1"] = {"id": "plan-1", "status": "draft", "plan_json": plan_json(spec)}

    def _submit(**args):
        resp = client.post("/workflows/submit", headers={"Authorization": "Bearer tok"},
                           json={"plan_id": "plan-1", "args": {"output_uri": "tapis://sys/out", **args}})
        assert resp.status_code == 200, resp.text
        return resp.json()["run_id"]
    return _submit


def events(run_id, event_type):
    return [e for e in STORE.provenance
            if e.get("workflow_run_id") == run_id and e.get("event_type") == event_type]


def test_a_run_needs_no_framing_and_records_none(submit):
    run_id = submit()
    (requested,) = events(run_id, "workflow_submit_requested")
    assert "framing" not in requested["payload_json"]


def test_framing_a_caller_supplies_is_recorded_with_the_run(submit):
    run_id = submit(start_date="2026-01-01", end_date="2026-12-31", aoi_geojson_uri="tapis://sys/aoi.geojson")
    (requested,) = events(run_id, "workflow_submit_requested")
    assert requested["payload_json"]["framing"] == {
        "start_date": "2026-01-01", "end_date": "2026-12-31", "aoi_geojson_uri": "tapis://sys/aoi.geojson"}


def test_stored_source_run_is_recorded_against_the_run(submit):
    run_id = submit()
    (audit,) = events(run_id, "stored_source_run")
    assert audit["payload_json"]["submitted_by"] == "alice"
    assert audit["payload_json"]["pieces"][0]["sha256"] == source_sha256(CODE)
    # Nothing is written without a run to attach it to.
    assert not [e for e in STORE.provenance
                if e.get("event_type") == "stored_source_run" and not e.get("workflow_run_id")]
