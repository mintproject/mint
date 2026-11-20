"""A runner's own secrets for the steps of a flow: the declaration, the plan, the
submit, the per-step fetch credential and fetch route, and the wrapper that fetches
(demo mode, Tapis stubbed).

Design: docs/design/2026-11-19-user-secrets-for-flows.md, sections 2-5 and 8."""
from __future__ import annotations

import io
import json
import os
import sys
import time
import types
import urllib.error
import urllib.request

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config

import pytest  # noqa: E402
from cryptography.fernet import Fernet  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main as main_module  # noqa: E402
from app import run_state, step_secrets, tapis  # noqa: E402
from app import secrets as secrets_store  # noqa: E402
from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402
from app.mint_sync import etl_process_to_spec_row  # noqa: E402
from app.planner import build_plan_json  # noqa: E402
from app.store import STORE  # noqa: E402
from app.stored_source import approval_sha256, decision, runnable_code  # noqa: E402

client = TestClient(app)
V = "https://example.org/"
VALUE = "SENTINEL-key-7c1d"
BASE = "https://models.example"
USERS = {"tok-alice": "alice", "tok-bob": "bob"}
ALICE = {"Authorization": "Bearer tok-alice"}
BOB = {"Authorization": "Bearer tok-bob"}
KEY = "step-secret-test-key"
ADAPTER = "https://svo.example"
CODE = "def run(inputs):\n    return 'ok'\n"
SECRETS = [{"name": "model_server", "label": "Model server",
            "env": {"MODEL_API_KEY": "api_key", "CHAT_BASE_URL": "chat_base_url"}}]
SENDS = [{"service": "The model server in your 'model_server' credential",
          "what": "Passages of your documents, to embed and label them"}]
BODY = {"fields": {"api_key": VALUE, "chat_base_url": BASE}}


@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    monkeypatch.setattr(settings, "secrets_encryption_keys", Fernet.generate_key().decode())
    monkeypatch.setattr(settings, "step_secret_key", KEY)
    monkeypatch.setattr(settings, "public_base_url", ADAPTER)
    monkeypatch.setattr(settings, "stored_source_enabled", True)
    monkeypatch.setattr("app.main.tapis.userinfo_username", lambda token: USERS.get(token))
    client.post("/admin/reset")
    main_module._CALLER_CACHE.clear()
    main_module._SECRET_CHANGE_RATE.clear()
    main_module._CREDENTIALS_RATE.clear()
    yield
    secrets_store.ValueScrubber.clear()


# --- pieces, flows and plans ------------------------------------------------------
def piece(name="draft", *, secrets=SECRETS, sends=SENDS, code=CODE, entrypoint="run", env=None,
          owner="bob", visibility="public", approved=True, inputs=("corpus",), outputs=("clean",)):
    body = {
        "name": name, "method": "tapis_function", "transform_type": "etl_process",
        "contracts": [*({"role": "input", "standard_variable_uri": V + i} for i in inputs),
                      *({"role": "output", "standard_variable_uri": V + o} for o in outputs)],
        "env_from_args": {"TAPIS_TOKEN": "tapis_token", **(env or {})},
        "metadata": {"source": {"language": "python", "code": code,
                                **({"entrypoint": entrypoint} if entrypoint else {})}},
    }
    if secrets:
        body["secrets"] = secrets
    if sends:
        body["sends_data_to"] = sends
    response = client.post("/transform-specs", json=body)
    assert response.status_code == 200, response.text
    spec_id = response.json()["id"]
    row = STORE.transform_spec[spec_id]
    row.update(owner_username=owner, visibility=visibility)
    if approved:
        row["approved_source_sha256"] = approval_sha256(row)
    return spec_id


def data_object(variable="corpus", uri="tapis://sys/docs"):
    return client.post("/data-objects", json={
        "label": variable, "resource_uri": uri, "format": "directory",
        "variables": [{"standard_variable_uri": V + variable}]}).json()["id"]


def stored_flow(monkeypatch, steps):
    flow = {"configuration_id": "cfg-1", "label": "draft", "parameters": [],
            "outputs": [], "thread_bindings": {}, "steps": steps}

    async def load(h, configuration_id):
        return flow if configuration_id == "cfg-1" else None
    monkeypatch.setattr(main_module, "_load_flow", load)


def step(position, piece_id, wires=None, settings_=None):
    return {"position": position, "etl_process_id": piece_id, "settings": settings_ or {},
            "wires": wires if wires is not None else [{"to": {"input": 1}, "from": {"flow_input": "in:corpus"}}]}


def plan(headers=ALICE, **over):
    return client.post("/plans/flow", headers=headers, json={
        "flow_id": "cfg-1", "inputs": {"in:corpus": data_object()}, **over})


def put_secret(headers=ALICE, name="model_server", body=BODY):
    response = client.put(f"/secrets/{name}", headers=headers, json=body)
    assert response.status_code == 200, response.text
    return response


def one_step_flow(monkeypatch, **piece_over):
    piece_id = piece(**piece_over)
    stored_flow(monkeypatch, [step(1, piece_id)])
    return piece_id


def stored_plan_text():
    return json.dumps([row["plan_json"] for row in STORE.plan.values()])


