"""Checking a flow before it is registered, and planning a stored flow."""
from __future__ import annotations

import os

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main as main_module  # noqa: E402
from app import tapis  # noqa: E402
from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)
V = "https://example.org/"
AUTH = {"Authorization": "Bearer tok"}
CODE = "def run(inputs):\n    return 'tapis://sys/out'\n"


@pytest.fixture(autouse=True)
def fresh():
    client.post("/admin/reset")
    main_module._CALLER_CACHE.clear()


def register(name, inputs, outputs, *, settings_=(), stored=False):
    body = {"name": name, "method": "tapis_function", "contracts": [
        *({"role": "input", "standard_variable_uri": V + i} for i in inputs),
        *({"role": "output", "standard_variable_uri": V + o} for o in outputs)],
        "parameters_schema_json": {"properties": {s: {"type": "string"} for s in settings_}},
        "env_from_args": {"TAPIS_TOKEN": "tapis_token", **{s.upper(): s for s in settings_}}}
    if stored:
        body["metadata"] = {"source": {"language": "python", "code": CODE, "entrypoint": "run"}}
    else:
        body["transform_type"] = "unit_convert"
    response = client.post("/transform-specs", json=body)
    assert response.status_code == 200, response.text
    return response.json()["id"]


def data_object(variable, uri):
    return client.post("/data-objects", json={
        "label": variable, "resource_uri": uri, "format": "directory",
        "variables": [{"standard_variable_uri": V + variable}]}).json()["id"]


def from_input(name, to):
    return {"to": {"input": to}, "from": {"flow_input": name}}


def from_step(source, output, to):
    return {"to": {"input": to}, "from": {"step": source, "output": output}}


@pytest.fixture
def pieces():
    return {
        "ingest": register("ingest", ["corpus"], ["clean"]),
        "score": register("score", ["clean", "lexicon"], ["counts"], settings_=["top_n"]),
        "report": register("report", ["counts", "clean"], ["report"], settings_=["title"]),
    }


def stored_flow(pieces, monkeypatch, **over):
    """Stand in for the catalog: the flow a configuration would hold."""
    flow = {
        "configuration_id": "cfg-1", "label": "dictionary", "parameters": [],
        "outputs": [{"step": 3, "output": 1}], "thread_bindings": {},
    }
    if "steps" not in over:
        flow["steps"] = [
            {"position": 1, "etl_process_id": pieces["ingest"], "settings": {}, "wires": [from_input("in:corpus", 1)]},
            {"position": 2, "etl_process_id": pieces["score"], "settings": {"top_n": "25"},
             "wires": [from_step(1, 1, 1), from_input("in:lexicon", 2)]},
            {"position": 3, "etl_process_id": pieces["report"], "settings": {"title": "Dictionary"},
             "wires": [from_step(2, 1, 1), from_step(1, 1, 2)], "pause_after": False},
        ]
    flow.update(over)

    async def load(h, configuration_id):
        return flow if configuration_id == "cfg-1" else None
    monkeypatch.setattr(main_module, "_load_flow", load)
    return flow


def bound():
    return {"in:corpus": data_object("corpus", "tapis://sys/docs"),
            "in:lexicon": data_object("lexicon", "tapis://sys/lexicon.csv")}


def plan(inputs=None, **over):
    return client.post("/plans/flow", headers=AUTH, json={
        "flow_id": "cfg-1", "inputs": bound() if inputs is None else inputs, **over})


# --- checking a flow before it is registered ----------------------------------

def check(steps, inputs=("corpus", "lexicon")):
    return client.post("/flows/check", headers=AUTH, json={
        "inputs": [{"id": "in:" + name, "contract": {"standard_variable_uri": V + name}} for name in inputs],
        "steps": steps}).json()


def test_a_flow_that_fits_checks_out_and_describes_its_pieces(pieces):
    result = check([
        {"position": 1, "etl_process_id": pieces["ingest"], "wires": [from_input("in:corpus", 1)]},
        {"position": 2, "etl_process_id": pieces["score"], "wires": [from_step(1, 1, 1), from_input("in:lexicon", 2)]},
    ])
    assert result["ok"] is True and result["problems"] == []
    assert result["depends_on"] == {"1": [], "2": [1]}
    assert result["pieces"][pieces["score"]] == {
        "inputs": [1, 2], "outputs": [1], "settings": ["top_n"], "values": []}


