"""Who may run a piece's stored source: at plan time, at submit time, in the
piece test endpoint, and which pipeline args that code may be handed."""
from __future__ import annotations

import asyncio
import os

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main as main_module  # noqa: E402
from app import tapis  # noqa: E402
from app.config import settings  # noqa: E402
from app.hasura import get_client  # noqa: E402
from app.main import app  # noqa: E402
from app.planner import build_plan_json  # noqa: E402
from app.store import STORE  # noqa: E402
from app.stored_source import (  # noqa: E402
    allowed_args, check_plan, decision, iter_stored_steps, plannable, source_sha256,
)

client = TestClient(app)
CODE = "from owe_python_sdk.runtime import execution_context as ctx\nctx.set_output('result', '1')\n"


def piece(pid="p1", owner="alice", visibility="private", approved=False, code=CODE, **over):
    spec = {
        "id": pid, "name": pid, "transform_type": "etl_process", "method": "tapis_function",
        "owner_username": owner, "visibility": visibility,
        "parameters_schema_json": {"metadata": {"source": {"language": "python", "code": code}}},
        "approved_source_sha256": source_sha256(code) if approved else None,
        "contracts": [],
    }
    spec.update(over)
    return spec


BUILTIN = {"id": "b1", "name": "b1", "transform_type": "unit_convert", "contracts": []}


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(settings, "stored_source_enabled", True)


@pytest.fixture(autouse=True)
def fresh():
    client.post("/admin/reset")
    main_module._CALLER_CACHE.clear()


def as_user(monkeypatch, username):
    monkeypatch.setattr(tapis, "userinfo_username", lambda token: username)


# --- decision --------------------------------------------------------------

def test_off_by_default_and_then_no_stored_source_runs_for_anyone():
    assert settings.stored_source_enabled is False
    assert decision(piece(), "alice") == "denied"
    assert decision(piece(visibility="public", approved=True), "bob") == "denied"
    assert decision(BUILTIN, None) == "builtin"


@pytest.mark.parametrize("spec,user,opt_in,expected", [
    (piece(), "alice", (), "own"),
    (piece(), "bob", (), "denied"),
    (piece(), "bob", ("p1",), "denied"),                                  # private is owner-only
    (piece(), None, (), "denied"),
    (piece(visibility="shared"), "bob", (), "denied"),                    # never auto-chosen
    (piece(visibility="shared"), "bob", ("p1",), "opt_in"),
    (piece(visibility="shared"), None, ("p1",), "denied"),                # opt-in needs a known caller
    (piece(visibility="public"), "bob", ("other",), "denied"),
    (piece(visibility="shared", approved=True), "bob", (), "approved"),
    (piece(visibility="public", approved=True), None, (), "approved"),
    (piece(visibility="private", approved=True), "bob", (), "denied"),    # approval does not publish
    (piece(owner=None, visibility=None, approved=True), "bob", (), "approved"),
    (BUILTIN, None, (), "builtin"),
])
def test_decision(enabled, spec, user, opt_in, expected):
    assert decision(spec, user, opt_in) == expected


def test_approval_of_an_older_source_does_not_count(enabled):
    spec = piece(visibility="public", approved=True)
    spec["parameters_schema_json"]["metadata"]["source"]["code"] = CODE + "# edited\n"
    assert decision(spec, "bob") == "denied"


def test_plannable_keeps_built_ins_and_drops_what_the_caller_may_not_run(enabled):
    registry = [BUILTIN, piece("mine", owner="bob"), piece("theirs"), piece("ok", visibility="public", approved=True)]
    assert [s["id"] for s in plannable(registry, "bob")] == ["b1", "mine", "ok"]


# --- plan steps and the submit-time check ----------------------------------

def plan_for(spec):
    return build_plan_json([spec])


def test_a_plan_step_records_the_piece_owner_and_source_hash(enabled):
    (step,) = plan_for(piece(visibility="shared"))["steps"]
    assert step["python_source"] == CODE
    assert step["stored_source"] == {
        "spec_id": "p1", "owner_username": "alice", "visibility": "shared",
        "sha256": source_sha256(CODE), "approved": False,
    }


def test_built_in_steps_carry_no_stored_source():
    (step,) = plan_for(BUILTIN)["steps"]
    assert "python_source" not in step and "stored_source" not in step
    assert check_plan(plan_for(BUILTIN), [BUILTIN], None) == []


