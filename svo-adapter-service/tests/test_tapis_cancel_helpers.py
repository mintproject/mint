"""The cancel path talks to two Tapis APIs; pin the exact routes, since the
unit tests for /runs/{id}/cancel stub these helpers out entirely."""
from __future__ import annotations

from app import tapis


class _Resp:
    def __init__(self, status_code: int, payload=None):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


def _capture(monkeypatch, status=200, payload=None):
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(tapis, "_make_client", lambda token=None: object())

    def fake_api(client, method, path, body=None):
        calls.append((method, path))
        return _Resp(status, payload)

    monkeypatch.setattr(tapis, "_api", fake_api)
    return calls


def test_terminate_posts_to_the_pipeline_run_resource(monkeypatch):
    # Workflows `terminatePipeline` is POST on the run itself; `/terminate` 404s.
    calls = _capture(monkeypatch)
    assert tapis.terminate_pipeline_run("tok", "pipe-1", "run-1", group_id="adapter-ops") == (True, 200)
    assert calls == [("POST", "/v3/workflows/groups/adapter-ops/pipelines/pipe-1/runs/run-1")]


def test_terminate_reports_a_rejected_request(monkeypatch):
    _capture(monkeypatch, status=403)
    assert tapis.terminate_pipeline_run("tok", "pipe-1", "run-1") == (False, 403)


def test_cancel_job_posts_cancel(monkeypatch):
    calls = _capture(monkeypatch)
    assert tapis.cancel_job("tok", "job-1") == (True, 200)
    assert calls == [("POST", "/v3/jobs/job-1/cancel")]


def test_userinfo_username_comes_from_tapis_not_the_token(monkeypatch):
    calls = _capture(monkeypatch, payload={"result": {"username": "alice"}})
    assert tapis.userinfo_username("tok") == "alice"
    assert calls == [("GET", "/v3/oauth2/userinfo")]
    _capture(monkeypatch, status=401, payload={"message": "bad"})
    assert tapis.userinfo_username("tok") is None
