import base64
import json
import io
import time
import urllib.request
import urllib.error

import pytest

from app.config import settings
from app.tapis import generate_tapis_workflow


def _model_code() -> str:
    workflow = generate_tapis_workflow({
        "id": "diagnostic-plan",
        "plan_json": {
            "steps": [],
            "model_task": {
                "stage_id": "model",
                "output_name": "cbb",
                "output_format": "cbc",
                "max_minutes": 1,
                "job_definition": {
                    "name": "mint-workflow-model-test",
                    "appId": "model-app",
                    "appVersion": "0.0.test",
                    "archiveSystemId": "ls6",
                },
            },
        },
    })
    return workflow["tasks"][0]["code"]


class _Response:
    def __init__(self, payload, status=200):
        self.payload = payload
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def getcode(self):
        return self.status

    def read(self):
        return json.dumps(self.payload).encode()


def _run(code, monkeypatch, capsys, responder, token="diagnostic-token"):
    monkeypatch.setenv("TAPIS_TOKEN", token)
    monkeypatch.setenv("TAPIS_BASE_URL", "https://portals.example")

    def urlopen(request, timeout=90):
        return responder(request, timeout)

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    exec(compile(code, "model-execution", "exec"), {})
    return json.loads(capsys.readouterr().out.strip())


def test_model_stage_captures_exact_job_uuid_and_discovers_declared_output(
    monkeypatch, capsys
):
    def responder(request, _timeout):
        assert request.headers["X-tapis-token"] == "diagnostic-token"
        if request.full_url.endswith("/v3/jobs/submit"):
            return _Response({"result": {"uuid": "provider-job-1"}})
        if request.full_url.endswith("/v3/jobs/provider-job-1/status"):
            return _Response({"result": {"status": "FINISHED"}})
        if request.full_url.endswith("/v3/jobs/provider-job-1"):
            return _Response({"result": {"uuid": "provider-job-1", "archiveSystemId": "ls6"}})
        if request.full_url.endswith("/v3/jobs/provider-job-1/output/list/"):
            return _Response({"result": [{
                "type": "file",
                "name": "model.cbb",
                "path": "/scratch/model-job/model.cbb",
            }]})
        raise AssertionError(request.full_url)

    result = _run(_model_code(), monkeypatch, capsys, responder)

    assert result["status"] == "ok"
    assert result["resource_uri"] == "tapis://ls6/scratch/model-job/model.cbb"
    assert result["model_job_uuid"] == "provider-job-1"
    assert "diagnostic-token" not in json.dumps(result)


def test_model_stage_fails_closed_when_declared_output_is_ambiguous(monkeypatch, capsys):
    def responder(request, _timeout):
        if request.full_url.endswith("/v3/jobs/submit"):
            return _Response({"result": {"uuid": "provider-job-2"}})
        if request.full_url.endswith("/status"):
            return _Response({"result": {"status": "COMPLETED"}})
        if request.full_url.endswith("/v3/jobs/provider-job-2"):
            return _Response({"result": {"archiveSystemId": "ls6"}})
        if request.full_url.endswith("/output/list/"):
            return _Response({"result": [
                {"type": "file", "name": "a.cbb", "path": "/a.cbb"},
                {"type": "file", "name": "b.cbb", "path": "/b.cbb"},
            ]})
        raise AssertionError(request.full_url)

    with pytest.raises(RuntimeError, match="MODEL_OUTPUT_AMBIGUOUS"):
        _run(_model_code(), monkeypatch, capsys, responder)

    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["code"] == "MODEL_OUTPUT_AMBIGUOUS"
    assert all("diagnostic-token" not in json.dumps(attempt) for attempt in payload["attempts"])


def test_model_stage_stops_on_tapis_normal_completion(monkeypatch, capsys):
    def responder(request, _timeout):
        assert request.headers["X-tapis-token"] == "diagnostic-token"
        if request.full_url.endswith("/v3/jobs/submit"):
            return _Response({"result": {"uuid": "provider-job-normal"}})
        if request.full_url.endswith("/v3/jobs/provider-job-normal/status"):
            return _Response({"result": {"status": "NORMAL_COMPLETION"}})
        if request.full_url.endswith("/v3/jobs/provider-job-normal"):
            return _Response({"result": {"uuid": "provider-job-normal", "archiveSystemId": "ls6"}})
        if request.full_url.endswith("/v3/jobs/provider-job-normal/output/list/"):
            return _Response({"result": [{
                "type": "file",
                "name": "model.cbb",
                "path": "/scratch/model-job/model.cbb",
            }]})
        raise AssertionError(request.full_url)

    result = _run(_model_code(), monkeypatch, capsys, responder)

    assert result["status"] == "ok"
    assert result["model_job_uuid"] == "provider-job-normal"


