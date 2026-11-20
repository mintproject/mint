"""The adapter as an internal engine (design 2026-11-20-adapter-behind-dynamo-apis.md):
step 0 closes the unauthenticated writes and gives the Ensemble Manager secret its own
setting, step 4 gives data objects an owner, step 5 is the front-door switch."""
from __future__ import annotations

import os

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config

import pytest  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main as main_module  # noqa: E402
from app.config import Settings, settings  # noqa: E402
from app.main import _front_door_open, app  # noqa: E402
from app.store import STORE, InMemoryHasura  # noqa: E402

client = TestClient(app)
ALICE = {"Authorization": "Bearer alice.jwt"}
BOB = {"Authorization": "Bearer bob.jwt"}
SERVICE = {"X-Ensemble-Manager-Secret": "service-secret"}
USERS = {"alice.jwt": "alice", "bob.jwt": "bob"}
OBJ = {"label": "heads", "resource_uri": "https://example.org/heads.tif"}


@pytest.fixture(autouse=True)
def live(monkeypatch):
    """A non-demo adapter over the in-memory store, with the shared secret set."""
    client.post("/admin/reset")
    monkeypatch.setattr(settings, "demo_mode", False)
    monkeypatch.setattr(settings, "internal_service_secret", "service-secret")
    monkeypatch.setattr(settings, "require_front_door", False)
    monkeypatch.setattr(settings, "admin_route_secret", "operator-secret")
    monkeypatch.setattr(main_module, "get_client", lambda token=None: InMemoryHasura(token))
    monkeypatch.setattr("app.main.tapis.userinfo_username", lambda token: USERS.get(token))
    main_module._CALLER_CACHE.clear()
    yield
    main_module._CALLER_CACHE.clear()


# --- step 0: POST /data-objects ---------------------------------------------

def test_registering_a_data_object_needs_a_signed_in_user():
    assert client.post("/data-objects", json=OBJ).status_code == 401
    assert client.post("/data-objects", json=OBJ, headers={"Authorization": "Bearer bad"}).status_code == 401
    assert STORE.data_object == {}


def test_registering_a_data_object_records_the_verified_owner():
    resp = client.post("/data-objects", json={**OBJ, "id": "do-1"}, headers=ALICE)
    assert resp.status_code == 200, resp.text
    assert STORE.data_object["do-1"]["owner_username"] == "alice"


def test_an_owner_cannot_be_supplied_in_the_body():
    resp = client.post("/data-objects", json={**OBJ, "id": "do-1", "owner_username": "bob"}, headers=ALICE)
    assert resp.status_code == 200
    assert STORE.data_object["do-1"]["owner_username"] == "alice"


def test_one_user_cannot_overwrite_another_users_data_object():
    client.post("/data-objects", json={**OBJ, "id": "do-1"}, headers=ALICE)
    resp = client.post("/data-objects", json={**OBJ, "id": "do-1", "label": "mine"}, headers=BOB)
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "DATA_OBJECT_NOT_OWNED"
    assert STORE.data_object["do-1"]["label"] == "heads"


def test_a_user_cannot_overwrite_a_row_that_has_no_owner():
    STORE.data_object["legacy"] = {"id": "legacy", "label": "old", "resource_uri": "x", "variables": []}
    resp = client.post("/data-objects", json={**OBJ, "id": "legacy"}, headers=ALICE)
    assert resp.status_code == 403


def test_a_model_output_object_needs_the_service_secret():
    owned = {**OBJ, "owner_execution_id": "ue_1"}
    assert client.post("/data-objects", json=owned, headers=ALICE).status_code == 403
    resp = client.post("/data-objects", json=owned, headers={**SERVICE, **ALICE})
    assert resp.status_code == 200
    assert STORE.data_object[resp.json()["id"]]["owner_username"] == "alice"
    # Without a forwarded token the handoff still works, and the row has no owner.
    resp = client.post("/data-objects", json=owned, headers=SERVICE)
    assert resp.status_code == 200
    assert "owner_username" not in STORE.data_object[resp.json()["id"]]


# --- step 0: POST /forecast/run ---------------------------------------------