# --- declarations ---------------------------------------------------------------
def test_a_valid_declaration_is_normalised_and_an_invalid_one_refused():
    assert step_secrets.parse_secrets([{"name": "a", "env": {"X_KEY": "f"}}]) == [
        {"name": "a", "label": "a", "env": {"X_KEY": "f"}}]
    for bad in ([{"name": "A", "env": {"X": "f"}}],                       # name rule
                [{"name": "a", "env": {"x": "f"}}],                       # task input rule
                [{"name": "a", "env": {"X": "F"}}],                       # field rule
                [{"name": "a", "env": {}}],
                [{"name": "a", "env": {"X": "f"}}, {"name": "a", "env": {"Y": "f"}}],
                [{"name": "a", "env": {"X": "f"}}, {"name": "b", "env": {"X": "g"}}],  # one input, two secrets
                [{"name": f"s{i}", "env": {"X": "f"}} for i in range(17)],
                [{"name": "a", "env": {"X": "f"}, "extra": 1}], "not-a-list"):
        with pytest.raises(step_secrets.StepSecretError) as caught:
            step_secrets.parse_secrets(bad)
        assert caught.value.detail["code"] == "SECRET_DECLARATION_INVALID"
    with pytest.raises(step_secrets.StepSecretError):
        step_secrets.parse_sends_data_to([{"service": "x" * 201, "what": "y"}])
    with pytest.raises(step_secrets.StepSecretError):
        step_secrets.parse_sends_data_to([{"service": "x", "what": "y" * 301}])
    assert step_secrets.parse_sends_data_to(SENDS) == SENDS


def test_a_catalog_round_trip_keeps_the_declarations():
    runtime = {"language": "python", "entrypoint": "run",
               "source": {"language": "python", "code": CODE},
               "secrets": [{"name": "model_server", "env": {"MODEL_API_KEY": "api_key"}}],
               "sends_data_to": SENDS}
    row = etl_process_to_spec_row({
        "id": "etl-secret", "label": "secret piece", "owner_username": "alice", "visibility": "private",
        "runtime_kind": "tapis_function", "runtime_json": runtime,
        "contracts": [{"role": "input", "position": 0}, {"role": "output", "position": 0}]}, [])
    (planned,) = build_plan_json([row])["steps"]
    assert planned["secrets"] == [{"name": "model_server", "label": "model_server",
                                   "env": {"MODEL_API_KEY": "api_key"}}]
    assert planned["sends_data_to"] == SENDS


def test_a_malformed_catalog_declaration_is_not_synced():
    warnings: list[str] = []
    row = etl_process_to_spec_row({
        "id": "etl-bad", "label": "bad", "runtime_json": {"secrets": [{"name": "A", "env": {"X": "f"}}]},
        "contracts": [{"role": "input"}, {"role": "output"}]}, warnings)
    assert row is None and "etl-bad" in warnings[0]


def test_approval_lapses_when_a_declaration_is_added_or_changed():
    plain = {"id": "p", "name": "p", "transform_type": "etl_process", "owner_username": "bob",
             "visibility": "public", "parameters_schema_json": {
                 "metadata": {"source": {"language": "python", "code": CODE, "entrypoint": "run"}}}}
    before = approval_sha256(plain)
    assert approval_sha256({**plain, "secrets": []}) == before  # an old approval still holds
    for key, value in (("secrets", SECRETS), ("sends_data_to", SENDS)):
        approved = {**plain, "approved_source_sha256": before}
        assert decision(approved, "carol") == "approved"
        edited = {**approved, key: value}
        assert approval_sha256(edited) != before and decision(edited, "carol") == "denied"
    declared = {**plain, "secrets": SECRETS, "approved_source_sha256": approval_sha256({**plain, "secrets": SECRETS})}
    assert decision(declared, "carol") == "approved"
    other = {**declared, "secrets": [{**SECRETS[0], "env": {"MODEL_API_KEY": "other_field"}}]}
    assert decision(other, "carol") == "denied"


# --- the plan ---------------------------------------------------------------------
def test_a_flow_whose_secret_is_stored_is_planned_ready(monkeypatch):
    one_step_flow(monkeypatch)
    put_secret()
    response = plan()
    assert response.status_code == 200, response.text
    plan_json = response.json()["plan_json"]
    assert plan_json["secrets"] == [{"name": "model_server", "label": "Model server",
                                     "fields": ["api_key", "chat_base_url"], "steps": [1], "stored": True}]
    assert plan_json["secrets_ready"] is True
    assert plan_json["sends_data_to"] == [{"step": 1, "piece": "draft", **SENDS[0]}]
    row = next(iter(STORE.secret.values()))
    assert plan_json["secret_bindings"] == {"model_server": {
        "id": row["id"], "version": 1, "owner": "alice"}}
    for text in (response.text, stored_plan_text(), json.dumps(STORE.provenance)):
        assert VALUE not in text and BASE not in text


def test_a_flow_whose_secret_is_not_stored_is_planned_not_ready(monkeypatch):
    one_step_flow(monkeypatch)
    response = plan()
    assert response.status_code == 200, response.text
    plan_json = response.json()["plan_json"]
    assert plan_json["secrets_ready"] is False
    assert plan_json["secrets"][0]["stored"] is False and plan_json["secrets"][0]["name"] == "model_server"
    assert "secret_bindings" not in plan_json


def test_a_stored_secret_missing_a_needed_field_is_not_stored_for_the_plan(monkeypatch):
    one_step_flow(monkeypatch)
    put_secret(body={"fields": {"api_key": VALUE}})
    assert plan().json()["plan_json"]["secrets"][0]["stored"] is False


def test_another_users_or_a_model_owners_secret_is_not_the_callers(monkeypatch):
    one_step_flow(monkeypatch)
    put_secret(headers=BOB)
    row = {"id": "33333333-3333-3333-3333-333333333333", "scope": "model_owner", "owner_username": "alice",
           "name": "model_server", "configuration_id": "cfg-x", "version": 1}
    STORE.secret[row["id"]] = {**row, "pinned_app_id": "a", "pinned_app_version": "1",
                               "fields": '{"api_key","chat_base_url"}', "created_at": "t", "updated_at": "t",
                               "last_used_at": None,
                               "ciphertext": secrets_store.seal(row, {"api_key": "owner-value"})}
    assert plan().json()["plan_json"]["secrets_ready"] is False