def test_a_check_reports_each_problem_with_its_step_and_link(pieces):
    result = check([
        {"position": 1, "etl_process_id": pieces["ingest"], "wires": [from_input("in:lexicon", 1)]},
        {"position": 2, "etl_process_id": "no-such-piece", "wires": []},
    ])
    assert result["ok"] is False
    assert [(p["code"], p["step"]) for p in result["problems"]] == [
        ("FLOW_WIRE_DOES_NOT_FIT", 1), ("FLOW_STEP_EMPTY", 2)]
    assert result["problems"][0]["wire"] == 0


def test_a_check_never_lists_managed_or_secret_arguments_as_settings():
    piece = register("p", ["corpus"], ["clean"], settings_=["top_n", "tapis_base_url", "ckan_token"])
    result = check([{"position": 1, "etl_process_id": piece, "wires": [from_input("in:corpus", 1)]}])
    assert result["pieces"][piece]["settings"] == ["top_n"]


# --- planning a stored flow ---------------------------------------------------

def test_a_flow_is_planned_as_its_graph(pieces, monkeypatch):
    stored_flow(pieces, monkeypatch)
    response = plan()
    assert response.status_code == 200, response.text
    plan_json = response.json()["plan_json"]
    steps = plan_json["steps"]
    assert [(s["step"], s["name"], s["depends_on"]) for s in steps] == [
        (1, "ingest", []), (2, "score", [1]), (3, "report", [1, 2])]
    assert steps[1]["wires"] == [
        {"to": {"input": 1}, "from": {"step": 1, "output": 1}},
        {"to": {"input": 2}, "from": {"arg": "source_uri_2"}}]
    assert steps[0]["flow_outputs"] == {"outputs": [1], "values": []}
    assert plan_json["flow"]["configuration_id"] == "cfg-1"
    assert [(i["input_id"], i["arg"]) for i in plan_json["flow"]["inputs"]] == [
        ("in:corpus", "source_uri"), ("in:lexicon", "source_uri_2")]


def test_each_flow_input_is_filled_in_from_its_data_object(pieces, monkeypatch):
    stored_flow(pieces, monkeypatch)
    parameters = {p["name"]: p for p in plan().json()["plan_json"]["parameters"]}
    assert parameters["source_uri"]["default"] == "tapis://sys/docs"
    assert parameters["source_uri_2"]["default"] == "tapis://sys/lexicon.csv"
    for name in ("source_uri", "source_uri_2"):
        assert parameters[name]["managed"] is True and parameters[name]["required"] is False


def test_a_flows_settings_become_defaults(pieces, monkeypatch):
    stored_flow(pieces, monkeypatch)
    parameters = {p["name"]: p for p in plan().json()["plan_json"]["parameters"]}
    assert (parameters["top_n"]["default"], parameters["top_n"]["required"]) == ("25", False)
    assert parameters["title"]["default"] == "Dictionary"


def test_the_planned_flow_becomes_a_wired_pipeline(pieces, monkeypatch):
    stored_flow(pieces, monkeypatch)
    body = plan().json()
    pipeline = tapis.generate_tapis_workflow({"id": body["plan_id"], "plan_json": body["plan_json"]})
    tasks = {task["id"]: task for task in pipeline["tasks"]}
    report = tasks["step-3-unit_convert"]
    assert report["depends_on"] == [{"id": "step-1-unit_convert"}, {"id": "step-2-unit_convert"}]
    assert report["input"]["SOURCE_1"]["value_from"] == {
        "task_output": {"task_id": "step-2-unit_convert", "output_id": "result"}}
    assert report["input"]["SOURCE_2"]["value_from"] == {
        "task_output": {"task_id": "step-1-unit_convert", "output_id": "result"}}
    assert tasks["step-2-unit_convert"]["input"]["SOURCE_2"]["value_from"] == {"args": "source_uri_2"}
    assert pipeline["params"]["source_uri_2"]["default"] == "tapis://sys/lexicon.csv"


