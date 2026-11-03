"""Token keeper (token lifecycle design rev 2): encrypted at-rest copy,
POST /runs/{id}/token, renewal, and the model task's fetch paths.

Demo mode, Tapis stubbed. Complements test_run_tokens.py (Phase 1 mint) and
test_run_signal.py (the HMAC credential this reuses under its own domain).
"""
from __future__ import annotations

import base64
import io
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from cryptography.fernet import Fernet  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import poller, run_state, run_tokens  # noqa: E402
from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402
from app.store import STORE  # noqa: E402
from app.tapis import generate_tapis_workflow  # noqa: E402

client = TestClient(app)
JWT_RE = re.compile(r"eyJ[\w-]+\.[\w-]+\.[\w-]+")


def _jwt(exp_in: int, user: str = "alice") -> str:
    def enc(obj):
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()
    claims = {"tapis/username": user, "exp": int(time.time()) + exp_in, "jti": os.urandom(4).hex()}
    return f"{enc({'alg': 'none'})}.{enc(claims)}.sig"


@pytest.fixture(autouse=True)
def _keeper(monkeypatch):
    monkeypatch.setattr(settings, "run_signal_secrets", "current-secret")
    monkeypatch.setattr(settings, "public_base_url", "https://svo.example")
    monkeypatch.setattr(settings, "run_token_enabled", True)
    monkeypatch.setattr(settings, "run_token_ttl_seconds", 3600)
    monkeypatch.setattr(settings, "run_token_ttl_min_seconds", 900)
    monkeypatch.setattr(settings, "run_token_ttl_max_seconds", 172800)
    monkeypatch.setattr(settings, "run_token_keeper_enabled", True)
    monkeypatch.setattr(settings, "run_token_encryption_keys", Fernet.generate_key().decode())
    monkeypatch.setattr(settings, "run_token_keeper_max_renewals", 3)
    monkeypatch.setattr(settings, "run_token_fetch_rate_limit", 4)
    from app import main as main_mod
    main_mod._TOKEN_FETCH_RATE.clear()
    client.post("/admin/reset")


def _run(token: str, **over):
    now = datetime.now(tz=timezone.utc)
    run_id = over.get("id", "run-1")
    row = {
        "id": run_id, "status": "running", "tapis_workflow_id": "pipe-1", "tapis_run_id": "uuid-1",
        "execution_id": "ue_1", "signals_armed": True, "health": None,
        "dispatched_at": now.isoformat(), "started_at": None, "last_signal_at": None,
        "model_job_uuid": None, "model_job_name": None, "model_job_verified": False,
        "submitted_by": "alice",
        "run_token_enc": run_tokens.encrypt_run_token(run_id, token),
        "run_token_expires_at": (run_tokens.token_expires_at(token) or now).isoformat(),
        "run_token_deadline_at": run_tokens.keeper_deadline(now).isoformat(),
        "run_token_renewals": 0,
    }
    row.update(over)
    STORE.run[row["id"]] = row
    return row


def _headers(run_id="run-1", *, expires=None, maker=run_state.make_token_fetch_credential):
    expires = expires or int((datetime.now(tz=timezone.utc) + timedelta(hours=1)).timestamp())
    return {"X-Run-Token-Credential": maker(run_id, expires), "X-Run-Token-Expires": str(expires)}


def _events(run_id, event_type=None):
    return [e for e in STORE.provenance
            if e.get("workflow_run_id") == run_id and (event_type is None or e.get("event_type") == event_type)]


# --- storage helpers -----------------------------------------------------------
def test_ciphertext_is_bound_to_the_run_and_is_not_a_jwt():
    token = _jwt(3600)
    enc = run_tokens.encrypt_run_token("run-1", token)
    assert not JWT_RE.search(enc)
    assert run_tokens.decrypt_run_token("run-1", enc) == token
    with pytest.raises(run_tokens.RunTokenError):
        run_tokens.decrypt_run_token("run-2", enc)  # copied onto another row
    with pytest.raises(run_tokens.RunTokenError):
        run_tokens.decrypt_run_token("run-1", enc[:-4] + "AAAA")


