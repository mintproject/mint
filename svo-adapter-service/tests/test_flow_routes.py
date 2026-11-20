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
    described = result["pieces"][pieces["score"]]
    assert {key: described[key] for key in ("inputs", "outputs", "settings", "values")} == {
        "inputs": [1, 2], "outputs": [1], "settings": ["top_n"], "values": []}
    assert described["setting_details"] == {"top_n": {"type": "string"}}
    assert described["input_contracts"]["2"] == {"standard_variable_uri": V + "lexicon"}
    assert described["output_contracts"] == {"1": {"standard_variable_uri": V + "counts"}}


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
    assert steps[0]["flow_outputs"] == {"outputs": [1], "values": [], "files": {}}
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


# --- whether this caller could run a stored flow --------------------------------

def availability(flow_id="cfg-1", headers=AUTH):
    return client.get(f"/flows/{flow_id}/availability", headers=headers)


def as_registry(monkeypatch, **by_name):
    """Rewrite the registry rows named here, as the catalog would hold them."""
    real = main_module._registry

    async def registry(h, **kwargs):
        rows = await real(h, **kwargs)
        return [{**row, **by_name[row["name"]]} if row.get("name") in by_name else row for row in rows]
    monkeypatch.setattr(main_module, "_registry", registry)


def test_a_flow_whose_pieces_the_caller_may_run_is_available(pieces, monkeypatch):
    stored_flow(pieces, monkeypatch)
    response = availability()
    assert response.status_code == 200, response.text
    assert response.json() == {"flow_id": "cfg-1", "available": True, "steps": [
        {"position": position, "runnable": True, "reason": None} for position in (1, 2, 3)]}


def test_a_deleted_piece_is_reported_as_missing(pieces, monkeypatch):
    stored_flow(pieces, monkeypatch)
    steps_flow = {"configuration_id": "cfg-1", "label": "x", "parameters": [], "outputs": [],
                  "thread_bindings": {}, "steps": [
                      {"position": 1, "etl_process_id": pieces["ingest"], "settings": {}, "wires": []},
                      {"position": 2, "etl_process_id": None, "settings": {}, "wires": []}]}

    async def load(h, configuration_id):
        return steps_flow
    monkeypatch.setattr(main_module, "_load_flow", load)
    body = availability().json()
    assert body["available"] is False
    assert body["steps"] == [{"position": 1, "runnable": True, "reason": None},
                             {"position": 2, "runnable": False, "reason": "piece_missing"}]


def test_another_users_private_piece_is_missing_and_nothing_about_it_leaks(pieces, monkeypatch):
    stored_flow(pieces, monkeypatch)
    as_registry(monkeypatch, score={"visibility": "private", "owner_username": "someone-else"})
    response = availability()
    body = response.json()
    assert body["available"] is False
    assert [(s["position"], s["reason"]) for s in body["steps"]] == [
        (1, None), (2, "piece_missing"), (3, None)]
    assert "someone-else" not in response.text and "score" not in response.text
    assert pieces["score"] not in response.text


def test_a_public_unapproved_stored_piece_is_not_approved(monkeypatch):
    monkeypatch.setattr(settings, "stored_source_enabled", True)
    piece = register("stored", ["corpus"], ["clean"], stored=True)
    stored_flow({}, monkeypatch, outputs=[], steps=[
        {"position": 1, "etl_process_id": piece, "settings": {}, "wires": []}])
    body = availability().json()
    assert body["available"] is False
    assert body["steps"] == [{"position": 1, "runnable": False, "reason": "not_approved"}]


def test_stored_code_is_reported_as_disabled_when_the_deployment_turns_it_off(monkeypatch):
    monkeypatch.setattr(settings, "stored_source_enabled", False)
    piece = register("stored", ["corpus"], ["clean"], stored=True)
    stored_flow({}, monkeypatch, outputs=[], steps=[
        {"position": 1, "etl_process_id": piece, "settings": {}, "wires": []}])
    assert availability().json()["steps"][0]["reason"] == "stored_source_disabled"


def test_the_callers_own_unapproved_piece_is_runnable(monkeypatch):
    monkeypatch.setattr(settings, "stored_source_enabled", True)
    monkeypatch.setattr("app.main.tapis.userinfo_username", lambda token: "alice")
    piece = register("stored", ["corpus"], ["clean"], stored=True)
    as_registry(monkeypatch, stored={"owner_username": "alice", "visibility": "private"})
    stored_flow({}, monkeypatch, outputs=[], steps=[
        {"position": 1, "etl_process_id": piece, "settings": {}, "wires": []}])
    assert availability().json() == {"flow_id": "cfg-1", "available": True, "steps": [
        {"position": 1, "runnable": True, "reason": None}]}


def test_availability_of_an_unknown_or_non_flow_configuration_is_flow_not_found(pieces, monkeypatch):
    stored_flow(pieces, monkeypatch)
    response = availability("no-such-config")
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "FLOW_NOT_FOUND"