def test_owner_may_submit_their_own_plan(enabled):
    spec = piece()
    assert check_plan(plan_for(spec), [spec], "alice") == []


def test_a_plan_handed_to_another_user_is_refused(enabled):
    spec = piece(visibility="shared")
    problems = check_plan(plan_for(spec), [spec], "bob")
    assert problems == [{"code": "STORED_SOURCE_NOT_PERMITTED", "transform_spec_id": "p1"}]


def test_opt_in_lets_the_user_who_gave_it_submit(enabled):
    spec = piece(visibility="shared")
    assert check_plan(plan_for(spec), [spec], "bob", ["p1"]) == []


def test_a_source_changed_after_planning_is_refused(enabled):
    spec = piece()
    plan = plan_for(spec)
    spec["parameters_schema_json"]["metadata"]["source"]["code"] = CODE + "import os\n"
    assert check_plan(plan, [spec], "alice")[0]["code"] == "STORED_SOURCE_CHANGED"


def test_a_tampered_step_is_refused(enabled):
    spec = piece()
    plan = plan_for(spec)
    plan["steps"][0]["python_source"] = CODE + "import os\n"
    assert check_plan(plan, [spec], "alice")[0]["code"] == "STORED_SOURCE_CHANGED"


def test_a_piece_the_submitter_cannot_see_is_refused(enabled):
    assert check_plan(plan_for(piece()), [], "alice")[0]["code"] == "STORED_SOURCE_PIECE_NOT_VISIBLE"


def test_everything_is_refused_while_the_switch_is_off():
    spec = piece()
    monkey_plan = {"steps": [{"transform_spec_id": "p1", "python_source": CODE,
                              "stored_source": {"sha256": source_sha256(CODE)}}]}
    assert check_plan(monkey_plan, [spec], "alice")[0]["code"] == "STORED_SOURCE_DISABLED"


def test_stored_steps_are_found_under_input_stages_too():
    plan = {"steps": [{"python_source": "a"}],
            "inputs": [{"steps": [{"python_source": "b"}, {"transform_type": "unit_convert"}]}]}
    assert sorted(s["python_source"] for s in iter_stored_steps(plan)) == ["a", "b"]


# --- pipeline args ----------------------------------------------------------

def step(env_from_args, declared=()):
    return {"step": 0, "transform_type": "etl_process", "name": "custom", "python_source": CODE,
            "env_from_args": env_from_args,
            "parameters_schema_json": {"properties": {k: {"type": "string"} for k in declared}}}


def test_allowed_args_are_the_token_the_source_and_declared_arguments():
    allowed = allowed_args(step({}, declared=("lat", "signal_token")), tapis._INPUT_SECRET_PARAMS)
    assert allowed == {"tapis_token", "source_uri", "lat"}


@pytest.mark.parametrize("arg", ["signal_token", "token_fetch_token", "credentials_url", "ckan_token", "undeclared"])
def test_stored_code_cannot_bind_other_secrets_or_undeclared_args(arg):
    with pytest.raises(ValueError, match="stored-source pieces may not bind"):
        tapis.generate_tapis_workflow({"id": "p", "plan_json": {"steps": [step({"X": arg})]}})


def test_stored_code_may_bind_its_token_source_and_declared_args():
    pipeline = tapis.generate_tapis_workflow({"id": "p", "plan_json": {"steps": [
        step({"TAPIS_TOKEN": "tapis_token", "SOURCE_URI": "source_uri", "LAT": "lat"}, declared=("lat",))]}})
    task = next(t for t in pipeline["tasks"] if t["type"] == "function" and "LAT" in (t.get("input") or {}))
    assert set(task["input"]) >= {"TAPIS_TOKEN", "SOURCE_URI", "LAT"}


def test_built_in_steps_keep_their_bindings():
    tapis.generate_tapis_workflow({"id": "p", "plan_json": {"steps": [
        {"step": 0, "transform_type": "unit_convert", "name": "u", "env_from_args": {"X": "anything"}}]}})


# --- routes -----------------------------------------------------------------

CONTRACTS = [{"role": "input", "standard_variable_uri": "https://example.org/a"},
             {"role": "output", "standard_variable_uri": "https://example.org/b"}]


def register(name="stored", source=True):
    body = {"name": name, "method": "tapis_function", "contracts": CONTRACTS}
    if source:
        body["metadata"] = {"source": {"language": "python", "code": CODE}}
    else:
        body["transform_type"] = "unit_convert"
    return client.post("/transform-specs", json=body).json()["id"]


