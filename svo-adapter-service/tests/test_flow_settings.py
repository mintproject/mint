"""A flow's settings: the pieces' description of each, and what the author decided.

Covers the piece summary a flow builder reads, the check that refuses a setting nobody
can give a value, and the run-time order: fixed value, runner's value, author's default,
piece's default, with a runner's value for a fixed or hidden setting refused.
"""
from __future__ import annotations

import os

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import flow_settings  # noqa: E402
from app import main as main_module  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)
V = "https://example.org/"
AUTH = {"Authorization": "Bearer tok"}

MATCH_MODE = {
    "type": "string", "title": "How terms are counted", "description": "Counting rule.",
    "default": "auto",
    "oneOf": [
        {"const": "auto", "title": "Automatic", "description": "Words and phrases."},
        {"const": "longest_match", "title": "Longest match", "description": "No double counting."},
    ],
}
MAX_FILES = {"type": "integer", "title": "Most files", "minimum": 1, "maximum": 500,
             "default": 200, "x-advanced": True}
COLOUR = {"type": "string", "enum": ["red", "green"]}


@pytest.fixture(autouse=True)
def fresh():
    client.post("/admin/reset")
    main_module._CALLER_CACHE.clear()


def register(name, properties, required=()):
    response = client.post("/transform-specs", json={
        "name": name, "method": "tapis_function", "transform_type": "unit_convert",
        "contracts": [{"role": "input", "standard_variable_uri": V + "corpus"},
                      {"role": "output", "standard_variable_uri": V + "clean"}],
        "parameters_schema_json": {"properties": properties, "required": list(required)},
        "env_from_args": {"TAPIS_TOKEN": "tapis_token", **{key.upper(): key for key in properties}}})
    assert response.status_code == 200, response.text
    return response.json()["id"]


def stored_flow(piece, monkeypatch, *, settings=None, step_settings=None, wires=None):
    flow = {
        "configuration_id": "cfg-1", "label": "dictionary", "parameters": [],
        "outputs": [{"step": 1, "output": 1}], "thread_bindings": {}, "settings": settings or {},
        "steps": [{"position": 1, "etl_process_id": piece, "settings": step_settings or {},
                   "wires": wires if wires is not None else [
                       {"to": {"input": 1}, "from": {"flow_input": "in:corpus"}}]}],
    }

    async def load(h, configuration_id):
        return flow if configuration_id == "cfg-1" else None
    monkeypatch.setattr(main_module, "_load_flow", load)


def plan():
    corpus = client.post("/data-objects", json={
        "label": "corpus", "resource_uri": "tapis://sys/docs", "format": "directory",
        "variables": [{"standard_variable_uri": V + "corpus"}]}).json()["id"]
    return client.post("/plans/flow", headers=AUTH, json={"flow_id": "cfg-1", "inputs": {"in:corpus": corpus}})


def parameters_of(response):
    assert response.status_code == 200, response.text
    return {p["name"]: p for p in response.json()["plan_json"]["parameters"]}


def submit(plan_id, **body):
    return client.post("/workflows/submit", headers=AUTH, json={
        "plan_id": plan_id, "accept_flow_settings": True, "dry_run": True, **body})


def check(piece, settings=None, step_settings=None):
    return client.post("/flows/check", headers=AUTH, json={
        "inputs": [{"id": "in:corpus", "contract": {"standard_variable_uri": V + "corpus"}}],
        "steps": [{"position": 1, "etl_process_id": piece, "settings": step_settings or {},
                   "wires": [{"to": {"input": 1}, "from": {"flow_input": "in:corpus"}}]}],
        **({"settings": settings} if settings is not None else {})}).json()


# --- describing a setting --------------------------------------------------------

def test_a_setting_is_described_by_what_its_schema_says():
    assert flow_settings.describe(MATCH_MODE) == {
        "type": "string", "title": "How terms are counted", "description": "Counting rule.",
        "default": "auto", "choices": [
            {"value": "auto", "title": "Automatic", "description": "Words and phrases."},
            {"value": "longest_match", "title": "Longest match", "description": "No double counting."}]}
    assert flow_settings.describe(MAX_FILES) == {
        "type": "integer", "title": "Most files", "minimum": 1, "maximum": 500, "default": 200,
        "advanced": True}


def test_a_plain_enum_gives_choices_without_explanations():
    assert flow_settings.describe(COLOUR) == {
        "type": "string", "choices": [{"value": "red"}, {"value": "green"}]}


def test_an_older_schema_is_described_as_it_always_was():
    assert flow_settings.describe({"type": "string", "description": "d"}) == {
        "type": "string", "description": "d"}
    assert flow_settings.describe(None) == {} and flow_settings.describe("x") == {}