def test_a_flow_with_no_secrets_is_ready_and_lists_nothing(monkeypatch):
    one_step_flow(monkeypatch, secrets=None, sends=None, code="def run(inputs):\n    return 1\n")
    plan_json = plan().json()["plan_json"]
    assert (plan_json["secrets"], plan_json["secrets_ready"], plan_json["sends_data_to"]) == ([], True, [])


def test_a_stale_registry_copy_is_refused_at_plan_naming_the_piece(monkeypatch):
    piece_id = one_step_flow(monkeypatch, secrets=None, sends=None)
    put_secret()

    async def catalog(h, ids):
        return {piece_id: {"id": piece_id, "runtime_json": {"secrets": SECRETS}}}
    monkeypatch.setattr(main_module, "_catalog_pieces", catalog)
    response = plan()
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "PIECE_REGISTRY_STALE"
    assert response.json()["detail"]["piece_id"] == piece_id


def test_a_registry_copy_that_matches_the_catalog_is_planned(monkeypatch):
    piece_id = one_step_flow(monkeypatch)

    async def catalog(h, ids):
        return {piece_id: {"id": piece_id, "runtime_json": {"secrets": SECRETS, "sends_data_to": SENDS}}}
    monkeypatch.setattr(main_module, "_catalog_pieces", catalog)
    assert plan().status_code == 200


@pytest.mark.parametrize("kwargs", [
    {"entrypoint": None},                                   # script-style: no wrapper to fetch for
    {"code": "def other(inputs):\n    return 1\n"},         # entrypoint not defined in the source
])
def test_a_script_style_piece_that_declares_a_secret_is_refused_at_plan(monkeypatch, kwargs):
    one_step_flow(monkeypatch, **kwargs)
    response = plan()
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "SECRET_PIECE_UNSUPPORTED" and detail["step"] == 1


def test_a_builtin_piece_that_declares_a_secret_is_refused_at_plan(monkeypatch):
    piece_id = client.post("/transform-specs", json={
        "name": "builtin", "method": "tapis_function", "transform_type": "unit_convert",
        "secrets": SECRETS, "env_from_args": {"TAPIS_TOKEN": "tapis_token"},
        "contracts": [{"role": "input", "standard_variable_uri": V + "corpus"},
                      {"role": "output", "standard_variable_uri": V + "clean"}]}).json()["id"]
    stored_flow(monkeypatch, [step(1, piece_id)])
    assert plan().json()["detail"]["code"] == "SECRET_PIECE_UNSUPPORTED"


def test_an_app_piece_that_declares_a_secret_is_refused_at_plan(monkeypatch):
    piece_id = client.post("/transform-specs", json={
        "name": "app", "method": "tapis_job", "tapis_app_id": "some-app", "transform_type": "custom",
        "secrets": SECRETS, "file_inputs": [{"name": "docs", "from_arg": "source_uri", "target_path": "docs"}],
        "contracts": [{"role": "input", "standard_variable_uri": V + "corpus"},
                      {"role": "output", "standard_variable_uri": V + "clean"}]}).json()["id"]
    stored_flow(monkeypatch, [step(1, piece_id)])
    assert plan().json()["detail"]["code"] == "SECRET_PIECE_UNSUPPORTED"


def test_a_chain_plan_cannot_carry_a_secret():
    spec = {"id": "p", "name": "p", "transform_type": "etl_process", "secrets": SECRETS,
            "parameters_schema_json": {"metadata": {"source": {"code": CODE, "entrypoint": "run"}}}}
    with pytest.raises(step_secrets.StepSecretError) as caught:
        tapis.generate_tapis_workflow({"id": "x", "plan_json": build_plan_json([spec])})
    assert caught.value.detail["code"] == "SECRET_PIECE_UNSUPPORTED"


# --- the destination rule ---------------------------------------------------------
@pytest.mark.parametrize("env,taken", [
    ({"MODEL_API_KEY": "key_arg"}, "MODEL_API_KEY"),        # a run argument fills the same input
    ({"model_api_key": "key_arg"}, "MODEL_API_KEY"),        # ... in another case
    ({"Chat_Base_Url": "url_arg"}, "CHAT_BASE_URL"),
])
def test_an_input_a_secret_fills_may_not_also_be_a_run_argument(monkeypatch, env, taken):
    one_step_flow(monkeypatch, env=env)
    response = plan()
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "FLOW_SECRET_INPUT_TAKEN" and detail["step"] == 1, detail
    assert detail["input"] == taken


@pytest.mark.parametrize("name", ["SOURCE_1", "source_result", "TAPIS_TOKEN", "tapis_base_url",
                                  "SVO_RUN_ID", "svo_adapter_url", "SVO_STEP_SECRET_TOKEN"])
def test_a_secret_may_not_fill_a_managed_or_source_input(monkeypatch, name):
    secrets = [{"name": "model_server", "env": {name.upper(): "api_key"}}]
    one_step_flow(monkeypatch, secrets=secrets)
    detail = plan().json()["detail"]
    assert detail["code"] == "FLOW_SECRET_INPUT_TAKEN" and detail["input"] == name.upper()


def test_a_link_from_a_flow_setting_into_a_secret_input_is_refused():
    link_step = {"step": 2, "secrets": [{"name": "s", "env": {"MODEL_API_KEY": "api_key"}}]}
    # What a flow setting or a link finally reaches is an env_from_args key.
    with pytest.raises(step_secrets.StepSecretError) as caught:
        step_secrets.step_inputs_check(link_step, ["SOURCE_1", "model_api_key"], ["TOP_N"])
    assert caught.value.detail["input"] == "MODEL_API_KEY" and caught.value.detail["step"] == 2
    step_secrets.step_inputs_check(link_step, ["SOURCE_1", "OTHER"], ["TOP_N"])


