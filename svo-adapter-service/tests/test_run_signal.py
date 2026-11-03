"""HTTP-level tests for /runs/{id}/signal, /cancel, the /poll interactions and
submit-time arming (demo mode, Tapis stubbed)."""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import run_state  # noqa: E402
from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402
from app.store import STORE  # noqa: E402

client = TestClient(app)
BEARER = {"Authorization": "Bearer caller.jwt.token"}


@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    monkeypatch.setattr(settings, "run_signal_secrets", "current-secret")
    monkeypatch.setattr(settings, "public_base_url", "https://svo.example")
    monkeypatch.setattr(settings, "cancel_admins", "")
    client.post("/admin/reset")


def _run(**over):
    row = {
        "id": "run-1", "status": "running", "tapis_workflow_id": "pipe-1", "tapis_run_id": "uuid-1",
        "execution_id": "ue_1", "signals_armed": True, "health": None,
        "dispatched_at": datetime.now(tz=timezone.utc).isoformat(),
        "started_at": None, "last_signal_at": None,
        "model_job_uuid": None, "model_job_name": None, "model_job_verified": False,
        "submitted_by": "alice",
    }
    row.update(over)
    STORE.run[row["id"]] = row
    return row


def _headers(run_id, *, expires=None, secret=None):
    expires = expires or int((datetime.now(tz=timezone.utc) + timedelta(hours=1)).timestamp())
    return {
        "X-Run-Signal-Token": run_state.make_signal_token(run_id, expires, secret=secret),
        "X-Run-Signal-Expires": str(expires),
    }


def _events(run_id, event_type=None):
    return [e for e in STORE.provenance
            if e.get("workflow_run_id") == run_id and (event_type is None or e.get("event_type") == event_type)]


def _signal(run_id, body, **kw):
    return client.post(f"/runs/{run_id}/signal", json=body, headers=_headers(run_id, **kw))


# --- /signal auth ----------------------------------------------------------------
def test_signal_is_unavailable_until_secrets_are_configured(monkeypatch):
    monkeypatch.setattr(settings, "run_signal_secrets", "")
    _run()
    # Even a well-formed token is refused outright while the feature is off.
    assert _signal("run-1", {"event": "started"}, secret="stale-secret").status_code == 503


def test_bad_token_unknown_run_and_expired_token_all_look_the_same():
    _run()
    bad = _signal("run-1", {"event": "started"}, secret="wrong")
    ghost = _signal("ghost", {"event": "started"})
    expired = _signal("run-1", {"event": "started"},
                      expires=int((datetime.now(tz=timezone.utc) - timedelta(seconds=5)).timestamp()))
    assert bad.status_code == ghost.status_code == expired.status_code == 401
    assert bad.json() == ghost.json() == expired.json()
    assert STORE.run["run-1"]["health"] is None


def test_invalid_event_is_a_400():
    _run()
    assert _signal("run-1", {"event": "heartbeat"}).status_code == 400
    assert _signal("run-1", {"event": "started", "task_id": "step-0"}).status_code == 400


# --- /signal effects --------------------------------------------------------------
def test_started_marks_the_run_alive():
    _run(status="submitting")
    response = _signal("run-1", {"event": "started"})
    assert response.status_code == 200 and response.json()["applied"] is True
    row = STORE.run["run-1"]
    assert row["status"] == "running" and row["health"] == "ok"
    assert row["started_at"] and row["last_signal_at"]
    assert len(_events("run-1", "run.signal.started")) == 1


def test_a_replayed_signal_is_recorded_but_not_applied():
    _run()
    assert _signal("run-1", {"event": "started"}).json()["applied"] is True
    first_started_at = STORE.run["run-1"]["started_at"]
    replay = _signal("run-1", {"event": "started"}).json()
    assert replay["duplicate"] is True and replay["applied"] is False
    assert STORE.run["run-1"]["started_at"] == first_started_at
    assert len(_events("run-1", "run.signal.duplicate")) == 1


def test_job_submitted_stores_an_unverified_job_identity():
    _run()
    _signal("run-1", {"event": "job_submitted", "job_uuid": "job-1", "job_name": "mint-workflow-model-x"})
    row = STORE.run["run-1"]
    assert row["model_job_uuid"] == "job-1" and row["model_job_verified"] is False
    assert row["model_job_name"] == "mint-workflow-model-x"


