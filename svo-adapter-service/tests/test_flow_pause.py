"""A flow that stops after a step for the user's edit, and continues on the edited copy.

Design: docs/design/2026-11-20-flow-pause-for-edit.md. Demo mode, Tapis stubbed:
the first segment, the pause, the resume and the second segment are all read back
from what the adapter sent to Tapis and what it recorded.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config

import pytest  # noqa: E402
from cryptography.fernet import Fernet  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import flow_graph, flow_run, flow_segments, poller, run_tokens, step_secrets, tapis  # noqa: E402
from app import main as main_module  # noqa: E402
from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402
from app.store import STORE  # noqa: E402
from app.stored_source import approval_sha256  # noqa: E402

client = TestClient(app)
V = "https://example.org/"
USERS = {"tok-alice": "alice", "tok-bob": "bob"}
ALICE = {"Authorization": "Bearer tok-alice"}
BOB = {"Authorization": "Bearer tok-bob"}
CATALOG = "ckan.example.org"
EDIT_URL = f"https://{CATALOG}/dataset/ds-1/resource/res-9/download/lexicon.json"
SHA = "a" * 64
DRAFT = {"output_uri": "tapis://ls6/scratch/alice/out", "lexicon_uri": "tapis://ls6/scratch/alice/out/lexicon_draft.json",
         "taxonomy_uri": "tapis://ls6/scratch/alice/out/taxonomy_draft.json"}
EDITABLE = {"file": "lexicon_draft.json", "key": "lexicon_uri", "check": "lexicon"}
KEY = "step-secret-test-key-0123456789-abcdef"
CODE = "def run(inputs):\n    return 'ok'\n"
SECRET_A = [{"name": "model_server", "label": "Model server", "env": {"MODEL_API_KEY": "api_key"}}]
SECRET_B = [{"name": "scorer", "label": "Scorer", "env": {"SCORE_KEY": "api_key"}}]
SENDS = [{"service": "A service", "what": "Passages of your documents"}]


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    monkeypatch.setattr(settings, "flow_pause_enabled", True)
    monkeypatch.setattr(settings, "flow_collection_catalog_host", CATALOG)
    monkeypatch.setattr(settings, "secrets_encryption_keys", Fernet.generate_key().decode())
    monkeypatch.setattr(settings, "step_secret_key", KEY)
    monkeypatch.setattr(settings, "public_base_url", "https://svo.example")
    monkeypatch.setattr(settings, "stored_source_enabled", True)
    monkeypatch.setattr(settings, "cancel_admins", "")
    monkeypatch.setattr(main_module.tapis, "userinfo_username", lambda token: USERS.get(token))
    client.post("/admin/reset")
    main_module._CALLER_CACHE.clear()
    main_module._SECRET_CHANGE_RATE.clear()


# --- the flow: ingest, draft (pause, edit the lexicon), score, report -----------------

def register(name, inputs, outputs, *, secrets=None):
    body = {"name": name, "method": "tapis_function", "transform_type": "etl_process",
            "contracts": [*({"role": "input", "standard_variable_uri": V + i} for i in inputs),
                          *({"role": "output", "standard_variable_uri": V + o} for o in outputs)],
            "env_from_args": {"TAPIS_TOKEN": "tapis_token"},
            "metadata": {"source": {"language": "python", "code": CODE, "entrypoint": "run"}}}
    if secrets:
        body["secrets"], body["sends_data_to"] = secrets, SENDS
    response = client.post("/transform-specs", json=body)
    assert response.status_code == 200, response.text
    spec_id = response.json()["id"]
    row = STORE.transform_spec[spec_id]
    row.update(owner_username="bob", visibility="public")
    row["approved_source_sha256"] = approval_sha256(row)
    return spec_id


def wire(source, to):
    return {"to": {"input": to}, "from": source}


def flow_steps(*, draft_secrets=None, score_secrets=None):
    ingest = register("ingest", ["corpus"], ["clean"])
    draft = register("draft", ["clean"], ["lexicon"], secrets=draft_secrets)
    score = register("score", ["clean", "lexicon"], ["counts"], secrets=score_secrets)
    report = register("report", ["counts", "clean"], ["report"])
    return [
        {"position": 1, "etl_process_id": ingest, "settings": {}, "wires": [wire({"flow_input": "in:corpus"}, 1)]},
        {"position": 2, "etl_process_id": draft, "settings": {}, "wires": [wire({"step": 1, "output": 1}, 1)],
         "pause_after": True},
        {"position": 3, "etl_process_id": score, "settings": {},
         "wires": [wire({"step": 1, "output": 1}, 1), wire({"step": 2, "output": 1}, 2)]},
        {"position": 4, "etl_process_id": report, "settings": {},
         "wires": [wire({"step": 3, "output": 1}, 1), wire({"step": 1, "output": 1}, 2)]},
    ]


def stored_flow(monkeypatch, steps=None, outputs=None, **secrets):
    flow = {"configuration_id": "cfg-1", "label": "formulation", "parameters": [], "thread_bindings": {},
            "outputs": outputs if outputs is not None else [
                {"step": 4, "output": 1}, {"step": 2, "output": 1, "editable": EDITABLE}],
            "steps": steps if steps is not None else flow_steps(**secrets)}

    async def load(h, configuration_id):
        return flow if configuration_id == "cfg-1" else None
    monkeypatch.setattr(main_module, "_load_flow", load)
    return flow


def plan(headers=ALICE):
    inputs = {"in:corpus": client.post("/data-objects", json={
        "label": "corpus", "resource_uri": "tapis://sys/docs", "format": "directory",
        "variables": [{"standard_variable_uri": V + "corpus"}]}).json()["id"]}
    return client.post("/plans/flow", headers=headers, json={"flow_id": "cfg-1", "inputs": inputs})


# --- Tapis, stubbed ----------------------------------------------------------------------

def report(**outputs):
    return "log line\n" + json.dumps({"svo_flow_outputs": outputs}) + "\n"


def task(task_id, status="completed", **outputs):
    return {"task_id": task_id, "status": status, "last_message": None, "stdout": report(**outputs) if outputs else ""}


@pytest.fixture
def tapis_stub(monkeypatch):
    seen = {"submits": [], "details": {}, "terminated": [], "creds": [],
            "root": "/scratch/alice", "fail_submit": False}

    def submit(pipeline, args, **kwargs):
        if seen["fail_submit"]:
            raise RuntimeError("Tapis refused")
        seen["submits"].append({"pipeline": pipeline, "args": args, "kwargs": kwargs})
        return {"uuid": f"tapis-run-{len(seen['submits'])}", "pipelineId": pipeline["id"]}

    def detail(pipeline_id, run_uuid, token=None):
        return seen["details"].get(run_uuid, {"status": "ACTIVE", "tasks": []})

    async def passthrough(args, caller_token):
        return {**args, "tapis_token": {"value": "run-token-for-" + str(USERS.get(caller_token))}}
    monkeypatch.setattr(main_module.tapis, "submit_tapis_workflow", submit)
    monkeypatch.setattr(main_module.tapis, "get_run_detail", detail)
    monkeypatch.setattr(main_module.tapis, "terminate_pipeline_run",
                        lambda token, pipeline_id, run_uuid: seen["terminated"].append(run_uuid) or (True, 200))
    monkeypatch.setattr(main_module.tapis, "resolve_scratch_root", lambda token, user, system: seen["root"])
    monkeypatch.setattr(main_module, "_with_run_token", passthrough)
    return seen


def first_segment_done(seen, run_uuid="tapis-run-1"):
    seen["details"][run_uuid] = {"status": "COMPLETED", "tasks": [
        task("step-1-etl_process", result="tapis://ls6/scratch/alice/clean"),
        task("step-2-etl_process", result=json.dumps(DRAFT))]}


def submit(plan_id, headers=ALICE, **body):
    return client.post("/workflows/submit", headers=headers, json={
        "plan_id": plan_id, "accept_flow_settings": True, **body})


def poll(run_id, headers=ALICE):
    response = client.post(f"/runs/{run_id}/poll", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def paused(monkeypatch, tapis_stub, **secrets):
    stored_flow(monkeypatch, **secrets)
    plan_id = plan().json()["plan_id"]
    response = submit(plan_id)
    assert response.status_code == 200, response.text
    run_id = response.json()["run_id"]
    first_segment_done(tapis_stub)
    return plan_id, run_id, poll(run_id)


def resume(run_id, url=EDIT_URL, key="2:1", headers=ALICE, **extra):
    return client.post(f"/runs/{run_id}/resume", headers=headers, json={
        "replacements": {key: {"url": url, "dataset_id": "ds-1", "resource_id": "res-9", **extra}}})


def code_of(response):
    return response.json()["detail"]["code"]


def task_ids(pipeline):
    return [t["id"] for t in pipeline["tasks"]]


# ================================ the plan =======================================================

def test_a_pausing_flow_is_planned_with_the_pause_and_a_staging_folder_even_without_a_collection(monkeypatch):
    stored_flow(monkeypatch)
    body = plan().json()
    flow = body["plan_json"]["flow"]
    assert flow["pause_after"] == [2] and flow["collections"] == []
    parameters = {p["name"]: p for p in body["plan_json"]["parameters"]}
    assert parameters["flow_staging_uri"]["managed"] is True


def test_with_pausing_off_the_plan_is_what_it_was_and_a_paused_flow_runs_whole(monkeypatch, tapis_stub):
    monkeypatch.setattr(settings, "flow_pause_enabled", False)
    stored_flow(monkeypatch)
    body = plan().json()
    assert "flow_staging_uri" not in {p["name"] for p in body["plan_json"]["parameters"]}
    response = submit(body["plan_id"])
    assert response.status_code == 200, response.text
    assert len(task_ids(tapis_stub["submits"][0]["pipeline"])) == 4
    assert "paused_after_step" not in STORE.run[response.json()["run_id"]]


@pytest.mark.parametrize("outputs,code", [
    ([{"step": 4, "output": 1}], "FLOW_DOES_NOT_CHECK_OUT"),                      # a pause with no editable file
    ([{"step": 2, "output": 1, "editable": {"file": "a/b.json"}}], "FLOW_DOES_NOT_CHECK_OUT"),
    ([{"step": 2, "output": 1, "editable": {"file": "a.json", "check": "yaml"}}], "FLOW_DOES_NOT_CHECK_OUT"),
    ([{"step": 1, "output": 1, "editable": {"file": "a.json"}}], "FLOW_DOES_NOT_CHECK_OUT"),   # editable elsewhere
])
def test_a_pause_that_cannot_be_run_is_refused_when_planned(monkeypatch, outputs, code):
    stored_flow(monkeypatch, outputs=outputs)
    response = plan()
    assert response.status_code == 422 and code_of(response) == code
    assert any(p["code"] == "FLOW_PAUSE" for p in response.json()["detail"]["problems"])


def test_a_flow_may_pause_once_only(monkeypatch):
    steps = flow_steps()
    steps[2]["pause_after"] = True
    stored_flow(monkeypatch, steps=steps)
    response = plan()
    assert response.status_code == 422
    assert "pause only once" in json.dumps(response.json())


def test_a_pause_after_the_last_step_or_with_nothing_reading_the_edit_is_refused(monkeypatch):
    steps = flow_steps()
    steps[3]["pause_after"], steps[1]["pause_after"] = True, False
    stored_flow(monkeypatch, steps=steps, outputs=[{"step": 4, "output": 1, "editable": EDITABLE}])
    assert "no step runs after the pause" in json.dumps(plan().json())
    steps = flow_steps()
    steps[2]["wires"] = [wire({"step": 1, "output": 1}, 1), wire({"flow_input": "in:corpus"}, 2)]
    stored_flow(monkeypatch, steps=steps)
    assert plan().status_code == 422


def test_the_check_route_refuses_the_same_pauses(monkeypatch):
    steps = flow_steps()
    body = {"inputs": [{"id": "in:corpus", "contract": {"standard_variable_uri": V + "corpus"}}],
            "steps": [{"position": s["position"], "etl_process_id": s["etl_process_id"], "wires": s["wires"],
                       "pause_after": s.get("pause_after", False)} for s in steps]}
    ok = client.post("/flows/check", headers=ALICE, json={**body, "outputs": [
        {"step": 4, "output": 1}, {"step": 2, "output": 1, "editable": EDITABLE}]}).json()
    assert ok["ok"] is True, ok
    refused = client.post("/flows/check", headers=ALICE, json={**body, "outputs": [{"step": 4, "output": 1}]}).json()
    assert refused["ok"] is False and refused["problems"][0]["code"] == "FLOW_PAUSE"


# ================================ the segments ==================================================

def plan_json_of(monkeypatch):
    stored_flow(monkeypatch)
    return plan().json()["plan_json"]


def test_segment_one_is_the_paused_step_and_what_it_follows_and_nothing_else(monkeypatch):
    plan_json = plan_json_of(monkeypatch)
    assert flow_segments.first_positions(plan_json, 2) == {1, 2}
    first = flow_segments.first_segment(plan_json, 2)
    assert [s["step"] for s in first["steps"]] == [1, 2]
    pipeline = tapis.generate_tapis_workflow({"id": "x", "plan_json": first})
    assert task_ids(pipeline) == ["step-1-etl_process", "step-2-etl_process"]


def test_segment_two_names_no_task_of_segment_one_and_reads_the_edit_through_its_own_gather(monkeypatch):
    plan_json = plan_json_of(monkeypatch)
    later, needed = flow_segments.second_segment(plan_json, 2, merge_key="lexicon_uri")
    pipeline = tapis.generate_tapis_workflow({"id": "x", "plan_json": later})
    ids = task_ids(pipeline)
    assert ids == ["gather-edit", "step-3-etl_process", "step-4-etl_process"]
    known = set(ids)
    for one in pipeline["tasks"]:
        assert {d["id"] for d in one.get("depends_on") or []} <= known
        for item in (one.get("input") or {}).values():
            task_out = (item.get("value_from") or {}).get("task_output")
            assert task_out is None or task_out["task_id"] in known
    assert {n["arg"] for n in needed} == {"resume_step1_output_1", "resume_step2_output_1"}
    # The edited file's address is an argument of the run, never part of the pipeline.
    edit = next(t for t in pipeline["tasks"] if t["id"] == "gather-edit")
    assert edit["input"]["EDIT_URL"]["value_from"] == {"args": "resume_edit_url"}
    assert pipeline["params"]["resume_edit_url"]["required"] is True
    assert "ckan.example.org/dataset" not in json.dumps(pipeline)
    score = next(t for t in pipeline["tasks"] if t["id"] == "step-3-etl_process")
    # The lexicon comes from the edit's gather (its summary, with the key repointed), the corpus from an argument.
    assert score["input"]["SOURCE_2"]["value_from"] == {"task_output": {"task_id": "gather-edit", "output_id": "carried"}}
    assert score["input"]["SOURCE_1"]["value_from"] == {"args": "resume_step1_output_1"}
    gather = next(t for t in pipeline["tasks"] if t["id"] == "gather-edit")
    assert gather["input"]["CARRIED"]["value_from"] == {"args": "resume_step2_output_1"}
    assert score["depends_on"] == [{"id": "gather-edit"}]
    for name in {n["arg"] for n in needed}:
        assert pipeline["params"][name]["required"] is True


def test_without_a_summary_the_later_steps_are_handed_the_edited_file_itself(monkeypatch):
    plan_json = plan_json_of(monkeypatch)
    later, needed = flow_segments.second_segment(plan_json, 2, merge_key=None)
    pipeline = tapis.generate_tapis_workflow({"id": "x", "plan_json": later})
    score = next(t for t in pipeline["tasks"] if t["id"] == "step-3-etl_process")
    assert score["input"]["SOURCE_2"]["value_from"]["task_output"]["output_id"] == "result"
    assert "CARRIED" not in next(t for t in pipeline["tasks"] if t["id"] == "gather-edit")["input"]
    assert {n["arg"] for n in needed} == {"resume_step1_output_1"}


def test_a_collection_read_only_after_the_pause_is_gathered_in_segment_two(monkeypatch):
    plan_json = plan_json_of(monkeypatch)
    plan_json["flow"]["collections"] = [{"input": "in:x", "label": "X", "gather": "gather-1",
                                         "resources": [{"name": "a", "url": "https://a.example/a"}]}]
    plan_json["steps"][2]["wires"].append({"to": {"input": 3}, "from": {"gather": "gather-1"}})
    assert [c["gather"] for c in flow_segments.first_segment(plan_json, 2)["flow"]["collections"]] == []
    later, needed = flow_segments.second_segment(plan_json, 2, merge_key=None)
    assert [c["gather"] for c in later["flow"]["collections"]] == ["gather-1", "gather-edit"]
    # and one the first segment read is carried in, not gathered twice
    plan_json["steps"][0]["wires"].append({"to": {"input": 2}, "from": {"gather": "gather-1"}})
    assert [c["gather"] for c in flow_segments.first_segment(plan_json, 2)["flow"]["collections"]] == ["gather-1"]
    later, needed = flow_segments.second_segment(plan_json, 2, merge_key=None)
    assert [c["gather"] for c in later["flow"]["collections"]] == ["gather-edit"]
    assert "resume_gather_1" in {n["arg"] for n in needed}


def test_values_are_filled_from_what_the_first_segment_printed_and_a_lost_one_is_named(monkeypatch):
    plan_json = plan_json_of(monkeypatch)
    _, needed = flow_segments.second_segment(plan_json, 2, merge_key="lexicon_uri")
    detail = {"tasks": [task("step-1-etl_process", result="tapis://ls6/clean"),
                        task("step-2-etl_process", result="x" * (flow_run.MAX_VALUE + 1))]}
    values, missing = flow_segments.resume_values(plan_json, needed, detail)
    assert values == {"resume_step1_output_1": "tapis://ls6/clean"} and missing == ["resume_step2_output_1"]


def test_the_summary_is_repointed_only_when_it_names_the_file(monkeypatch):
    plan_json = plan_json_of(monkeypatch)
    assert flow_segments.merge_key_for(plan_json, 2, json.dumps(DRAFT)) == "lexicon_uri"
    assert flow_segments.merge_key_for(plan_json, 2, "tapis://ls6/file") is None
    assert flow_segments.merge_key_for(plan_json, 2, json.dumps({"other": "x"})) is None


def test_each_segment_is_its_own_pipeline_id():
    assert flow_segments.segment_pipeline_id("plan1", 1) != flow_segments.segment_pipeline_id("plan1", 2)


# ================================ submit: segment one ===========================================

def test_a_pausing_flow_submits_only_up_to_its_pause(monkeypatch, tapis_stub):
    stored_flow(monkeypatch)
    plan_id = plan().json()["plan_id"]
    response = submit(plan_id)
    assert response.status_code == 200, response.text
    run_id = response.json()["run_id"]
    sent = tapis_stub["submits"][0]
    assert task_ids(sent["pipeline"]) == ["step-1-etl_process", "step-2-etl_process"]
    assert sent["pipeline"]["id"] == flow_segments.segment_pipeline_id(plan_id, 1)
    row = STORE.run[run_id]
    assert row["paused_after_step"] == 2 and row["status"] == "running"
    # The staging folder is the run's own, whether or not anything is gathered.
    assert sent["args"]["flow_staging_uri"]["value"].endswith(f"/dynamo-runs/{run_id}")


def test_through_step_may_only_name_the_pause_and_only_when_pausing_is_on(monkeypatch, tapis_stub):
    stored_flow(monkeypatch)
    plan_id = plan().json()["plan_id"]
    assert code_of(submit(plan_id, through_step=3)) == "FLOW_THROUGH_STEP_INVALID"
    assert submit(plan_id, through_step=2).status_code == 200
    monkeypatch.setattr(settings, "flow_pause_enabled", False)
    assert code_of(submit(plan_id, through_step=2)) == "FLOW_PAUSE_DISABLED"


def test_a_plan_with_no_pause_refuses_a_through_step(monkeypatch, tapis_stub):
    stored_flow(monkeypatch, steps=[{**s, "pause_after": False} for s in flow_steps()],
                outputs=[{"step": 4, "output": 1}])
    assert code_of(submit(plan().json()["plan_id"], through_step=2)) == "FLOW_THROUGH_STEP_INVALID"


def test_a_plan_made_before_pausing_was_on_must_be_made_again(monkeypatch, tapis_stub):
    monkeypatch.setattr(settings, "flow_pause_enabled", False)
    stored_flow(monkeypatch)
    plan_id = plan().json()["plan_id"]
    monkeypatch.setattr(settings, "flow_pause_enabled", True)
    refused = submit(plan_id)
    assert refused.status_code == 409 and code_of(refused) == "FLOW_PLAN_PREDATES_PAUSE"


def test_the_replayed_arguments_hold_no_token_and_no_credential(monkeypatch, tapis_stub):
    stored_flow(monkeypatch)
    run_id = submit(plan().json()["plan_id"]).json()["run_id"]
    kept = STORE.run[run_id]["segment_json"]["args"]
    assert "tapis_token" not in kept and "run-token" not in json.dumps(kept)
    assert not [name for name in kept if "token" in name.lower()]
    assert "flow_staging_uri" in kept
    stored = json.dumps([STORE.run, STORE.provenance])
    assert "run-token-for-alice" not in stored
    assert not run_tokens.looks_like_secret(stored)
    assert main_module._replayable_args({
        "tapis_token": {"value": "t"}, "step_secret_token_2": {"value": "c"}, "svo_run_id": {"value": "r"},
        "ckan_token": {"value": "k"}, "x": {"value": "eyJhbGciOi.eyJzdWIi.sig"}, "ok": {"value": "fine"}}) == {
        "ok": {"value": "fine"}}


# ================================ poll: the pause ================================================

def test_the_first_segment_ending_is_a_pause_shown_with_the_file_to_edit(monkeypatch, tapis_stub):
    _, run_id, polled = paused(monkeypatch, tapis_stub)
    flow = polled["flow"]
    assert flow["status"] == "awaiting_edit" and flow["paused_after_step"] == 2
    assert STORE.run[run_id]["status"] == "completed"
    by_step = {s["step"]: s["status"] for s in flow["steps"]}
    assert by_step == {1: "completed", 2: "completed", 3: "waiting", 4: "waiting"}
    editable = next(o for o in flow["outputs"] if o.get("editable"))
    assert editable["key"] == "2:1" and editable["file_location"] == DRAFT["lexicon_uri"]
    assert [e["event_type"] for e in STORE.provenance if e["event_type"] == "run.paused"] == ["run.paused"]
    poll(run_id)
    assert [e["event_type"] for e in STORE.provenance].count("run.paused") == 1
    assert STORE.run[run_id].get("completed_at") is not None


def test_polling_a_paused_run_never_moves_the_time_it_paused(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    stamp = STORE.run[run_id]["completed_at"]
    poll(run_id)
    assert STORE.run[run_id]["completed_at"] == stamp


def test_the_file_to_edit_is_the_summarys_own_address_or_the_folder_plus_the_name():
    value = json.dumps({"output_uri": "tapis://ls6/o"})
    assert flow_run._edit_file({"file": "a.json", "key": "lexicon_uri"}, value) == "tapis://ls6/o/a.json"
    assert flow_run._edit_file({"file": "a.json"}, "tapis://ls6/o/a.json") == "tapis://ls6/o/a.json"
    assert flow_run._edit_file({"file": "a.json", "key": "k"}, None) is None


# ================================ cancel ========================================================

def test_cancelling_a_paused_run_closes_it_and_calls_tapis_not_at_all(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    response = client.post(f"/runs/{run_id}/cancel", headers=ALICE)
    assert response.status_code == 200 and response.json() == {
        "run_id": run_id, "status": "cancelled", "terminated": False, "awaiting_edit": True}
    assert tapis_stub["terminated"] == [] and STORE.run[run_id]["status"] == "cancelled"
    assert [e["payload_json"].get("awaiting_edit") for e in STORE.provenance if e["event_type"] == "run.cancelled"] == [True]
    assert poll(run_id)["status"] == "cancelled"
    assert resume(run_id).status_code == 409


def test_only_the_submitter_or_a_cancel_admin_may_cancel_a_paused_run(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    assert code_of(client.post(f"/runs/{run_id}/cancel", headers=BOB)) == "RUN_CANCEL_FORBIDDEN"
    monkeypatch.setattr(settings, "cancel_admins", "bob")
    assert client.post(f"/runs/{run_id}/cancel", headers=BOB).json()["status"] == "cancelled"


def test_a_finished_run_that_never_paused_is_still_already_terminal(monkeypatch, tapis_stub):
    stored_flow(monkeypatch)
    run_id = submit(plan().json()["plan_id"]).json()["run_id"]
    STORE.run[run_id].update(status="completed", paused_after_step=None)
    assert client.post(f"/runs/{run_id}/cancel", headers=ALICE).json()["already_terminal"] is True


# ================================ resume ========================================================

def test_a_resume_submits_the_rest_as_its_own_run_on_the_edited_file(monkeypatch, tapis_stub):
    plan_id, run_id, _ = paused(monkeypatch, tapis_stub)
    response = resume(run_id)
    assert response.status_code == 200, response.text
    child_id = response.json()["run_id"]
    assert response.json()["paused_run_id"] == run_id and child_id != run_id
    sent = tapis_stub["submits"][1]
    assert task_ids(sent["pipeline"]) == ["gather-edit", "step-3-etl_process", "step-4-etl_process"]
    assert sent["pipeline"]["id"] == flow_segments.segment_pipeline_id(plan_id, 2)
    assert sent["kwargs"]["recreate"] is True
    args = sent["args"]
    # The same staging folder, the first segment's values, a token minted now for the resumer.
    assert args["flow_staging_uri"]["value"].endswith(f"/dynamo-runs/{run_id}")
    assert args["resume_step1_output_1"]["value"] == "tapis://ls6/scratch/alice/clean"
    assert json.loads(args["resume_step2_output_1"]["value"]) == DRAFT
    assert args["tapis_token"]["value"] == "run-token-for-alice"
    gather = next(t for t in sent["pipeline"]["tasks"] if t["id"] == "gather-edit")
    assert args["resume_edit_url"]["value"] == EDIT_URL
    assert "ckan.example.org/dataset" not in json.dumps(sent["pipeline"])
    assert '"check": "lexicon"' in gather["code"].replace("\\", "")
    child = STORE.run[child_id]
    assert child["parent_run_id"] == run_id and child["status"] == "running" and child["submitted_by"] == "alice"
    assert STORE.run[run_id]["resumed_run_id"] == child_id
    events = [(e.get("workflow_run_id"), e["event_type"]) for e in STORE.provenance]
    assert (run_id, "run.resumed") in events
    edit = child["segment_json"]["replacement"]
    assert edit["replaced_by"] == "alice" and edit["url"] == EDIT_URL and edit["resource_id"] == "res-9"
    assert edit["dataset_id"] == "ds-1" and edit["original"] == DRAFT["lexicon_uri"] and edit["replaced_at"]


def test_a_second_resume_of_the_same_pause_loses(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    assert resume(run_id).status_code == 200
    again = resume(run_id)
    assert again.status_code == 409 and code_of(again) == "RUN_NOT_AWAITING_EDIT"
    assert len(tapis_stub["submits"]) == 2


@pytest.mark.asyncio
async def test_of_two_resumes_that_both_read_the_run_as_paused_one_claim_wins(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    h = main_module.get_client(None)

    def claimed(result):
        return result["update_adapter_workflow_run"]["affected_rows"]
    assert claimed(await h.execute(main_module.RESUME_RUN_IF, {"id": run_id, "child": "a"})) == 1
    assert claimed(await h.execute(main_module.RESUME_RUN_IF, {"id": run_id, "child": "b"})) == 0
    # A retry names the child it replaces: a stale one loses too.
    assert claimed(await h.execute(main_module.RESUME_RETRY_IF, {"id": run_id, "was": "zzz", "child": "c"})) == 0
    assert claimed(await h.execute(main_module.RESUME_RETRY_IF, {"id": run_id, "was": "a", "child": "c"})) == 1
    assert STORE.run[run_id]["resumed_run_id"] == "c"


def test_a_lost_claim_submits_nothing(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    # The run is claimed by another resume between this one's reads and its claim.
    real = main_module._validate_plan_args

    def claim_first(*args, **kwargs):
        STORE.run[run_id]["resumed_run_id"] = "someone-else"
        return real(*args, **kwargs)
    monkeypatch.setattr(main_module, "_validate_plan_args", claim_first)
    lost = resume(run_id)
    assert lost.status_code == 409 and code_of(lost) == "RUN_STATUS_CHANGED"
    assert len(tapis_stub["submits"]) == 1 and STORE.run[run_id]["resumed_run_id"] == "someone-else"


def test_only_the_submitter_may_resume(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    refused = resume(run_id, headers=BOB)
    assert refused.status_code == 403 and code_of(refused) == "RUN_RESUME_FORBIDDEN"
    monkeypatch.setattr(settings, "cancel_admins", "bob")
    assert resume(run_id, headers=BOB).status_code == 403  # an admin may cancel, not edit
    assert client.post(f"/runs/{run_id}/resume", json={"replacements": {}}).status_code == 401
    assert len(tapis_stub["submits"]) == 1


def test_a_run_that_is_not_paused_cannot_be_resumed(monkeypatch, tapis_stub):
    stored_flow(monkeypatch)
    run_id = submit(plan().json()["plan_id"]).json()["run_id"]
    assert code_of(resume(run_id)) == "RUN_NOT_AWAITING_EDIT"       # still running
    assert resume("no-such-run").status_code == 404


def test_resume_is_off_when_pausing_is_off(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    monkeypatch.setattr(settings, "flow_pause_enabled", False)
    assert code_of(resume(run_id)) == "FLOW_PAUSE_DISABLED"


@pytest.mark.parametrize("url,message", [
    (f"https://elsewhere.example/dataset/ds-1/resource/res-9/download/a.json", "uploaded to the data catalog"),
    (f"http://{CATALOG}/dataset/ds-1/resource/res-9/download/a.json", "not allowed"),
    (f"tapis://ls6/scratch/alice/edits/a.json", "uploaded to the data catalog"),
    (f"https://{CATALOG}/dataset/ds-1/resource/res-9/../x.json", "must be a catalog resource download"),
    (f"https://{CATALOG}/dataset/ds-1/resource/res-9/download/%2e%2e", "must be a catalog resource download"),
    (f"https://{CATALOG}/dataset/ds-1/resource/res-9%2fdownload/a.json", "must be a catalog resource download"),
    (f"https://{CATALOG}/dataset/ds%2f../resource/res-9/download/a.json", "must be a catalog resource download"),
    (f"https://{CATALOG}/api/3/action/package_show", "must be a catalog resource download"),
    (f"https://{CATALOG}/dataset/ds-1/resource/res-9/download/a.json?sig=abc", "query or a fragment"),
    (f"https://{CATALOG}/dataset/ds-1/resource/res-9/download/a.json?", "query or a fragment"),
    (f"https://{CATALOG}/dataset/ds-1/resource/res-9/download/a.json#x", "not allowed"),
    (f"https://{CATALOG}/dataset/ds-1/resource/other/download/a.json", "not the resource at that address"),
    (f"https://user:pw@{CATALOG}/dataset/ds-1/resource/res-9/a.json", "not allowed"),
    (f"https://{CATALOG}/a b.json", "not allowed"),
])
def test_an_edit_that_is_not_a_catalog_file_is_refused_before_anything_is_submitted(monkeypatch, tapis_stub, url, message):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    refused = resume(run_id, url=url)
    assert refused.status_code == 422 and code_of(refused) == "FLOW_REPLACEMENT_REFUSED"
    assert message in refused.json()["detail"]["message"]
    assert len(tapis_stub["submits"]) == 1 and "resumed_run_id" not in STORE.run[run_id]


def test_with_no_catalog_host_set_no_edit_is_accepted(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    monkeypatch.setattr(settings, "flow_collection_catalog_host", "")
    assert code_of(resume(run_id)) == "FLOW_REPLACEMENT_REFUSED"


def test_a_resume_replaces_the_one_editable_output_and_nothing_else(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    for key in ("3:1", "2:2", "lexicon"):
        refused = resume(run_id, key=key)
        assert refused.status_code == 422 and code_of(refused) == "FLOW_REPLACEMENT_NOT_EDITABLE"
        assert refused.json()["detail"]["editable"] == ["2:1"]
    both = client.post(f"/runs/{run_id}/resume", headers=ALICE, json={"replacements": {
        "2:1": {"url": EDIT_URL}, "3:1": {"url": EDIT_URL}}})
    assert code_of(both) == "FLOW_REPLACEMENT_NOT_EDITABLE"
    assert client.post(f"/runs/{run_id}/resume", headers=ALICE, json={"replacements": {}}).status_code == 422
    assert len(tapis_stub["submits"]) == 1


def test_a_resume_cannot_carry_arguments_or_other_fields(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    for extra in ({"args": {"top_n": "1"}}, {"through_step": 3}, {"tapis_token": "x"}):
        response = client.post(f"/runs/{run_id}/resume", headers=ALICE, json={
            "replacements": {"2:1": {"url": EDIT_URL}}, **extra})
        assert response.status_code == 422
    response = client.post(f"/runs/{run_id}/resume", headers=ALICE, json={
        "replacements": {"2:1": {"url": EDIT_URL, "extra": 1}}})
    assert response.status_code == 422
    assert len(tapis_stub["submits"]) == 1


def test_a_first_segment_that_reported_nothing_for_the_paused_step_cannot_be_resumed(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    tapis_stub["details"]["tapis-run-1"]["tasks"][1] = task("step-2-etl_process")
    refused = resume(run_id)
    assert refused.status_code == 409 and code_of(refused) == "FLOW_RESUME_VALUE_MISSING"
    assert len(tapis_stub["submits"]) == 1 and "resumed_run_id" not in STORE.run[run_id]


def test_a_failed_submit_of_the_next_segment_leaves_the_run_waiting_to_try_again(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    tapis_stub["fail_submit"] = True
    failed = resume(run_id)
    assert failed.status_code == 502 and code_of(failed) == "TAPIS_WORKFLOW_SUBMISSION_FAILED"
    assert poll(run_id)["flow"]["status"] == "awaiting_edit"
    tapis_stub["fail_submit"] = False
    assert resume(run_id).status_code == 200


# ================================ the continuation ==============================================

def test_the_run_after_the_edit_shows_the_whole_flow_and_records_what_was_fetched(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    child_id = resume(run_id).json()["run_id"]
    stored = "tapis://ls6/scratch/alice/dynamo-runs/x/inputs/gather-edit/lexicon.json"
    tapis_stub["details"]["tapis-run-2"] = {"status": "ACTIVE", "tasks": [
        task("gather-edit", result=stored, carried="{}", sha256=SHA, bytes=412),
        task("step-3-etl_process", status="active")]}
    flow = poll(child_id)["flow"]
    by_step = {s["step"]: s["status"] for s in flow["steps"]}
    assert by_step == {"gather-edit": "completed", 1: "completed", 2: "completed", 3: "running", 4: "pending"}
    assert flow["status"] == "running"
    replacement = flow["replacement"]
    assert replacement["sha256"] == SHA and replacement["bytes"] == 412 and replacement["stored_as"] == stored
    assert replacement["replaced_by"] == "alice" and replacement["url"] == EDIT_URL
    recorded = [e for e in STORE.provenance if e["event_type"] == "run.input.replaced"]
    assert len(recorded) == 1 and recorded[0]["workflow_run_id"] == child_id
    assert recorded[0]["payload_json"]["sha256"] == SHA
    poll(child_id)
    assert len([e for e in STORE.provenance if e["event_type"] == "run.input.replaced"]) == 1


def test_a_continuation_that_ends_is_completed_and_a_bad_sha_is_not_recorded(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    child_id = resume(run_id).json()["run_id"]
    tapis_stub["details"]["tapis-run-2"] = {"status": "COMPLETED", "tasks": [
        task("gather-edit", result="tapis://x/y", sha256="not-a-hash"),
        task("step-3-etl_process", counts="tapis://ls6/counts"), task("step-4-etl_process", report="tapis://ls6/report")]}
    polled = poll(child_id)
    assert polled["flow"]["status"] == "completed" and STORE.run[child_id]["status"] == "completed"
    assert not [e for e in STORE.provenance if e["event_type"] == "run.input.replaced"]
    # A continuation is not itself a pause.
    assert STORE.run[child_id].get("paused_after_step") is None


def test_a_failed_continuation_puts_the_first_run_back_to_waiting_with_the_reason(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    child_id = resume(run_id).json()["run_id"]
    tapis_stub["details"]["tapis-run-2"] = {"status": "FAILED", "tasks": [
        {"task_id": "gather-edit", "status": "failed", "last_message": "lexicon.json cannot be used: no groups were found",
         "stdout": ""}]}
    assert poll(child_id)["flow"]["status"] == "failed"
    waiting = poll(run_id)["flow"]
    assert waiting["status"] == "awaiting_edit" and "lexicon.json" in waiting["resume_error"]
    # Another edit may be sent; it is a new segment two beside the failed one.
    again = resume(run_id, url=f"https://{CATALOG}/dataset/ds-1/resource/res-10/download/fixed.json", resource_id="res-10")
    assert again.status_code == 200, again.text
    assert again.json()["run_id"] not in (child_id, run_id)
    assert STORE.run[run_id]["resumed_run_id"] == again.json()["run_id"]
    assert STORE.run[child_id]["status"] == "failed"


def test_cancelling_after_a_failed_continuation_closes_the_waiting_run(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    child_id = resume(run_id).json()["run_id"]
    STORE.run[child_id].update(status="failed", error_message="bad edit")
    assert client.post(f"/runs/{run_id}/cancel", headers=ALICE).json()["awaiting_edit"] is True
    assert STORE.run[run_id]["status"] == "cancelled"


# ================================ secrets across the segments ===================================

def put_secret(name, headers=ALICE):
    body = {"fields": {"api_key": f"VALUE-{name}"}}
    assert client.put(f"/secrets/{name}", headers=headers, json=body).status_code == 200


def test_each_segment_binds_the_secrets_of_its_own_steps_when_it_is_submitted(monkeypatch, tapis_stub):
    put_secret("model_server")
    put_secret("scorer")
    _, run_id, _ = paused(monkeypatch, tapis_stub, draft_secrets=SECRET_A, score_secrets=SECRET_B)
    first = STORE.run[run_id]["bound_secrets"]
    assert [e["step"] for e in first["steps"]] == [2] and first["steps"][0]["secrets"][0]["name"] == "model_server"
    sent_first = tapis_stub["submits"][0]["args"]
    assert "step_secret_token_2" in sent_first and "step_secret_token_3" not in sent_first
    child_id = resume(run_id).json()["run_id"]
    second = STORE.run[child_id]["bound_secrets"]
    assert [e["step"] for e in second["steps"]] == [3] and second["steps"][0]["secrets"][0]["name"] == "scorer"
    sent_second = tapis_stub["submits"][1]["args"]
    assert "step_secret_token_3" in sent_second and "step_secret_token_2" not in sent_second
    assert sent_second["svo_run_id"]["value"] == child_id
    credential = sent_second["step_secret_token_3"]["value"]
    assert step_secrets.verify_credential(KEY, credential, child_id, 3, second["steps"][0]["secrets"])
    assert not step_secrets.verify_credential(KEY, credential, run_id, 3, second["steps"][0]["secrets"])
    events = [e for e in STORE.secret_event if e["event"] == "bound"]
    assert sorted((e["run_id"], e["secret_version"]) for e in events) == sorted([(run_id, 1), (child_id, 1)])
    everything = json.dumps([STORE.run, STORE.provenance, STORE.secret_event, STORE.plan,
                             [s["pipeline"] for s in tapis_stub["submits"]]])
    assert "VALUE-model_server" not in everything and "VALUE-scorer" not in everything


def test_a_resumed_segment_keeps_the_secret_checks(monkeypatch, tapis_stub):
    put_secret("model_server")
    put_secret("scorer")
    _, run_id, _ = paused(monkeypatch, tapis_stub, draft_secrets=SECRET_A, score_secrets=SECRET_B)
    # The secret the second segment needs changed after the plan was made.
    put_secret("scorer")
    changed = resume(run_id)
    assert changed.status_code == 409 and code_of(changed) == "FLOW_SECRET_CHANGED"
    assert "resumed_run_id" not in STORE.run[run_id] and len(tapis_stub["submits"]) == 1


def test_a_second_segment_whose_secret_is_gone_is_refused_naming_it(monkeypatch, tapis_stub):
    put_secret("model_server")
    put_secret("scorer")
    _, run_id, _ = paused(monkeypatch, tapis_stub, draft_secrets=SECRET_A, score_secrets=SECRET_B)
    STORE.secret.clear()
    refused = resume(run_id)
    assert refused.status_code == 422 and code_of(refused) == "FLOW_SECRET_MISSING"
    assert refused.json()["detail"]["secrets"][0]["name"] == "scorer"


def test_a_plan_made_by_someone_else_is_not_resumed_into_secrets(monkeypatch, tapis_stub):
    put_secret("model_server")
    put_secret("scorer")
    plan_id, run_id, _ = paused(monkeypatch, tapis_stub, draft_secrets=SECRET_A, score_secrets=SECRET_B)
    STORE.plan[plan_id]["plan_json"]["planned_by"] = "bob"
    refused = resume(run_id)
    assert refused.status_code == 403 and code_of(refused) == "FLOW_PLAN_NOT_YOURS"
    assert len(tapis_stub["submits"]) == 1


def test_a_piece_that_lost_its_trust_stops_a_secret_run_at_resume(monkeypatch, tapis_stub):
    put_secret("model_server")
    put_secret("scorer")
    _, run_id, _ = paused(monkeypatch, tapis_stub, draft_secrets=SECRET_A, score_secrets=SECRET_B)
    report_piece = next(r for r in STORE.transform_spec.values() if r["name"] == "report")
    report_piece["approved_source_sha256"] = None
    refused = resume(run_id)
    assert refused.status_code == 403 and code_of(refused) in ("SECRET_PIECE_NOT_TRUSTED", "STORED_SOURCE_REFUSED")
    assert len(tapis_stub["submits"]) == 1


def test_a_resume_with_secrets_refuses_a_conflict_the_way_a_submit_does(monkeypatch, tapis_stub):
    put_secret("model_server")
    put_secret("scorer")
    _, run_id, _ = paused(monkeypatch, tapis_stub, draft_secrets=SECRET_A, score_secrets=SECRET_B)
    # Another of alice's runs holds unissued secret credentials; this segment would add an
    # untrusted step beside it (the report piece is public and approved, so make it neither).
    report_piece = next(r for r in STORE.transform_spec.values() if r["name"] == "report")
    report_piece.update(owner_username="alice", visibility="private")
    STORE.run["other"] = {"id": "other", "status": "running", "submitted_by": "alice", "workflow_plan_id": "p",
                          "bound_secrets": {"steps": [{"step": 1, "issued": False, "secrets": []}]}}
    seen = []
    real = main_module._check_run_conflict

    async def spy(*args, **kwargs):
        seen.append(kwargs["secrets_here"])
        return await real(*args, **kwargs)
    monkeypatch.setattr(main_module, "_check_run_conflict", spy)
    resume(run_id)
    # The conflict rule ran for the resumed segment, with its secrets in view.
    assert seen == [True]


# ================================ the timeout ===================================================

@pytest.mark.asyncio
async def test_a_run_left_paused_too_long_is_cancelled_by_the_sweep_and_a_fresh_one_is_not(monkeypatch):
    now = datetime(2026, 12, 1, tzinfo=timezone.utc)
    old = (now - timedelta(days=15)).isoformat()
    fresh = (now - timedelta(days=13)).isoformat()
    STORE.run.update({
        "old": {"id": "old", "status": "completed", "paused_after_step": 2, "completed_at": old},
        "new": {"id": "new", "status": "completed", "paused_after_step": 2, "completed_at": fresh},
        "plain": {"id": "plain", "status": "completed", "completed_at": old},
        "busy": {"id": "busy", "status": "completed", "paused_after_step": 2, "completed_at": old,
                 "resumed_run_id": "busy-child"},
        "busy-child": {"id": "busy-child", "status": "running"},
        "retry": {"id": "retry", "status": "completed", "paused_after_step": 2, "completed_at": old,
                  "resumed_run_id": "retry-child"},
        "retry-child": {"id": "retry-child", "status": "failed"},
    })
    cancelled = await poller.sweep_paused(now)
    assert sorted(cancelled) == ["old", "retry"]
    assert STORE.run["old"]["status"] == "cancelled" and "14 days" in STORE.run["old"]["error_message"]
    assert [STORE.run[i]["status"] for i in ("new", "plain", "busy")] == ["completed"] * 3
    assert [e["payload_json"]["reason"] for e in STORE.provenance if e["event_type"] == "run.cancelled"] == [
        "paused_too_long", "paused_too_long"]
    assert await poller.sweep_paused(now) == []  # nothing is cancelled twice


# ================================ pure rules ====================================================

def test_the_editable_shape_is_checked_in_one_place():
    assert flow_graph.editable_problem({"file": "a.json"}) is None
    assert flow_graph.editable_problem({"file": "a.json", "check": "lexicon", "key": "lexicon_uri"}) is None
    for bad in (None, {}, {"file": ""}, {"file": "../a"}, {"file": ".hidden"}, {"file": "a", "check": "yaml"},
                {"file": "a", "key": "Bad Key"}, {"file": "a", "other": 1}, {"file": "x" * 300}):
        assert flow_graph.editable_problem(bad)


def test_a_plan_with_no_pause_has_no_pause_problem():
    assert flow_segments.problem({"steps": [], "flow": {"outputs": []}}) is None
    assert flow_segments.paused_steps({}) == []


# ================================ review findings ===============================================

def test_the_resource_id_is_required_and_must_be_the_one_in_the_address(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    body = {"replacements": {"2:1": {"url": EDIT_URL}}}
    refused = client.post(f"/runs/{run_id}/resume", headers=ALICE, json=body)
    assert refused.status_code == 422 and code_of(refused) == "FLOW_REPLACEMENT_REFUSED"
    assert "resource_id is required" in refused.json()["detail"]["message"]
    assert len(tapis_stub["submits"]) == 1


def test_only_a_plain_resource_download_is_accepted(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    assert resume(run_id, url=f"https://{CATALOG}/dataset/ds%2D1/resource/res-9/download/a%20b.json").status_code == 200


def test_the_edited_files_address_is_an_argument_of_the_run_not_part_of_the_pipeline(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    assert resume(run_id).status_code == 200
    sent = tapis_stub["submits"][1]
    assert sent["args"]["resume_edit_url"] == {"value": EDIT_URL}
    assert "res-9" not in json.dumps(sent["pipeline"]) and CATALOG + "/dataset" not in json.dumps(sent["pipeline"])


def test_the_run_token_is_minted_only_for_a_resume_that_won_the_claim(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    minted = []
    real = main_module._with_run_token

    async def spy(args, token):
        minted.append(token)
        return await real(args, token)
    monkeypatch.setattr(main_module, "_with_run_token", spy)
    STORE.run[run_id]["resumed_run_id"] = "someone-else"
    STORE.run["someone-else"] = {"id": "someone-else", "status": "running"}
    assert resume(run_id).status_code == 409
    assert minted == []


def test_a_resume_that_fails_before_its_segment_is_recorded_gives_the_claim_back(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    real = main_module.INSERT_RUN

    class Down(Exception):
        pass

    original = main_module.get_client

    def failing_client(token):
        h = original(token)
        execute = h.execute

        async def run(query, variables=None):
            if query is real:
                raise Down("hasura went away")
            return await execute(query, variables)
        h.execute = run
        return h
    monkeypatch.setattr(main_module, "get_client", failing_client)
    with pytest.raises(Down):
        resume(run_id)
    monkeypatch.setattr(main_module, "get_client", original)
    assert not STORE.run[run_id].get("resumed_run_id")
    assert len(tapis_stub["submits"]) == 1
    # Still paused, and a second try goes through.
    assert poll(run_id)["flow"]["status"] == "awaiting_edit"
    assert resume(run_id).status_code == 200


def test_a_claim_naming_a_run_that_was_never_recorded_is_still_a_pause(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    STORE.run[run_id]["resumed_run_id"] = "never-written"
    flow = poll(run_id)["flow"]
    assert flow["status"] == "awaiting_edit" and "not started" in flow["resume_error"]
    retry = resume(run_id)
    assert retry.status_code == 200, retry.text
    assert STORE.run[run_id]["resumed_run_id"] == retry.json()["run_id"]


@pytest.mark.asyncio
async def test_the_sweep_treats_a_never_recorded_child_as_a_pause_and_counts_from_the_last_failure():
    now = datetime(2026, 12, 1, tzinfo=timezone.utc)
    old = (now - timedelta(days=15)).isoformat()
    recent = (now - timedelta(days=2)).isoformat()
    STORE.run.update({
        "lost": {"id": "lost", "status": "completed", "paused_after_step": 2, "completed_at": old,
                 "resumed_run_id": "gone"},
        "retried": {"id": "retried", "status": "completed", "paused_after_step": 2, "completed_at": old,
                    "resumed_run_id": "retried-child"},
        "retried-child": {"id": "retried-child", "status": "failed", "created_at": recent, "dispatched_at": recent},
    })
    assert await poller.sweep_paused(now) == ["lost"]
    assert STORE.run["retried"]["status"] == "completed"   # waiting again for only two days
    later = now + timedelta(days=13)
    assert await poller.sweep_paused(later) == ["retried"]
    assert STORE.provenance[-1]["payload_json"]["counted_from"].startswith("2026-11-29")


def test_a_poll_of_a_run_that_was_resumed_names_the_run_that_followed(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    child_id = resume(run_id).json()["run_id"]
    flow = poll(run_id)["flow"]
    assert flow["status"] == "resumed" and flow["resumed_run_id"] == child_id


def test_a_reported_value_that_looks_like_a_credential_or_a_bad_address_is_not_passed_on(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln"
    for bad in (jwt, "file:///etc/passwd", "https://user:pw@evil.example/x", "tapis://ls6/a b"):
        tapis_stub["details"]["tapis-run-1"]["tasks"][0] = task("step-1-etl_process", result=bad)
        refused = resume(run_id)
        assert refused.status_code == 409 and code_of(refused) == "FLOW_RESUME_VALUE_REFUSED", bad
        assert refused.json()["detail"]["arguments"] == ["resume_step1_output_1"]
    assert len(tapis_stub["submits"]) == 1 and not STORE.run[run_id].get("resumed_run_id")
    # A summary is checked key by key.
    tapis_stub["details"]["tapis-run-1"]["tasks"][0] = task("step-1-etl_process", result="tapis://ls6/scratch/ok")
    tapis_stub["details"]["tapis-run-1"]["tasks"][1] = task(
        "step-2-etl_process", result=json.dumps({**DRAFT, "taxonomy_uri": "javascript:alert(1)"}))
    assert code_of(resume(run_id)) == "FLOW_RESUME_VALUE_REFUSED"


def test_free_text_values_are_checked_for_a_credential_only():
    needed = [{"arg": "resume_a", "kind": "step", "step": 1, "output_id": "value_note"},
              {"arg": "resume_b", "kind": "step", "step": 1, "output_id": "result"}]
    assert flow_segments.refused_values({"resume_a": "just some words", "resume_b": "tapis://ls6/x"}, needed) == []
    assert flow_segments.refused_values({"resume_a": "just some words", "resume_b": "words"}, needed) == ["resume_b"]
    assert flow_segments.refused_values({"resume_a": "gAAAAAB-secret", "resume_b": "tapis://ls6/x"}, needed) == ["resume_a"]


def test_a_setting_named_like_a_resume_argument_is_refused_when_the_flow_is_planned(monkeypatch):
    steps = flow_steps()
    stored_flow(monkeypatch, steps=steps)
    plan_json = plan().json()["plan_json"]
    assert flow_segments.reserved_parameters(plan_json) == []
    plan_json["parameters"].append({"name": "resume_step1_output_1", "type": "string"})
    assert flow_segments.reserved_parameters(plan_json) == ["resume_step1_output_1"]
    with pytest.raises(main_module.HTTPException) as caught:
        main_module._check_pause_builds(plan_json, "cfg-1")
    assert caught.value.detail["code"] == "FLOW_PARAMETER_RESERVED"


def test_a_user_value_is_never_overwritten_by_a_reported_one(monkeypatch, tapis_stub):
    _, run_id, _ = paused(monkeypatch, tapis_stub)
    STORE.run[run_id]["segment_json"]["args"]["resume_step1_output_1"] = {"value": "the user's"}
    refused = resume(run_id)
    assert refused.status_code == 409 and code_of(refused) == "FLOW_RESUME_ARGUMENT_CLASH"
    assert len(tapis_stub["submits"]) == 1
    assert STORE.run[run_id]["segment_json"]["args"]["resume_step1_output_1"] == {"value": "the user's"}