def test_a_configuration_that_is_not_a_flow_is_refused(pieces, monkeypatch):
    stored_flow(pieces, monkeypatch)
    response = client.post("/plans/flow", headers=AUTH, json={"flow_id": "a-model", "inputs": {}})
    assert response.status_code == 422 and response.json()["detail"]["code"] == "FLOW_NOT_FOUND"


def test_every_input_the_flow_reads_needs_a_data_object(pieces, monkeypatch):
    stored_flow(pieces, monkeypatch)
    response = plan({"in:corpus": data_object("corpus", "tapis://sys/docs")})
    assert response.status_code == 422
    assert response.json()["detail"] == {
        "code": "FLOW_INPUT_NOT_BOUND", "inputs": ["in:lexicon"],
        "message": "the flow needs a data object for each of these inputs"}
    missing = plan({"in:corpus": "nope", "in:lexicon": data_object("lexicon", "tapis://sys/l")})
    assert missing.status_code == 404 and missing.json()["detail"]["code"] == "DATA_OBJECT_NOT_FOUND"


def test_data_that_does_not_fit_the_flows_input_is_refused(pieces, monkeypatch):
    stored_flow(pieces, monkeypatch)
    response = plan({"in:corpus": data_object("lexicon", "tapis://sys/wrong"),
                     "in:lexicon": data_object("lexicon", "tapis://sys/l")})
    detail = response.json()["detail"]
    assert response.status_code == 422 and detail["code"] == "FLOW_DOES_NOT_CHECK_OUT"
    assert [(p["code"], p["step"], p["wire"]) for p in detail["problems"]] == [("FLOW_WIRE_DOES_NOT_FIT", 1, 0)]


def test_a_flow_whose_piece_was_deleted_is_refused(pieces, monkeypatch):
    flow = stored_flow(pieces, monkeypatch)
    flow["steps"][1]["etl_process_id"] = None
    detail = plan().json()["detail"]
    assert detail["code"] == "FLOW_DOES_NOT_CHECK_OUT"
    assert ("FLOW_STEP_EMPTY", 2) in [(p["code"], p["step"]) for p in detail["problems"]]


def test_a_flow_may_not_set_an_argument_the_adapter_manages(monkeypatch):
    piece = register("p", ["corpus"], ["clean"], settings_=["tapis_base_url"])
    stored_flow({"ingest": piece, "score": piece, "report": piece}, monkeypatch, steps=[
        {"position": 1, "etl_process_id": piece, "settings": {"tapis_base_url": "https://evil.example"},
         "wires": [from_input("in:corpus", 1)]}], outputs=[])
    detail = plan({"in:corpus": data_object("corpus", "tapis://sys/docs")}).json()["detail"]
    assert [p["code"] for p in detail["problems"]] == ["FLOW_SETTING_REFUSED"]


def test_two_steps_may_not_disagree_on_a_setting_they_share(monkeypatch):
    piece = register("p", ["corpus"], ["corpus"], settings_=["top_n"])
    stored_flow({}, monkeypatch, outputs=[], steps=[
        {"position": 1, "etl_process_id": piece, "settings": {"top_n": "5"}, "wires": [from_input("in:corpus", 1)]},
        {"position": 2, "etl_process_id": piece, "settings": {"top_n": "9"}, "wires": [from_step(1, 1, 1)]}])
    detail = plan({"in:corpus": data_object("corpus", "tapis://sys/docs")}).json()["detail"]
    assert (detail["code"], detail["settings"]) == ("FLOW_SETTING_CONFLICT", ["top_n"])


def test_a_flow_with_no_dataset_input_plans_with_no_data_object(monkeypatch):
    piece = register("run", [], ["archive"], settings_=["start_date"])
    stored_flow({}, monkeypatch, outputs=[{"step": 1, "output": 1}], steps=[
        {"position": 1, "etl_process_id": piece, "settings": {"start_date": "2024-01-01"}, "wires": []}])
    response = plan({})
    assert response.status_code == 200, response.text
    assert response.json()["plan_json"]["flow"]["inputs"] == []