def test_availability_of_a_malformed_stored_flow_is_not_a_server_error(pieces, monkeypatch):
    flow = stored_flow(pieces, monkeypatch)
    flow["steps"].extend(["nope", {"position": "x", "etl_process_id": 7}])
    response = availability()
    assert response.status_code == 200, response.text
    assert response.json()["available"] is False


def test_availability_needs_a_signed_in_caller(pieces, monkeypatch):
    stored_flow(pieces, monkeypatch)
    monkeypatch.setattr(settings, "demo_mode", False)
    monkeypatch.setattr("app.main.tapis.userinfo_username", lambda token: None)
    main_module._CALLER_CACHE.clear()
    assert availability(headers={}).status_code == 401
    assert availability().status_code == 401
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


def test_a_submission_cannot_replace_what_the_plan_fixed(pieces, monkeypatch):
    # The dataset was checked against the piece's contract at plan time. A value
    # sent at submit would replace it unchecked.
    stored_flow(pieces, monkeypatch)
    body = plan().json()
    for args in ({"source_uri": "tapis://other/system"}, {"execution_id": "x"}, {"tapis_token": "t"}):
        refused = submit(body["plan_id"], args=args, accept_flow_settings=True)
        detail = refused.json()["detail"]
        assert refused.status_code == 422 and detail["code"] == "FLOW_ARGUMENT_FIXED"
        assert detail["arguments"] == sorted(args)
    assert main_module._fixed_flow_args({"parameters": [{"name": "source_uri", "managed": True}]},
                                        {"source_uri": "x"}) == []  # not a flow: the chain rules apply


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


def app_piece(**over):
    body = {
        "name": "app", "method": "tapis_job", "tapis_app_id": "some-app", "transform_type": "custom",
        "file_inputs": [{"name": "docs", "from_arg": "source_uri", "target_path": "docs"}],
        "env_from_args": {"TOP_N": "top_n"},
        "parameters_schema_json": {"properties": {"top_n": {"type": "string"}},
                                   "value_outputs": [{"name": "job_uuid"}]},
        "contracts": [
            {"role": "input", "standard_variable_uri": V + "corpus"},
            {"role": "output", "standard_variable_uri": V + "clean",
             "schema_requirement_json": {"archived_file": "clean_*.csv"}},
            {"role": "output", "standard_variable_uri": V + "counts"}]}
    body.update(over)
    response = client.post("/transform-specs", json=body)
    assert response.status_code == 200, response.text
    return response.json()["id"]


def test_a_piece_that_runs_as_a_tapis_app_hands_its_archived_files_to_a_later_step(monkeypatch):
    first = app_piece()
    second = register("report", ["counts", "clean"], ["report"])
    stored_flow({}, monkeypatch, outputs=[{"step": 2, "output": 1}], steps=[
        {"position": 1, "etl_process_id": first, "settings": {"top_n": "5"}, "wires": [from_input("in:corpus", 1)]},
        {"position": 2, "etl_process_id": second, "settings": {},
         "wires": [from_step(1, 2, 1), from_step(1, 1, 2)]}])
    response = plan({"in:corpus": data_object("corpus", "tapis://sys/docs")})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["plan_json"]["steps"][0]["flow_outputs"] == {
        "outputs": [1, 2], "values": ["job_uuid"], "files": {"1": "clean_*.csv"}}
    pipeline = tapis.generate_tapis_workflow({"id": body["plan_id"], "plan_json": body["plan_json"]})
    tasks = {task["id"]: task for task in pipeline["tasks"]}
    app, report = tasks["step-1-custom"], tasks["step-2-unit_convert"]
    # A function that runs the job, not a job task: a job task returns nothing.
    assert app["type"] == "function" and set(app["output"]) == {"result", "result_2", "value_job_uuid"}
    assert app["input"]["SOURCE_1"]["value_from"] == {"args": "source_uri"}
    assert app["input"]["TOP_N"]["value_from"] == {"args": "top_n"}
    assert report["input"]["SOURCE_1"]["value_from"] == {
        "task_output": {"task_id": "step-1-custom", "output_id": "result_2"}}
    assert report["input"]["SOURCE_2"]["value_from"] == {
        "task_output": {"task_id": "step-1-custom", "output_id": "result"}}


def test_an_app_pieces_output_file_name_is_checked_when_the_flow_is_planned(monkeypatch):
    piece = app_piece(contracts=[
        {"role": "input", "standard_variable_uri": V + "corpus"},
        {"role": "output", "standard_variable_uri": V + "clean",
         "schema_requirement_json": {"archived_file": "../../etc/passwd"}}])
    stored_flow({}, monkeypatch, outputs=[], steps=[
        {"position": 1, "etl_process_id": piece, "settings": {}, "wires": [from_input("in:corpus", 1)]}])
    response = plan({"in:corpus": data_object("corpus", "tapis://sys/docs")})
    assert response.status_code == 422 and response.json()["detail"]["code"] == "FLOW_DOES_NOT_BUILD"