def test_key_rotation_keeps_old_ciphertext_readable(monkeypatch):
    old_key = settings.run_token_encryption_keys
    token = _jwt(3600)
    enc = run_tokens.encrypt_run_token("run-1", token)
    monkeypatch.setattr(settings, "run_token_encryption_keys", f"{Fernet.generate_key().decode()},{old_key}")
    assert run_tokens.decrypt_run_token("run-1", enc) == token
    monkeypatch.setattr(settings, "run_token_encryption_keys", Fernet.generate_key().decode())
    with pytest.raises(run_tokens.RunTokenError):
        run_tokens.decrypt_run_token("run-1", enc)


def test_renewal_margin_and_due():
    assert run_tokens.renew_margin_seconds() == 900  # ttl 3600 // 4
    now = datetime.now(tz=timezone.utc)
    assert run_tokens.renewal_due(now + timedelta(seconds=800), now)
    assert not run_tokens.renewal_due(now + timedelta(seconds=1000), now)
    assert not run_tokens.renewal_due(None, now)  # no exp claim: serve as-is, never churn


def test_validate_keeper_config_fails_closed(monkeypatch):
    run_tokens.validate_keeper_config()  # fixture config is complete
    monkeypatch.setattr(settings, "run_token_encryption_keys", "not-a-key")
    with pytest.raises(run_tokens.RunTokenError) as exc:
        run_tokens.validate_keeper_config()
    assert "malformed" in str(exc.value) and "not-a-key" not in str(exc.value)
    monkeypatch.setattr(settings, "run_token_encryption_keys", "")
    with pytest.raises(run_tokens.RunTokenError):
        run_tokens.validate_keeper_config()
    monkeypatch.setattr(settings, "run_token_keeper_enabled", False)
    run_tokens.validate_keeper_config()  # off: nothing to validate
    assert not run_tokens.keeper_configured()


def test_fetch_credential_is_its_own_domain():
    expires = int(time.time()) + 600
    sig = run_state.make_signal_token("run-1", expires)
    fetch = run_state.make_token_fetch_credential("run-1", expires)
    assert sig != fetch
    assert run_state.verify_token_fetch_credential("run-1", str(expires), fetch)
    assert not run_state.verify_token_fetch_credential("run-1", str(expires), sig)
    assert not run_state.verify_signal_token("run-1", str(expires), fetch)
    assert not run_state.verify_token_fetch_credential("run-2", str(expires), fetch)


# --- POST /runs/{id}/token -------------------------------------------------------
def test_fetch_returns_the_stored_token_and_audits_without_leaking():
    token = _jwt(3600)
    _run(token)
    resp = client.post("/runs/run-1/token", headers=_headers())
    assert resp.status_code == 200, resp.text
    assert resp.json()["token"] == token
    assert resp.headers["cache-control"] == "no-store"
    fetched = _events("run-1", "run.token.fetched")
    assert len(fetched) == 1 and fetched[0]["payload_json"]["renewed"] is False
    for event in _events("run-1"):
        assert not JWT_RE.search(json.dumps(event["payload_json"]))


def test_fetch_rejects_bad_unknown_and_signal_domain_credentials():
    _run(_jwt(3600))
    assert client.post("/runs/run-1/token").status_code == 401
    assert client.post("/runs/run-1/token", headers=_headers(maker=run_state.make_signal_token)).status_code == 401
    assert client.post("/runs/run-9/token", headers=_headers("run-9")).status_code == 401
    stale = int(time.time()) - 5
    assert client.post("/runs/run-1/token", headers=_headers(expires=stale)).status_code == 401
    assert _events("run-1") == []  # refused before any database access


