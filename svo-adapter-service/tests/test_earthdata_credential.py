"""Earthdata credential: GET /runs/{id}/credentials/earthdata, the task code that
fetches it, and the guarantee the password never reaches logs, responses or
the persisted pipeline definition (demo mode, Tapis stubbed)."""
from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pydantic import SecretStr  # noqa: E402

from app import run_state, tapis  # noqa: E402
from app.config import settings  # noqa: E402
from app.main import _public_workflow_args, app  # noqa: E402
from app.store import STORE  # noqa: E402

client = TestClient(app)
SENTINEL = "SENTINEL-pw-9f3a"
URL = "/runs/run-1/credentials/earthdata"


@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    monkeypatch.setattr(settings, "run_signal_secrets", "current-secret")
    monkeypatch.setattr(settings, "public_base_url", "https://svo.example")
    monkeypatch.setattr(settings, "earthdata_username", SecretStr("edl-user"))
    monkeypatch.setattr(settings, "earthdata_password", SecretStr(SENTINEL))
    client.post("/admin/reset")


def _run(**over):
    row = {"id": "run-1", "status": "running", "signals_armed": True, "health": None,
           "submitted_by": "alice"}
    row.update(over)
    STORE.run[row["id"]] = row


def _headers(run_id="run-1", secret=None):
    expires = int((datetime.now(tz=timezone.utc) + timedelta(hours=1)).timestamp())
    return {"X-Run-Signal-Token": run_state.make_signal_token(run_id, expires, secret=secret),
            "X-Run-Signal-Expires": str(expires)}


def test_404_when_not_configured(monkeypatch):
    monkeypatch.setattr(settings, "earthdata_password", None)
    _run()
    assert not settings.earthdata_configured()
    assert client.get(URL, headers=_headers()).status_code == 404


@pytest.mark.parametrize("headers", [{}, "wrong"])
def test_bad_or_missing_token_rejected(headers):
    _run()
    if headers == "wrong":
        headers = _headers(secret="wrong")
    assert client.get(URL, headers=headers).status_code in (401, 403)


def test_200_with_right_token_returns_both_fields():
    _run()
    resp = client.get(URL, headers=_headers())
    assert resp.status_code == 200
    assert resp.json() == {"username": "edl-user", "password": SENTINEL}
    assert resp.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("over", [{"status": "completed"}, {"signals_armed": False}])
def test_409_when_run_not_active(over):
    _run(**over)
    assert client.get(URL, headers=_headers()).status_code == 409


def test_provenance_event_carries_no_values():
    _run()
    client.get(URL, headers=_headers())
    events = [e for e in STORE.provenance if e.get("event_type") == "run.credential.issued"]
    assert len(events) == 1
    assert events[0]["payload_json"] == {"credential": "earthdata", "task_id": "model"}
    assert SENTINEL not in json.dumps(STORE.provenance, default=str)


def test_public_args_hide_earthdata():
    assert _public_workflow_args({"earthdata": {"value": "x"}, "a": {"value": 1}}) == {"a": {"value": 1}}


def test_sentinel_never_leaks_outside_credentials_response(caplog):
    caplog.set_level(logging.DEBUG)
    _run()
    assert client.get(URL, headers=_headers()).status_code == 200
    client.get(URL, headers=_headers(secret="wrong"))
    seed = client.post("/admin/seed-subside-werc").json()
    plan_id = client.post("/plans", json={
        "data_object_id": seed["data_object"]["id"],
        "target_contract": seed["target_contract"]}).json()["plan_id"]
    dry = client.post("/workflows/submit", json={"plan_id": plan_id, "dry_run": True, "args": {
        "start_date": "2024-01-01", "end_date": "2025-01-01", "allocation": "A",
        "aoi_geojson_uri": "tapis://ls6/demo/aoi.geojson"}})
    assert dry.status_code == 200
    assert SENTINEL not in dry.text
    assert client.get("/runs/run-1").text.count(SENTINEL) == 0
    assert all(SENTINEL not in r.getMessage() for r in caplog.records)
    assert SENTINEL not in json.dumps(STORE.provenance, default=str)