def test_an_app_piece_in_a_chain_is_still_a_job_task():
    spec = app_piece()
    chain = client.post("/plans", headers=AUTH, json={
        "data_object_id": data_object("corpus", "tapis://sys/docs"), "piece_ids": [spec],
        "target_contract": {"standard_variable_uri": V + "clean"}})
    assert chain.status_code == 200, chain.text
    body = chain.json()
    pipeline = tapis.generate_tapis_workflow({"id": body["plan_id"], "plan_json": body["plan_json"]})
    assert [task["type"] for task in pipeline["tasks"]] == ["tapis_job"]


def test_a_stored_flow_with_values_of_the_wrong_kind_is_refused_not_a_server_error(pieces, monkeypatch):
    flow = stored_flow(pieces, monkeypatch)
    flow["steps"][1]["wires"] = [{"to": {"input": True}, "from": {"flow_input": []}}, None]
    flow["steps"].append("nope")
    response = plan()
    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "FLOW_DOES_NOT_CHECK_OUT"


# --- the thread's region as a flow input ---------------------------------------
import json  # noqa: E402

BBOX = {"kind": "bbox", "bbox": [-97.9, 30.1, -97.5, 30.5]}


def region_flow(monkeypatch, **over):
    piece = register("clip", ["boundary", "corpus"], ["clean"])
    steps = [{"position": 1, "etl_process_id": piece, "settings": {},
              "wires": [from_input("in:aoi", 1), from_input("in:corpus", 2)]}]
    stored_flow({}, monkeypatch, outputs=[], steps=steps,
                **{"thread_bindings": {"region": {"input": "in:aoi"}}, **over})


def plan_region(source=BBOX, input_id="in:aoi", inputs=None):
    body = {"flow_id": "cfg-1", "inputs": inputs if inputs is not None else {
        "in:corpus": data_object("corpus", "tapis://sys/docs")}}
    if source is not None:
        body["region"] = {"input": input_id, "source": source}
    return client.post("/plans/flow", headers=AUTH, json=body)


def test_the_threads_region_fills_the_input_the_flow_marks_for_it(monkeypatch):
    region_flow(monkeypatch)
    response = plan_region()
    assert response.status_code == 200, response.text
    plan_json = response.json()["plan_json"]
    parameters = {p["name"]: p for p in plan_json["parameters"]}
    region = parameters["source_uri"]
    # The piece receives the region as GeoJSON text, not as a location.
    assert json.loads(region["default"]) == {"type": "Polygon", "coordinates": [[
        [-97.9, 30.1], [-97.5, 30.1], [-97.5, 30.5], [-97.9, 30.5], [-97.9, 30.1]]]}
    assert (region["managed"], region["managed_source"]) == (True, "thread_region")
    assert parameters["source_uri_2"]["default"] == "tapis://sys/docs"
    assert plan_json["flow"]["inputs"][0] == {"input_id": "in:aoi", "arg": "source_uri", "region": True}


def test_a_region_boundary_is_passed_on_as_it_was_given(monkeypatch):
    region_flow(monkeypatch)
    ring = [[-97.9, 30.1], [-97.5, 30.1], [-97.5, 30.5], [-97.9, 30.1]]
    source = {"kind": "geojson", "geometry": {"type": "MultiPolygon", "coordinates": [[ring]]}}
    parameters = {p["name"]: p for p in plan_region(source).json()["plan_json"]["parameters"]}
    assert json.loads(parameters["source_uri"]["default"]) == source["geometry"]


def test_without_a_region_the_marked_input_still_needs_a_dataset(monkeypatch):
    region_flow(monkeypatch)
    detail = plan_region(source=None).json()["detail"]
    assert (detail["code"], detail["inputs"]) == ("FLOW_INPUT_NOT_BOUND", ["in:aoi"])
    with_dataset = plan_region(source=None, inputs={
        "in:corpus": data_object("corpus", "tapis://sys/docs"),
        "in:aoi": data_object("boundary", "tapis://sys/aoi.geojson")})
    assert with_dataset.status_code == 200, with_dataset.text


@pytest.mark.parametrize("case", ["another input", "an input with a dataset", "a flow that marks no region"])
def test_a_region_fills_only_the_input_the_flow_marks_and_only_when_it_is_free(monkeypatch, case):
    region_flow(monkeypatch, **({"thread_bindings": {}} if case == "a flow that marks no region" else {}))
    if case == "another input":
        response = plan_region(input_id="in:corpus", inputs={})
    elif case == "an input with a dataset":
        response = plan_region(inputs={"in:corpus": data_object("corpus", "tapis://sys/docs"),
                                       "in:aoi": data_object("boundary", "tapis://sys/aoi.geojson")})
    else:
        response = plan_region()
    assert response.status_code == 422 and response.json()["detail"]["code"] == "FLOW_REGION_REFUSED"