def test_a_flow_that_sets_a_secret_input_is_refused_at_check_and_plan(monkeypatch):
    piece_id = piece(env={"MODEL_API_KEY": "key_arg"})
    checked = client.post("/flows/check", headers=ALICE, json={
        "inputs": [{"id": "in:corpus", "contract": {"standard_variable_uri": V + "corpus"}}],
        "steps": [{"position": 1, "etl_process_id": piece_id,
                   "wires": [{"to": {"input": 1}, "from": {"flow_input": "in:corpus"}}]}]}).json()
    assert checked["ok"] is False
    assert [(p["code"], p["step"], p["input"]) for p in checked["problems"]] == [
        ("FLOW_SECRET_INPUT_TAKEN", 1, "MODEL_API_KEY")]
    stored_flow(monkeypatch, [step(1, piece_id)])
    assert plan().json()["detail"]["code"] == "FLOW_SECRET_INPUT_TAKEN"


def test_a_flow_that_fits_checks_out_with_secrets(monkeypatch):
    piece_id = piece()
    checked = client.post("/flows/check", headers=ALICE, json={
        "inputs": [{"id": "in:corpus", "contract": {"standard_variable_uri": V + "corpus"}}],
        "steps": [{"position": 1, "etl_process_id": piece_id,
                   "wires": [{"to": {"input": 1}, "from": {"flow_input": "in:corpus"}}]}]}).json()
    assert checked["ok"] is True and checked["problems"] == []


def test_the_pipeline_gives_the_step_its_adapter_inputs_and_only_its_own_credential(monkeypatch):
    one_step_flow(monkeypatch)
    plan_json = plan().json()["plan_json"]
    pipeline = tapis.generate_tapis_workflow({"id": "p", "plan_json": plan_json})
    (task,) = [t for t in pipeline["tasks"] if t["id"].startswith("step-1")]
    assert task["input"]["SVO_RUN_ID"]["value_from"] == {"args": "svo_run_id"}
    assert task["input"]["SVO_ADAPTER_URL"]["value_from"] == {"args": "svo_adapter_url"}
    assert task["input"]["SVO_STEP_SECRET_TOKEN"]["value_from"] == {"args": "step_secret_token_1"}
    assert task["input"]["TAPIS_TOKEN"]["value_from"] == {"args": "tapis_token"}
    assert {"svo_run_id", "svo_adapter_url", "step_secret_token_1"} <= set(pipeline["params"])
    assert "MODEL_API_KEY" not in task["input"] and "CHAT_BASE_URL" not in task["input"]


# --- submit -----------------------------------------------------------------------
@pytest.fixture
def captured(monkeypatch):
    seen = {"submits": []}

    def fake_submit(pipeline, args, **kwargs):
        seen["submits"].append({"pipeline": pipeline, "args": args})
        return {"uuid": "tapis-run-1", "pipelineId": pipeline["id"], "tapisStatus": "submitted"}

    async def passthrough(args, caller_token):
        return args
    monkeypatch.setattr("app.main.tapis.submit_tapis_workflow", fake_submit)
    monkeypatch.setattr("app.main._with_run_token", passthrough)
    return seen


def submit(plan_id, headers=ALICE, **body):
    return client.post("/workflows/submit", headers=headers, json={"plan_id": plan_id, **body})


def planned_and_submitted(monkeypatch, **piece_over):
    one_step_flow(monkeypatch, **piece_over)
    put_secret()
    plan_id = plan().json()["plan_id"]
    response = submit(plan_id)
    assert response.status_code == 200, response.text
    return plan_id, response.json()["run_id"]


def test_submit_binds_ids_and_versions_and_hands_the_step_its_credential(monkeypatch, captured):
    _, run_id = planned_and_submitted(monkeypatch)
    row = STORE.run[run_id]
    secret_id = next(iter(STORE.secret))
    assert row["bound_secrets"] == {"steps": [{"step": 1, "issued": False, "secrets": [{
        "id": secret_id, "version": 1, "name": "model_server",
        "env": {"MODEL_API_KEY": "api_key", "CHAT_BASE_URL": "chat_base_url"}}]}]}
    args = captured["submits"][0]["args"]
    assert args["svo_run_id"]["value"] == run_id and args["svo_adapter_url"]["value"] == ADAPTER
    credential = args["step_secret_token_1"]["value"]
    assert step_secrets.verify_credential(
        KEY, credential, run_id, 1, row["bound_secrets"]["steps"][0]["secrets"])
    assert int(credential.split(".")[0]) > time.time()
    bound = [e for e in STORE.secret_event if e["event"] == "bound"]
    assert len(bound) == 1 and bound[0]["run_id"] == run_id and bound[0]["scope"] == "user"
    assert bound[0]["secret_id"] == secret_id and bound[0]["secret_version"] == 1
    # No value anywhere the run or its pipeline is kept.
    stored = json.dumps([STORE.run, STORE.plan, STORE.provenance, STORE.secret_event, captured["submits"][0]["pipeline"]])
    assert VALUE not in stored and BASE not in stored
    assert VALUE not in json.dumps(args) and VALUE not in json.dumps(row)


def test_a_dry_run_binds_nothing_and_returns_no_credential(monkeypatch, captured):
    one_step_flow(monkeypatch)
    put_secret()
    response = submit(plan().json()["plan_id"], dry_run=True)
    assert response.status_code == 200, response.text
    assert not any(name.startswith("step_secret_token_") for name in response.json()["args"])
    assert KEY not in response.text
    run = next(iter(STORE.run.values()))
    assert "bound_secrets" not in run and not captured["submits"]