def test_forecast_run_needs_a_signed_in_user(monkeypatch):
    monkeypatch.setattr(main_module.ntgam, "run_forecast", lambda scenario: {"risk": 1})
    assert client.post("/forecast/run", json={"scenario": {"a": 1}}).status_code == 401
    ok = client.post("/forecast/run", json={"scenario": {"a": 1}}, headers=ALICE)
    assert ok.status_code == 200 and ok.json() == {"risk": 1}


# --- step 0: GET /transform-specs -------------------------------------------

def _specs():
    STORE.transform_spec.clear()
    for sid, visibility, owner in (
        ("pub", "public", None), ("shr", "shared", "carol"),
        ("prv-alice", "private", "alice"), ("prv-carol", "private", "carol"),
    ):
        STORE.transform_spec[sid] = {"id": sid, "visibility": visibility, "owner_username": owner}


def _listed(headers=None):
    resp = client.get("/transform-specs", headers=headers or {})
    assert resp.status_code == 200
    return sorted(spec["id"] for spec in resp.json())


def test_anonymous_listing_shows_only_public_pieces():
    _specs()
    assert _listed() == ["pub"]
    assert _listed({"Authorization": "Bearer bad"}) == ["pub"]


def test_a_signed_in_user_sees_public_shared_and_their_own_pieces():
    _specs()
    assert _listed(ALICE) == ["prv-alice", "pub", "shr"]
    assert _listed(BOB) == ["pub", "shr"]


# --- step 0: the shared secret has no Hasura fallback -----------------------

def test_the_hasura_admin_secret_is_not_the_service_secret(monkeypatch):
    monkeypatch.setattr(settings, "internal_service_secret", None)
    monkeypatch.setattr(settings, "hasura_admin_secret", "hasura-admin")
    assert not main_module._internal_service_authorized("hasura-admin")
    owned = {**OBJ, "owner_execution_id": "ue_1"}
    resp = client.post("/data-objects", json=owned, headers={"X-Ensemble-Manager-Secret": "hasura-admin"})
    assert resp.status_code == 503
    assert resp.json()["detail"]["code"] == "INTERNAL_SERVICE_NOT_CONFIGURED"


def test_a_wrong_secret_is_403_and_a_missing_setting_is_503(monkeypatch):
    body = {"output_data_object": OBJ}
    assert client.post("/runs/r1/register-output", json=body).status_code == 403
    assert client.post("/runs/r1/register-output", json=body,
                       headers={"X-Ensemble-Manager-Secret": "nope"}).status_code == 403
    monkeypatch.setattr(settings, "internal_service_secret", None)
    assert client.post("/runs/r1/register-output", json=body, headers=SERVICE).status_code == 503
    assert client.post("/plans/deferred/p1/bind", json={"data_object_id": "d", "plan_hash": "h", "parent_execution_id": "ue_1",
                                     "model_child_id": "m", "parameter_values_hash": "p"},
                       headers=SERVICE).status_code == 503


def test_register_output_accepts_the_service_secret():
    resp = client.post("/runs/r1/register-output", json={"output_data_object": OBJ}, headers=SERVICE)
    assert resp.status_code == 200, resp.text


# --- step 0: CORS ------------------------------------------------------------

def test_cors_lists_no_origin_by_default():
    assert Settings().cors_origin_list == []
    cors = [m for m in app.user_middleware if m.cls is CORSMiddleware]
    assert cors and cors[0].kwargs["allow_origins"] == []


def test_cors_origins_setting_is_a_comma_separated_list(monkeypatch):
    monkeypatch.setenv("SVO_ADAPTER_CORS_ORIGINS", "https://a.example, https://b.example,")
    assert Settings().cors_origin_list == ["https://a.example", "https://b.example"]


# --- step 4: data object ownership ------------------------------------------

def test_a_user_lists_only_their_own_data_objects():
    client.post("/data-objects", json={**OBJ, "id": "a1"}, headers=ALICE)
    client.post("/data-objects", json={**OBJ, "id": "b1"}, headers=BOB)
    STORE.data_object["legacy"] = {"id": "legacy", "label": "old", "resource_uri": "x", "variables": []}
    assert [o["id"] for o in client.get("/data-objects", headers=ALICE).json()] == ["a1"]
    assert [o["id"] for o in client.get("/data-objects", headers=BOB).json()] == ["b1"]


