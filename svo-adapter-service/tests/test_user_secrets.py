"""A runner's own secrets (scope 'user'): store, list and delete through
PUT/GET/DELETE /secrets with the caller's Tapis token (demo mode, Tapis stubbed)."""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from cryptography.fernet import Fernet  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main as main_module  # noqa: E402
from app import secrets as secrets_store  # noqa: E402
from app.config import settings  # noqa: E402
from app.hasura import get_client  # noqa: E402
from app.main import app  # noqa: E402
from app.store import STORE  # noqa: E402

client = TestClient(app)
VALUE = "SENTINEL-key-7c1d"
CFG = "cfg-opera"
USERS = {"tok-alice": "alice", "tok-bob": "bob", "tok-owner1": "owner1"}
ALICE = {"Authorization": "Bearer tok-alice"}
BOB = {"Authorization": "Bearer tok-bob"}
OWNER1 = {"Authorization": "Bearer tok-owner1"}
BODY = {"fields": {"api_key": VALUE, "base_url": "https://models.example"}}


@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    monkeypatch.setattr(settings, "secrets_encryption_keys", Fernet.generate_key().decode())
    monkeypatch.setattr("app.main.tapis.userinfo_username", lambda token: USERS.get(token))
    client.post("/admin/reset")
    main_module._CALLER_CACHE.clear()
    main_module._SECRET_CHANGE_RATE.clear()
    yield
    secrets_store.ValueScrubber.clear()


def _put(name="model_server", headers=ALICE, body=BODY):
    return client.put(f"/secrets/{name}", headers=headers, json=body)


def _run(coro):
    return asyncio.run(coro)


def _start_run(user="alice", status="running", run_id="run-1"):
    STORE.run[run_id] = {"id": run_id, "submitted_by": user, "status": status}


def _model_owner_row(owner="owner1", name="earthdata"):
    row = {"id": "33333333-3333-3333-3333-333333333333", "scope": "model_owner",
           "owner_username": owner, "name": name, "configuration_id": CFG, "version": 1}
    STORE.secret[row["id"]] = {**row, "pinned_app_id": "app", "pinned_app_version": "1",
                               "fields": '{"password"}', "created_at": "t", "updated_at": "t",
                               "last_used_at": None,
                               "ciphertext": secrets_store.seal(row, {"password": VALUE})}
    return row


# --- store, list, replace, delete ----------------------------------------------
def test_store_then_list_shows_names_only_and_never_the_value():
    saved = _put()
    assert saved.status_code == 200
    assert saved.headers["cache-control"] == "no-store"
    assert set(saved.json()) == {"name", "fields", "version", "created_at", "updated_at"}
    assert saved.json()["name"] == "model_server" and saved.json()["version"] == 1
    assert sorted(saved.json()["fields"]) == ["api_key", "base_url"]
    listed = client.get("/secrets", headers=ALICE)
    assert listed.status_code == 200 and listed.headers["cache-control"] == "no-store"
    assert [r["name"] for r in listed.json()] == ["model_server"]
    assert sorted(listed.json()[0]["fields"]) == ["api_key", "base_url"]
    for text in (saved.text, listed.text):
        assert VALUE not in text and "ciphertext" not in text and "https://models.example" not in text
    stored = [{k: v for k, v in r.items() if k != "ciphertext"} for r in STORE.secret.values()]
    assert VALUE not in json.dumps(stored)
    assert VALUE not in json.dumps(STORE.secret_event)


def test_list_is_sorted_by_name():
    for name in ("zeta", "alpha", "mid"):
        assert _put(name).status_code == 200
    assert [r["name"] for r in client.get("/secrets", headers=ALICE).json()] == ["alpha", "mid", "zeta"]


def test_replace_bumps_the_version_and_keeps_one_row():
    _put()
    again = _put(body={"fields": {"api_key": "another-value-1"}})
    assert again.json()["version"] == 2 and again.json()["fields"] == ["api_key"]
    assert len(STORE.secret) == 1
    row = next(iter(STORE.secret.values()))
    assert row["scope"] == "user" and row["configuration_id"] == ""
    assert secrets_store.open_(row) == {"api_key": "another-value-1"}


def test_delete_removes_it_and_a_missing_name_is_404():
    _put()
    gone = client.delete("/secrets/model_server", headers=ALICE)
    assert gone.status_code == 200 and VALUE not in gone.text
    assert client.get("/secrets", headers=ALICE).json() == []
    missing = client.delete("/secrets/model_server", headers=ALICE)
    assert missing.status_code == 404 and missing.json()["detail"]["code"] == "SECRET_NOT_FOUND"