def test_the_piece_summary_passes_the_description_through():
    piece = register("score", {"match_mode": MATCH_MODE, "max_files": MAX_FILES, "colour": COLOUR,
                               "top_n": {"type": "string", "description": "old style"}})
    details = check(piece)["pieces"][piece]["setting_details"]
    assert details["match_mode"]["title"] == "How terms are counted"
    assert details["match_mode"]["choices"][1] == {
        "value": "longest_match", "title": "Longest match", "description": "No double counting."}
    assert details["max_files"] == {
        "type": "integer", "title": "Most files", "minimum": 1, "maximum": 500, "default": 200,
        "advanced": True}
    assert details["colour"]["choices"] == [{"value": "red"}, {"value": "green"}]
    assert details["top_n"] == {"type": "string", "description": "old style"}


# --- the flow check ------------------------------------------------------------

def test_a_hidden_setting_the_piece_requires_needs_a_value():
    piece = register("score", {"mode": {"type": "string"}}, required=["mode"])
    refused = check(piece, {"mode": {"visibility": "hidden"}})
    assert refused["ok"] is False
    assert [(p["code"], p["step"]) for p in refused["problems"]] == [
        ("FLOW_SETTING_HIDDEN_WITHOUT_VALUE", 1)]
    assert check(piece, {"mode": {"visibility": "shown"}})["ok"] is True
    assert check(piece, {"mode": {"visibility": "hidden"}}, {"mode": "a"})["ok"] is True


def test_a_hidden_setting_with_a_piece_default_or_that_is_not_required_is_fine():
    piece = register("score", {"mode": {"type": "string", "default": "auto"}, "extra": {"type": "string"}},
                     required=["mode"])
    assert check(piece, {"mode": {"visibility": "hidden"}, "extra": {"visibility": "hidden"}})["ok"] is True


def test_a_fixed_setting_needs_something_to_fix_it_to():
    piece = register("score", {"mode": {"type": "string"}})
    refused = check(piece, {"mode": {"fixed": True}})
    assert [p["code"] for p in refused["problems"]] == ["FLOW_SETTING_FIXED_WITHOUT_VALUE"]
    assert check(piece, {"mode": {"fixed": True}}, {"mode": "a"})["ok"] is True


@pytest.mark.parametrize("settings", [
    {"nope": {"visibility": "shown"}}, {"mode": {"visibility": "secret"}}, {"mode": {"fixed": "yes"}},
    {"mode": {"colour": 1}}, {"mode": "hidden"}])
def test_the_authors_decisions_must_be_well_formed(settings):
    piece = register("score", {"mode": {"type": "string"}})
    result = check(piece, settings)
    assert result["ok"] is False
    assert {p["code"] for p in result["problems"]} == {"FLOW_SETTING_INVALID"}


def test_a_check_with_no_settings_is_unchanged():
    piece = register("score", {"mode": {"type": "string"}}, required=["mode"])
    assert check(piece)["ok"] is True


# --- running: fixed > runner > author default > piece default ----------------------

def values_used(plan_id, **body):
    response = submit(plan_id, **body)
    assert response.status_code == 200, response.text
    return response


def test_the_plan_says_who_may_see_and_change_each_setting(monkeypatch):
    piece = register("score", {"match_mode": MATCH_MODE, "max_files": MAX_FILES, "colour": COLOUR})
    stored_flow(piece, monkeypatch, settings={
        "colour": {"visibility": "hidden", "fixed": True}}, step_settings={"colour": "green"})
    parameters = parameters_of(plan())
    assert parameters["match_mode"]["visibility"] == "shown"
    assert parameters["max_files"]["visibility"] == "advanced"
    assert (parameters["colour"]["visibility"], parameters["colour"]["fixed"],
            parameters["colour"]["default"]) == ("hidden", True, "green")
    # The form reads the description from the plan too.
    assert parameters["match_mode"]["title"] == "How terms are counted"
    assert parameters["match_mode"]["allowed_values"] == ["auto", "longest_match"]
    assert parameters["match_mode"]["choices"][0]["description"] == "Words and phrases."
    assert parameters["max_files"]["advanced"] is True


def test_the_authors_visibility_beats_the_pieces_hint(monkeypatch):
    piece = register("score", {"max_files": MAX_FILES, "match_mode": MATCH_MODE})
    stored_flow(piece, monkeypatch, settings={
        "max_files": {"visibility": "shown"}, "match_mode": {"visibility": "advanced"}})
    parameters = parameters_of(plan())
    assert (parameters["max_files"]["visibility"], parameters["match_mode"]["visibility"]) == (
        "shown", "advanced")


def test_a_runner_may_not_send_a_fixed_or_a_hidden_setting(monkeypatch):
    piece = register("score", {"match_mode": MATCH_MODE, "max_files": MAX_FILES, "colour": COLOUR})
    stored_flow(piece, monkeypatch, settings={
        "match_mode": {"fixed": True}, "colour": {"visibility": "hidden"}},
        step_settings={"colour": "red"})
    plan_id = plan().json()["plan_id"]
    refused = submit(plan_id, args={"match_mode": "longest_match", "colour": "green", "max_files": 5})
    detail = refused.json()["detail"]
    assert refused.status_code == 422 and detail["code"] == "FLOW_SETTING_REFUSED"
    assert (detail["fixed"], detail["hidden"], detail["arguments"]) == (
        ["match_mode"], ["colour"], ["colour", "match_mode"])
    # Also when the value is sent the way SUBSIDE sends it.
    wrapped = submit(plan_id, args={"colour": {"value": "green"}})
    assert wrapped.status_code == 422 and wrapped.json()["detail"]["hidden"] == ["colour"]
    # A setting that is shown or advanced is the runner's to change.
    assert submit(plan_id, args={"max_files": 5}).status_code == 200