@pytest.mark.parametrize("source,code", [
    ({"kind": "bbox", "bbox": [-180, -80, 180, 80]}, "AOI_REGION_TOO_LARGE"),
    ({"kind": "bbox", "bbox": [1, 2]}, None),
    ({"kind": "wkt", "text": "POLYGON(...)"}, None),
    ("nope", None),
])
def test_a_region_is_held_to_the_limits_a_models_region_input_has(monkeypatch, source, code):
    region_flow(monkeypatch)
    response = plan_region(source)
    assert response.status_code == 422, response.text
    if code:
        assert response.json()["detail"]["code"] == code


# --- a flow input that takes a collection ---------------------------------------
import uuid  # noqa: E402

from app import flow_run  # noqa: E402

FILES = [{"name": "a.csv", "url": "https://files.example.org/a.csv"},
         {"name": "", "url": "https://other.example.net/get?id=7&sig=SECRET"},
         {"name": "c.txt", "url": "tapis://corral/data/c.txt"}]


@pytest.fixture(autouse=True)
def tapis_storage_allowed(monkeypatch):
    # The tests below gather one file from Tapis storage, which an adapter must be
    # set up to allow. By default it is not: see the test of that.
    monkeypatch.setattr(settings, "flow_collection_tapis_systems", "corral")


def collection_flow(monkeypatch, collections=("in:corpus",), **over):
    """ingest reads the corpus; score reads its result and a lexicon."""
    pieces = {"ingest": register("ingest", ["corpus"], ["clean"]),
              "score": register("score", ["clean", "lexicon"], ["counts"], settings_=["top_n"]),
              "report": register("report", ["counts", "clean"], ["report"], settings_=["title"])}
    stored_flow(pieces, monkeypatch, thread_bindings={"collections": list(collections)}, **over)
    return pieces


def plan_collection(files=FILES, input_id="in:corpus", label="Documents", inputs=None, **over):
    body = {"flow_id": "cfg-1",
            "inputs": inputs if inputs is not None else {"in:lexicon": data_object("lexicon", "tapis://sys/lexicon.csv")},
            "collections": {input_id: {"label": label, "resources": files}}, **over}
    return client.post("/plans/flow", headers=AUTH, json=body)


def test_a_collection_input_is_gathered_by_one_task_that_its_steps_read_from(monkeypatch):
    collection_flow(monkeypatch)
    response = plan_collection()
    assert response.status_code == 200, response.text
    plan_json = response.json()["plan_json"]
    assert plan_json["flow"]["collections"] == [
        {"input": "in:corpus", "label": "Documents", "gather": "gather-1", "resources": FILES}]
    assert plan_json["flow"]["inputs"] == [
        {"input_id": "in:corpus", "collection": "gather-1"},
        {"input_id": "in:lexicon", "arg": "source_uri_2", "data_object_id": plan_json["flow"]["inputs"][1]["data_object_id"]}]
    steps = plan_json["steps"]
    assert steps[0]["wires"] == [{"to": {"input": 1}, "from": {"gather": "gather-1"}}]
    assert steps[1]["wires"][1] == {"to": {"input": 2}, "from": {"arg": "source_uri_2"}}
    parameters = {p["name"]: p for p in plan_json["parameters"]}
    # Nothing fills a source_uri for the collection input from a data object.
    assert "source_uri" not in parameters and parameters["source_uri_2"]["default"] == "tapis://sys/lexicon.csv"
    staging = parameters["flow_staging_uri"]
    assert (staging["managed"], staging["managed_source"], staging["required"]) == (True, "run_folder", False)
    assert staging["description"] == "The folder this run stages gathered inputs in"


def test_the_pipeline_has_a_gather_task_before_the_steps_that_read_it(monkeypatch):
    collection_flow(monkeypatch)
    body = plan_collection().json()
    pipeline = tapis.generate_tapis_workflow({"id": body["plan_id"], "plan_json": body["plan_json"]})
    ids = [task["id"] for task in pipeline["tasks"]]
    assert ids[0] == "gather-1" and ids.index("gather-1") < ids.index("step-1-unit_convert")
    gather, first, second = (next(t for t in pipeline["tasks"] if t["id"] == i)
                             for i in ("gather-1", "step-1-unit_convert", "step-2-unit_convert"))
    assert gather["type"] == "function" and gather["output"] == {"result": {"type": "string"}}
    assert gather["input"] == {
        "TAPIS_TOKEN": {"type": "string", "value_from": {"args": "tapis_token"}},
        "TAPIS_BASE_URL": {"type": "string", "value_from": {"args": "tapis_base_url"}},
        "STAGING_URI": {"type": "string", "value_from": {"args": "flow_staging_uri"}}}
    assert "depends_on" not in gather
    # The spec is data in the code: the links are in it, and the task reads nothing else.
    spec_line = next(line for line in gather["code"].splitlines() if line.startswith("_SPEC = json.loads("))
    assert "files.example.org/a.csv" in spec_line and "gather-1" in spec_line
    assert first["depends_on"] == [{"id": "gather-1"}]
    assert first["input"]["SOURCE_1"]["value_from"] == {
        "task_output": {"task_id": "gather-1", "output_id": "result"}}
    assert second["depends_on"] == [{"id": "step-1-unit_convert"}]
    assert pipeline["params"]["flow_staging_uri"]["required"] is False
    assert "source_uri" not in pipeline["params"]


