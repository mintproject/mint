"""Operator routes (/admin/*, POST /transform-specs) need the admin route secret;
the piece test endpoint needs a Tapis-verified caller."""
from __future__ import annotations

import os

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import tapis  # noqa: E402
from app.config import settings  # noqa: E402
from app.main import _is_operator_route, app  # noqa: E402

client = TestClient(app)
SECRET = "operator-secret"


@pytest.fixture
def live(monkeypatch):
    """A non-demo adapter with the admin route secret configured."""
    monkeypatch.setattr(settings, "demo_mode", False)
    monkeypatch.setattr(settings, "admin_route_secret", SECRET)


def _admin_routes() -> list[tuple[str, str]]:
    return sorted(
        (method, route.path)
        for route in app.routes
        if getattr(route, "path", "").startswith("/admin/")
        for method in getattr(route, "methods", ()) - {"HEAD", "OPTIONS"}
    )


def test_every_admin_route_is_an_operator_route_except_secrets():
    routes = _admin_routes()
    assert ("POST", "/admin/sync-from-mint") in routes
    for method, path in routes:
        assert _is_operator_route(method, path) is (path != "/admin/secrets"), path


def test_registry_writes_are_operator_routes_and_reads_are_not():
    assert _is_operator_route("POST", "/transform-specs")
    assert _is_operator_route("POST", "/transform-specs/")
    assert not _is_operator_route("GET", "/transform-specs")
    assert not _is_operator_route("POST", "/transform-specs/abc/test")
    assert not _is_operator_route("POST", "/plans")


@pytest.mark.parametrize("method,path", [
    ("POST", "/admin/sync-from-mint"),
    ("POST", "/admin/sync-from-ckan"),
    ("POST", "/admin/recompute-edges"),
    ("POST", "/admin/poll"),
    ("POST", "/admin/validate-tapis"),
    ("POST", "/admin/seed-gma-dfc"),
    ("POST", "/admin/reset"),
    ("GET", "/admin/sync-status"),
    ("POST", "/transform-specs"),
])
def test_operator_routes_refuse_a_missing_or_wrong_secret(live, method, path):
    for headers in ({}, {"X-Admin-Secret": "wrong"}, {"Authorization": "Bearer some-user-token"}):
        resp = client.request(method, path, headers=headers, json={"name": "x"})
        assert resp.status_code == 403, (path, headers)
        assert resp.json()["detail"]["code"] == "ADMIN_AUTH_REQUIRED"


def test_operator_routes_fail_closed_when_no_secret_is_configured(live, monkeypatch):
    monkeypatch.setattr(settings, "admin_route_secret", None)
    resp = client.post("/admin/sync-from-mint", headers={"X-Admin-Secret": SECRET})
    assert resp.status_code == 503
    assert resp.json()["detail"]["code"] == "ADMIN_ROUTES_NOT_CONFIGURED"


def test_the_right_secret_reaches_the_handler(live):
    # /admin/reset answers 400 outside demo mode, which proves the guard let it through.
    resp = client.post("/admin/reset", headers={"X-Admin-Secret": SECRET})
    assert resp.status_code == 400


def test_a_refusal_from_an_unlisted_origin_carries_no_allow_origin_header(live):
    # CORS lists no origin by default (SVO_ADAPTER_CORS_ORIGINS), so a browser page
    # cannot read even this refusal.
    resp = client.post("/admin/poll", headers={"Origin": "https://example.org"})
    assert resp.status_code == 403
    assert "access-control-allow-origin" not in resp.headers


def test_demo_mode_is_not_guarded():
    assert settings.demo_mode
    assert client.post("/admin/reset").status_code == 200


def test_secrets_admin_keeps_its_own_credential(live):
    # Not the operator guard's 403/503 codes: /admin/secrets has a dedicated guard.
    resp = client.request("DELETE", "/admin/secrets", headers={"X-Admin-Secret": SECRET}, json={})
    code = (resp.json().get("detail") or {})
    assert not (isinstance(code, dict) and code.get("code") in {"ADMIN_AUTH_REQUIRED", "ADMIN_ROUTES_NOT_CONFIGURED"})


def test_piece_test_requires_a_verified_caller(live, monkeypatch):
    monkeypatch.setattr(tapis, "userinfo_username", lambda token: None)
    for headers in ({}, {"Authorization": "Bearer not-a-real-token"}):
        resp = client.post("/transform-specs/some-id/test", headers=headers, json={"dry_run": True})
        assert resp.status_code == 401, headers
        assert resp.json()["detail"]["code"] == "TAPIS_AUTH_REQUIRED"