def test_finished_with_code_reports_failure_without_failing_the_run():
    _run()
    _signal("run-1", {"event": "finished", "code": "MODEL_PROVIDER_JOB_FAILED", "message": "exit 2"})
    row = STORE.run["run-1"]
    assert row["status"] == "running" and row["health"] == "reported_failed"
    assert "MODEL_PROVIDER_JOB_FAILED" in row["error_message"]


def test_signals_cannot_revive_a_terminal_run():
    _run(status="completed")
    response = _signal("run-1", {"event": "started"})
    assert response.status_code == 200 and response.json()["applied"] is False
    assert STORE.run["run-1"]["status"] == "completed" and STORE.run["run-1"]["started_at"] is None


def test_started_clears_a_stall_verdict():
    _run(health="stalled", error_message="stalled msg")
    _signal("run-1", {"event": "started"})
    assert STORE.run["run-1"]["health"] == "ok"


# --- /cancel ----------------------------------------------------------------------
@pytest.fixture
def tapis_stubs(monkeypatch):
    calls = {"terminate": [], "cancel_job": [], "username": "alice",
             "terminate_ok": True, "cancel_ok": True}

    def fake_userinfo(token):
        return calls["username"]

    def fake_terminate(token, pipeline_id, run_uuid, group_id=None):
        calls["terminate"].append((pipeline_id, run_uuid))
        return (calls["terminate_ok"], 200 if calls["terminate_ok"] else 500)

    def fake_cancel_job(token, job_uuid):
        calls["cancel_job"].append(job_uuid)
        return (calls["cancel_ok"], 200 if calls["cancel_ok"] else 500)

    monkeypatch.setattr("app.main.tapis.userinfo_username", fake_userinfo)
    monkeypatch.setattr("app.main.tapis.terminate_pipeline_run", fake_terminate)
    monkeypatch.setattr("app.main.tapis.cancel_job", fake_cancel_job)
    return calls


def test_cancel_requires_a_bearer_token(tapis_stubs):
    _run()
    assert client.post("/runs/run-1/cancel").status_code == 401


def test_cancel_is_forbidden_for_anyone_but_the_submitter(tapis_stubs):
    _run(submitted_by="bob")
    response = client.post("/runs/run-1/cancel", headers=BEARER)
    assert response.status_code == 403
    assert STORE.run["run-1"]["status"] == "running" and tapis_stubs["terminate"] == []


def test_cancel_admin_may_cancel_any_run(monkeypatch, tapis_stubs):
    monkeypatch.setattr(settings, "cancel_admins", "alice")
    _run(submitted_by="bob")
    assert client.post("/runs/run-1/cancel", headers=BEARER).status_code == 200
    assert STORE.run["run-1"]["status"] == "cancelled"


def test_cancel_terminates_the_run_and_a_verified_job(tapis_stubs):
    _run(model_job_uuid="job-1", model_job_verified=True)
    response = client.post("/runs/run-1/cancel", headers=BEARER)
    assert response.status_code == 200
    assert response.json()["status"] == "cancelled" and response.json()["job_cancelled"] is True
    row = STORE.run["run-1"]
    assert row["status"] == "cancelled" and row["error_message"] == "Cancelled by alice"
    assert tapis_stubs["terminate"] == [("pipe-1", "uuid-1")]
    assert tapis_stubs["cancel_job"] == ["job-1"]
    audit = _events("run-1", "run.cancelled")[0]["payload_json"]
    assert audit["username"] == "alice" and audit["terminate_http_status"] == 200


def test_cancel_never_touches_an_unverified_job(tapis_stubs):
    _run(model_job_uuid="job-1", model_job_verified=False)
    client.post("/runs/run-1/cancel", headers=BEARER)
    assert tapis_stubs["cancel_job"] == []
    assert STORE.run["run-1"]["status"] == "cancelled"


def test_cancel_partial_failure_stays_cancelling(tapis_stubs):
    tapis_stubs["terminate_ok"] = False
    _run()
    response = client.post("/runs/run-1/cancel", headers=BEARER)
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "RUN_CANCEL_INCOMPLETE"
    assert STORE.run["run-1"]["status"] == "cancelling"
    assert _events("run-1", "run.cancel_failed")


def test_cancel_is_a_noop_on_a_terminal_run(tapis_stubs):
    _run(status="failed")
    response = client.post("/runs/run-1/cancel", headers=BEARER)
    assert response.status_code == 200 and response.json()["already_terminal"] is True
    assert tapis_stubs["terminate"] == []


