"""Planning a chain the caller names (PlanIn.piece_ids) instead of searching for
one, and the duplicate-submission policy on generated pipelines."""
from __future__ import annotations

import os

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main as main_module  # noqa: E402
from app import tapis  # noqa: E402
from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402
from app.store import STORE  # noqa: E402

client = TestClient(app)
V = "https://example.org/"
CODE = "from owe_python_sdk.runtime import execution_context as ctx\nctx.set_output('result', '1')\n"
AUTH = {"Authorization": "Bearer tok"}


@pytest.fixture(autouse=True)
def fresh():
    client.post("/admin/reset")
    main_module._CALLER_CACHE.clear()


def register(name, source, output, *, extra_outputs=(), stored=False):
    body = {"name": name, "method": "tapis_function", "contracts": [
        {"role": "input", "standard_variable_uri": V + source},
        {"role": "output", "standard_variable_uri": V + output},
        *({"role": "output", "standard_variable_uri": V + o} for o in extra_outputs)]}
    if stored:
        body["metadata"] = {"source": {"language": "python", "code": CODE}}
    else:
        body["transform_type"] = "unit_convert"
    return client.post("/transform-specs", json=body).json()["id"]


def data_object(variable="corpus"):
    return client.post("/data-objects", json={
        "label": "docs", "resource_uri": "tapis://sys/docs", "format": "directory",
        "variables": [{"standard_variable_uri": V + variable}]}).json()["id"]


def plan(piece_ids, target="report", source=None, **over):
    return client.post("/plans", headers=AUTH, json={
        "data_object_id": source or data_object(), "piece_ids": piece_ids,
        "target_contract": {"standard_variable_uri": V + target}, **over})


def names(response):
    return [step["name"] for step in response.json()["plan_json"]["steps"]]


# --- the chain that is named is the chain that is planned ---------------------

def test_two_pieces_that_fit_the_same_step_are_told_apart_by_name():
    score = register("score", "corpus", "counts")
    frames = register("frames", "corpus", "counts")
    project = register("project", "counts", "report")
    by_score, by_frames = plan([score, project]), plan([frames, project])
    assert by_score.status_code == by_frames.status_code == 200
    assert names(by_score) == ["score", "project"]
    assert names(by_frames) == ["frames", "project"]
    assert by_score.json()["plan_json"]["piece_ids"] == [score, project]


def test_a_named_chain_is_not_shortened_to_what_a_search_would_find():
    direct = register("direct", "corpus", "report")
    long_a, long_b = register("first", "corpus", "counts"), register("second", "counts", "report")
    assert names(plan([long_a, long_b])) == ["first", "second"]
    assert names(plan([direct])) == ["direct"]


def test_a_catalog_id_resolves_to_its_registry_row():
    spec = register("score", "corpus", "report")
    STORE.transform_spec[spec]["mint_etl_process_id"] = "https://w3id.org/okn/i/mint/etl/score-1"
    assert names(plan(["https://w3id.org/okn/i/mint/etl/score-1"])) == ["score"]


# --- refusals -----------------------------------------------------------------

def test_a_piece_missing_from_the_registry_is_named():
    known = register("score", "corpus", "report")
    resp = plan([known, "https://w3id.org/okn/i/mint/etl/not-synced"])
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "PIECE_NOT_IN_REGISTRY"
    assert resp.json()["detail"]["piece_ids"] == ["https://w3id.org/okn/i/mint/etl/not-synced"]


def test_the_first_step_that_does_not_fit_is_named():
    score, report = register("score", "corpus", "counts"), register("report", "weights", "report")
    resp = plan([score, report])
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert (detail["code"], detail["position"], detail["piece_id"]) == ("PIECE_DOES_NOT_FIT", 1, report)


def test_a_chain_that_fits_but_misses_the_target_is_refused():
    score = register("score", "corpus", "counts")
    resp = plan([score], target="report")
    detail = resp.json()["detail"]
    assert resp.status_code == 422
    assert (detail["code"], detail["position"], detail["piece_id"]) == ("PIECE_DOES_NOT_FIT", 1, None)


def test_an_empty_list_is_a_validation_error():
    assert plan([]).status_code == 422


def test_fit_is_on_the_first_output_only():
    # As in the search: a piece hands on its first output, whatever else it writes.
    first = register("lexicon-first", "corpus", "lexicon", extra_outputs=("counts",))
    second = register("lexicon-second", "corpus", "counts", extra_outputs=("lexicon",))
    assert plan([first], target="lexicon").status_code == 200
    resp = plan([second], target="lexicon")
    assert resp.status_code == 422 and resp.json()["detail"]["position"] == 1


# --- permission is the submit rule, applied at plan time ----------------------

def test_naming_another_users_piece_is_refused_at_plan_time(monkeypatch):
    monkeypatch.setattr(settings, "stored_source_enabled", True)
    monkeypatch.setattr(tapis, "userinfo_username", lambda token: "bob")
    theirs = register("theirs", "corpus", "report", stored=True)
    STORE.transform_spec[theirs].update(owner_username="alice", visibility="shared")
    resp = plan([theirs])
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "STORED_SOURCE_REFUSED"
    assert resp.json()["detail"]["problems"][0]["code"] == "STORED_SOURCE_NOT_PERMITTED"
    # ... unless the caller opts in to that piece by id.
    assert plan([theirs], allow_unapproved_piece_ids=[theirs]).status_code == 200


def test_naming_your_own_piece_is_allowed(monkeypatch):
    monkeypatch.setattr(settings, "stored_source_enabled", True)
    monkeypatch.setattr(tapis, "userinfo_username", lambda token: "alice")
    mine = register("mine", "corpus", "report", stored=True)
    STORE.transform_spec[mine].update(owner_username="alice", visibility="private")
    assert names(plan([mine])) == ["mine"]


def test_stored_code_is_refused_by_name_while_the_switch_is_off():
    stored = register("stored", "corpus", "report", stored=True)
    resp = plan([stored])
    assert resp.status_code == 403
    assert resp.json()["detail"]["problems"][0]["code"] == "STORED_SOURCE_DISABLED"


# --- a second run of a plan must not end the first ------------------------------

def test_generated_pipelines_allow_a_second_run_while_one_is_in_flight():
    score = register("score", "corpus", "report")
    plan_id = plan([score]).json()["plan_id"]
    pipeline = client.post("/workflows/generate", json={"plan_id": plan_id}).json()["tapis_workflow_definition"]
    assert pipeline["execution_profile"]["duplicate_submission_policy"] == "allow"