def test_a_chain_written_for_source_uri_gets_the_gathered_folder_under_the_chain_names(monkeypatch):
    piece = client.post("/transform-specs", json={
        "name": "chain", "method": "tapis_function", "transform_type": "unit_convert",
        "contracts": [{"role": "input", "standard_variable_uri": V + "corpus"},
                      {"role": "output", "standard_variable_uri": V + "clean"}],
        "parameters_schema_json": {"properties": {}},
        "env_from_args": {"TAPIS_TOKEN": "tapis_token", "SOURCE_URI": "source_uri"}}).json()["id"]
    stored_flow({}, monkeypatch, outputs=[], thread_bindings={"collections": ["in:corpus"]}, steps=[
        {"position": 1, "etl_process_id": piece, "settings": {}, "wires": [from_input("in:corpus", 1)]}])
    body = plan_collection(inputs={}).json()
    pipeline = tapis.generate_tapis_workflow({"id": "x", "plan_json": body["plan_json"]})
    task = next(t for t in pipeline["tasks"] if t["id"] == "step-1-unit_convert")
    gathered = {"task_output": {"task_id": "gather-1", "output_id": "result"}}
    assert task["input"]["SOURCE_URI"]["value_from"] == gathered
    assert task["input"]["SOURCE_RESULT"]["value_from"] == gathered
    # source_uri is declared by the piece but nobody sets it: it must not be required.
    assert pipeline["params"]["source_uri"]["required"] is False


def test_gather_tasks_are_numbered_in_the_order_the_steps_first_read_the_inputs(monkeypatch):
    collection_flow(monkeypatch, collections=("in:corpus", "in:lexicon"))
    body = {"flow_id": "cfg-1", "collections": {
        "in:lexicon": {"label": "Lexicon", "resources": FILES[:1]},
        "in:corpus": {"label": "Documents", "resources": FILES}}}
    plan_json = client.post("/plans/flow", headers=AUTH, json=body).json()["plan_json"]
    assert [(c["input"], c["gather"]) for c in plan_json["flow"]["collections"]] == [
        ("in:corpus", "gather-1"), ("in:lexicon", "gather-2")]
    pipeline = tapis.generate_tapis_workflow({"id": "x", "plan_json": plan_json})
    assert [t["id"] for t in pipeline["tasks"][:2]] == ["gather-1", "gather-2"]
    assert [d["id"] for d in next(t for t in pipeline["tasks"] if t["id"] == "step-2-unit_convert")["depends_on"]] == [
        "gather-2", "step-1-unit_convert"]


def test_a_marked_input_bound_the_ordinary_way_has_no_gather_task(monkeypatch):
    collection_flow(monkeypatch)
    response = plan(bound())
    assert response.status_code == 200, response.text
    plan_json = response.json()["plan_json"]
    assert plan_json["flow"]["collections"] == []
    assert "flow_staging_uri" not in {p["name"] for p in plan_json["parameters"]}
    pipeline = tapis.generate_tapis_workflow({"id": "x", "plan_json": plan_json})
    assert not any(t["id"].startswith("gather") for t in pipeline["tasks"])


def test_a_flow_with_no_collection_is_planned_as_before(pieces, monkeypatch):
    stored_flow(pieces, monkeypatch)
    plan_json = plan().json()["plan_json"]
    assert plan_json["flow"]["collections"] == []
    assert "flow_staging_uri" not in {p["name"] for p in plan_json["parameters"]}


def refused(response, code):
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert detail["code"] == code
    return detail


def test_a_collection_for_an_input_the_flow_does_not_mark_is_refused(monkeypatch):
    collection_flow(monkeypatch, collections=())
    detail = refused(plan_collection(), "FLOW_COLLECTION_REFUSED")
    assert detail["input"] == "in:corpus" and "does not mark" in detail["message"]
    collection_flow(monkeypatch, collections=("in:lexicon",))
    refused(plan_collection(), "FLOW_COLLECTION_REFUSED")


def test_a_collection_and_a_data_object_for_the_same_input_are_refused(monkeypatch):
    collection_flow(monkeypatch)
    detail = refused(plan_collection(inputs=bound()), "FLOW_COLLECTION_REFUSED")
    assert "bound to a data object" in detail["message"]


def test_a_collection_may_not_fill_the_input_the_thread_region_fills(monkeypatch):
    collection_flow(monkeypatch)
    detail = refused(plan_collection(region={"input": "in:corpus", "source": BBOX}), "FLOW_COLLECTION_REFUSED")
    assert "region" in detail["message"]


def test_a_collection_for_an_input_no_step_reads_is_refused(monkeypatch):
    collection_flow(monkeypatch, collections=("in:corpus", "in:ghost"))
    refused(plan_collection(input_id="in:ghost"), "FLOW_COLLECTION_REFUSED")