@pytest.mark.parametrize("args", [{"svo_run_id": "other"}, {"svo_adapter_url": "https://evil.example"},
                                  {"step_secret_token_1": "mine"}, {"step_secret_token_9": "mine"}])
def test_a_submission_cannot_set_what_the_adapter_manages(monkeypatch, captured, args):
    one_step_flow(monkeypatch)
    put_secret()
    refused = submit(plan().json()["plan_id"], args=args, accept_flow_settings=True)
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "FLOW_ARGUMENT_FIXED"
    assert refused.json()["detail"]["arguments"] == sorted(args)
    assert not captured["submits"]


def test_submit_refuses_a_missing_secret_naming_its_fields(monkeypatch, captured):
    one_step_flow(monkeypatch)
    plan_id = plan().json()["plan_id"]
    refused = submit(plan_id)
    assert refused.status_code == 422
    assert refused.json()["detail"]["code"] == "FLOW_SECRET_MISSING"
    assert refused.json()["detail"]["secrets"] == [{"name": "model_server", "fields": ["api_key", "chat_base_url"]}]
    assert not STORE.run and not captured["submits"]


def test_submit_refuses_when_the_secret_changed_since_the_plan(monkeypatch, captured):
    one_step_flow(monkeypatch)
    put_secret()
    plan_id = plan().json()["plan_id"]
    put_secret(body={"fields": {"api_key": "a-newer-value", "chat_base_url": BASE}})
    refused = submit(plan_id)
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == "FLOW_SECRET_CHANGED" and refused.json()["detail"]["name"] == "model_server"
    assert not STORE.run and not captured["submits"]
    assert submit(plan().json()["plan_id"]).status_code == 200  # planning again knowingly


def test_submit_refuses_an_untrusted_step_in_a_run_that_binds_a_secret(monkeypatch, captured):
    trusted = piece("trusted")
    shared = piece("other", secrets=None, sends=None, owner="bob", visibility="shared", approved=False,
                   inputs=("clean",), outputs=("report",), code="def run(inputs):\n    return 2\n")
    stored_flow(monkeypatch, [
        step(1, trusted),
        step(2, shared, wires=[{"to": {"input": 1}, "from": {"step": 1, "output": 1}}])])
    put_secret()
    planned = plan(allow_unapproved_piece_ids=[shared])
    assert planned.status_code == 200, planned.text  # the runner opted in to it
    refused = submit(planned.json()["plan_id"])
    assert refused.status_code == 403
    assert refused.json()["detail"]["code"] == "SECRET_PIECE_NOT_TRUSTED" and refused.json()["detail"]["step"] == 2
    assert not STORE.run and not captured["submits"]


def test_submit_refuses_a_piece_kind_that_cannot_be_given_a_secret(monkeypatch, captured):
    one_step_flow(monkeypatch)
    put_secret()
    plan_id = plan().json()["plan_id"]
    del STORE.plan[plan_id]["plan_json"]["steps"][0]["python_entrypoint"]
    refused = submit(plan_id)
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "SECRET_PIECE_UNSUPPORTED"
    assert refused.json()["detail"]["step"] == 1


def test_submit_needs_the_step_secret_key(monkeypatch, captured):
    one_step_flow(monkeypatch)
    put_secret()
    plan_id = plan().json()["plan_id"]
    monkeypatch.setattr(settings, "step_secret_key", "")
    refused = submit(plan_id)
    assert refused.status_code == 503 and refused.json()["detail"]["code"] == "STEP_SECRETS_NOT_CONFIGURED"
    assert not STORE.run and not captured["submits"]


def test_submit_refuses_when_the_piece_declares_other_secrets_than_the_plan_did(monkeypatch, captured):
    piece_id = one_step_flow(monkeypatch)
    put_secret()
    plan_id = plan().json()["plan_id"]
    STORE.transform_spec[piece_id]["parameters_schema_json"]["tapis"]["secrets"] = [
        {"name": "model_server", "env": {"MODEL_API_KEY": "other_field"}}]
    row = STORE.transform_spec[piece_id]
    row["approved_source_sha256"] = approval_sha256(row)  # approved again as declared
    refused = submit(plan_id)
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "STEP_SECRET_DECLARATION_CHANGED"


# --- the fetch route ----------------------------------------------------------------
def fetch(run_id, credential, headers=ALICE, step=1):
    send = dict(headers or {})
    if credential is not None:
        send["X-Step-Secret-Token"] = credential
    return client.get(f"/runs/{run_id}/steps/{step}/secrets", headers=send)


@pytest.fixture
def bound(monkeypatch, captured):
    plan_id, run_id = planned_and_submitted(monkeypatch)
    return {"run": run_id, "plan": plan_id,
            "credential": captured["submits"][0]["args"]["step_secret_token_1"]["value"]}


def no_value(response):
    assert VALUE not in response.text and BASE not in response.text


def test_a_step_fetches_exactly_the_values_of_its_env_map(bound):
    response = fetch(bound["run"], bound["credential"])
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"inputs": {"MODEL_API_KEY": VALUE, "CHAT_BASE_URL": BASE}}
    issued = [e for e in STORE.secret_event if e["event"] == "issued"]
    assert len(issued) == 1 and issued[0]["run_id"] == bound["run"] and issued[0]["secret_version"] == 1
    assert issued[0]["secret_id"] == next(iter(STORE.secret))
    events = json.dumps([STORE.secret_event, STORE.provenance, STORE.run])
    assert VALUE not in events and BASE not in events
    assert STORE.run[bound["run"]]["bound_secrets"]["steps"][0]["issued"] is True