def test_fetch_is_unavailable_for_terminal_runs_and_when_keeper_is_off(monkeypatch):
    _run(_jwt(3600), status="completed")
    resp = client.post("/runs/run-1/token", headers=_headers())
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "RUN_TOKEN_UNAVAILABLE"
    assert _events("run-1", "run.token.refused")[0]["payload_json"]["reason"] == "run_not_active"
    monkeypatch.setattr(settings, "run_token_keeper_enabled", False)
    assert client.post("/runs/run-1/token", headers=_headers()).status_code == 404


def test_fetch_past_deadline_clears_and_revokes(monkeypatch):
    revoked = []
    monkeypatch.setattr(run_tokens, "revoke_token", lambda auth, tok: revoked.append(tok) or True)
    token = _jwt(3600)
    past = (datetime.now(tz=timezone.utc) - timedelta(minutes=1)).isoformat()
    _run(token, run_token_deadline_at=past)
    assert client.post("/runs/run-1/token", headers=_headers()).status_code == 404
    assert STORE.run["run-1"]["run_token_enc"] is None
    assert revoked == [token]
    assert _events("run-1", "run.token.refused")[0]["payload_json"]["reason"] == "deadline_passed"


def test_fetch_with_expired_stored_token_clears_it():
    _run(_jwt(-10))
    assert client.post("/runs/run-1/token", headers=_headers()).status_code == 404
    assert STORE.run["run-1"]["run_token_enc"] is None
    assert _events("run-1", "run.token.refused")[0]["payload_json"]["reason"] == "stored_token_expired"


def test_fetch_renews_a_token_close_to_expiry_and_revokes_the_predecessor(monkeypatch):
    minted, revoked = [], []
    fresh = _jwt(3600)

    def fake_mint(caller):
        minted.append(caller)
        return fresh
    monkeypatch.setattr(run_tokens, "mint_run_token", fake_mint)
    monkeypatch.setattr(run_tokens, "revoke_token", lambda auth, tok: revoked.append(tok) or True)
    old = _jwt(600)  # inside the 900 s margin
    _run(old)
    resp = client.post("/runs/run-1/token", headers=_headers())
    assert resp.status_code == 200 and resp.json()["token"] == fresh
    assert minted == [old] and revoked == [old]
    row = STORE.run["run-1"]
    assert row["run_token_renewals"] == 1
    assert run_tokens.decrypt_run_token("run-1", row["run_token_enc"]) == fresh
    assert _events("run-1", "run.token.renewed")[0]["payload_json"]["renewals"] == 1
    assert _events("run-1", "run.token.fetched")[0]["payload_json"]["renewed"] is True


def test_fetch_serves_the_current_token_when_renewal_fails(monkeypatch):
    def failing_mint(caller):
        raise run_tokens.RunTokenError("Tapis run-token mint failed (HTTP 500)")
    monkeypatch.setattr(run_tokens, "mint_run_token", failing_mint)
    old = _jwt(600)
    _run(old)
    resp = client.post("/runs/run-1/token", headers=_headers())
    assert resp.status_code == 200 and resp.json()["token"] == old
    assert _events("run-1", "run.token.renew_failed")


def test_renewal_cap_stops_minting(monkeypatch):
    monkeypatch.setattr(run_tokens, "mint_run_token", lambda caller: _jwt(3600))
    monkeypatch.setattr(run_tokens, "revoke_token", lambda auth, tok: True)
    old = _jwt(600)
    _run(old, run_token_renewals=settings.run_token_keeper_max_renewals)
    resp = client.post("/runs/run-1/token", headers=_headers())
    assert resp.status_code == 200 and resp.json()["token"] == old
    assert _events("run-1", "run.token.renew_capped")


def test_fetch_rate_limit():
    _run(_jwt(3600))
    codes = [client.post("/runs/run-1/token", headers=_headers()).status_code for _ in range(5)]
    assert codes == [200, 200, 200, 200, 429]