@pytest.mark.parametrize("url,reason", [
    ("http://files.example.org/a.csv", "http links are refused"),
    ("ftp://files.example.org/a.csv", "https://"),
    ("file:///etc/passwd", "https://"),
    ("https://user:pass@files.example.org/a.csv", "user name or password"),
    ("https://files.example.org:8443/a.csv", "port 443"),
    ("https://files.example.org/a.csv#part", "fragment"),
    ("https://files.example.org/a b.csv", "space"),
    ("tapis://corral/../etc/passwd", "'..'"),
    ("tapis://bad system/a", "space"),
    ("tapis://-sys/a", "system name"),
    ("tapis://corral", "path"),
])
def test_each_bad_link_is_refused_naming_the_resource_and_the_reason(monkeypatch, url, reason):
    collection_flow(monkeypatch)
    files = [FILES[0], {"name": "x", "url": url}]
    detail = refused(plan_collection(files), "FLOW_COLLECTION_RESOURCE_REFUSED")
    assert detail["index"] == 1 and "resource 1" in detail["message"] and reason in detail["message"]
    assert url not in detail["message"]


def test_a_collection_holds_at_most_the_configured_number_of_resources(monkeypatch):
    collection_flow(monkeypatch)
    monkeypatch.setattr(settings, "flow_collection_max_resources", 2)
    assert plan_collection(FILES[:2]).status_code == 200
    detail = refused(plan_collection(FILES), "FLOW_COLLECTION_REFUSED")
    assert detail["limit"] == 2


@pytest.mark.parametrize("collections", [
    {"in:corpus": {"label": "x", "resources": []}},
    {"in:corpus": {"label": "x"}},
    {"in:corpus": {"resources": FILES}},
    {"in:corpus": {"label": "x" * 201, "resources": FILES}},
    {"in:corpus": {"label": "x", "resources": [{"name": "a"}]}},
    {"in:corpus": {"label": "x", "resources": [{"name": "a", "url": 5}]}},
    {"in:corpus": {"label": "x", "resources": [{"name": "a", "url": "https://h/" + "a" * 2000}]}},
    {"in:corpus": {"label": "x", "resources": [{"name": "n" * 256, "url": "https://h.example/a"}]}},
    {"in:corpus": {"label": "x", "resources": [{"name": "a", "url": "https://h.example/a", "extra": 1}]}},
    {"in:corpus": {"label": "x", "resources": "https://h.example/a"}},
    {"in:corpus": "https://h.example/a"},
    {"in:corpus": None},
    ["in:corpus"],
])
def test_a_malformed_collection_is_a_422_never_a_500(monkeypatch, collections):
    collection_flow(monkeypatch)
    response = client.post("/plans/flow", headers=AUTH, json={"flow_id": "cfg-1", "inputs": {}, "collections": collections})
    assert response.status_code == 422, response.text


def test_a_marked_input_given_nothing_is_still_unbound(monkeypatch):
    collection_flow(monkeypatch)
    detail = refused(plan({"in:lexicon": data_object("lexicon", "tapis://sys/l")}), "FLOW_INPUT_NOT_BOUND")
    assert detail["inputs"] == ["in:corpus"]


def test_a_collection_is_checked_as_fitting_the_input_the_author_marked(monkeypatch):
    # The files have no registered contract: they are taken as what the first piece
    # input linked to the marked input asks for, so a second piece that asks for
    # something else of the same input is still caught.
    first, second = register("one", ["corpus"], ["clean"]), register("two", ["lexicon"], ["counts"])
    stored_flow({}, monkeypatch, outputs=[], thread_bindings={"collections": ["in:corpus"]}, steps=[
        {"position": 1, "etl_process_id": first, "settings": {}, "wires": [from_input("in:corpus", 1)]},
        {"position": 2, "etl_process_id": second, "settings": {}, "wires": [from_input("in:corpus", 1)]}])
    detail = refused(plan_collection(inputs={}), "FLOW_DOES_NOT_CHECK_OUT")
    assert [(p["code"], p["step"]) for p in detail["problems"]] == [("FLOW_WIRE_DOES_NOT_FIT", 2)]


# --- submitting a flow that gathers ----------------------------------------------

@pytest.fixture
def submitting(monkeypatch):
    seen = {"submits": [], "roots": []}

    def fake_submit(pipeline, args, **kwargs):
        seen["submits"].append({"pipeline": pipeline, "args": args})
        return {"uuid": "tapis-run-1", "pipelineId": pipeline["id"]}

    monkeypatch.setattr(main_module.tapis, "submit_tapis_workflow", fake_submit)
    monkeypatch.setattr(main_module.tapis, "userinfo_username", lambda token: "alice")
    monkeypatch.setattr(main_module.tapis, "resolve_scratch_root",
                        lambda token, user, system: seen["roots"].append((user, system)) or seen.get("root", "/scratch/alice"))
    return seen


