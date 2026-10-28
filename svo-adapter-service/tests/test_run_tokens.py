from __future__ import annotations

import base64
import json

import pytest

from app import run_tokens
from app.config import settings


def _jwt(claims: dict) -> str:
    def enc(obj):
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()
    return f"{enc({'alg': 'none'})}.{enc(claims)}.sig"


class _Resp:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self._body = body if body is not None else {"result": {"access_token": {"access_token": "RUN.JWT.TOKEN"}}}

    def json(self):
        return self._body


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(settings, "run_token_enabled", True)
    monkeypatch.setattr(settings, "run_token_ttl_seconds", 3600)
    monkeypatch.setattr(settings, "run_token_ttl_min_seconds", 900)
    monkeypatch.setattr(settings, "run_token_ttl_max_seconds", 7200)


def test_ttl_is_clamped(monkeypatch, enabled):
    monkeypatch.setattr(settings, "run_token_ttl_seconds", 10)
    assert run_tokens.run_token_ttl() == 900
    monkeypatch.setattr(settings, "run_token_ttl_seconds", 10**9)
    assert run_tokens.run_token_ttl() == 7200


def test_mint_request_shape_and_result(monkeypatch, enabled):
    seen = {}

    def fake_post(url, headers, json, timeout):
        seen.update(url=url, headers=headers, body=json)
        return _Resp()

    monkeypatch.setattr(run_tokens.httpx, "post", fake_post)
    caller = _jwt({"tapis/username": "alice"})
    assert run_tokens.mint_run_token(caller) == "RUN.JWT.TOKEN"
    assert seen["url"].endswith("/v3/tokens")
    assert seen["headers"]["X-Tapis-Token"] == caller
    assert seen["body"]["token_username"] == "alice"
    assert seen["body"]["account_type"] == "user"
    assert seen["body"]["access_token_ttl"] == 3600
    assert seen["body"]["target_site_id"].startswith("svo-adapter-run-")


def test_apply_replaces_token_arg_only_when_enabled(monkeypatch, enabled):
    monkeypatch.setattr(run_tokens, "mint_run_token", lambda caller: "RUN")
    args = {"tapis_token": {"value": "CALLER"}, "lat": {"value": 1}}
    out = run_tokens.apply_run_token(args, "CALLER")
    assert out["tapis_token"] == {"value": "RUN"}
    assert out["lat"] == {"value": 1}
    assert args["tapis_token"] == {"value": "CALLER"}  # input not mutated

    monkeypatch.setattr(settings, "run_token_enabled", False)
    assert run_tokens.apply_run_token(args, "CALLER") is args


def test_apply_skips_when_no_token_arg_or_caller(enabled):
    no_arg = {"lat": {"value": 1}}
    assert run_tokens.apply_run_token(no_arg, "CALLER") is no_arg
    with_arg = {"tapis_token": {"value": "x"}}
    assert run_tokens.apply_run_token(with_arg, None) is with_arg


def test_mint_failure_fails_closed_without_leaking_token(monkeypatch, enabled):
    monkeypatch.setattr(run_tokens.httpx, "post", lambda *a, **k: _Resp(403))
    caller = _jwt({"tapis/username": "alice"})
    with pytest.raises(run_tokens.RunTokenError) as exc:
        run_tokens.apply_run_token({"tapis_token": {"value": caller}}, caller)
    assert caller not in str(exc.value)
    assert "403" in str(exc.value)


def test_missing_username_claim_is_rejected():
    with pytest.raises(run_tokens.RunTokenError):
        run_tokens.mint_run_token(_jwt({"sub": "x"}))
    with pytest.raises(run_tokens.RunTokenError):
        run_tokens.mint_run_token("not-a-jwt")