# --- isolation -------------------------------------------------------------------
def test_one_user_cannot_see_replace_or_delete_anothers_secret():
    _put(headers=ALICE)
    assert client.get("/secrets", headers=BOB).json() == []
    other = client.delete("/secrets/model_server", headers=BOB)
    assert other.status_code == 404  # same answer whether or not alice has one
    assert client.delete("/secrets/nothing-here", headers=BOB).json() == other.json()
    _put(headers=BOB, body={"fields": {"api_key": "bobs-own-value"}})
    alice_row = [r for r in STORE.secret.values() if r["owner_username"] == "alice"][0]
    assert secrets_store.open_(alice_row)["api_key"] == VALUE and alice_row["version"] == 1


def test_two_users_hold_the_same_name_independently():
    _put(headers=ALICE)
    _put(headers=BOB, body={"fields": {"api_key": "bobs-own-value"}})
    assert len(STORE.secret) == 2
    assert client.get("/secrets", headers=ALICE).json()[0]["version"] == 1
    assert client.delete("/secrets/model_server", headers=BOB).status_code == 200
    assert [r["name"] for r in client.get("/secrets", headers=ALICE).json()] == ["model_server"]


def test_a_model_owner_secret_is_not_listed_replaced_or_deleted_here():
    row = _model_owner_row(owner="owner1", name="earthdata")
    assert client.get("/secrets", headers=OWNER1).json() == []
    assert client.delete("/secrets/earthdata", headers=OWNER1).status_code == 404
    assert _put("earthdata", headers=OWNER1).status_code == 200  # a separate user-scope row
    assert STORE.secret[row["id"]]["version"] == 1
    assert secrets_store.open_(STORE.secret[row["id"]]) == {"password": VALUE}
    assert len(STORE.secret) == 2
    assert len(client.get("/secrets", headers=OWNER1).json()) == 1


def test_resolve_for_a_model_never_binds_a_user_secret():
    _put("earthdata", headers=OWNER1, body={"fields": {"username": "u", "password": "p-ssword"}})
    store = secrets_store.FernetSecretStore(get_client(None))
    configuration = {"id": CFG, "owner_username": "owner1"}
    decls = [secrets_store.Declaration("earthdata", {"username": "U", "password": "P"})]
    result = _run(secrets_store.resolve(store, configuration, decls, {"appId": "a", "appVersion": "1"}))
    assert result.bound == [] and [m["name"] for m in result.missing] == ["earthdata"]


# --- Fernet binding --------------------------------------------------------------
def _swap_ciphertext(user_row, owner_row):
    ct = secrets_store.seal(user_row, {"password": VALUE})
    with pytest.raises(secrets_store.SecretError):
        secrets_store.open_(owner_row, ct)


def test_a_ciphertext_cannot_cross_between_user_and_model_owner_rows():
    base = {"id": "44444444-4444-4444-4444-444444444444", "owner_username": "owner1",
            "name": "earthdata", "version": 1}
    user_row = {**base, "scope": "user", "configuration_id": ""}
    owner_row = {**base, "scope": "model_owner", "configuration_id": CFG}
    _swap_ciphertext(user_row, owner_row)  # user ciphertext on a model-owner row
    ct = secrets_store.seal(owner_row, {"password": VALUE})
    with pytest.raises(secrets_store.SecretError):  # and the other way round
        secrets_store.open_(user_row, ct)
    # even with the same id, owner, name and an emptied configuration, scope differs
    with pytest.raises(secrets_store.SecretError):
        secrets_store.open_({**owner_row, "configuration_id": ""}, ct)


def test_a_ciphertext_copied_between_stored_rows_is_refused():
    _put("one"), _put("two")
    rows = {r["name"]: r for r in STORE.secret.values()}
    with pytest.raises(secrets_store.SecretError):
        secrets_store.open_(rows["two"], rows["one"]["ciphertext"])


# --- auth and configuration ------------------------------------------------------
@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer unknown-token"}])
def test_not_signed_in_is_401(headers):
    assert client.get("/secrets", headers=headers).status_code == 401
    assert _put(headers=headers).status_code == 401
    assert client.delete("/secrets/x", headers=headers).status_code == 401
    assert STORE.secret == {}


def test_without_an_encryption_key_every_route_is_503(monkeypatch):
    monkeypatch.setattr(settings, "secrets_encryption_keys", "")
    for response in (_put(), client.get("/secrets", headers=ALICE),
                     client.delete("/secrets/x", headers=ALICE)):
        assert response.status_code == 503
        assert response.json()["detail"]["code"] == "SECRETS_NOT_CONFIGURED"