def test_a_fixed_value_is_what_the_run_uses(monkeypatch):
    piece = register("score", {"match_mode": MATCH_MODE})
    stored_flow(piece, monkeypatch, settings={"match_mode": {"fixed": True}},
                step_settings={"match_mode": "longest_match"})
    body = plan().json()
    parameter = {p["name"]: p for p in body["plan_json"]["parameters"]}["match_mode"]
    assert (parameter["default"], parameter["fixed"], parameter["default_source"]) == (
        "longest_match", True, "flow")
    assert submit(body["plan_id"]).status_code == 200


def test_a_fixed_setting_with_no_author_value_runs_on_the_pieces_default(monkeypatch):
    piece = register("score", {"match_mode": MATCH_MODE})
    stored_flow(piece, monkeypatch, settings={"match_mode": {"fixed": True}})
    parameter = parameters_of(plan())["match_mode"]
    assert (parameter["default"], parameter["fixed"]) == ("auto", True)
    assert "default_source" not in parameter


def test_the_authors_default_beats_the_pieces_and_the_runner_beats_both(monkeypatch):
    piece = register("score", {"match_mode": MATCH_MODE})
    stored_flow(piece, monkeypatch, step_settings={"match_mode": "longest_match"})
    body = plan().json()
    parameter = {p["name"]: p for p in body["plan_json"]["parameters"]}["match_mode"]
    assert parameter["default"] == "longest_match" and parameter["default_source"] == "flow"
    assert "fixed" not in parameter
    # The runner's own value is accepted, and is checked against the choices.
    assert submit(body["plan_id"], args={"match_mode": "auto"}).status_code == 200
    wrong = submit(body["plan_id"], args={"match_mode": "nonsense"})
    assert wrong.status_code == 422 and wrong.json()["detail"]["code"] == "INVALID_PARAMETERS"


def test_the_pieces_default_is_used_when_nobody_chose(monkeypatch):
    piece = register("score", {"match_mode": MATCH_MODE})
    stored_flow(piece, monkeypatch)
    parameter = parameters_of(plan())["match_mode"]
    assert parameter["default"] == "auto" and "default_source" not in parameter


def test_the_dates_a_thread_fills_in_pass_even_when_hidden():
    plan_json = {
        "flow": {"thread_bindings": {"start_date": {"parameter": "cfg-1_setting_start"}}},
        "parameters": [{"name": "start", "visibility": "hidden"}, {"name": "other", "visibility": "hidden"}]}
    refused = main_module._refused_flow_setting_args(plan_json, {"start": "2020-01-01", "other": "x"})
    assert refused == {"hidden": ["other"]}


def test_a_plan_that_is_not_a_flow_refuses_nothing():
    assert main_module._refused_flow_setting_args(
        {"parameters": [{"name": "x", "fixed": True}]}, {"x": 1}) == {}


# --- what the run form reads --------------------------------------------------------

def test_the_run_form_reads_each_setting_resolved(monkeypatch):
    piece = register("score", {"match_mode": MATCH_MODE, "max_files": MAX_FILES, "colour": COLOUR})
    stored_flow(piece, monkeypatch, settings={"colour": {"visibility": "hidden", "fixed": True}},
                step_settings={"colour": "green", "match_mode": "longest_match"})
    response = client.get("/flows/cfg-1/settings", headers=AUTH)
    assert response.status_code == 200, response.text
    body = response.json()
    by_name = {item["name"]: item for item in body["settings"]}
    assert list(by_name) == ["colour", "match_mode", "max_files"]
    assert by_name["match_mode"]["default"] == "longest_match"
    assert by_name["match_mode"]["visibility"] == "shown"
    assert by_name["match_mode"]["choices"][0]["title"] == "Automatic"
    assert by_name["max_files"]["visibility"] == "advanced" and by_name["max_files"]["minimum"] == 1
    assert (by_name["colour"]["fixed"], by_name["colour"]["visibility"]) == (True, "hidden")
    assert by_name["colour"]["parameter_id"] == "cfg-1_setting_colour"
    assert body["thread_bound"] == []


def test_the_run_form_settings_of_a_configuration_that_is_not_a_flow_are_refused(monkeypatch):
    stored_flow(register("score", {"a": {"type": "string"}}), monkeypatch)
    response = client.get("/flows/a-model/settings", headers=AUTH)
    assert response.status_code == 422 and response.json()["detail"]["code"] == "FLOW_NOT_FOUND"