def _code(**task):
    return tapis._model_execution_code({"job_definition": {"name": "j", "fileInputs": []}, **task})


def test_task_code_fetches_and_injects_without_embedding_values():
    code = _code()
    assert "CREDENTIALS_URL" in code
    assert "EARTHDATA_USERNAME" in code and "EARTHDATA_PASSWORD" in code
    assert "earthdata-netrc" in code
    assert "parameterSet" in code and "envVariables" in code
    assert SENTINEL not in code
    compile(code, "<task>", "exec")


def test_pipeline_definition_binds_url_but_never_a_password():
    workflow = tapis.generate_tapis_workflow({"id": "p", "plan_json": {
        "steps": [], "parameters": [],
        "model_task": {"stage_id": "model", "output_name": "o", "output_format": "tif",
                       "job_definition": {"appId": "a", "appVersion": "1", "fileInputs": [], "parameterSet": {}}},
    }})
    model = workflow["tasks"][0]
    assert model["input"]["CREDENTIALS_URL"] == {"type": "string", "value_from": {"args": "credentials_url"}}
    assert "credentials_url" in tapis.STANDARD_PARAMS
    dumped = json.dumps(workflow)
    assert SENTINEL not in dumped and "EARTHDATA_PASSWORD\", \"value" not in dumped


def _composite_submit(monkeypatch, app_id: str):
    """Real (mocked-Tapis) composite submit; dry runs return before signals are armed."""
    captured = []

    def fake_submit(pipeline, args, **kwargs):
        captured.append(args)
        return {"uuid": "tapis-run-1", "pipelineId": pipeline["id"], "tapisStatus": "submitted"}

    monkeypatch.setattr("app.main.tapis.submit_tapis_workflow", fake_submit)
    monkeypatch.setattr("app.main.tapis.userinfo_username", lambda token: "alice")
    monkeypatch.setattr(settings, "internal_service_secret", "em-secret")
    seed = client.post("/admin/seed-subside-werc").json()
    plan_id = client.post("/plans", json={
        "data_object_id": seed["data_object"]["id"],
        "target_contract": seed["target_contract"]}).json()["plan_id"]
    response = client.post("/workflows/submit",
        headers={"Authorization": "Bearer caller.jwt.token", "X-Ensemble-Manager-Secret": "em-secret"},
        json={"plan_id": plan_id, "execution_id": "ue-test-1",
              "args": {"start_date": "2024-01-01", "end_date": "2025-01-01", "allocation": "A",
                       "aoi_geojson_uri": "tapis://ls6/demo/aoi.geojson",
                       "min_overlap_percent": "50", "num_workers": "4", "reference_mode": "auto"},
              "model_task": {"stage_id": "model", "output_name": "o", "output_format": "tif",
                             "output_uri": "tapis://ls6/mint-workflow-output/ue-test-1/model/o",
                             "max_minutes": 5,
                             "job_definition": {"name": "mint-workflow-model-x", "appId": app_id,
                                                "appVersion": "1", "fileInputs": [],
                                                "parameterSet": {"appArgs": []}}}})
    assert response.status_code == 200, response.text
    return response, captured[0]


def test_credentials_url_only_for_allowed_apps(monkeypatch):
    _run()
    assert settings.earthdata_app_allowed("subside-h2i-opera-analysis")
    assert settings.earthdata_app_allowed("subside-werc-opera-analysis")
    assert not settings.earthdata_app_allowed("modflow6-simulation")
    assert not settings.earthdata_app_allowed(None)

    response, args = _composite_submit(monkeypatch, "subside-h2i-opera-analysis")
    run_id = response.json()["run_id"]
    assert args["credentials_url"]["value"] == f"https://svo.example/runs/{run_id}/credentials/earthdata"
    assert "credentials_url" in args and "signal_url" in args

    _, denied = _composite_submit(monkeypatch, "modflow6-simulation")
    assert "credentials_url" not in denied
    assert "signal_url" in denied  # signals still armed for MODFLOW runs


def test_task_code_dies_when_credential_expected_but_no_signal_token():
    code = _code()
    assert "EARTHDATA_CREDENTIAL_UNAVAILABLE" in code
    assert "no run signal token was issued" in code