def test_the_credential_is_good_once(bound):
    assert fetch(bound["run"], bound["credential"]).status_code == 200
    again = fetch(bound["run"], bound["credential"])
    assert again.status_code == 409 and again.json()["detail"]["code"] == "STEP_SECRET_ALREADY_ISSUED"
    no_value(again)


def test_a_lost_race_is_read_again_and_one_use_still_holds(bound, monkeypatch):
    # Another step's fetch changes the column between this one's read and claim.
    real = main_module.ISSUE_STEP_SECRETS_IF
    state = {"first": True}
    original = type(get_hasura()).execute

    async def racing(self, query, variables=None):
        if query is real and state["first"]:
            state["first"] = False
            STORE.run[bound["run"]]["bound_secrets"]["steps"].append(
                {"step": 2, "secrets": [], "issued": True})
        return await original(self, query, variables)
    monkeypatch.setattr(type(get_hasura()), "execute", racing)
    assert fetch(bound["run"], bound["credential"]).status_code == 200
    assert fetch(bound["run"], bound["credential"]).status_code == 409


def get_hasura():
    return main_module.get_client(None)


@pytest.mark.parametrize("headers,status,code", [
    (None, 401, "STEP_SECRET_AUTH_REQUIRED"),
    ({"Authorization": "Bearer unknown-token"}, 401, "STEP_SECRET_AUTH_REQUIRED"),
    (BOB, 403, "STEP_SECRET_REFUSED"),                       # another user's token
])
def test_the_runners_own_token_is_needed(bound, headers, status, code):
    response = fetch(bound["run"], bound["credential"], headers=headers)
    assert (response.status_code, response.json()["detail"]["code"]) == (status, code)
    no_value(response)
    assert fetch(bound["run"], bound["credential"]).status_code == 200  # nothing was consumed


def test_another_users_token_gets_the_same_answer_for_a_run_that_does_not_exist(bound):
    real = fetch(bound["run"], bound["credential"], headers=BOB)
    missing = fetch("no-such-run", bound["credential"], headers=BOB)
    assert real.status_code == missing.status_code and real.json() == missing.json()


def credential_for(run_id, step=1, *, secrets=None, key=KEY, expires=None):
    entry = STORE.run[run_id]["bound_secrets"]["steps"][0]
    return step_secrets.make_credential(
        key, run_id, step, secrets if secrets is not None else entry["secrets"],
        expires if expires is not None else int(time.time()) + 3600)


def test_the_step_credential_is_needed_and_must_be_for_exactly_this_run_and_step(bound):
    run = bound["run"]
    other_run = "run-2"
    STORE.run[other_run] = {**STORE.run[run], "id": other_run}
    cases = {
        "missing": None, "forged": "9999999999.deadbeef", "garbage": "nonsense",
        "wrong key": credential_for(run, key="another-key"),
        "expired": credential_for(run, expires=int(time.time()) - 5),
        "other step": credential_for(run, step=2),
        "other run": credential_for(other_run),
        "other secrets": credential_for(run, secrets=[{"id": "x", "version": 1}]),
        "tampered expiry": str(int(time.time()) + 99999) + "." + bound["credential"].split(".")[1],
    }
    for label, credential in cases.items():
        response = fetch(run, credential)
        assert response.status_code == 401, label
        assert response.json()["detail"]["code"] in ("STEP_SECRET_AUTH_REQUIRED", "STEP_SECRET_CREDENTIAL_REJECTED")
        no_value(response)
    assert fetch(run, bound["credential"]).status_code == 200  # none was consumed


@pytest.mark.parametrize("status", ["completed", "failed", "cancelled", "generated"])
def test_a_finished_run_serves_nothing(bound, status):
    STORE.run[bound["run"]]["status"] = status
    response = fetch(bound["run"], bound["credential"])
    assert response.status_code == 409 and response.json()["detail"]["code"] == "RUN_NOT_ACTIVE"
    no_value(response)


def test_a_step_that_is_not_bound_gets_nothing(bound):
    response = fetch(bound["run"], credential_for(bound["run"], step=9), step=9)
    assert response.status_code == 404 and response.json()["detail"]["code"] == "STEP_SECRET_NOT_BOUND"


def test_a_piece_that_is_no_longer_approved_gets_nothing(bound):
    piece_id = next(iter(STORE.transform_spec))
    STORE.transform_spec[piece_id]["approved_source_sha256"] = None
    response = fetch(bound["run"], bound["credential"])
    assert response.status_code == 403
    assert response.json()["detail"]["code"] in ("SECRET_PIECE_NOT_TRUSTED", "STORED_SOURCE_NOT_PERMITTED")
    no_value(response)


def test_a_piece_that_changed_its_declaration_gets_nothing(bound):
    piece_id = next(iter(STORE.transform_spec))
    row = STORE.transform_spec[piece_id]
    # Approved again as declared, but declaring a different field than the plan bound.
    row["parameters_schema_json"]["tapis"]["secrets"] = [
        {"name": "model_server", "env": {"MODEL_API_KEY": "other_field"}}]
    row["approved_source_sha256"] = approval_sha256(row)
    response = fetch(bound["run"], bound["credential"])
    assert response.status_code == 409 and response.json()["detail"]["code"] == "STEP_SECRET_DECLARATION_CHANGED"
    no_value(response)


def test_a_deleted_secret_gets_nothing(bound):
    STORE.secret.clear()
    response = fetch(bound["run"], bound["credential"])
    assert response.status_code == 409 and response.json()["detail"]["code"] == "SECRET_REMOVED"
    no_value(response)