def test_a_flow_does_not_let_a_user_run_a_piece_they_may_not(monkeypatch):
    # A flow only names pieces. The piece is still checked for whoever plans it.
    monkeypatch.setattr(settings, "stored_source_enabled", False)
    piece = register("stored", ["corpus"], ["clean"], stored=True)
    stored_flow({}, monkeypatch, outputs=[], steps=[
        {"position": 1, "etl_process_id": piece, "settings": {}, "wires": [from_input("in:corpus", 1)]}])
    response = plan({"in:corpus": data_object("corpus", "tapis://sys/docs")})
    assert response.status_code == 403
    assert response.json()["detail"]["problems"][0]["code"] == "STORED_SOURCE_DISABLED"


def test_checking_or_planning_a_flow_needs_a_signed_in_caller(monkeypatch):
    import asyncio
    monkeypatch.setattr(settings, "demo_mode", False)
    monkeypatch.setattr("app.main.tapis.userinfo_username", lambda token: "alice" if token == "good" else None)
    main_module._CALLER_CACHE.clear()
    assert asyncio.run(main_module._require_signed_in("good")) == "alice"
    for token in (None, "unknown"):
        with pytest.raises(Exception) as caught:
            asyncio.run(main_module._require_signed_in(token))
        assert getattr(caught.value, "status_code", None) == 401
    main_module._CALLER_CACHE.clear()


# --- what a flow's author may not do to whoever runs it ------------------------

def submit(plan_id, **body):
    return client.post("/workflows/submit", headers=AUTH, json={"plan_id": plan_id, **body})


def test_a_flows_defaults_are_marked_and_need_the_submitters_acceptance(pieces, monkeypatch):
    stored_flow(pieces, monkeypatch)
    body = plan().json()
    parameters = {p["name"]: p for p in body["plan_json"]["parameters"]}
    assert parameters["top_n"]["default_source"] == "flow"
    assert "default_source" not in parameters["source_uri"]
    refused = submit(body["plan_id"])
    detail = refused.json()["detail"]
    assert refused.status_code == 422 and detail["code"] == "FLOW_SETTINGS_NOT_ACCEPTED"
    assert detail["defaults"] == {"top_n": "25", "title": "Dictionary"} and detail["links"] == []


def test_a_value_the_submitter_sends_needs_no_acceptance(pieces, monkeypatch):
    stored_flow(pieces, monkeypatch)
    plan_json = plan().json()["plan_json"]
    own = main_module._unaccepted_flow_settings(plan_json, {"top_n": "9", "title": {"value": "Mine"}})
    assert own == {"defaults": {}, "links": []}
    partly = main_module._unaccepted_flow_settings(plan_json, {"top_n": "9"})
    assert partly["defaults"] == {"title": "Dictionary"}


def test_accepting_the_flows_settings_lets_the_submission_through(pieces, monkeypatch):
    stored_flow(pieces, monkeypatch)
    body = plan().json()
    assert submit(body["plan_id"], dry_run=True).status_code == 200
    gate = main_module._unaccepted_flow_settings(body["plan_json"], {})
    assert gate["defaults"]  # there is something to accept, and a chain plan has none:
    assert main_module._unaccepted_flow_settings({"parameters": body["plan_json"]["parameters"]}, {}) == {
        "defaults": {}, "links": []}