def test_a_run_stages_what_it_gathers_in_a_folder_named_for_the_run(monkeypatch, submitting):
    collection_flow(monkeypatch)
    plan_id = plan_collection().json()["plan_id"]
    response = submit(plan_id, accept_flow_settings=True)
    assert response.status_code == 200, response.text
    run_id = response.json()["run_id"]
    uuid.UUID(run_id)
    sent = submitting["submits"][0]["args"]
    assert sent["flow_staging_uri"] == {"value": f"tapis://{settings.tapis_exec_system}/scratch/alice/dynamo-runs/{run_id}"}
    assert submitting["roots"] == [("alice", settings.tapis_exec_system)]
    # The run is recorded under the id the folder was named for.
    assert client.get(f"/runs/{run_id}", headers=AUTH).json()["id"] == run_id


def test_a_run_whose_scratch_folder_cannot_be_found_is_refused_with_what_to_do(monkeypatch, submitting):
    collection_flow(monkeypatch)
    plan_id = plan_collection().json()["plan_id"]
    submitting["root"] = None
    response = submit(plan_id, accept_flow_settings=True)
    detail = refused(response, "FLOW_STAGING_UNRESOLVED")
    assert detail["message"] == (
        f"could not find your scratch folder on {settings.tapis_exec_system}: run any job there once")
    assert submitting["submits"] == []
    assert client.get("/runs", headers=AUTH).json()["runs"] == []  # nothing was recorded


def test_a_dry_run_does_not_look_for_the_folder_and_says_it_would(monkeypatch, submitting):
    collection_flow(monkeypatch)
    plan_id = plan_collection().json()["plan_id"]
    response = submit(plan_id, dry_run=True)
    assert response.status_code == 200, response.text
    assert submitting["roots"] == []
    body = response.json()
    assert body["flow_staging"]["resolved"] is False and "dynamo-runs" in body["flow_staging"]["message"]
    assert "flow_staging_uri" not in body["args"]


def test_a_plan_without_a_collection_never_looks_for_a_folder(monkeypatch, submitting, pieces):
    stored_flow(pieces, monkeypatch)
    response = submit(plan().json()["plan_id"], accept_flow_settings=True)
    assert response.status_code == 200, response.text
    assert submitting["roots"] == [] and "flow_staging_uri" not in submitting["submits"][0]["args"]


def test_the_staging_folder_is_not_the_submitters_to_choose(monkeypatch, submitting):
    collection_flow(monkeypatch)
    plan_id = plan_collection().json()["plan_id"]
    refused_ = submit(plan_id, args={"flow_staging_uri": "tapis://ls6/elsewhere"}, accept_flow_settings=True)
    assert refused(refused_, "FLOW_ARGUMENT_FIXED")["arguments"] == ["flow_staging_uri"]
    assert submitting["submits"] == []


def test_the_tapis_address_is_not_the_submitters_to_choose(monkeypatch, submitting):
    # Every step sends the runner's token to this address.
    collection_flow(monkeypatch)
    plan_id = plan_collection().json()["plan_id"]
    refused_ = submit(plan_id, args={"tapis_base_url": "https://evil.example"}, accept_flow_settings=True)
    assert refused(refused_, "FLOW_ARGUMENT_FIXED")["arguments"] == ["tapis_base_url"]
    assert submitting["submits"] == []


def test_a_run_is_given_the_adapters_own_tapis_address(monkeypatch, submitting):
    collection_flow(monkeypatch)
    plan_id = plan_collection().json()["plan_id"]
    assert submit(plan_id, accept_flow_settings=True).status_code == 200
    sent = submitting["submits"][0]
    value = sent["args"]["tapis_base_url"]
    assert (value.get("value") if isinstance(value, dict) else value) == settings.tapis_base_url
    gather = next(task for task in sent["pipeline"]["tasks"] if task["id"] == "gather-1")
    assert json.dumps(settings.tapis_base_url.split("//", 1)[1].split("/")[0].lower()) in gather["code"].replace("\\", "")


def test_a_collection_reads_tapis_storage_only_where_the_adapter_allows_it(monkeypatch):
    # The files come from a thread others may edit, and are read with the runner's token.
    collection_flow(monkeypatch)
    monkeypatch.setattr(settings, "flow_collection_tapis_systems", "")
    detail = refused(plan_collection(), "FLOW_COLLECTION_RESOURCE_REFUSED")
    assert detail["index"] == 2 and "corral" in detail["message"]
    assert plan_collection(files=FILES[:2]).status_code == 200