def test_a_replaced_secret_gets_nothing(bound):
    row = next(iter(STORE.secret.values()))
    new = {**{k: row[k] for k in ("id", "scope", "owner_username", "name", "configuration_id")}, "version": 2}
    row.update(version=2, ciphertext=secrets_store.seal(new, {"api_key": "swapped-in-1", "chat_base_url": "https://evil.example"}))
    response = fetch(bound["run"], bound["credential"])
    assert response.status_code == 409 and response.json()["detail"]["code"] == "FLOW_SECRET_CHANGED"
    assert "swapped-in-1" not in response.text and "evil.example" not in response.text


def test_a_secret_that_lost_a_field_gets_nothing(bound):
    row = next(iter(STORE.secret.values()))
    row["ciphertext"] = secrets_store.seal(row, {"api_key": VALUE})
    response = fetch(bound["run"], bound["credential"])
    assert response.status_code == 409 and response.json()["detail"]["code"] == "SECRET_FIELDS_INCOMPLETE"
    assert fetch(bound["run"], bound["credential"]).status_code == 409  # nothing was consumed, still refused


def test_the_per_run_rate_limit_applies(bound):
    main_module._CREDENTIALS_RATE[bound["run"]] = [time.time()] * main_module._CREDENTIALS_RATE_LIMIT
    response = fetch(bound["run"], bound["credential"])
    assert response.status_code == 429 and response.json()["detail"]["code"] == "RUN_CREDENTIALS_RATE_LIMITED"


def test_the_fetch_route_needs_its_configuration(bound, monkeypatch):
    monkeypatch.setattr(settings, "step_secret_key", "")
    response = fetch(bound["run"], bound["credential"])
    assert response.status_code == 503 and response.json()["detail"]["code"] == "STEP_SECRETS_NOT_CONFIGURED"


def test_a_run_that_is_not_the_callers_cannot_be_used_by_another_runners_step(bound):
    # Bob holds his own valid token and the credential of alice's step: still refused.
    put_secret(headers=BOB)
    assert fetch(bound["run"], bound["credential"], headers=BOB).status_code == 403


# --- the model-owner path stays apart -------------------------------------------------
def signal_headers(run_id):
    expires = int(time.time()) + 3600
    return {"X-Run-Signal-Token": run_state.make_signal_token(run_id, expires),
            "X-Run-Signal-Expires": str(expires)}


def test_the_model_credentials_route_never_returns_a_runners_secret(bound, monkeypatch):
    monkeypatch.setattr(settings, "run_signal_secrets", "sig-secret")
    run_id = bound["run"]
    STORE.run[run_id]["signals_armed"] = True
    # A flow run's bound_secrets (per step) is not a model owner's list.
    response = client.get(f"/runs/{run_id}/credentials", headers=signal_headers(run_id))
    assert response.status_code == 404 and VALUE not in response.text
    # Even a list that points at a runner's own row serves nothing.
    secret = STORE.run[run_id]["bound_secrets"]["steps"][0]["secrets"][0]
    STORE.run[run_id]["bound_secrets"] = [{**secret, "app": "a@1"}]
    response = client.get(f"/runs/{run_id}/credentials", headers=signal_headers(run_id))
    assert response.status_code == 409 and VALUE not in response.text and BASE not in response.text
    assert STORE.run[run_id].get("credentials_issued", 0) == 0


def test_the_flow_path_never_reads_a_model_owners_secret(bound):
    owner_row = {"id": "44444444-4444-4444-4444-444444444444", "scope": "model_owner",
                 "owner_username": "alice", "name": "model_server", "configuration_id": "cfg-x", "version": 1}
    STORE.secret[owner_row["id"]] = {**owner_row, "pinned_app_id": "a", "pinned_app_version": "1",
                                     "fields": '{"api_key","chat_base_url"}', "created_at": "t",
                                     "updated_at": "t", "last_used_at": None,
                                     "ciphertext": secrets_store.seal(owner_row, {
                                         "api_key": "owner-secret-value", "chat_base_url": "https://owner.example"})}
    response = fetch(bound["run"], bound["credential"])
    assert response.status_code == 200 and "owner-secret-value" not in response.text
    assert response.json()["inputs"]["MODEL_API_KEY"] == VALUE


# --- the wrapper ----------------------------------------------------------------------
WRAPPED = ("def run(inputs):\n"
           "    print('using', inputs['MODEL_API_KEY'])\n"
           "    return {'echo': inputs['MODEL_API_KEY'], 'where': inputs['CHAT_BASE_URL'],\n"
           "            'sees_credential': 'SVO_STEP_SECRET_TOKEN' in inputs, 'token': inputs.get('TAPIS_TOKEN')}\n")
TASK_INPUTS = {"TAPIS_TOKEN": "tok-alice", "SVO_RUN_ID": "run-9", "SVO_ADAPTER_URL": ADAPTER + "/",
               "SVO_STEP_SECRET_TOKEN": "cred-9"}
INPUT_NAMES = sorted(TASK_INPUTS)


class _Response:
    def __init__(self, status, body):
        self.status, self._body = status, body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


@pytest.fixture
def task(monkeypatch):
    """Run wrapped code against a stand-in Workflows context and a stand-in adapter."""
    calls: list = []

    def execute(code, *, answer, inputs=TASK_INPUTS):
        outputs: dict = {}
        ctx = types.SimpleNamespace(get_input=inputs.get, set_output=outputs.__setitem__)
        runtime = types.ModuleType("owe_python_sdk.runtime")
        runtime.execution_context = ctx
        monkeypatch.setitem(sys.modules, "owe_python_sdk", types.ModuleType("owe_python_sdk"))
        monkeypatch.setitem(sys.modules, "owe_python_sdk.runtime", runtime)

        class Opener:
            def open(self, request, timeout=None):
                calls.append(request)
                return answer(request)
        monkeypatch.setattr(urllib.request, "build_opener", lambda *handlers: Opener())
        exec(compile(code, "entrypoint.py", "exec"), {"__name__": "__main__"})
        return outputs
    execute.calls = calls
    return execute


