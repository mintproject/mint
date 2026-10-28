"""HTTP-level check of per-run token wiring on /workflows/submit (demo mode,
Tapis stubbed). Complements the unit tests in test_run_tokens.py."""
from __future__ import annotations

import base64
import json
import os
import sys
from pathlib import Path

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import run_tokens  # noqa: E402
from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)

WERC_ARGS = {
    "start_date": "2024-01-01",
    "end_date": "2025-01-01",
    "allocation": "PT2050-DataX",
    "aoi_geojson_uri": "tapis://ls6/demo/aoi.geojson",
    "min_overlap_percent": 0.5,
    "num_workers": 1,
    "reference_mode": "auto",
}


def _jwt(claims: dict) -> str:
    def enc(obj):
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()
    return f"{enc({'alg': 'none'})}.{enc(claims)}.sig"


CALLER = _jwt({"tapis/username": "alice"})


class _Resp:
    def __init__(self, status=200):
        self.status_code = status

    def json(self):
        return {"result": {"access_token": {"access_token": "RUN.JWT.TOKEN"}}}


def _plan_id() -> str:
    client.post("/admin/reset")
    seed = client.post("/admin/seed-subside-werc").json()
    return client.post("/plans", json={
        "data_object_id": seed["data_object"]["id"],
        "target_contract": seed["target_contract"],
    }).json()["plan_id"]


@pytest.fixture
def stubs(monkeypatch):
    captured = {"submits": [], "mints": []}

    def fake_submit(pipeline, args, **kwargs):
        captured["submits"].append({"args": args, "token": kwargs.get("token")})
        return {"uuid": "run-1", "pipelineId": pipeline["id"], "tapisStatus": "submitted"}

    def fake_post(url, headers, json, timeout):
        captured["mints"].append({"url": url, "caller": headers["X-Tapis-Token"], "body": json})
        return captured.get("mint_response", _Resp())

    monkeypatch.setattr("app.main.tapis.submit_tapis_workflow", fake_submit)
    monkeypatch.setattr(run_tokens.httpx, "post", fake_post)
    return captured


def _submit(plan_id, **extra):
    return client.post(
        "/workflows/submit",
        headers={"Authorization": f"Bearer {CALLER}"},
        json={"plan_id": plan_id, "args": WERC_ARGS, **extra},
    )


def test_enabled_submit_passes_run_token_but_registers_with_caller_token(monkeypatch, stubs):
    monkeypatch.setattr(settings, "run_token_enabled", True)
    resp = _submit(_plan_id())

    assert resp.status_code == 200, resp.text
    assert len(stubs["mints"]) == 1
    assert stubs["mints"][0]["caller"] == CALLER
    assert stubs["mints"][0]["body"]["token_username"] == "alice"
    sub = stubs["submits"][0]
    assert sub["args"]["tapis_token"] == {"value": "RUN.JWT.TOKEN"}
    assert sub["token"] == CALLER  # register + run still authenticate as the caller
    assert "RUN.JWT.TOKEN" not in resp.text and CALLER not in resp.text


def test_disabled_submit_is_unchanged(monkeypatch, stubs):
    monkeypatch.setattr(settings, "run_token_enabled", False)
    resp = _submit(_plan_id())

    assert resp.status_code == 200, resp.text
    assert stubs["mints"] == []
    assert stubs["submits"][0]["args"]["tapis_token"] == {"value": CALLER}


def test_dry_run_never_mints(monkeypatch, stubs):
    monkeypatch.setattr(settings, "run_token_enabled", True)
    resp = _submit(_plan_id(), dry_run=True)

    assert resp.status_code == 200, resp.text
    assert stubs["mints"] == [] and stubs["submits"] == []
    assert "tapis_token" not in resp.json().get("args", {})


def test_mint_failure_returns_502_and_never_submits_or_leaves_a_run(monkeypatch, stubs):
    monkeypatch.setattr(settings, "run_token_enabled", True)
    stubs["mint_response"] = _Resp(403)
    plan_id = _plan_id()
    resp = _submit(plan_id)

    assert resp.status_code == 502
    detail = resp.json()["detail"]
    assert detail["code"] == "RUN_TOKEN_MINT_FAILED"
    assert CALLER not in resp.text
    assert stubs["submits"] == []  # caller token is never used as a fallback
    assert client.get("/runs").json()["runs"] == []  # failed before any run row
