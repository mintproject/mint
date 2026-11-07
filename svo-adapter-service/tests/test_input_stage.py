"""Input-side ETL in the model bridge: the AOI piece, the generated DAG, the
model task's staging of produced inputs, /plans/input and composite submit
(design 2026-11-05-aoi-etl-piece.md). Tapis is stubbed throughout."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).parent))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main as main_module  # noqa: E402
from app import tapis  # noqa: E402
from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402
from app.planner import build_plan_json  # noqa: E402
from app.store import STORE  # noqa: E402
from app.task_code import get_code  # noqa: E402
from input_stage_fixtures import GOLDEN_PLAN, model_row  # noqa: E402

client = TestClient(app)
AOI_VAR = "https://w3id.org/okn/i/mint/area_of_interest__boundary"
AOI_SPEC = json.loads((ROOT / "examples" / "aoi_transforms.json").read_text())["transform_specs"][0]
SCRATCH = "/scratch/06659/wmobley"
STAGING = f"{SCRATCH}/dynamo-runs/ue-test-1/inputs"
SQUARE = {"type": "Polygon", "coordinates": [[[-97.3, 31.4], [-96.9, 31.4], [-96.9, 31.7], [-97.3, 31.7], [-97.3, 31.4]]]}


# --- the aoi_from_boundary function task -----------------------------------------
def run_aoi(source, **env):
    child_env = {k: v for k, v in os.environ.items() if k not in {"BUFFER_M", "SIMPLIFY_M", "DISSOLVE"}}
    child_env.update({"SOURCE": source if isinstance(source, str) else json.dumps(source),
                      **{k.upper(): str(v) for k, v in env.items()}})
    # The task hands its GeoJSON to the workflow engine via ctx.set_output (stdout carries only
    # a digest), so stub the SDK context and print what it receives.
    stub = (
        "import sys, types\n"
        "_m = types.ModuleType('owe_python_sdk.runtime.execution_context')\n"
        "_m.get_input = lambda name: None\n"
        "_m.set_output = lambda k, v: print('RESULT:' + v)\n"
        "for _n in ('owe_python_sdk', 'owe_python_sdk.runtime'):\n"
        "    sys.modules[_n] = types.ModuleType(_n)\n"
        "sys.modules['owe_python_sdk.runtime'].execution_context = _m\n"
        "sys.modules['owe_python_sdk.runtime.execution_context'] = _m\n")
    proc = subprocess.run([sys.executable, "-I", "-c", stub + get_code("aoi_from_boundary")],
                          env=child_env, capture_output=True, text=True, timeout=60)
    result = [ln[7:] for ln in proc.stdout.splitlines() if ln.startswith("RESULT:")]
    return proc.returncode, (result[0] if result else proc.stdout.strip())


def only_feature(out):
    collection = json.loads(out)
    assert collection["type"] == "FeatureCollection" and len(collection["features"]) == 1
    return collection["features"][0]["geometry"]


def test_bbox_string_becomes_one_rounded_polygon_deterministically():
    for text in ("-97.3 31.4 -96.9 31.7", "-97.3, 31.4, -96.9,31.7"):
        code, out = run_aoi(text)
        assert code == 0, out
        assert only_feature(out) == {"type": "Polygon", "coordinates": SQUARE["coordinates"]}
    assert run_aoi("-97.3 31.4 -96.9 31.7") == run_aoi("-97.3 31.4 -96.9 31.7")
    code, out = run_aoi("-97.123456789 31.4 -96.9 31.7")
    assert only_feature(out)["coordinates"][0][0] == [-97.1234568, 31.4]
    assert out == json.dumps(json.loads(out), sort_keys=True, separators=(",", ":"))


@pytest.mark.parametrize("wrap", [
    lambda g: g,
    lambda g: {"type": "Feature", "properties": {}, "geometry": g},
    lambda g: {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": g}]},
])
def test_polygon_passes_through_as_geometry_feature_or_collection(wrap):
    code, out = run_aoi(wrap(SQUARE))
    assert code == 0, out
    assert only_feature(out) == SQUARE


def test_several_polygons_dissolve_into_one_multipolygon_feature():
    other = {"type": "Polygon", "coordinates": [[[-96.0, 31.0], [-95.9, 31.0], [-95.9, 31.1], [-96.0, 31.1], [-96.0, 31.0]]]}
    collection = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": SQUARE}, {"type": "Feature", "geometry": other}]}
    code, out = run_aoi(collection)
    assert code == 0, out
    geometry = only_feature(out)
    assert geometry["type"] == "MultiPolygon" and len(geometry["coordinates"]) == 2
    code, out = run_aoi(collection, dissolve="false")
    assert code != 0 and "dissolve" in out


def test_geojson_nested_in_a_boundary_result_blob_is_found():
    blob = {"schema_version": 1, "status": "ok",
            "result": json.dumps({"data": {"features": [{"type": "Feature", "geometry": SQUARE}]}})}
    code, out = run_aoi(blob)
    assert code == 0, out
    assert only_feature(out) == SQUARE
    assert run_aoi(json.dumps(blob))[1] == out


def test_the_object_source_forms_from_the_ensemble_manager_are_accepted():
    code, out = run_aoi({"kind": "geojson", "geometry": SQUARE})
    assert code == 0, out
    assert only_feature(out) == SQUARE
    code, out = run_aoi({"kind": "bbox", "bbox": [-97.3, 31.4, -96.9, 31.7]})
    assert code == 0 and only_feature(out) == SQUARE
    assert run_aoi({"kind": "bbox", "bbox": [1, 2, 3]})[0] != 0


def test_bbox_only_replaces_the_geometry_with_its_box():
    triangle = {"type": "Polygon", "coordinates": [[[-97.0, 31.0], [-96.0, 31.0], [-96.5, 32.0], [-97.0, 31.0]]]}
    code, out = run_aoi(triangle, bbox_only="true")
    assert code == 0, out
    assert only_feature(out)["coordinates"][0] == [[-97.0, 31.0], [-96.0, 31.0], [-96.0, 32.0], [-97.0, 32.0], [-97.0, 31.0]]


def test_area_cap_hard_fails_and_never_degrades():
    code, out = run_aoi("-110 25 -90 40")
    assert code != 0 and "region too large" in out and '"status": "error"' in out
    assert run_aoi("-110 25 -90 40", max_area_km2=10_000_000)[0] == 0


@pytest.mark.parametrize("source,needle", [
    ({"type": "Point", "coordinates": [-97, 31]}, "polygon"),
    ({"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]}}]}, "polygon"),
    ("", "empty input"),
    ({"type": "FeatureCollection", "features": []}, "empty input"),
    ("not geojson at all", "no GeoJSON"),
    ({"type": "Polygon", "coordinates": [[[500000, 3500000], [500100, 3500000], [500100, 3500100], [500000, 3500000]]]}, "projected"),
])
def test_bad_input_fails_with_a_clear_message(source, needle):
    code, out = run_aoi(source)
    assert code != 0 and needle in out


# --- the generated pipeline --------------------------------------------------------
def aoi_chain(name="aoi", app_input="aoi-geojson", source="-97.3 31.4 -96.9 31.7", params=None):
    spec = {**AOI_SPEC, "parameters_schema_json": {
        **AOI_SPEC["parameters_schema_json"], "tapis": {"env_from_args": AOI_SPEC["env_from_args"]}}}
    plan = build_plan_json([spec])
    return {"name": name, "app_input_name": app_input, "steps": plan["steps"],
            "source": source, "params": params or {}}


def composite(input_steps=None, **job):
    plan = json.loads(json.dumps(GOLDEN_PLAN))
    task = plan["plan_json"]["model_task"]
    task["job_definition"].update(job)
    if input_steps is not None:
        task["input_steps"] = input_steps
    return plan


def test_no_input_steps_leaves_the_pipeline_byte_identical():
    golden = (Path(__file__).parent / "golden" / "composite_pipeline_no_inputs.json").read_text()
    pipeline = tapis.generate_tapis_workflow(composite())
    assert json.dumps(pipeline, indent=1, sort_keys=True) + "\n" == golden
    assert "input_staging_dir" not in pipeline["params"]


def test_input_tasks_precede_the_model_and_leave_the_post_model_chain_alone():
    pipeline = tapis.generate_tapis_workflow(composite([aoi_chain()]))
    ids = [t["id"] for t in pipeline["tasks"]]
    assert ids[:2] == ["in0-step-0-aoi_from_boundary", "model"]
    by_id = {t["id"]: t for t in pipeline["tasks"]}
    aoi, model = by_id["in0-step-0-aoi_from_boundary"], by_id["model"]

    assert aoi["type"] == "function" and "depends_on" not in aoi
    assert aoi["execution_profile"] == {"max_retries": 1, "max_exec_time": 600}
    assert aoi["input"]["SOURCE"]["value_from"] == {"args": "in0_source"}
    assert aoi["input"]["BUFFER_M"]["value_from"] == {"args": "in0_buffer_m"}
    for forbidden in ("CREDENTIALS_URL", "SIGNAL_URL", "SIGNAL_TOKEN", "TOKEN_URL", "TOKEN_FETCH_TOKEN", "TAPIS_TOKEN"):
        assert forbidden not in aoi["input"]
    # No input task may read the model's outputs (that would be a cycle).
    assert '"model"' not in json.dumps(aoi)

    assert model["depends_on"] == [{"id": "in0-step-0-aoi_from_boundary"}]
    assert model["input"]["INPUT_0"]["value_from"] == {
        "task_output": {"task_id": "in0-step-0-aoi_from_boundary", "output_id": "result"}}
    assert model["input"]["INPUT_STAGING_DIR"]["value_from"] == {"args": "input_staging_dir"}
    # Post-model steps still chain from the model result, not from an input task.
    first_post = by_id["step-0-budget_extract_drain"]
    assert first_post["input"]["SOURCE_URI"]["value_from"]["task_output"]["task_id"] == "model"
    assert {"id": "model"} in first_post["depends_on"]
    assert "in0_source" in pipeline["params"] and "in0_max_area_km2" in pipeline["params"]
    assert pipeline["params"]["in0_max_area_km2"]["default"] == 160000


def test_two_chains_get_namespaced_ids_and_args():
    pipeline = tapis.generate_tapis_workflow(composite([aoi_chain(), aoi_chain("aoi2", "other-aoi")]))
    ids = [t["id"] for t in pipeline["tasks"]]
    assert ids[:3] == ["in0-step-0-aoi_from_boundary", "in1-step-0-aoi_from_boundary", "model"]
    model = pipeline["tasks"][2]
    assert model["depends_on"] == [{"id": ids[0]}, {"id": ids[1]}]
    assert {"in0_source", "in1_source", "in0_dissolve", "in1_dissolve"} <= set(pipeline["params"])
    assert tapis.input_stage_arg_names([aoi_chain(), aoi_chain("b", "c")]) >= {"in1_bbox_only", "in0_source"}


def test_a_chain_feeds_each_step_the_previous_result():
    chain = aoi_chain()
    chain["steps"] = [chain["steps"][0], {**chain["steps"][0], "step": 1, "depends_on": [0]}]
    tasks = tapis.generate_tapis_workflow(composite([chain]))["tasks"]
    second = tasks[1]
    assert second["id"] == "in0-step-1-aoi_from_boundary"
    assert second["depends_on"] == [{"id": "in0-step-0-aoi_from_boundary"}]
    assert second["input"]["SOURCE"]["value_from"] == {
        "task_output": {"task_id": "in0-step-0-aoi_from_boundary", "output_id": "result"}}
    assert tasks[2]["input"]["INPUT_0"]["value_from"]["task_output"]["task_id"] == second["id"]


def test_the_model_code_compiles_and_carries_the_staging_logic():
    model = tapis.generate_tapis_workflow(composite([aoi_chain()]))["tasks"][1]
    compile(model["code"], "model", "exec")
    assert "INPUT_CONFLICT" in model["code"] and "/v3/files/ops/" in model["code"]
    assert "_stage_inputs(_definition)" in model["code"]
    assert "'aoi-geojson'" in model["code"] or '"aoi-geojson"' in model["code"]


# --- executing the generated model task against a stubbed Tapis --------------------
class FakeTapis:
    def __init__(self):
        self.files, self.submits = [], []

    def urlopen(self, request, timeout=None):
        url = request.full_url if hasattr(request, "full_url") else str(request)
        path = url.split("tapis.test", 1)[1]
        method = request.get_method() if hasattr(request, "get_method") else "GET"
        if path.startswith("/v3/files/ops/") and method == "POST":
            self.files.append({"path": path, "body": request.data, "content_type": request.get_header("Content-type")})
            payload = {"status": "success"}
        elif path.startswith("/v3/jobs/submit"):
            self.submits.append(json.loads(request.data))
            payload = {"result": {"uuid": "job-1"}}
        elif path.startswith("/v3/jobs/job-1/status"):
            payload = {"result": {"status": "FINISHED"}}
        elif path.startswith("/v3/jobs/job-1/output/list"):
            # One page; the task pages until an empty one.
            first_page = "skip=0" in request.full_url
            payload = {"result": [{"name": "model.cbb", "path": "/out/model.cbb"}] if first_page else []}
        elif path.startswith("/v3/jobs/job-1"):
            payload = {"result": {"archiveSystemId": "ls6"}}
        elif path.startswith("/v3/jobs/list"):
            payload = {"result": []}
        else:
            raise AssertionError(f"unexpected request {method} {path}")
        body = json.dumps(payload).encode()

        class Response:
            def __enter__(self_inner): return self_inner
            def __exit__(self_inner, *exc): return False
            def read(self_inner): return body
            def getcode(self_inner): return 200
        return Response()


def run_model_code(monkeypatch, file_inputs=()):
    fake = FakeTapis()
    pipeline = tapis.generate_tapis_workflow(composite(
        [aoi_chain()], execSystemId="ls6", fileInputs=list(file_inputs)))
    code = pipeline["tasks"][1]["code"]
    content = json.dumps({"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": SQUARE}]})
    for key, value in {"TAPIS_BASE_URL": "https://tapis.test", "TAPIS_TOKEN": "t.t.t",
                       "INPUT_0": content, "INPUT_STAGING_DIR": STAGING}.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr("urllib.request.urlopen", fake.urlopen)
    monkeypatch.setattr("time.sleep", lambda *_: None)
    scope = {"__name__": "__main__"}
    return fake, content, scope, lambda: exec(compile(code, "model", "exec"), scope)


def test_model_task_writes_the_input_to_files_and_submits_one_file_input(monkeypatch):
    fake, content, scope, run = run_model_code(monkeypatch)
    run()
    assert len(fake.files) == 1
    written = fake.files[0]
    assert written["path"] == f"/v3/files/ops/ls6{STAGING}/aoi.geojson"
    assert written["content_type"].startswith("multipart/form-data; boundary=")
    assert b'name="file"' in written["body"] and content.encode() in written["body"]
    uri = f"tapis://ls6/scratch/06659/wmobley/dynamo-runs/ue-test-1/inputs/aoi.geojson"
    assert fake.submits[0]["fileInputs"] == [{"name": "aoi-geojson", "sourceUrl": uri}]
    # The attempts record carries the hash and URI, never the content.
    stage = next(a for a in scope["_attempts"] if a.get("method") == "STAGE")
    assert stage["uri"] == uri and len(stage["sha256"]) == 64
    assert "FeatureCollection" not in json.dumps(scope["_attempts"])


def test_a_bound_dataset_with_the_same_input_name_is_a_conflict_and_nothing_is_written(monkeypatch):
    bound = {"name": "aoi-geojson", "sourceUrl": "tapis://ls6/some/dataset.geojson"}
    fake, _, _, run = run_model_code(monkeypatch, file_inputs=[bound])
    with pytest.raises(RuntimeError, match="INPUT_CONFLICT"):
        run()
    assert fake.files == [] and fake.submits == []


def test_a_different_bound_input_is_kept_next_to_the_produced_one(monkeypatch):
    other = {"name": "other", "sourceUrl": "tapis://ls6/x.txt"}
    fake, _, _, run = run_model_code(monkeypatch, file_inputs=[other])
    run()
    assert [i["name"] for i in fake.submits[0]["fileInputs"]] == ["other", "aoi-geojson"]


# --- the registered piece ----------------------------------------------------------
def test_the_piece_registers_without_conflict_and_declares_the_aoi_contract():
    sys.path.insert(0, str(ROOT / "scripts"))
    import register_existing_etl_pieces as reg
    rows = reg.unique_rows(reg.manifests(ROOT / "examples"))
    row = next(r for r in rows if r["id"] == "ts-aoi-from-boundary")
    contracts = row["contracts"]["data"]
    assert [c["role"] for c in contracts] == ["input", "output"]
    assert contracts[0]["standard_variable_uri"] is None and contracts[0]["format"] == "geojson"
    assert contracts[1]["standard_variable_uri"] == AOI_VAR and contracts[1]["crs_requirement"] == "EPSG:4326"


# --- /plans/model-inputs and composite submit ---------------------------------------
EM = {"X-Ensemble-Manager-Secret": "em-secret"}
BEARER = {"Authorization": "Bearer caller.jwt.token"}
BBOX = {"kind": "bbox", "bbox": [-97.3, 31.4, -96.9, 31.7]}


@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    monkeypatch.setattr(settings, "internal_service_secret", "em-secret")
    monkeypatch.setattr("app.main.tapis.userinfo_username", lambda token: "alice")
    client.post("/admin/reset")


def register_aoi_piece(model=True):
    assert client.post("/transform-specs", headers=BEARER, json=AOI_SPEC).status_code == 200
    if model:
        STORE.transform_spec["model-row"] = model_row()


def plan_inputs(**over):
    return client.post("/plans/model-inputs", headers=BEARER, json={
        "configuration_id": "cfg-1", "sources": [BBOX], "filled_app_inputs": [], **over})


def test_plans_model_inputs_returns_the_step_without_writing_a_plan_row():
    register_aoi_piece()
    response = plan_inputs()
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["registry"] == "ok" and len(body["steps_digest"]) == 64
    [item] = body["input_steps"]
    assert item["name"] == item["app_input_name"] == "aoi-geojson" and item["extension"] == "geojson"
    assert [s["transform_type"] for s in item["steps"]] == ["aoi_from_boundary"]
    assert item["source"] == BBOX and item["params"]["max_area_km2"] == 160000
    assert item["derivation"]["method"] == "bbox" and item["derivation"]["vertices_in"] == 4
    assert [(c["app_input_name"], c["outcome"]) for c in body["considered"]] == [("aoi-geojson", "planned")]
    assert not STORE.plan
    assert plan_inputs(sources=[{"kind": "geojson", "geometry": SQUARE}]).status_code == 200


def test_plans_model_inputs_errors_are_422_with_code_and_message():
    register_aoi_piece()
    response = plan_inputs(sources=[{"kind": "bbox", "bbox": [-120, 20, -80, 45]}])
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "AOI_REGION_TOO_LARGE"
    assert response.json()["detail"]["message"]
    assert plan_inputs(sources=[{"kind": "wkt"}]).json()["detail"]["code"] == "INPUT_SOURCE_INVALID"
    assert plan_inputs(sources=[]).status_code == 422


@pytest.fixture
def submit(monkeypatch):
    captured = {"submits": [], "roots": []}

    def fake_submit(pipeline, args, **kwargs):
        captured["submits"].append({"pipeline": pipeline, "args": args})
        return {"uuid": "tapis-run-1", "pipelineId": pipeline["id"], "tapisStatus": "submitted"}

    async def passthrough(args, caller_token):
        return args

    def fake_root(token, username, system):
        captured["roots"].append((username, system))
        return captured.get("root", SCRATCH)

    monkeypatch.setattr("app.main.tapis.submit_tapis_workflow", fake_submit)
    monkeypatch.setattr("app.main._with_run_token", passthrough)
    monkeypatch.setattr("app.main.tapis.resolve_scratch_root", fake_root)
    register_aoi_piece()
    seed = client.post("/admin/seed-subside-werc").json()
    plan_id = client.post("/plans", json={
        "data_object_id": seed["data_object"]["id"],
        "target_contract": seed["target_contract"]}).json()["plan_id"]

    def do(input_sources="default", dry_run=False, args=None, task=None, **job):
        if input_sources == "default":
            input_sources = [{**BBOX, "derivation": {"region_id": "waco"}}]
        model_task = {"stage_id": "model", "output_name": "o", "output_format": "tif", "max_minutes": 5,
                      "configuration_id": "cfg-1",
                      "job_definition": {"name": "mint-workflow-model-x", "appId": "app", "appVersion": "1",
                                         "execSystemId": "ls6", "fileInputs": [], "parameterSet": {"appArgs": []},
                                         **job},
                      "input_sources": input_sources, **(task or {})}
        return client.post("/workflows/submit", headers={**BEARER, **EM}, json={
            "plan_id": plan_id, "execution_id": "ue-test-1", "dry_run": dry_run,
            "args": {"start_date": "2024-01-01", "end_date": "2025-01-01", "allocation": "A",
                     "aoi_geojson_uri": "tapis://ls6/demo/aoi.geojson", "min_overlap_percent": "50",
                     "num_workers": "4", "reference_mode": "auto", **(args or {})},
            "model_task": model_task})

    captured["submit"] = do
    return captured


def test_submit_with_input_sources_resolves_staging_from_job_history(submit):
    response = submit["submit"](args={"input_staging_dir": "/etc", "in0_source": "evil"})
    assert response.status_code == 200, response.text
    sent = submit["submits"][0]
    assert sent["args"]["input_staging_dir"]["value"] == STAGING
    assert json.loads(sent["args"]["in0_source"]["value"]) == BBOX
    assert sent["args"]["in0_max_area_km2"]["value"] == 160000
    assert submit["roots"] == [("alice", "ls6")]
    assert "in0-step-0-aoi_from_boundary" in [t["id"] for t in sent["pipeline"]["tasks"]]
    event = next(e for e in STORE.provenance if e["event_type"] == "run.input.planned")
    payload = event["payload_json"]
    assert [(i["name"], i["app_input_name"], i["step_ids"]) for i in payload["inputs"]] == [
        ("aoi-geojson", "aoi-geojson", ["in0-step-0-aoi_from_boundary"])]
    assert payload["inputs"][0]["derivation"]["region_id"] == "waco"
    assert payload["considered"][0]["outcome"] == "planned" and len(payload["steps_digest"]) == 64
    assert "31.4" not in json.dumps(STORE.provenance)  # the source lives in args, not provenance
    assert "region_id" not in json.dumps(sent["pipeline"]) and "region_id" not in json.dumps(sent["args"])


def test_submit_matches_the_preview_digest_and_rejects_a_changed_plan(submit):
    digest = plan_inputs(sources=[{**BBOX, "derivation": {"region_id": "waco"}}]).json()["steps_digest"]
    assert submit["submit"](task={"expected_steps_digest": digest}).status_code == 200
    changed = submit["submit"](task={"expected_steps_digest": "0" * 64})
    assert changed.status_code == 409 and changed.json()["detail"]["code"] == "INPUT_PLAN_CHANGED"


def test_a_filled_input_is_skipped_and_the_pipeline_has_no_input_tasks(submit):
    bound = {"name": "aoi-geojson", "sourceUrl": "tapis://ls6/some/dataset.geojson"}
    for kwargs in ({"fileInputs": [bound]}, {"task": {"filled_app_inputs": ["aoi-geojson"]}}):
        response = submit["submit"](dry_run=True, **kwargs)
        assert response.status_code == 200, response.text
        assert "in0_source" not in response.json()["args"]
    assert submit["roots"] == []


def test_submit_with_input_steps_is_unsupported(submit):
    response = submit["submit"](task={"input_steps": [{"name": "aoi"}]})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "INPUT_STEPS_UNSUPPORTED"
    assert "input_sources" in response.json()["detail"]["message"]
    assert not STORE.run and not submit["submits"]


def test_submit_rejects_a_model_missing_from_the_registry_or_on_another_app(submit):
    missing = submit["submit"](task={"configuration_id": "cfg-unknown"})
    assert missing.status_code == 422 and missing.json()["detail"]["code"] == "MODEL_NOT_IN_REGISTRY"
    mismatch = submit["submit"](appId="other-app")
    assert mismatch.status_code == 422 and mismatch.json()["detail"]["code"] == "MODEL_APP_MISMATCH"
    assert not STORE.run and not submit["submits"]


def test_submit_with_a_required_input_and_no_path_is_422_with_considered(submit):
    STORE.transform_spec["model-row"] = model_row(inputs=[
        ("needed", False, "ds-x", "https://w3id.org/okn/i/mint/county__boundary", "geojson")])
    response = submit["submit"]()
    detail = response.json()["detail"]
    assert response.status_code == 422 and detail["code"] == "NO_INPUT_TRANSFORM_PATH"
    assert detail["considered"][0]["outcome"] == "no_path" and detail["considered"][0]["blocking"] is True
    assert not STORE.run


def test_submit_without_job_history_is_a_structured_422_and_queues_nothing(submit):
    submit["root"] = None
    response = submit["submit"]()
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "INPUT_STAGING_UNRESOLVED"
    assert "run any job on ls6 once, or bind a dataset to aoi-geojson" in detail["message"]
    assert not STORE.run and not submit["submits"]


def test_object_sources_become_json_args_and_derivation_is_provenance_only(submit):
    derivation = {"method": "region_geometry", "region_id": "waco", "vertices_in": 5, "bytes": 120}
    source = {"kind": "geojson", "geometry": SQUARE, "derivation": derivation}
    response = submit["submit"](input_sources=[source])
    assert response.status_code == 200, response.text
    sent = submit["submits"][0]
    assert json.loads(sent["args"]["in0_source"]["value"]) == {"kind": "geojson", "geometry": SQUARE}
    assert "derivation" not in json.dumps(sent["pipeline"]) and "region_id" not in json.dumps(sent["args"])
    event = next(e for e in STORE.provenance if e["event_type"] == "run.input.planned")
    recorded = event["payload_json"]["inputs"][0]["derivation"]
    assert recorded["method"] == "region_geometry" and recorded["region_id"] == "waco"
    assert recorded["vertices_in"] == 5 and recorded["area_km2"] > 0
    for bad in ({"kind": "wkt", "wkt": "POINT(0 0)"}, {"kind": "bbox", "bbox": [1, 2]}, {"kind": "geojson"}):
        rejected = submit["submit"](input_sources=[bad])
        assert rejected.status_code == 422 and rejected.json()["detail"]["code"] == "INPUT_SOURCE_INVALID"


def test_deferred_plan_accepts_format_only_contracts_and_plans_zero_steps():
    response = client.post("/plans/deferred", headers=BEARER, json={
        "source_contract": {"format": "tif"}, "target_contract": {"format": "tif"},
        "model_output_key": "o"})
    assert response.status_code == 200, response.text
    assert response.json()["plan_json"]["steps"] == []


def test_submit_dry_run_does_not_resolve_staging(submit):
    response = submit["submit"](dry_run=True)
    assert response.status_code == 200, response.text
    assert submit["roots"] == []
    assert "in0_source" in response.json()["args"]


def test_submit_rejects_secrets_in_the_model_task(submit):
    cases = [
        ([{**BBOX, "derivation": {"note": "Bearer abc.def"}}], "COMPOSITE_MODEL_TASK_SECRET"),
        ([{**BBOX, "tapis_token": "abc"}], "COMPOSITE_MODEL_TASK_SECRET"),
    ]
    for sources, code in cases:
        response = submit["submit"](input_sources=sources)
        assert response.status_code == 422 and response.json()["detail"]["code"] == code, (code, response.text)
    assert not STORE.run and not submit["submits"]


def _fake_jobs_api(monkeypatch, search_rows=None, list_rows=None, details=None):
    """Patch requests.get for /v3/jobs/search|list and tapis.get_job; return the call log."""
    calls = {"get": [], "detail": []}

    class Resp:
        ok = True
        def __init__(self, rows): self.rows = rows
        def json(self): return {"result": self.rows}

    def fake_get(url, params=None, headers=None, timeout=None):
        calls["get"].append((url, params, headers))
        return Resp(search_rows if url.endswith("/v3/jobs/search") else list_rows or [])

    def fake_get_job(token, uuid):
        calls["detail"].append((token, uuid))
        return (details or {}).get(uuid)

    monkeypatch.setattr("requests.get", fake_get)
    monkeypatch.setattr(tapis, "get_job", fake_get_job)
    monkeypatch.setattr(tapis, "_SCRATCH_ROOTS", {})
    return calls


def test_resolve_scratch_root_searches_jobs_on_the_system_and_caches(monkeypatch):
    calls = _fake_jobs_api(monkeypatch, search_rows=[
        {"uuid": "a"}, {"uuid": "b", "execSystemExecDir": f"{SCRATCH}/tapis/abc-123"}], details={})
    assert tapis.resolve_scratch_root("tok", "wmobley", "ls6") == SCRATCH
    assert tapis.resolve_scratch_root("tok", "wmobley", "ls6") == SCRATCH
    url, params, headers = calls["get"][0]
    assert len(calls["get"]) == 1 and url.endswith("/v3/jobs/search")
    assert params["execSystemId.eq"] == "ls6" and "execSystemExecDir" in params["select"]
    assert headers["X-Tapis-Token"] == "tok"
    # The row without the directory was read in full before the one that had it.
    assert calls["detail"] == [("tok", "a")]


def test_resolve_scratch_root_reads_job_details_when_search_omits_the_dir(monkeypatch):
    calls = _fake_jobs_api(monkeypatch, search_rows=[{"uuid": "j1"}, {"uuid": "j2"}],
                           details={"j2": {"execSystemExecDir": f"{SCRATCH}/tapis/j2"}})
    assert tapis.resolve_scratch_root("tok", "wmobley", "ls6") == SCRATCH
    assert [u for _, u in calls["detail"]] == ["j1", "j2"]


def test_resolve_scratch_root_falls_back_to_the_summary_listing(monkeypatch):
    calls = _fake_jobs_api(monkeypatch, search_rows=[], list_rows=[
        {"uuid": "f1", "execSystemId": "frontera"}, {"uuid": "l1", "execSystemId": "ls6"}],
        details={"l1": {"execSystemExecDir": f"{SCRATCH}/tapis/l1"}})
    assert tapis.resolve_scratch_root("tok", "wmobley", "ls6") == SCRATCH
    assert [u.rsplit("/v3/", 1)[1] for u, _, _ in calls["get"]] == ["jobs/search", "jobs/list"]
    assert calls["detail"] == [("tok", "l1")]  # the frontera job is never read


def test_resolve_scratch_root_is_none_without_a_usable_job(monkeypatch):
    calls = _fake_jobs_api(monkeypatch, search_rows=[{"uuid": str(i)} for i in range(6)], details={})
    assert tapis.resolve_scratch_root("tok", "other", "ls6") is None
    assert len(calls["detail"]) == tapis._SCRATCH_DETAIL_READS
    assert tapis._scratch_root_from_exec_dir("relative/tapis/x") == ""