def test_listing_data_objects_needs_a_signed_in_user():
    assert client.get("/data-objects").status_code == 401


# --- step 5: the front door --------------------------------------------------

@pytest.fixture
def front_door(monkeypatch):
    monkeypatch.setattr(settings, "require_front_door", True)


def test_the_front_door_is_off_by_default():
    assert Settings().require_front_door is False
    assert client.get("/data-objects", headers=ALICE).status_code == 200


def test_a_user_route_without_the_secret_is_refused(front_door):
    for method, path in (("GET", "/data-objects"), ("POST", "/plans"), ("GET", "/runs"),
                         ("GET", "/secrets"), ("POST", "/forecast/run"), ("GET", "/transform-specs")):
        resp = client.request(method, path, headers=ALICE, json={})
        assert resp.status_code == 403, path
        assert resp.json()["detail"]["code"] == "FRONT_DOOR_REQUIRED"


def test_a_user_route_with_the_secret_and_a_token_is_served(front_door):
    resp = client.get("/data-objects", headers={**SERVICE, **ALICE})
    assert resp.status_code == 200


def test_the_secret_does_not_replace_the_users_token(front_door):
    assert client.get("/data-objects", headers=SERVICE).status_code == 401


def test_a_browser_origin_is_refused_even_with_the_secret(front_door):
    resp = client.get("/data-objects", headers={**SERVICE, **ALICE, "Origin": "https://app.example"})
    assert resp.status_code == 403


def test_a_wrong_secret_is_refused(front_door):
    resp = client.get("/data-objects", headers={"X-Ensemble-Manager-Secret": "nope", **ALICE})
    assert resp.status_code == 403


def test_the_front_door_without_a_secret_setting_answers_503(front_door, monkeypatch):
    monkeypatch.setattr(settings, "internal_service_secret", None)
    resp = client.get("/data-objects", headers=ALICE)
    assert resp.status_code == 503
    assert resp.json()["detail"]["code"] == "INTERNAL_SERVICE_NOT_CONFIGURED"


def test_callbacks_operator_routes_and_public_reads_stay_reachable(front_door):
    for method, path in (("POST", "/runs/r1/signal"), ("GET", "/runs/r1/credentials"),
                         ("POST", "/runs/r1/token")):
        resp = client.request(method, path, json={})
        assert (resp.json().get("detail") or {}).get("code") != "FRONT_DOOR_REQUIRED", path
    resp = client.post("/admin/poll")  # the operator guard answers, not the front door
    assert resp.json()["detail"]["code"] == "ADMIN_AUTH_REQUIRED"
    assert client.post("/transform-specs", json={"name": "x"}).json()["detail"]["code"] == "ADMIN_AUTH_REQUIRED"
    assert client.get("/health").status_code == 200
    assert client.get("/runtime-defaults").status_code != 403


def test_the_open_routes_are_exactly_the_designs_route_table():
    open_routes = sorted(
        (method, route.path)
        for route in app.routes
        if getattr(route, "path", "")
        for method in (getattr(route, "methods", None) or set()) - {"HEAD", "OPTIONS"}
        if _front_door_open(method, route.path)
        and not route.path.startswith(("/admin", "/ui", "/docs", "/openapi", "/redoc"))
        and (method, route.path) != ("POST", "/transform-specs")
    )
    assert open_routes == sorted([
        ("POST", "/runs/{run_id}/signal"), ("GET", "/runs/{run_id}/credentials"),
        ("POST", "/runs/{run_id}/token"),
        ("GET", "/"), ("GET", "/health"), ("GET", "/objectives"), ("GET", "/objectives/{objective_id}"),
        ("GET", "/runtime-defaults"), ("GET", "/spatial/layers"), ("GET", "/etl/common-variables"),
        ("GET", "/dfc-targets"), ("GET", "/forecast/ntgam/options"),
    ])