def ok_answer(_request):
    return _Response(200, json.dumps({"inputs": {"MODEL_API_KEY": VALUE, "CHAT_BASE_URL": BASE}}).encode())


def test_the_wrapper_fetches_and_hands_the_values_to_the_piece_without_printing_them(task, capsys):
    code = runnable_code(WRAPPED, "run", INPUT_NAMES, secret_step=3)
    outputs = task(code, answer=ok_answer)
    (request,) = task.calls
    assert request.full_url == f"{ADAPTER}/runs/run-9/steps/3/secrets"
    headers = {k.lower(): v for k, v in request.header_items()}
    assert headers["authorization"] == "Bearer tok-alice" and headers["x-step-secret-token"] == "cred-9"
    result = json.loads(outputs["result"])
    assert result == {"echo": "***", "where": "***", "sees_credential": False, "token": "tok-alice"}
    printed = capsys.readouterr()
    assert VALUE not in printed.out + printed.err and BASE not in printed.out + printed.err
    assert "using ***" in printed.out
    assert VALUE not in json.dumps(outputs)


def test_the_fetched_values_do_reach_the_piece(task):
    code = runnable_code(
        "def run(inputs):\n    return len(inputs['MODEL_API_KEY']) * 1000 + len(inputs['CHAT_BASE_URL'])\n",
        "run", INPUT_NAMES, secret_step=1)
    assert task(code, answer=ok_answer) == {"result": str(len(VALUE) * 1000 + len(BASE))}


def test_a_failed_fetch_fails_the_step_with_the_code_and_nothing_else(task, capsys):
    def refuse(request):
        raise urllib.error.HTTPError(request.full_url, 409, "SECRET-REASON " + VALUE, {},
                                     io.BytesIO(b'{"detail":{"code":"BODY-TEXT ' + VALUE.encode() + b'"}}'))
    code = runnable_code(WRAPPED, "run", INPUT_NAMES, secret_step=1)
    with pytest.raises(SystemExit) as caught:
        task(code, answer=refuse)
    assert caught.value.code == 1
    printed = capsys.readouterr()
    assert printed.out.strip() == '{"status": "error", "code": "STEP_SECRET_FETCH_FAILED", "http_status": 409}'
    assert printed.err == "" and "BODY-TEXT" not in printed.out and "SECRET-REASON" not in printed.out


@pytest.mark.parametrize("answer,status", [
    (lambda r: (_ for _ in ()).throw(OSError("connection refused: " + VALUE)), 0),
    (lambda r: _Response(200, b"not json"), 200),
    (lambda r: _Response(200, json.dumps({"inputs": {"K": 5}}).encode()), 200),
    (lambda r: _Response(200, json.dumps({"other": {}}).encode()), 200),
])
def test_any_other_fetch_failure_is_one_line_as_well(task, capsys, answer, status):
    code = runnable_code(WRAPPED, "run", INPUT_NAMES, secret_step=1)
    with pytest.raises(SystemExit):
        task(code, answer=answer)
    printed = capsys.readouterr()
    assert json.loads(printed.out) == {"status": "error", "code": "STEP_SECRET_FETCH_FAILED", "http_status": status}
    assert VALUE not in printed.out + printed.err and "connection refused" not in printed.out + printed.err


def test_the_wrapper_masks_a_value_the_piece_returns_in_a_flow_output(task, capsys):
    code = runnable_code(
        "def run(inputs):\n    return {'svo_flow': {'outputs': {'1': 'key=' + inputs['MODEL_API_KEY']},"
        " 'values': {'note': ['x', inputs['CHAT_BASE_URL']]}}}\n",
        "run", INPUT_NAMES, {"outputs": {"1": "result"}, "values": {"note": "value_note"}}, secret_step=1)
    outputs = task(code, answer=ok_answer)
    assert outputs["result"] == "key=***" and json.loads(outputs["value_note"]) == ["x", "***"]
    printed = capsys.readouterr().out
    assert VALUE not in printed and BASE not in printed and "svo_flow_outputs" in printed


def test_an_error_in_the_piece_does_not_carry_the_value(task):
    code = runnable_code("def run(inputs):\n    raise ValueError('bad key ' + inputs['MODEL_API_KEY'])\n",
                         "run", INPUT_NAMES, secret_step=1)
    with pytest.raises(RuntimeError) as caught:
        task(code, answer=ok_answer)
    assert VALUE not in str(caught.value) and "bad key ***" in str(caught.value)


def test_a_step_without_a_secret_is_wrapped_as_before(task):
    plain = runnable_code(CODE, "run", ["TAPIS_TOKEN"])
    assert "STEP_SECRET_FETCH_FAILED" not in plain and "urllib" not in plain
    assert task(plain, answer=ok_answer) == {"result": "ok"} and not task.calls


def test_the_generated_task_code_is_the_fetching_wrapper(monkeypatch):
    one_step_flow(monkeypatch)
    plan_json = plan().json()["plan_json"]
    pipeline = tapis.generate_tapis_workflow({"id": "p", "plan_json": plan_json})
    (task_def,) = [t for t in pipeline["tasks"] if t["id"].startswith("step-1")]
    assert "/steps/1/secrets" in task_def["code"] and "STEP_SECRET_FETCH_FAILED" in task_def["code"]
    assert VALUE not in task_def["code"]