# --- sweep + release ----------------------------------------------------------------
@pytest.mark.anyio
async def test_sweep_renews_due_clears_expired_and_respects_deadline(monkeypatch):
    monkeypatch.setattr(run_tokens, "mint_run_token", lambda caller: _jwt(3600))
    revoked = []
    monkeypatch.setattr(run_tokens, "revoke_token", lambda auth, tok: revoked.append(tok) or True)
    due = _run(_jwt(600), id="due")
    fine = _run(_jwt(3000), id="fine")
    expired = _run(_jwt(-5), id="expired")
    past = (datetime.now(tz=timezone.utc) - timedelta(minutes=1)).isoformat()
    late = _run(_jwt(3000), id="late", run_token_deadline_at=past)
    done = _run(_jwt(600), id="done", status="completed")
    touched = await poller.renew_run_tokens()
    assert set(touched) == {"due", "expired", "late"}
    assert STORE.run["due"]["run_token_renewals"] == 1
    assert STORE.run["fine"]["run_token_renewals"] == 0 and STORE.run["fine"]["run_token_enc"]
    assert STORE.run["expired"]["run_token_enc"] is None
    assert STORE.run["late"]["run_token_enc"] is None
    assert STORE.run["done"]["run_token_renewals"] == 0
    assert _events("expired", "run.token.expired_unrenewed")
    assert _events("late", "run.token.cleared")[0]["payload_json"]["reason"] == "deadline"
    assert len(revoked) == 2  # predecessor of `due`, stored token of `late`
    assert fine and done and due


@pytest.mark.anyio
async def test_release_run_token_revokes_and_reports():
    revoked = []
    import app.run_tokens as rt
    original = rt.revoke_token
    rt.revoke_token = lambda auth, tok: revoked.append(tok) or True
    try:
        token = _jwt(3600)
        _run(token)
        from app.hasura import get_client
        assert await poller.release_run_token(get_client(None), "run-1", "terminal:completed") is True
        assert revoked == [token]
        assert _events("run-1", "run.token.cleared")[0]["payload_json"] == {
            "reason": "terminal:completed", "revoked": True}
        assert await poller.release_run_token(get_client(None), "run-9", "terminal:completed") is None
    finally:
        rt.revoke_token = original


def test_terminal_update_clears_keeper_columns_only_when_the_keeper_is_on(monkeypatch):
    status, update = poller._terminal_update_set("FINISHED", {})
    assert status == "completed"
    assert update["run_token_enc"] is None and update["run_token_expires_at"] is None
    # Keeper off (the default): the update set must not name the new columns, so
    # a database without the migration keeps working.
    monkeypatch.setattr(settings, "run_token_keeper_enabled", False)
    _, update = poller._terminal_update_set("FINISHED", {})
    assert "run_token_enc" not in update and "run_token_expires_at" not in update


def test_fetch_serves_the_winner_when_the_renewal_cas_loses(monkeypatch):
    winner = _jwt(7200)
    revoked = []
    monkeypatch.setattr(run_tokens, "revoke_token", lambda auth, tok: revoked.append(tok) or True)
    old = _jwt(600)
    _run(old)

    def racing_mint(caller):
        # Another renewer stores its successor between our mint and our CAS.
        row = STORE.run["run-1"]
        row["run_token_enc"] = run_tokens.encrypt_run_token("run-1", winner)
        row["run_token_expires_at"] = run_tokens.token_expires_at(winner).isoformat()
        row["run_token_renewals"] = 1
        return _jwt(7200)
    monkeypatch.setattr(run_tokens, "mint_run_token", racing_mint)
    resp = client.post("/runs/run-1/token", headers=_headers())
    assert resp.status_code == 200
    assert resp.json()["token"] == winner          # never the token about to be revoked
    assert winner not in revoked and old not in revoked  # only our losing mint was revoked
    assert len(revoked) == 1 and STORE.run["run-1"]["run_token_renewals"] == 1