def output_flow(monkeypatch, **over):
    """A flow whose last piece must be told where to write: a required output_uri."""
    ingest = register("ingest", ["corpus"], ["clean"])
    publish = client.post("/transform-specs", json={
        "name": "write", "method": "tapis_function", "transform_type": "unit_convert",
        "contracts": [{"role": "input", "standard_variable_uri": V + "clean"}],
        "parameters_schema_json": {"properties": {"output_uri": {"type": "string"}}, "required": ["output_uri"]},
        "env_from_args": {"TAPIS_TOKEN": "tapis_token", "OUTPUT_URI": "output_uri"}}).json()["id"]
    stored_flow({}, monkeypatch, outputs=[], thread_bindings={"collections": ["in:corpus"]}, steps=[
        {"position": 1, "etl_process_id": ingest, "settings": {}, "wires": [from_input("in:corpus", 1)]},
        {"position": 2, "etl_process_id": publish, "settings": over.get("settings", {}),
         "wires": [from_step(1, 1, 1)]}])


def parameters_of(response):
    return {p["name"]: p for p in response.json()["plan_json"]["parameters"]}


def test_a_required_output_uri_nobody_gave_defaults_to_the_runs_outputs_folder(monkeypatch, submitting):
    output_flow(monkeypatch)
    response = plan_collection(inputs={})
    output = parameters_of(response)["output_uri"]
    assert (output["required"], output["default_source"], output.get("default")) == (False, "run_folder", None)
    run = submit(response.json()["plan_id"])
    assert run.status_code == 200, run.text
    sent = submitting["submits"][0]["args"]
    assert sent["output_uri"] == {"value": sent["flow_staging_uri"]["value"] + "/outputs"}


def test_a_caller_who_gives_output_uri_keeps_it(monkeypatch, submitting):
    output_flow(monkeypatch)
    plan_id = plan_collection(inputs={}).json()["plan_id"]
    run = submit(plan_id, args={"output_uri": "tapis://corral/mine"})
    assert run.status_code == 200, run.text
    assert submitting["submits"][0]["args"]["output_uri"] == {"value": "tapis://corral/mine"}


def test_an_output_uri_the_flow_has_a_default_for_is_left_alone(monkeypatch, submitting):
    output_flow(monkeypatch, settings={"output_uri": "tapis://corral/flows-choice"})
    response = plan_collection(inputs={})
    output = parameters_of(response)["output_uri"]
    assert output["default"] == "tapis://corral/flows-choice" and "default_source" not in output or output["default_source"] == "flow"
    run = submit(response.json()["plan_id"], accept_flow_settings=True)
    assert run.status_code == 200, run.text
    assert submitting["submits"][0]["args"]["output_uri"] == {"value": "tapis://corral/flows-choice"}


def test_without_a_collection_output_uri_is_not_defaulted(monkeypatch):
    ingest = register("ingest", ["corpus"], ["clean"])
    publish = client.post("/transform-specs", json={
        "name": "write", "method": "tapis_function", "transform_type": "unit_convert",
        "contracts": [{"role": "input", "standard_variable_uri": V + "clean"}],
        "parameters_schema_json": {"properties": {"output_uri": {"type": "string"}}, "required": ["output_uri"]},
        "env_from_args": {"TAPIS_TOKEN": "tapis_token", "OUTPUT_URI": "output_uri"}}).json()["id"]
    stored_flow({}, monkeypatch, outputs=[], steps=[
        {"position": 1, "etl_process_id": ingest, "settings": {}, "wires": [from_input("in:corpus", 1)]},
        {"position": 2, "etl_process_id": publish, "settings": {}, "wires": [from_step(1, 1, 1)]}])
    output = parameters_of(plan({"in:corpus": data_object("corpus", "tapis://sys/docs")}))["output_uri"]
    assert output["required"] is True and "default_source" not in output


# --- what a run of it looks like -------------------------------------------------

def test_the_gather_step_is_listed_first_and_the_steps_that_read_it_wait_for_it(monkeypatch):
    collection_flow(monkeypatch)
    plan_json = plan_collection().json()["plan_json"]
    detail = {"tasks": [{"task_id": "gather-1", "status": "completed", "last_message": "done"},
                        {"task_id": "step-1-unit_convert", "status": "active"}]}
    steps = flow_run.view(plan_json, detail)["steps"]
    assert steps[0] == {"step": "gather-1", "name": "Gather Documents", "task_id": "gather-1",
                        "depends_on": [], "status": "completed", "message": "done"}
    assert [(s["step"], s["status"], s["depends_on"]) for s in steps[1:]] == [
        (1, "running", ["gather-1"]), (2, "pending", [1]), (3, "pending", [1, 2])]
    assert flow_run.view(plan_json, {"tasks": []})["steps"][0]["status"] == "pending"


def test_the_flow_check_passes_collections_on_unchanged(pieces):
    steps = [{"position": 1, "etl_process_id": pieces["ingest"], "wires": [from_input("in:corpus", 1)]}]

    def checked(bindings):
        return client.post("/flows/check", headers=AUTH, json={
            "inputs": [{"id": "in:corpus", "contract": {"standard_variable_uri": V + "corpus"}}],
            "steps": steps, "thread_bindings": bindings}).json()
    assert checked({"collections": ["in:corpus"]})["ok"] is True
    result = checked({"collections": ["in:nope"]})
    assert [p["code"] for p in result["problems"]] == ["FLOW_THREAD_BINDING"]
