"""Adapter secrets store: encryption binding, catalog-driven resolution at
submit, the credentials endpoint, admin seeding, the generic task-side
injection, and the guarantee that no stored value leaks anywhere but the
credentials response (demo mode, Tapis stubbed)."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from cryptography.fernet import Fernet  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main as main_module  # noqa: E402
from app import run_state, tapis  # noqa: E402
from app import secrets as secrets_store  # noqa: E402
from app.config import settings  # noqa: E402
from app.error_handling import safe_error_message  # noqa: E402
from app.hasura import get_client  # noqa: E402
from app.main import _public_workflow_args, app  # noqa: E402
from app.mint_sync import _build_env_from_args  # noqa: E402
from app.store import STORE  # noqa: E402

client = TestClient(app)
SENTINEL = "SENTINEL-pw-9f3a"
CFG = "cfg-opera"
APP_ID, APP_VERSION = "subside-h2i-opera-analysis", "1"
EM = {"X-Ensemble-Manager-Secret": "em-secret"}
ADMIN = {"X-Secrets-Admin-Secret": "admin-secret"}
BEARER = {"Authorization": "Bearer caller.jwt.token"}
ENV_MAP = ["username=EARTHDATA_USERNAME", "password=EARTHDATA_PASSWORD"]


def _declaration(name="earthdata", env=ENV_MAP):
    return {"parameter": {"label": name, "parameter_type": "secret",
                          "has_accepted_values": env}}


def _configuration(**over):
    return {"id": CFG, "owner_username": "owner1", "tapis_app_id": APP_ID,
            "tapis_app_version": APP_VERSION,
            "parameters": [_declaration(), {"parameter": {"label": "start", "parameter_type": "model_param"}}],
            **over}


@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    monkeypatch.setattr(settings, "run_signal_secrets", "current-secret")
    monkeypatch.setattr(settings, "public_base_url", "https://svo.example")
    monkeypatch.setattr(settings, "internal_service_secret", "em-secret")
    monkeypatch.setattr(settings, "secrets_admin_secret", "admin-secret")
    monkeypatch.setattr(settings, "secrets_encryption_keys", Fernet.generate_key().decode())
    monkeypatch.setattr("app.main.tapis.userinfo_username", lambda token: "alice")
    client.post("/admin/reset")
    main_module._CREDENTIALS_RATE.clear()
    STORE.catalog_configuration[CFG] = _configuration()
    yield
    secrets_store.ValueScrubber.clear()


def _run_async(coro):
    return asyncio.run(coro)


def _put_body(**over):
    return {"scope": "model_owner", "owner_username": "owner1", "configuration_id": CFG,
            "name": "earthdata", "fields": {"username": "edl-user", "password": SENTINEL},
            "acknowledged": True, **over}


def _put(**over):
    return client.put("/admin/secrets", headers=ADMIN, json=_put_body(**over))


def _row(**over):
    return {"id": "11111111-1111-1111-1111-111111111111", "scope": "model_owner",
            "owner_username": "owner1", "name": "earthdata", "configuration_id": CFG,
            "version": 1, **over}


# --- encryption, binding, validation, rotation ------------------------------------
def test_seal_open_round_trip_and_ciphertext_hides_the_value():
    row = _row()
    ciphertext = secrets_store.seal(row, {"password": SENTINEL})
    assert SENTINEL not in ciphertext
    assert secrets_store.open_(row, ciphertext) == {"password": SENTINEL}


@pytest.mark.parametrize("field,value", [
    ("id", "22222222-2222-2222-2222-222222222222"), ("scope", "user"),
    ("owner_username", "mallory"), ("name", "other"), ("configuration_id", "cfg-other"),
    ("version", 2)])
def test_a_copied_ciphertext_fails_for_every_bound_field(field, value):
    ciphertext = secrets_store.seal(_row(), {"password": SENTINEL})
    with pytest.raises(secrets_store.SecretError):
        secrets_store.open_(_row(**{field: value}), ciphertext)


def test_fails_closed_without_a_ring(monkeypatch):
    monkeypatch.setattr(settings, "secrets_encryption_keys", "")
    assert not secrets_store.secrets_configured()
    with pytest.raises(secrets_store.SecretError):
        secrets_store.seal(_row(), {"a": "b"})


def test_the_ring_is_independent_of_the_run_token_keeper(monkeypatch):
    monkeypatch.setattr(settings, "run_token_encryption_keys", Fernet.generate_key().decode())
    monkeypatch.setattr(settings, "secrets_encryption_keys", "")
    assert not secrets_store.secrets_configured()


@pytest.mark.parametrize("name", ["", "Upper", "has space", "x" * 65, "a.b"])
def test_bad_secret_names_are_rejected(name):
    with pytest.raises(secrets_store.SecretValidationError):
        secrets_store.validate_name(name)


@pytest.mark.parametrize("fields", [
    {}, {"Bad": "x"}, {"a" * 33: "x"}, {"a": ""}, {"a": "x\ny"}, {"a": "x\x00y"},
    {f"f{i}": "v" for i in range(17)}, {"a": "x" * 4097}])
def test_bad_field_sets_are_rejected(fields):
    with pytest.raises(secrets_store.SecretValidationError):
        secrets_store.validate_fields(fields)


def test_rotation_reencrypts_under_the_new_key_and_the_old_key_can_go(monkeypatch):
    old = Fernet.generate_key().decode()
    new = Fernet.generate_key().decode()
    monkeypatch.setattr(settings, "secrets_encryption_keys", old)
    store = secrets_store.FernetSecretStore(get_client(None))
    saved = _run_async(store.put(scope="model_owner", owner="owner1", name="earthdata",
                                 configuration_id=CFG, pinned_app_id=APP_ID,
                                 pinned_app_version=APP_VERSION, fields={"password": SENTINEL},
                                 actor="test"))
    before = STORE.secret[saved["id"]]["ciphertext"]

    monkeypatch.setattr(settings, "secrets_encryption_keys", f"{new},{old}")
    dry = _run_async(secrets_store.rotate_all(get_client(None), apply=False))
    assert dry == {"rows": 1, "rotated": 1, "failed": 0}
    assert STORE.secret[saved["id"]]["ciphertext"] == before
    _run_async(secrets_store.rotate_all(get_client(None), apply=True))
    assert STORE.secret[saved["id"]]["ciphertext"] != before

    monkeypatch.setattr(settings, "secrets_encryption_keys", new)
    assert secrets_store.open_(STORE.secret[saved["id"]]) == {"password": SENTINEL}


def test_declarations_parse_from_the_catalog_and_reject_malformed_maps():
    [decl] = secrets_store.parse_declarations(_configuration())
    assert decl.name == "earthdata" and decl.env == {
        "username": "EARTHDATA_USERNAME", "password": "EARTHDATA_PASSWORD"}
    for bad in (_declaration(env=["password"]), _declaration(env=[]), _declaration(name="Bad Name"),
                _declaration(env=["username=earthdata_user"])):
        with pytest.raises(secrets_store.SecretResolutionError):
            secrets_store.parse_declarations({"parameters": [bad]})


# --- admin seeding ---------------------------------------------------------------
def test_admin_put_requires_the_dedicated_secret_and_a_ring(monkeypatch):
    assert client.put("/admin/secrets", json=_put_body()).status_code == 403
    assert client.put("/admin/secrets", headers={"X-Secrets-Admin-Secret": "x"},
                      json=_put_body()).status_code == 403
    monkeypatch.setattr(settings, "secrets_encryption_keys", "")
    assert _put().status_code == 503


def test_admin_routes_reject_the_em_and_hasura_secrets_alone(monkeypatch):
    monkeypatch.setattr(settings, "hasura_admin_secret", "hasura-admin")
    ref = {k: _put_body()[k] for k in ("scope", "owner_username", "configuration_id", "name")}
    for headers in (EM, {"X-Secrets-Admin-Secret": "em-secret"}, {"X-Secrets-Admin-Secret": "hasura-admin"},
                    {"X-Hasura-Admin-Secret": "hasura-admin"}):
        assert client.put("/admin/secrets", headers=headers, json=_put_body()).status_code == 403
        assert client.request("DELETE", "/admin/secrets", headers=headers, json=ref).status_code == 403
    assert not STORE.secret
    assert _put().status_code == 200


def test_admin_routes_are_503_when_the_admin_secret_is_unset(monkeypatch):
    monkeypatch.setattr(settings, "secrets_admin_secret", None)
    monkeypatch.setattr(settings, "hasura_admin_secret", "hasura-admin")
    for headers in (ADMIN, EM, {"X-Secrets-Admin-Secret": "hasura-admin"}):
        resp = client.put("/admin/secrets", headers=headers, json=_put_body())
        assert resp.status_code == 503 and resp.json()["detail"]["code"] == "SECRETS_ADMIN_NOT_CONFIGURED"


def test_admin_put_with_an_unowned_configuration_is_secret_owner_unset():
    STORE.catalog_configuration[CFG] = _configuration(owner_username=None)
    resp = _put()
    assert resp.status_code == 422 and resp.json()["detail"] == {
        "code": "SECRET_OWNER_UNSET", "message": secrets_store.OWNER_UNSET_MESSAGE}
    assert not STORE.secret


def test_admin_put_returns_metadata_only_and_pins_the_app():
    resp = _put()
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["version"] == 1 and body["fields"] == ["password", "username"]
    assert body["pinned_app_id"] == APP_ID and body["pinned_app_version"] == APP_VERSION
    assert SENTINEL not in resp.text and "ciphertext" not in body
    replaced = _put(fields={"username": "edl-user", "password": "new-" + SENTINEL})
    assert replaced.json()["version"] == 2 and replaced.json()["id"] == body["id"]
    assert [e["event"] for e in STORE.secret_event] == ["created", "replaced"]


@pytest.mark.parametrize("over,status,code", [
    ({"acknowledged": False}, 422, "ACKNOWLEDGEMENT_REQUIRED"),
    ({"owner_username": "mallory"}, 403, "SECRET_OWNER_MISMATCH"),
    ({"configuration_id": "missing"}, 404, "CONFIGURATION_NOT_FOUND"),
    ({"name": "undeclared"}, 422, "SECRET_NOT_DECLARED"),
    ({"fields": {"username": "only"}}, 422, "SECRET_FIELDS_INCOMPLETE"),
    ({"fields": {"username": "u", "password": "p\nq"}}, 422, "SECRET_INVALID"),
    ({"scope": "user"}, 422, "SECRET_SCOPE_UNSUPPORTED")])
def test_admin_put_refusals(over, status, code):
    resp = _put(**over)
    assert resp.status_code == status and resp.json()["detail"]["code"] == code
    assert not STORE.secret


def test_admin_delete_requires_auth_removes_the_row_and_keeps_the_trail():
    _put()
    ref = {k: _put_body()[k] for k in ("scope", "owner_username", "configuration_id", "name")}
    assert client.request("DELETE", "/admin/secrets", json=ref).status_code == 403
    resp = client.request("DELETE", "/admin/secrets", headers=ADMIN, json=ref)
    assert resp.status_code == 200 and "ciphertext" not in resp.json() and not STORE.secret
    assert STORE.secret_event[-1]["event"] == "deleted"
    assert client.request("DELETE", "/admin/secrets", headers=ADMIN, json=ref).status_code == 404


# --- resolution at submit -----------------------------------------------------------
def _model_task(app_version=APP_VERSION, **over):
    return {"stage_id": "model", "output_name": "o", "output_format": "tif",
            "output_uri": "tapis://ls6/mint-workflow-output/ue-test-1/model/o",
            "max_minutes": 5, "configuration_id": CFG,
            "job_definition": {"name": "mint-workflow-model-x", "appId": APP_ID,
                               "appVersion": app_version, "fileInputs": [],
                               "parameterSet": {"appArgs": []}},
            **over}


@pytest.fixture
def submit(monkeypatch):
    captured = {"submits": [], "tokens": []}

    def fake_submit(pipeline, args, **kwargs):
        captured["submits"].append({"pipeline": pipeline, "args": args})
        return {"uuid": "tapis-run-1", "pipelineId": pipeline["id"], "tapisStatus": "submitted"}

    async def spy_with_run_token(args, caller_token):
        captured["tokens"].append(caller_token)
        return args

    monkeypatch.setattr("app.main.tapis.submit_tapis_workflow", fake_submit)
    monkeypatch.setattr("app.main._with_run_token", spy_with_run_token)
    seed = client.post("/admin/seed-subside-werc").json()
    plan_id = client.post("/plans", json={
        "data_object_id": seed["data_object"]["id"],
        "target_contract": seed["target_contract"]}).json()["plan_id"]
    captured["plan_id"] = plan_id

    def do(dry_run=False, model_task=None):
        return client.post("/workflows/submit", headers={**BEARER, **EM}, json={
            "plan_id": plan_id, "execution_id": "ue-test-1", "dry_run": dry_run,
            "args": {"start_date": "2024-01-01", "end_date": "2025-01-01", "allocation": "A",
                     "aoi_geojson_uri": "tapis://ls6/demo/aoi.geojson",
                     "min_overlap_percent": "50", "num_workers": "4", "reference_mode": "auto"},
            "model_task": model_task or _model_task()})

    captured["submit"] = do
    return captured


def _no_side_effects(submit):
    assert not STORE.run and not submit["tokens"] and not submit["submits"]


def test_submit_binds_the_owner_secret_and_issues_the_credentials_url(submit):
    assert _put().status_code == 200
    response = submit["submit"]()
    assert response.status_code == 200, response.text
    run_id = response.json()["run_id"]
    row = STORE.run[run_id]
    secret_id = next(iter(STORE.secret))
    assert row["bound_secrets"] == [{
        "id": secret_id, "version": 1, "name": "earthdata",
        "env": {"username": "EARTHDATA_USERNAME", "password": "EARTHDATA_PASSWORD"},
        "app": f"{APP_ID}@{APP_VERSION}"}]
    args = submit["submits"][0]["args"]
    assert args["credentials_url"]["value"] == f"https://svo.example/runs/{run_id}/credentials"
    bound = [e for e in STORE.secret_event if e["event"] == "bound"]
    assert len(bound) == 1 and bound[0]["run_id"] == run_id and bound[0]["secret_id"] == secret_id


def test_a_run_without_declarations_gets_no_credentials_url(submit):
    STORE.catalog_configuration[CFG] = _configuration(parameters=[])
    response = submit["submit"]()
    assert response.status_code == 200, response.text
    assert "credentials_url" not in submit["submits"][0]["args"]
    assert STORE.run[response.json()["run_id"]].get("bound_secrets") is None


def test_missing_secret_is_a_structured_422_and_queues_nothing(submit):
    response = submit["submit"]()
    assert response.status_code == 422
    assert response.json()["detail"] == {
        "code": "SECRET_REQUIRED",
        "message": "this model needs credentials provided by the model owner",
        "missing": [{"name": "earthdata", "source": "owner_only", "fields": ["password", "username"]}]}
    _no_side_effects(submit)


def test_a_secret_from_a_different_owner_does_not_resolve(submit):
    assert _put().status_code == 200
    STORE.catalog_configuration[CFG] = _configuration(owner_username="someone-else")
    assert submit["submit"]().status_code == 422
    _no_side_effects(submit)


def test_app_pin_mismatch_is_403_with_a_mismatch_event_and_no_side_effects(submit):
    assert _put().status_code == 200
    response = submit["submit"](model_task=_model_task(app_version="2"))
    assert response.status_code == 403 and response.json()["detail"]["code"] == "SECRET_APP_MISMATCH"
    assert [e["event"] for e in STORE.secret_event][-1] == "mismatch"
    _no_side_effects(submit)


def test_submit_with_an_unowned_configuration_is_secret_owner_unset(submit):
    STORE.catalog_configuration[CFG] = _configuration(owner_username=None)
    for dry_run in (False, True):
        response = submit["submit"](dry_run=dry_run)
        assert response.status_code == 422 and response.json()["detail"] == {
            "code": "SECRET_OWNER_UNSET", "message": secrets_store.OWNER_UNSET_MESSAGE}
    _no_side_effects(submit)


def test_composite_submit_without_configuration_id_warns_and_skips(submit, caplog):
    caplog.set_level(logging.WARNING)
    task = _model_task()
    del task["configuration_id"]
    response = submit["submit"](model_task=task)
    assert response.status_code == 200, response.text
    assert any("secret resolution skipped" in r.getMessage() for r in caplog.records)
    assert STORE.run[response.json()["run_id"]].get("bound_secrets") is None


def test_incomplete_stored_fields_are_a_422(submit):
    store = secrets_store.FernetSecretStore(get_client(None))
    _run_async(store.put(scope="model_owner", owner="owner1", name="earthdata", configuration_id=CFG,
                         pinned_app_id=APP_ID, pinned_app_version=APP_VERSION,
                         fields={"username": "only"}, actor="test"))
    response = submit["submit"]()
    assert response.status_code == 422 and response.json()["detail"]["code"] == "SECRET_FIELDS_INCOMPLETE"
    _no_side_effects(submit)


def test_required_secrets_hint_must_be_a_subset_of_the_catalog(submit):
    assert _put().status_code == 200
    ok = submit["submit"](model_task=_model_task(required_secrets=[{"name": "earthdata"}]))
    assert ok.status_code == 200, ok.text
    STORE.run.clear()
    bad = submit["submit"](model_task=_model_task(required_secrets=[{"name": "earthdata"}, {"name": "other"}]))
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "SECRET_DECLARATION_MISMATCH"
    assert not STORE.run


def test_declared_secrets_without_signals_are_a_503(monkeypatch, submit):
    assert _put().status_code == 200
    monkeypatch.setattr(settings, "run_signal_secrets", "")
    response = submit["submit"]()
    assert response.status_code == 503 and response.json()["detail"]["code"] == "SIGNALS_REQUIRED"
    _no_side_effects(submit)


def test_declared_secrets_without_a_ring_are_a_503(monkeypatch, submit):
    assert _put().status_code == 200
    monkeypatch.setattr(settings, "secrets_encryption_keys", "")
    assert submit["submit"]().json()["detail"]["code"] == "SECRETS_NOT_CONFIGURED"
    _no_side_effects(submit)


def test_dry_run_reports_names_and_never_decrypts(monkeypatch, submit):
    monkeypatch.setattr(secrets_store, "open_", lambda *a, **k: pytest.fail("dry run decrypted"))
    missing = submit["submit"](dry_run=True)
    assert missing.status_code == 200 and missing.json()["secrets"] == {"bound": [], "missing": ["earthdata"]}
    assert _put().status_code == 200
    bound = submit["submit"](dry_run=True)
    assert bound.json()["secrets"] == {"bound": ["earthdata"], "missing": []}
    assert SENTINEL not in bound.text
    assert all(r.get("bound_secrets") is None for r in STORE.run.values())


# --- GET /runs/{id}/credentials -----------------------------------------------------
def _headers(run_id, secret=None):
    expires = int((datetime.now(tz=timezone.utc) + timedelta(hours=1)).timestamp())
    return {"X-Run-Signal-Token": run_state.make_signal_token(run_id, expires, secret=secret),
            "X-Run-Signal-Expires": str(expires)}


@pytest.fixture
def bound_run(submit):
    assert _put().status_code == 200
    run_id = submit["submit"]().json()["run_id"]
    return run_id


def _creds(run_id, **kw):
    return client.get(f"/runs/{run_id}/credentials", headers=_headers(run_id, **kw))


def test_credentials_returns_the_env_map_uncached_and_audits_names_only(bound_run):
    resp = _creds(bound_run)
    assert resp.status_code == 200
    assert resp.json() == {"env": {"EARTHDATA_USERNAME": "edl-user", "EARTHDATA_PASSWORD": SENTINEL}}
    assert resp.headers["cache-control"] == "no-store"
    issued = [e for e in STORE.secret_event if e["event"] == "issued"]
    assert len(issued) == 1 and issued[0]["run_id"] == bound_run and issued[0]["name"] == "earthdata"
    [prov] = [e for e in STORE.provenance if e.get("event_type") == "run.credential.issued"]
    assert prov["payload_json"] == {"secrets": ["earthdata@v1"], "task_id": "model"}
    assert next(iter(STORE.secret.values()))["last_used_at"]


@pytest.mark.parametrize("headers", [{}, "wrong"])
def test_bad_or_missing_token_rejected(bound_run, headers):
    if headers == "wrong":
        headers = _headers(bound_run, secret="wrong")
    assert client.get(f"/runs/{bound_run}/credentials", headers=headers).status_code in (401, 403)


def test_old_earthdata_route_is_gone(bound_run):
    assert client.get(f"/runs/{bound_run}/credentials/earthdata", headers=_headers(bound_run)).status_code == 404


def test_run_without_bound_secrets_gets_404():
    STORE.run["run-x"] = {"id": "run-x", "status": "running", "signals_armed": True}
    assert _creds("run-x").status_code == 404


@pytest.mark.parametrize("over", [{"status": "completed"}, {"signals_armed": False}])
def test_409_when_run_not_active(bound_run, over):
    STORE.run[bound_run].update(over)
    assert _creds(bound_run).status_code == 409


def test_fourth_fetch_is_409_exhausted_and_last_used_is_written_once(bound_run):
    assert [_creds(bound_run).status_code for _ in range(3)] == [200, 200, 200]
    secret = next(iter(STORE.secret.values()))
    first_used = secret["last_used_at"]
    resp = _creds(bound_run)
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "CREDENTIALS_EXHAUSTED"
    assert STORE.run[bound_run]["credentials_issued"] == 3 and secret["last_used_at"] == first_used


def test_credentials_use_their_own_rate_bucket(bound_run):
    while main_module._signal_rate_ok(bound_run, datetime.now(tz=timezone.utc).timestamp()):
        pass
    assert _creds(bound_run).status_code == 200


def test_credentials_rate_limit_applies(bound_run, monkeypatch):
    monkeypatch.setattr(main_module, "_CREDENTIALS_RATE_LIMIT", 2)
    monkeypatch.setattr(main_module, "_CREDENTIALS_MAX_ISSUES", 99)
    assert [_creds(bound_run).status_code for _ in range(3)] == [200, 200, 429]


def test_removed_secret_is_409_and_nothing_is_returned(bound_run):
    saved = dict(STORE.secret)
    STORE.secret.clear()
    resp = _creds(bound_run)
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "SECRET_REMOVED"
    assert SENTINEL not in resp.text
    assert STORE.run[bound_run].get("credentials_issued", 0) == 0  # a failure consumes no issue
    STORE.secret.update(saved)
    assert [_creds(bound_run).status_code for _ in range(4)] == [200, 200, 200, 409]


def test_a_failed_decrypt_does_not_consume_an_issue(bound_run):
    secret = next(iter(STORE.secret.values()))
    good = secret["ciphertext"]
    secret["ciphertext"] = secrets_store.seal(
        _row(id="22222222-2222-2222-2222-222222222222"), {"password": SENTINEL})
    assert [_creds(bound_run).status_code for _ in range(2)] == [503, 503]
    assert STORE.run[bound_run].get("credentials_issued", 0) == 0
    secret["ciphertext"] = good
    assert [_creds(bound_run).status_code for _ in range(4)] == [200, 200, 200, 409]
    assert STORE.run[bound_run]["credentials_issued"] == 3


def test_a_lost_compare_and_set_rereads_and_retries_once(bound_run, monkeypatch):
    real = type(get_client(None)).execute
    calls = {"n": 0}

    async def racing(self, query, variables=None):
        if "IssueRunCredentialsIf" in query and calls["n"] == 0:
            calls["n"] += 1
            STORE.run[bound_run]["credentials_issued"] = 1  # a concurrent fetch won
        return await real(self, query, variables)

    monkeypatch.setattr(type(get_client(None)), "execute", racing)
    assert _creds(bound_run).status_code == 200
    assert STORE.run[bound_run]["credentials_issued"] == 2


def test_a_newer_version_is_served_and_noted_in_the_event(bound_run):
    assert _put(fields={"username": "edl-user", "password": "rotated-" + SENTINEL}).json()["version"] == 2
    resp = _creds(bound_run)
    assert resp.json()["env"]["EARTHDATA_PASSWORD"] == "rotated-" + SENTINEL
    issued = [e for e in STORE.secret_event if e["event"] == "issued"][-1]
    assert issued["secret_version"] == 2
    assert STORE.provenance[-1]["payload_json"]["secrets"] == ["earthdata@v2"]


def test_repointed_secret_row_is_refused_at_delivery(bound_run):
    next(iter(STORE.secret.values()))["pinned_app_version"] = "9"
    resp = _creds(bound_run)
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "SECRET_APP_MISMATCH"
    assert STORE.secret_event[-1]["event"] == "mismatch"


def test_tampered_ciphertext_is_a_503_not_a_value(bound_run):
    other = secrets_store.seal(_row(id="22222222-2222-2222-2222-222222222222"), {"password": SENTINEL})
    next(iter(STORE.secret.values()))["ciphertext"] = other
    resp = _creds(bound_run)
    assert resp.status_code == 503 and SENTINEL not in resp.text


# --- task-side injection ---------------------------------------------------------------
def _code(**task):
    return tapis._model_execution_code({"job_definition": {"name": "j", "fileInputs": []}, **task})


def test_task_code_replaces_env_keys_and_fails_with_secret_unavailable():
    code = _code()
    assert "CREDENTIALS_URL" in code and "SECRET_UNAVAILABLE" in code
    assert '_e.get("key") == _key' in code  # replace, never duplicate
    assert "continue without" not in code and "EARTHDATA_USERNAME" not in code
    assert "earthdata-netrc" in code and "no run signal token was issued" in code
    assert SENTINEL not in code
    compile(code, "<task>", "exec")


def test_pipeline_definition_binds_url_but_never_a_value():
    workflow = tapis.generate_tapis_workflow({"id": "p", "plan_json": {
        "steps": [], "parameters": [],
        "model_task": {"stage_id": "model", "output_name": "o", "output_format": "tif",
                       "job_definition": {"appId": "a", "appVersion": "1", "fileInputs": [], "parameterSet": {}}},
    }})
    model = workflow["tasks"][0]
    assert model["input"]["CREDENTIALS_URL"] == {"type": "string", "value_from": {"args": "credentials_url"}}
    assert "credentials_url" in tapis.STANDARD_PARAMS
    assert SENTINEL not in json.dumps(workflow)


# --- catalog sync ---------------------------------------------------------------------
def test_mint_sync_skips_secret_parameters_without_a_warning():
    warnings: list[str] = []
    env = _build_env_from_args([
        {"parameter": {"label": "earthdata", "parameter_type": "secret", "has_accepted_values": ENV_MAP}},
        {"parameter": {"label": "lat", "parameter_type": "model_param"}}], CFG, warnings)
    assert env == {"LAT": "lat"} and warnings == []


# --- by-value redaction and the sentinel leak test (merge gate) ----------------------------
def test_registered_values_are_scrubbed_from_error_text_and_log_records(caplog):
    secrets_store.install_log_scrubber()
    secrets_store.register_values([SENTINEL])
    assert SENTINEL not in safe_error_message(f"upstream said {SENTINEL} is wrong")
    caplog.set_level(logging.INFO)
    logging.getLogger("test.leak").warning("password was %s", SENTINEL)
    assert caplog.records and all(SENTINEL not in r.getMessage() for r in caplog.records)
    assert "[redacted]" in caplog.records[-1].getMessage()


def test_public_args_still_hide_server_injected_tokens():
    assert _public_workflow_args({"tapis_token": {"value": "x"}, "a": {"value": 1}}) == {"a": {"value": 1}}


def test_a_failing_hasura_write_during_put_never_echoes_the_values(monkeypatch, caplog):
    secrets_store.install_log_scrubber()
    caplog.set_level(logging.DEBUG)
    real = type(get_client(None)).execute

    async def failing(self, query, variables=None):
        if "InsertSecret(" in query:
            raise RuntimeError(f"hasura rejected {SENTINEL}")
        return await real(self, query, variables)

    monkeypatch.setattr(type(get_client(None)), "execute", failing)
    quiet = TestClient(app, raise_server_exceptions=False)
    resp = quiet.put("/admin/secrets", headers=ADMIN, json=_put_body())
    assert resp.status_code in (500, 503) and SENTINEL not in resp.text
    assert all(SENTINEL not in r.getMessage() for r in caplog.records)
    assert not STORE.secret


def test_sentinel_never_leaks_outside_the_credentials_response(caplog, submit):
    caplog.set_level(logging.DEBUG)
    secrets_store.install_log_scrubber()
    put = _put()
    dry = submit["submit"](dry_run=True)
    real = submit["submit"]()
    run_id = real.json()["run_id"]
    assert _creds(run_id).status_code == 200  # the one place the value may appear
    _creds(run_id, secret="wrong")
    delete = client.request("DELETE", "/admin/secrets", headers=ADMIN,
                            json={k: _put_body()[k] for k in ("scope", "owner_username", "configuration_id", "name")})
    # A deliberately malformed PUT: FastAPI would echo the whole body as `input`.
    malformed = client.put("/admin/secrets", headers=ADMIN, json={
        "owner_username": "owner1", "configuration_id": CFG,
        "fields": {"username": "edl-user", "password": SENTINEL, "n": 5}})
    assert malformed.status_code == 422 and "input" not in malformed.text
    bad_json = client.put("/admin/secrets", headers={**ADMIN, "Content-Type": "application/json"},
                          content=f'{{"fields": {{"password": "{SENTINEL}"}}'.encode())
    assert bad_json.status_code == 422

    for response in (put, dry, real, delete, malformed, bad_json, client.get(f"/runs/{run_id}"),
                     client.get(f"/runs/{run_id}/provenance")):
        assert SENTINEL not in response.text
    assert all(SENTINEL not in r.getMessage() for r in caplog.records)
    for state in (STORE.provenance, list(STORE.run.values()), list(STORE.plan.values()),
                  STORE.secret_event, submit["submits"]):
        assert SENTINEL not in json.dumps(state, default=str)
    assert all(SENTINEL not in json.dumps(s["pipeline"]) for s in submit["submits"])