def test_a_setting_linked_from_an_earlier_step_is_listed_for_acceptance(monkeypatch):
    first = client.post("/transform-specs", json={
        "name": "resolve", "method": "tapis_function", "transform_type": "unit_convert",
        "contracts": [{"role": "output", "standard_variable_uri": V + "archive"}],
        "parameters_schema_json": {"properties": {}, "value_outputs": [{"name": "manifest_name"}]}}).json()["id"]
    second = register("publish", ["archive"], [], settings_=["manifest_name"])
    link = {"to": {"setting": "manifest_name"}, "from": {"step": 1, "value": "manifest_name"}}
    stored_flow({}, monkeypatch, outputs=[], steps=[
        {"position": 1, "etl_process_id": first, "settings": {}, "wires": []},
        {"position": 2, "etl_process_id": second, "settings": {}, "wires": [from_step(1, 1, 1), link]}])
    response = plan({})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["plan_json"]["flow"]["linked_settings"] == [
        {"step": 2, "setting": "manifest_name", "from": {"step": 1, "value": "manifest_name"}}]
    detail = submit(body["plan_id"]).json()["detail"]
    assert detail["code"] == "FLOW_SETTINGS_NOT_ACCEPTED" and len(detail["links"]) == 1


def test_a_flow_that_cannot_be_built_into_a_pipeline_is_refused_at_plan_time(monkeypatch):
    resolve = client.post("/transform-specs", json={
        "name": "resolve", "method": "tapis_function", "transform_type": "unit_convert",
        "contracts": [{"role": "output", "standard_variable_uri": V + "archive"}],
        "parameters_schema_json": {"properties": {}, "value_outputs": [{"name": "manifest_name"}]}}).json()["id"]
    # Declares the setting but reads it through no task input.
    publish = client.post("/transform-specs", json={
        "name": "publish", "method": "tapis_function", "transform_type": "unit_convert",
        "contracts": [{"role": "input", "standard_variable_uri": V + "archive"}],
        "parameters_schema_json": {"properties": {"manifest_name": {"type": "string"}}}}).json()["id"]
    link = {"to": {"setting": "manifest_name"}, "from": {"step": 1, "value": "manifest_name"}}
    stored_flow({}, monkeypatch, outputs=[], steps=[
        {"position": 1, "etl_process_id": resolve, "settings": {}, "wires": []},
        {"position": 2, "etl_process_id": publish, "settings": {}, "wires": [from_step(1, 1, 1), link]}])
    response = plan({})
    assert response.status_code == 422 and response.json()["detail"]["code"] == "FLOW_DOES_NOT_BUILD"


def test_another_users_private_piece_is_an_empty_step_and_nothing_about_it_is_reported(pieces, monkeypatch):
    stored_flow(pieces, monkeypatch)
    real = main_module._registry

    async def registry(h, **kwargs):
        rows = await real(h, **kwargs)
        return [{**row, "visibility": "private", "owner_username": "someone-else"}
                if row.get("name") == "score" else row for row in rows]
    monkeypatch.setattr(main_module, "_registry", registry)
    detail = plan().json()["detail"]
    assert detail["code"] == "FLOW_DOES_NOT_CHECK_OUT"
    assert ("FLOW_STEP_EMPTY", 2) in [(p["code"], p["step"]) for p in detail["problems"]]
    assert "score" not in str(detail) and pieces["score"] not in str(detail)


def test_a_piece_that_runs_as_a_tapis_app_cannot_be_a_flow_step_yet(monkeypatch):
    app_piece = client.post("/transform-specs", json={
        "name": "app", "method": "tapis_job", "tapis_app_id": "some-app", "transform_type": "custom",
        "contracts": [{"role": "input", "standard_variable_uri": V + "corpus"},
                      {"role": "output", "standard_variable_uri": V + "clean"}]}).json()["id"]
    stored_flow({}, monkeypatch, outputs=[], steps=[
        {"position": 1, "etl_process_id": app_piece, "settings": {}, "wires": [from_input("in:corpus", 1)]}])
    detail = plan({"in:corpus": data_object("corpus", "tapis://sys/docs")}).json()["detail"]
    assert (detail["code"], detail["steps"]) == ("FLOW_NOT_SUPPORTED", [1])


def test_a_stored_flow_with_values_of_the_wrong_kind_is_refused_not_a_server_error(pieces, monkeypatch):
    flow = stored_flow(pieces, monkeypatch)
    flow["steps"][1]["wires"] = [{"to": {"input": True}, "from": {"flow_input": []}}, None]
    flow["steps"].append("nope")
    response = plan()
    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "FLOW_DOES_NOT_CHECK_OUT"