# --- /poll interactions --------------------------------------------------------------
def test_poll_never_revises_a_cancelled_run(monkeypatch):
    _run(status="cancelled")

    def must_not_be_called(*args, **kwargs):
        raise AssertionError("Tapis must not be consulted for a cancelled run")

    monkeypatch.setattr("app.main.tapis.get_run_detail", must_not_be_called)
    response = client.post("/runs/run-1/poll", headers=BEARER)
    assert response.status_code == 200 and response.json()["status"] == "cancelled"


def test_poll_verifies_the_signalled_job_and_clears_stalled(monkeypatch):
    _run(health="stalled", model_job_uuid="job-1", model_job_name="mint-workflow-model-x")
    monkeypatch.setattr("app.main.tapis.get_run_detail",
                        lambda *a, **k: {"status": "ACTIVE", "tasks": []})
    monkeypatch.setattr("app.main.tapis.get_job",
                        lambda token, uuid: {"uuid": uuid, "name": "mint-workflow-model-x", "status": "QUEUED"})
    response = client.post("/runs/run-1/poll", headers=BEARER)
    assert response.status_code == 200
    row = STORE.run["run-1"]
    assert row["model_job_verified"] is True and row["health"] == "ok"
    assert row["status"] == "running"


def test_poll_rejects_a_job_whose_name_does_not_match(monkeypatch):
    _run(health="stalled", model_job_uuid="job-1", model_job_name="mint-workflow-model-x")
    monkeypatch.setattr("app.main.tapis.get_run_detail",
                        lambda *a, **k: {"status": "ACTIVE", "tasks": []})
    monkeypatch.setattr("app.main.tapis.get_job",
                        lambda token, uuid: {"uuid": uuid, "name": "someone-elses-job"})
    client.post("/runs/run-1/poll", headers=BEARER)
    row = STORE.run["run-1"]
    assert row["model_job_verified"] is False and row["health"] == "stalled"


# --- submit-time arming -------------------------------------------------------------
WERC_ARGS = {
    "start_date": "2024-01-01",
    "end_date": "2025-01-01",
    "allocation": "PT2050-DataX",
    "aoi_geojson_uri": "tapis://ls6/demo/aoi.geojson",
    "min_overlap_percent": 0.5,
    "num_workers": 1,
    "reference_mode": "auto",
}
MODEL_TASK = {
    "stage_id": "model",
    "output_name": "cbb",
    "output_format": "cbc",
    "max_minutes": 30,
    "job_definition": {"name": "mint-workflow-model-abc", "appId": "modflow6-simulation",
                       "appVersion": "0.0.test"},
}


@pytest.fixture
def composite_submit(monkeypatch):
    captured = {"submits": []}

    def fake_submit(pipeline, args, **kwargs):
        captured["submits"].append({"pipeline": pipeline, "args": args})
        return {"uuid": "tapis-run-1", "pipelineId": pipeline["id"], "tapisStatus": "submitted"}

    monkeypatch.setattr("app.main.tapis.submit_tapis_workflow", fake_submit)
    monkeypatch.setattr("app.main.tapis.userinfo_username", lambda token: "alice")
    monkeypatch.setattr(settings, "internal_service_secret", "em-secret")
    seed = client.post("/admin/seed-subside-werc").json()
    plan_id = client.post("/plans", json={
        "data_object_id": seed["data_object"]["id"],
        "target_contract": seed["target_contract"],
    }).json()["plan_id"]

    def submit():
        return client.post(
            "/workflows/submit",
            headers={**BEARER, "X-Ensemble-Manager-Secret": "em-secret"},
            json={"plan_id": plan_id, "args": WERC_ARGS, "model_task": MODEL_TASK, "execution_id": "ue_1"},
        )

    captured["submit"] = submit
    return captured


def test_composite_submit_arms_signals_and_records_the_submitter(composite_submit):
    response = composite_submit["submit"]()
    assert response.status_code == 200, response.text
    run_id = response.json()["run_id"]
    args = composite_submit["submits"][0]["args"]
    assert args["signal_url"]["value"] == f"https://svo.example/runs/{run_id}/signal"
    assert run_state.verify_signal_token(run_id, args["signal_expires"]["value"], args["signal_token"]["value"])
    row = STORE.run[run_id]
    assert row["signals_armed"] is True and row["dispatched_at"]
    assert row["submitted_by"] == "alice" and row["model_job_name"] == "mint-workflow-model-abc"
    assert _events(run_id, "run.signal.armed")
    # The token is a credential: it must not come back in the response.
    assert "signal_token" not in response.text