def planning_ids(token="tok"):
    return {s["id"] for s in asyncio.run(main_module._registry(get_client(token)))}


def test_listing_shows_stored_source_pieces_but_planning_leaves_them_out():
    stored, builtin = register(), register("builtin", source=False)
    assert {stored, builtin} <= {s["id"] for s in client.get("/transform-specs").json()}
    assert planning_ids() == {builtin}


def test_planning_includes_an_approved_piece_once_the_switch_is_on(enabled, monkeypatch):
    as_user(monkeypatch, "bob")
    stored = register()
    assert stored not in planning_ids()
    client.put("/admin/transform-spec-approval", json={"spec_id": stored, "approved": True})
    assert stored in planning_ids()


def test_planning_includes_the_callers_own_piece(enabled, monkeypatch):
    as_user(monkeypatch, "alice")
    stored = register()
    STORE.transform_spec[stored]["owner_username"] = "alice"
    STORE.transform_spec[stored]["visibility"] = "private"
    assert stored in planning_ids()
    main_module._CALLER_CACHE.clear()
    as_user(monkeypatch, "bob")
    assert stored not in planning_ids()


def test_caller_lookup_is_cached_per_token(enabled, monkeypatch):
    calls = []
    monkeypatch.setattr(tapis, "userinfo_username", lambda token: calls.append(token) or "alice")
    register()
    planning_ids("tok-1"); planning_ids("tok-1"); planning_ids("tok-2")
    assert calls == ["tok-1", "tok-2"]


def insert_plan(spec):
    STORE.plan["plan-1"] = {"id": "plan-1", "status": "draft", "plan_json": build_plan_json([spec])}
    return "plan-1"


def test_submit_refuses_stored_source_while_the_switch_is_off():
    stored = register()
    plan_id = insert_plan(STORE.transform_spec[stored])
    resp = client.post("/workflows/submit", json={"plan_id": plan_id, "dry_run": True},
                       headers={"Authorization": "Bearer tok"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "STORED_SOURCE_REFUSED"
    assert resp.json()["detail"]["problems"][0]["code"] == "STORED_SOURCE_DISABLED"


def test_submit_refuses_another_users_plan_and_logs_nothing(enabled, monkeypatch):
    stored = register()
    STORE.transform_spec[stored].update(owner_username="alice", visibility="shared")
    plan_id = insert_plan(STORE.transform_spec[stored])
    as_user(monkeypatch, "bob")
    resp = client.post("/workflows/submit", json={"plan_id": plan_id, "dry_run": True},
                       headers={"Authorization": "Bearer bobs-token"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["problems"][0]["code"] == "STORED_SOURCE_NOT_PERMITTED"
    assert not any(e.get("event_type") == "stored_source_run" for e in STORE.provenance)


def test_an_opt_in_does_not_transfer_to_another_submitter(enabled, monkeypatch):
    stored = register()
    STORE.transform_spec[stored].update(owner_username="alice", visibility="shared")
    plan_id = insert_plan(STORE.transform_spec[stored])
    STORE.plan[plan_id]["plan_json"]["stored_source_opt_in"] = {"username": "bob", "piece_ids": [stored]}
    as_user(monkeypatch, "carol")
    resp = client.post("/workflows/submit", json={"plan_id": plan_id, "dry_run": True},
                       headers={"Authorization": "Bearer carols-token"})
    assert resp.status_code == 403


def test_piece_test_endpoint_applies_the_same_rule(enabled, monkeypatch):
    stored = register()
    STORE.transform_spec[stored].update(owner_username="alice", visibility="shared")
    as_user(monkeypatch, "bob")
    headers = {"Authorization": "Bearer bobs-token"}
    refused = client.post(f"/transform-specs/{stored}/test", json={"dry_run": True}, headers=headers)
    assert refused.status_code == 403
    assert refused.json()["detail"]["code"] == "STORED_SOURCE_NOT_PERMITTED"
    allowed = client.post(f"/transform-specs/{stored}/test",
                          json={"dry_run": True, "allow_unapproved": True}, headers=headers)
    assert allowed.status_code == 200


def test_piece_test_endpoint_still_runs_built_ins():
    builtin = register("builtin", source=False)
    assert client.post(f"/transform-specs/{builtin}/test", json={"dry_run": True}).status_code == 200