# --- validation, and nothing echoed ----------------------------------------------
@pytest.mark.parametrize("name,body", [
    ("Bad Name", BODY),
    ("x" * 65, BODY),
    ("ok", {"fields": {f"f{i}": "value-xx" + VALUE for i in range(17)}}),
    ("ok", {"fields": {"big": VALUE + "x" * 5000}}),
    ("ok", {"fields": {"BadField": VALUE}}),
    ("ok", {"fields": {}}),
])
def test_bad_name_or_fields_are_422_without_the_value(name, body):
    response = client.put(f"/secrets/{name}", headers=ALICE, json=body)
    assert response.status_code == 422
    assert VALUE not in response.text
    assert STORE.secret == {}


@pytest.mark.parametrize("body", [
    {"fields": {"api_key": VALUE}, "extra": VALUE},
    {"fields": {"api_key": 12345, "other": VALUE}},
    {"fields": [VALUE]},
    {"fields": VALUE},
    {"nope": VALUE},
])
def test_a_malformed_body_is_422_and_does_not_echo_it(body):
    response = _put(body=body)
    assert response.status_code == 422
    assert VALUE not in response.text
    assert all("input" not in e and "ctx" not in e for e in response.json()["detail"])


def test_a_failing_store_never_echoes_or_logs_the_value(monkeypatch, caplog):
    async def boom(self, **kw):
        raise RuntimeError(f"hasura said no: {VALUE}")
    monkeypatch.setattr(secrets_store.FernetSecretStore, "put", boom)
    with caplog.at_level("DEBUG"):
        with pytest.raises(RuntimeError):
            TestClient(app, raise_server_exceptions=True).put("/secrets/x", headers=ALICE, json=BODY)
    assert VALUE not in caplog.text


# --- the lock while a run is active ----------------------------------------------
@pytest.mark.parametrize("status", ["submitting", "running"])
def test_an_active_run_locks_put_and_delete_but_not_list(status):
    _put()
    _start_run(status=status)
    locked = _put(body={"fields": {"api_key": "swapped-value"}})
    assert locked.status_code == 409 and locked.json()["detail"]["code"] == "SECRET_LOCKED_BY_RUN"
    assert "you have a run in progress" in locked.json()["detail"]["message"]
    assert client.delete("/secrets/model_server", headers=ALICE).status_code == 409
    assert client.get("/secrets", headers=ALICE).status_code == 200
    assert secrets_store.open_(next(iter(STORE.secret.values())))["api_key"] == VALUE


def test_someone_elses_active_run_does_not_lock_you():
    _start_run(user="bob")
    assert _put().status_code == 200


def test_a_finished_run_releases_the_lock():
    _put()
    _start_run(status="running")
    assert _put().status_code == 409
    STORE.run["run-1"]["status"] = "succeeded"
    assert _put(body={"fields": {"api_key": "new-value-ok"}}).status_code == 200
    _start_run(status="failed", run_id="run-2")
    assert client.delete("/secrets/model_server", headers=ALICE).status_code == 200


# --- rate limit ------------------------------------------------------------------
def test_more_than_twenty_changes_in_ten_minutes_is_429():
    for i in range(20):
        assert _put(body={"fields": {"api_key": f"value-number-{i}"}}).status_code == 200
    over = _put()
    assert over.status_code == 429 and over.json()["detail"]["code"] == "SECRET_RATE_LIMITED"
    assert client.delete("/secrets/model_server", headers=ALICE).status_code == 429
    assert client.get("/secrets", headers=ALICE).status_code == 200  # listing is not limited
    assert _put(headers=BOB).status_code == 200  # per caller


# --- events ----------------------------------------------------------------------
def test_events_record_the_caller_and_never_a_value():
    _put()
    _put(body={"fields": {"api_key": "second-value-9"}})
    client.delete("/secrets/model_server", headers=ALICE)
    events = [e for e in STORE.secret_event if e["scope"] == "user"]
    assert [e["event"] for e in events] == ["created", "replaced", "deleted"]
    assert {e["actor"] for e in events} == {"alice"}
    assert {e["owner_username"] for e in events} == {"alice"}
    dumped = json.dumps(events)
    assert VALUE not in dumped and "second-value-9" not in dumped


# --- the model-owner path stays apart --------------------------------------------
@pytest.mark.parametrize("cfg", ["", "  "])
def test_admin_routes_refuse_an_empty_configuration_for_a_model_owner(cfg):
    monkey = {"X-Secrets-Admin-Secret": "admin-secret"}
    settings.secrets_admin_secret = "admin-secret"
    try:
        put = client.put("/admin/secrets", headers=monkey, json={
            "owner_username": "owner1", "configuration_id": cfg, "name": "earthdata",
            "fields": {"password": VALUE}, "acknowledged": True})
        delete = client.request("DELETE", "/admin/secrets", headers=monkey, json={
            "owner_username": "owner1", "configuration_id": cfg, "name": "earthdata"})
    finally:
        settings.secrets_admin_secret = ""
    for response in (put, delete):
        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "SECRET_CONFIGURATION_REQUIRED"
        assert VALUE not in response.text