def test_composite_submit_is_unarmed_when_signals_are_not_configured(monkeypatch, composite_submit):
    monkeypatch.setattr(settings, "run_signal_secrets", "")
    response = composite_submit["submit"]()
    assert response.status_code == 200, response.text
    args = composite_submit["submits"][0]["args"]
    assert "signal_token" not in args and "signal_url" not in args
    assert STORE.run[response.json()["run_id"]]["signals_armed"] is False


# --- token keeper at submit (run_tokens.py, design rev 2) ---------------------------
def test_composite_submit_stores_the_run_token_and_arms_the_fetch_credential(monkeypatch, composite_submit):
    from cryptography.fernet import Fernet
    from app import run_tokens

    monkeypatch.setattr(settings, "run_token_enabled", True)
    monkeypatch.setattr(settings, "run_token_keeper_enabled", True)
    monkeypatch.setattr(settings, "run_token_encryption_keys", Fernet.generate_key().decode())

    # BEARER here is not a real JWT, so stub the mint itself (shape is covered
    # by test_run_tokens.py).
    monkeypatch.setattr(run_tokens, "mint_run_token", lambda caller: "RUN.JWT.TOKEN")

    response = composite_submit["submit"]()
    assert response.status_code == 200, response.text
    run_id = response.json()["run_id"]
    args = composite_submit["submits"][0]["args"]
    assert args["tapis_token"]["value"] == "RUN.JWT.TOKEN"
    assert args["token_url"]["value"] == f"https://svo.example/runs/{run_id}/token"
    assert run_state.verify_token_fetch_credential(
        run_id, args["token_fetch_expires"]["value"], args["token_fetch_token"]["value"])
    # The fetch credential is not a signal token and vice versa.
    assert not run_state.verify_signal_token(
        run_id, args["token_fetch_expires"]["value"], args["token_fetch_token"]["value"])
    # The signal credential now lives as long as the keeper, so a late task can still report.
    assert int(args["signal_expires"]["value"]) >= int(args["token_fetch_expires"]["value"])

    row = STORE.run[run_id]
    assert row["run_token_enc"] and "RUN.JWT.TOKEN" not in row["run_token_enc"]
    assert run_tokens.decrypt_run_token(run_id, row["run_token_enc"]) == "RUN.JWT.TOKEN"
    assert row["run_token_deadline_at"] and row["run_token_renewals"] == 0
    assert _events(run_id, "run.token.stored")
    for secret in ("RUN.JWT.TOKEN", "token_fetch_token", args["signal_token"]["value"]):
        assert secret not in response.text


def test_composite_submit_without_keeper_stores_nothing(monkeypatch, composite_submit):
    from app import run_tokens

    monkeypatch.setattr(settings, "run_token_enabled", True)
    monkeypatch.setattr(settings, "run_token_keeper_enabled", False)

    # BEARER here is not a real JWT, so stub the mint itself (shape is covered
    # by test_run_tokens.py).
    monkeypatch.setattr(run_tokens, "mint_run_token", lambda caller: "RUN.JWT.TOKEN")
    response = composite_submit["submit"]()
    assert response.status_code == 200, response.text
    args = composite_submit["submits"][0]["args"]
    assert "token_url" not in args and "token_fetch_token" not in args
    assert STORE.run[response.json()["run_id"]].get("run_token_enc") is None


def test_composite_submit_failure_releases_the_stored_token(monkeypatch, composite_submit):
    from cryptography.fernet import Fernet
    from app import run_tokens

    monkeypatch.setattr(settings, "run_token_enabled", True)
    monkeypatch.setattr(settings, "run_token_keeper_enabled", True)
    monkeypatch.setattr(settings, "run_token_encryption_keys", Fernet.generate_key().decode())
    monkeypatch.setattr(run_tokens, "mint_run_token", lambda caller: "RUN.JWT.TOKEN")
    revoked = []
    monkeypatch.setattr(run_tokens, "revoke_token", lambda auth, tok: revoked.append(tok) or True)

    def failing_submit(pipeline, args, **kwargs):
        raise RuntimeError("Tapis Workflows is down")
    monkeypatch.setattr("app.main.tapis.submit_tapis_workflow", failing_submit)

    response = composite_submit["submit"]()
    assert response.status_code == 502
    run_id = response.json()["detail"]["run_id"]
    row = STORE.run[run_id]
    assert row["status"] == "failed"
    assert row["run_token_enc"] is None and row["run_token_expires_at"] is None
    assert revoked == ["RUN.JWT.TOKEN"]
    assert _events(run_id, "run.token.cleared")[0]["payload_json"]["reason"] == "submit_failed"