def test_fetch_on_a_cancelling_row_releases_its_token(monkeypatch):
    revoked = []
    monkeypatch.setattr(run_tokens, "revoke_token", lambda auth, tok: revoked.append(tok) or True)
    token = _jwt(3600)
    _run(token, status="cancelling")
    assert client.post("/runs/run-1/token", headers=_headers()).status_code == 404
    assert revoked == [token] and STORE.run["run-1"]["run_token_enc"] is None


@pytest.mark.anyio
async def test_sweep_clears_cancelling_rows_past_the_deadline(monkeypatch):
    revoked = []
    monkeypatch.setattr(run_tokens, "revoke_token", lambda auth, tok: revoked.append(tok) or True)
    past = (datetime.now(tz=timezone.utc) - timedelta(minutes=1)).isoformat()
    token = _jwt(3600)
    _run(token, id="stuck", status="cancelling", run_token_deadline_at=past)
    assert await poller.renew_run_tokens() == ["stuck"]
    assert STORE.run["stuck"]["run_token_enc"] is None and revoked == [token]


# --- generated model task -------------------------------------------------------------
def _composite_plan():
    return {
        "id": "plan-keeper",
        "plan_json": {
            "steps": [],
            "parameters": [],
            "model_task": {
                "stage_id": "model",
                "output_uri": "tapis://ls6/mint-workflow-output/ue-1/model/cbb",
                "output_name": "cbb",
                "output_format": "cbc",
                "max_minutes": 5,
                "job_definition": {
                    "name": "mint-workflow-model-ue-1",
                    "appId": "modflow6-simulation",
                    "appVersion": "0.0.test",
                    "archiveSystemId": "ls6",
                    "fileInputs": [],
                    "parameterSet": {"appArgs": []},
                },
            },
        },
    }


def test_model_task_declares_token_fetch_inputs_and_paths():
    workflow = generate_tapis_workflow(_composite_plan())
    model_task = workflow["tasks"][0]
    for key, arg in (("TOKEN_URL", "token_url"), ("TOKEN_FETCH_TOKEN", "token_fetch_token"),
                     ("TOKEN_FETCH_EXPIRES", "token_fetch_expires")):
        assert model_task["input"][key] == {"type": "string", "value_from": {"args": arg}}
        assert workflow["params"][arg]["required"] is False
    code = model_task["code"]
    compile(code, "<model-task>", "exec")
    assert "RUN_TOKEN_EXPIRED_BEFORE_START" in code
    assert "exc.code == 401 and auth_retry and _fetch_token()" in code  # 401 only, never 403
    assert code.index("_fetch_token()") < code.index("_job_uuid = _existing_job()")
    for line in code.splitlines():
        if "print(" in line:
            assert "_token" not in line and "_cred" not in line and "TOKEN" not in line, line