def test_model_stage_reports_auth_failure_without_echoing_the_token(monkeypatch, capsys):
    secret = "diagnostic-token"

    def responder(request, _timeout):
        assert request.headers["X-tapis-token"] == secret
        if request.full_url.endswith("/v3/jobs/submit"):
            return _Response({"result": {"uuid": "provider-job-auth"}})
        raise urllib.error.HTTPError(
            request.full_url,
            401,
            "unauthorized",
            hdrs=None,
            fp=io.BytesIO(b'{"message":"owner mismatch"}'),
        )

    with pytest.raises(RuntimeError, match="MODEL_PROVIDER_AUTH_FAILED"):
        _run(_model_code(), monkeypatch, capsys, responder)

    output = capsys.readouterr().out
    assert "MODEL_PROVIDER_AUTH_FAILED" in output
    assert secret not in output


def _jwt(expires_in: int) -> str:
    def part(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    return ".".join([
        part({"alg": "none"}),
        part({"exp": int(time.time()) + expires_in,
              "tapis/username": "alice", "tapis/tenant_id": "portals"}),
        "sig",
    ])


def _job_responder(statuses, seen_tokens, mint=None):
    """Serve one model job whose status walks through ``statuses``."""
    polls = iter(statuses)

    def responder(request, _timeout):
        seen_tokens.append((request.get_method(), request.full_url.rsplit("/v3", 1)[1],
                            request.headers["X-tapis-token"]))
        if request.full_url.endswith("/v3/tokens"):
            return _Response(mint(request))
        if request.full_url.endswith("/v3/jobs/submit"):
            return _Response({"result": {"uuid": "long-job"}})
        if request.full_url.endswith("/v3/jobs/long-job/status"):
            return _Response({"result": {"status": next(polls)}})
        if request.full_url.endswith("/v3/jobs/long-job"):
            return _Response({"result": {"uuid": "long-job", "archiveSystemId": "ls6"}})
        if request.full_url.endswith("/v3/jobs/long-job/output/list/"):
            return _Response({"result": [{"type": "file", "name": "model.cbb", "path": "/m/model.cbb"}]})
        raise AssertionError(request.full_url)

    return responder


def test_model_stage_polls_until_the_job_is_terminal_with_no_poll_limit(monkeypatch, capsys):
    monkeypatch.setattr("time.sleep", lambda _seconds: None)
    seen = []
    # Far more polls than any fixed window would have allowed.
    statuses = ["QUEUED"] * 2000 + ["RUNNING"] * 50 + ["FINISHED"]

    result = _run(_model_code(), monkeypatch, capsys, _job_responder(statuses, seen))

    assert result["status"] == "ok"
    assert sum(1 for _m, path, _t in seen if path.endswith("/status")) == len(statuses)


def test_model_stage_renews_its_token_before_it_expires(monkeypatch, capsys):
    monkeypatch.setattr("time.sleep", lambda _seconds: None)
    monkeypatch.setattr(settings, "run_token_enabled", True)
    monkeypatch.setattr(settings, "run_token_ttl_seconds", 3600)
    expiring, fresh = _jwt(60), _jwt(3600)
    minted = []

    def mint(request):
        minted.append(json.loads(request.data))
        return {"result": {"access_token": {"access_token": fresh}}}

    seen = []
    result = _run(_model_code(), monkeypatch, capsys,
                  _job_responder(["QUEUED", "RUNNING", "FINISHED"], seen, mint), token=expiring)

    assert result["status"] == "ok"
    assert len(minted) == 1
    assert minted[0]["token_username"] == "alice" and minted[0]["access_token_ttl"] == 3600
    # The renewal call authenticates with the expiring token; every call after uses the fresh one.
    mint_index = next(i for i, (_m, path, _t) in enumerate(seen) if path == "/tokens")
    assert seen[mint_index][2] == expiring
    assert all(token == fresh for _m, _p, token in seen[mint_index + 1:])
    assert fresh not in json.dumps(result)


def test_model_stage_keeps_polling_when_a_renewal_attempt_fails(monkeypatch, capsys):
    monkeypatch.setattr("time.sleep", lambda _seconds: None)
    monkeypatch.setattr(settings, "run_token_enabled", True)
    expiring = _jwt(120)

    def mint(_request):
        raise OSError("tokens API unavailable")

    seen = []
    result = _run(_model_code(), monkeypatch, capsys,
                  _job_responder(["QUEUED", "FINISHED"], seen, mint), token=expiring)

    assert result["status"] == "ok"
    assert {token for _m, _p, token in seen} == {expiring}