class _FakeResponse(io.BytesIO):
    def __init__(self, payload, code=200):
        super().__init__(json.dumps(payload).encode())
        self._code = code

    def getcode(self):
        return self._code

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _run_generated_model_task(monkeypatch, *, baked_token: str, fresh_token: str | None,
                              token_url: str = "https://svo.example/runs/run-1/token"):
    """Execute the generated task with urllib stubbed; return the call log."""
    calls: list[dict] = []
    job_uuid = "job-uuid-1"

    def fake_urlopen(request, timeout=None):
        url = request.full_url
        calls.append({"url": url, "method": request.get_method(),
                      "tapis_token": request.get_header("X-tapis-token"),
                      "fetch_cred": request.get_header("X-run-token-credential")})
        if url == token_url:
            if fresh_token is None:
                raise urllib.error.HTTPError(url, 404, "nope", {}, io.BytesIO(b"{}"))
            return _FakeResponse({"token": fresh_token})
        if url.endswith("/signal"):
            return _FakeResponse({"accepted": True})
        if "/v3/jobs/list" in url:
            return _FakeResponse({"result": []})
        if url.endswith("/v3/jobs/submit"):
            if request.get_header("X-tapis-token") == baked_token and fresh_token is not None:
                raise urllib.error.HTTPError(url, 401, "expired", {}, io.BytesIO(b"{}"))
            return _FakeResponse({"result": {"uuid": job_uuid}})
        if url.endswith(f"/v3/jobs/{job_uuid}/status"):
            return _FakeResponse({"result": {"status": "FINISHED"}})
        if url.endswith("/output/list/"):
            return _FakeResponse({"result": [{"name": "model.cbb", "type": "file",
                                              "url": "tapis://ls6/out/model.cbb"}]})
        if url.endswith(f"/v3/jobs/{job_uuid}"):
            return _FakeResponse({"result": {"archiveSystemId": "ls6", "condition": "NORMAL_COMPLETION"}})
        if url.endswith("/v3/tokens"):
            return _FakeResponse({"result": {"access_token": {"access_token": fresh_token or baked_token}}})
        raise AssertionError(f"unexpected call {request.get_method()} {url}")

    import urllib.error  # noqa: F401 — used by the stub above
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(time, "sleep", lambda *_: None)
    for key, value in {
        "TAPIS_BASE_URL": "https://portals.example", "TAPIS_TOKEN": baked_token,
        "SIGNAL_URL": "https://svo.example/runs/run-1/signal", "SIGNAL_TOKEN": "sig", "SIGNAL_EXPIRES": "9999999999",
        "TOKEN_URL": token_url, "TOKEN_FETCH_TOKEN": "cred", "TOKEN_FETCH_EXPIRES": "9999999999",
    }.items():
        monkeypatch.setenv(key, value)
    code = generate_tapis_workflow(_composite_plan())["tasks"][0]["code"]
    exec(compile(code, "<model-task>", "exec"), {"__name__": "__task__"})
    return calls


def test_late_start_fetches_a_live_token_before_the_first_tapis_call(monkeypatch, capsys):
    baked, fresh = _jwt(-60), _jwt(3600)
    calls = _run_generated_model_task(monkeypatch, baked_token=baked, fresh_token=fresh)
    tapis_calls = [c for c in calls if "portals.example" in c["url"]]
    fetches = [c for c in calls if c["url"].endswith("/token")]
    assert fetches and fetches[0]["fetch_cred"] == "cred"
    assert calls.index(fetches[0]) < calls.index(tapis_calls[0])
    assert all(c["tapis_token"] == fresh for c in tapis_calls)
    out = capsys.readouterr().out
    assert '"status": "ok"' in out and baked not in out and fresh not in out


def test_late_start_without_a_keeper_fails_with_a_clear_code(monkeypatch, capsys):
    with pytest.raises(RuntimeError) as exc:
        _run_generated_model_task(monkeypatch, baked_token=_jwt(-60), fresh_token=None)
    assert "RUN_TOKEN_EXPIRED_BEFORE_START" in str(exc.value)
    assert "eyJ" not in capsys.readouterr().out.replace(_jwt(0)[:0], "")


def test_mid_run_401_fetches_once_and_does_not_double_submit(monkeypatch):
    # Baked token is still valid at start (no pre-fetch) but Tapis rejects the
    # submit with 401; the task must fetch, re-check for an existing job, and
    # submit exactly once with the fresh token.
    baked, fresh = _jwt(3600), _jwt(7200)
    calls = _run_generated_model_task(monkeypatch, baked_token=baked, fresh_token=fresh)
    submits = [c for c in calls if c["url"].endswith("/v3/jobs/submit")]
    lists = [c for c in calls if "/v3/jobs/list" in c["url"]]
    fetches = [c for c in calls if c["url"].endswith("/token")]
    assert [c["tapis_token"] for c in submits] == [baked, fresh]
    assert len(fetches) == 1
    assert len(lists) == 2  # once before submit, once after the 401 before resubmitting
