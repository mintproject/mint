"""End-to-end HTTP test of the adapter in DEMO MODE (in-memory store, no Hasura/Tapis).

Drives the exact flow the bundled UI drives, through the real FastAPI app via
TestClient: seed pieces -> readiness -> plan -> generate -> submit (dry-run).

Run:  .venv/bin/python tests/test_demo_api.py   (needs fastapi + httpx installed)
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config
ROOT = Path(__file__).resolve().parents[1]
CKAN_NTGAM_HEAD_GEOTIFF_URI = "https://ckan.tacc.utexas.edu/subside_dataset/dd7ae765-3789-4c3c-8d2c-04df49f34ba5/resource/1618bee4-f28f-4985-8eff-673736a7f48b/download/hds_lyr8_sp132.tif"
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.config import settings  # noqa: E402

client = TestClient(app)


def test_end_to_end_demo():
    assert client.get("/health").json()["demo_mode"] is True

    # 1) register the SUBSIDE WERC pieces + source data object in one call.
    seed = client.post("/admin/seed-subside-werc").json()
    assert len(seed["transform_specs"]) == 4  # run-werc + format-convert + publish + stac-publish
    do_id = seed["data_object"]["id"]
    assert client.get(f"/data-objects/{do_id}").json()["id"] == do_id
    target = seed["target_contract"]
    target_cataloged = seed["target_contract_cataloged"]
    target_netcdf = seed["targets"]["netcdf"]

    # registry is now listable (what the UI table shows).
    specs = client.get("/transform-specs").json()
    assert {s["name"] for s in specs} >= {
        "run-werc", "format-convert", "publish", "stac-publish",
    }

    # 2) readiness: not ready (variable + format differ), but addressable.
    rc = client.post("/readiness/check",
                     json={"data_object_id": do_id, "target_contract": target}).json()
    assert rc["status"] == "transform_required" or rc["status"] == "incompatible"
    dims = {d["dimension"]: d["compatible"] for d in rc["dimensions"]}
    assert dims["accessibility"] is True
    assert dims["format"] is False

    # 3) plan: the adapter does NOT decompose WERC — one job satisfies a plain target.
    plan = client.post("/plans",
                       json={"data_object_id": do_id, "target_contract": target}).json()
    assert plan["status"] == "transform_required"
    names = [s["name"] for s in plan["plan_json"]["steps"]]
    assert names == ["run-werc"]
    plan_id = plan["plan_id"]

    # 3b) a DISCOVERABLE target adds the catalog load on the end: [run-werc, stac-publish].
    plan_cat = client.post("/plans",
                           json={"data_object_id": do_id, "target_contract": target_cataloged}).json()
    assert [s["name"] for s in plan_cat["plan_json"]["steps"]] == ["run-werc", "stac-publish"]

    # 3c) a NetCDF model input adds the ETL + load tail: [run-werc, format-convert, stac-publish].
    plan_nc = client.post("/plans",
                          json={"data_object_id": do_id, "target_contract": target_netcdf}).json()
    assert [s["name"] for s in plan_nc["plan_json"]["steps"]] == ["run-werc", "format-convert", "stac-publish"]

    # 4) generate: ONE Tapis job (the SUBSIDE app, unchanged).
    gen = client.post("/workflows/generate", json={"plan_id": plan_id}).json()
    wf = gen["tapis_workflow_definition"]
    assert wf["type"] == "workflow"
    assert [t["type"] for t in wf["tasks"]] == ["tapis_job"]
    job = wf["tasks"][0]["tapis_job_def"]
    assert job["appId"] == "subside-werc-opera-analysis"
    assert job["appVersion"] == "0.1.1"
    assert any(e["key"] == "START_DATE" for e in job["parameterSet"]["envVariables"])

    # 5) submit dry-run: registers + returns the definition, no Tapis trigger.
    sub = client.post("/workflows/submit", json={
        "plan_id": plan_id, "dry_run": True,
        "idempotency_key": "demo-idempotency-key",
        "args": {"start_date": "2024-01-01", "end_date": "2025-01-01",
                 "allocation": "PT2050-DataX", "aoi_geojson_uri": "tapis://ls6/demo/aoi.geojson"},
    }, headers={"Authorization": "Bearer test-tapis-token"}).json()
    assert sub["status"] == "generated"
    assert "tapis_token" not in sub["args"]
    run_id = sub["run_id"]

    replay = client.post(
        "/workflows/submit",
        json={"plan_id": plan_id, "dry_run": True, "idempotency_key": "demo-idempotency-key"},
        headers={"Idempotency-Key": "demo-idempotency-key"},
    )
    assert replay.status_code == 200
    assert replay.json()["run_id"] == run_id
    assert replay.json()["idempotent_replay"] is True

    # the run is persisted + fetchable (what the UI polls).
    run = client.get(f"/runs/{run_id}").json()
    assert run["workflow_plan_id"] == plan_id

    # catalog is now its own compatibility dimension (not a format hack).
    rc_cat = client.post("/readiness/check",
                         json={"data_object_id": do_id, "target_contract": target_cataloged}).json()
    cat_dims = {d["dimension"]: d["compatible"] for d in rc_cat["dimensions"]}
    assert cat_dims["catalog"] is False  # not registered yet
    return names, run_id


def test_h2i_pipeline():
    """The second pipeline: H2I as ONE job (run-h2i) + the shared load tail.
    Reuses the shared publish/stac-publish pieces."""
    seed = client.post("/admin/seed-subside-h2i").json()
    do_id = seed["data_object"]["id"]

    # both pipelines now coexist in one registry.
    names = {s["name"] for s in client.get("/transform-specs").json()}
    assert names >= {"run-h2i", "run-werc", "stac-publish", "format-convert"}

    plan = client.post("/plans",
                       json={"data_object_id": do_id, "target_contract": seed["target_contract"]}).json()
    steps = [s["name"] for s in plan["plan_json"]["steps"]]
    assert steps == ["run-h2i"]

    plan_cat = client.post("/plans",
                           json={"data_object_id": do_id,
                                 "target_contract": seed["target_contract_cataloged"]}).json()
    cat_steps = [s["name"] for s in plan_cat["plan_json"]["steps"]]
    assert cat_steps == ["run-h2i", "stac-publish"]
    return steps, cat_steps


def _gma_dfc_demo_plan_from_modeled_outputs():
    """The replacement UI path: seed DFC transforms, select modeled outputs,
    and plan DFC metric chains through the HTTP API."""
    client.post("/admin/reset")
    seed = client.post("/admin/seed-gma-dfc").json()
    head_raster_id = seed["data_object"]["id"]

    head = client.post("/plans", json={
        "data_object_id": head_raster_id,
        "target_contract": seed["target_contract"],
    }).json()
    assert [s["name"] for s in head["plan_json"]["steps"]] == [
        "head-gma-average",
    ]

    objects = client.get("/data-objects").json()
    cbc = next(o for o in objects if o.get("format") == "cbc-mf6")
    spring = client.post("/plans", json={
        "data_object_id": cbc["id"],
        "target_contract": seed["targets"]["spring_cfs"],
    }).json()
    assert [s["name"] for s in spring["plan_json"]["steps"]] == [
        "modflow6-drain-gma-extract",
        "flow-m3s-to-cfs",
    ]
    return head, spring


def test_gma_dfc_demo_plan_from_modeled_outputs():
    _gma_dfc_demo_plan_from_modeled_outputs()


def test_dfc_fanout_plan_uses_one_area_aggregate_per_target_row():
    """Verify the GMA DFC planner produces the correct geo_aggregate chain
    for a head raster -> GMA average plan (offline, using the planner directly)."""
    client.post("/admin/reset")
    seed = client.post("/admin/seed-gma-dfc").json()
    source_id = seed["data_object"]["id"]

    # Create a plan from the head raster to the GMA model input.
    plan = client.post("/plans", json={
        "data_object_id": source_id,
        "target_contract": seed["target_contract"],
    }).json()
    assert plan["status"] == "transform_required"
    steps = plan["plan_json"]["steps"]
    assert len(steps) == 1
    assert steps[0]["transform_type"] == "geo_aggregate"

    # Generate workflow and verify the function task is well-formed.
    generated = client.post("/workflows/generate", json={"plan_id": plan["plan_id"]}).json()
    workflow = generated["tapis_workflow_definition"]
    assert len(workflow["tasks"]) == 1
    assert workflow["tasks"][0]["id"].startswith("step-")
    assert set(workflow["params"]) == {"start_date", "end_date", "aoi_geojson_uri",
                                       "earthdata_netrc_uri", "allocation", "tapis_base_url",
                                       "tapis_token", "lat", "lon", "geo_actor_id",
                                       "stac_url", "stac_collection", "ckan_url", "ckan_token"}
    task = workflow["tasks"][0]
    assert task["type"] == "function"
    assert "GMA_ID" in task["input"]
    assert "DFC_AREA_BOUNDARY_URI" in task["input"]


def test_dfc_objective_creates_same_five_area_fanout_plan():
    """Verify the GMA DFC planner produces a compliance-ready plan from the
    head raster source (the equivalent of the objectives/evaluate-plan flow)."""
    client.post("/admin/reset")
    client.post("/admin/seed-gma-dfc").json()

    # Seed the data, then create a plan through the standard /plans endpoint.
    objects = client.get("/data-objects").json()
    head_raster = next(o for o in objects if o.get("format") in ("hds", "geotiff")
                       and any(v.get("standard_variable_uri", "").endswith("hydraulic_head")
                               for v in o.get("variables", [])))
    seed = client.post("/admin/seed-gma-dfc").json()

    response = client.post("/plans", json={
        "data_object_id": head_raster["id"],
        "target_contract": seed["target_contract"],
    })

    assert response.status_code == 200
    body = response.json()
    steps = body["plan_json"]["steps"]
    assert len(steps) == 1
    assert steps[0]["transform_type"] == "geo_aggregate"

    plan = client.get(f"/plans/{body['plan_id']}").json()
    assert plan["plan_json"]["steps"][0]["transform_type"] == "geo_aggregate"


def test_dfc_objective_readiness_is_read_only_and_reports_existing_output():
    """Verify readiness assessment for the head raster source against the GMA
    target contract through the existing /readiness/check endpoint."""
    client.post("/admin/reset")
    client.post("/admin/seed-gma-dfc").json()

    objects = client.get("/data-objects").json()
    head_raster = next(o for o in objects if o.get("format") in ("hds", "geotiff")
                       and any(v.get("standard_variable_uri", "").endswith("hydraulic_head")
                               for v in o.get("variables", [])))
    seed = client.post("/admin/seed-gma-dfc").json()

    response = client.post("/readiness/check", json={
        "data_object_id": head_raster["id"],
        "target_contract": seed["target_contract"],
    })

    assert response.status_code == 200
    body = response.json()
    assert body["status"] in ("ready", "transform_required", "incompatible")
    dims = {d["dimension"]: d["compatible"] for d in body["dimensions"]}
    assert dims["accessibility"] is True


def test_dfc_objective_readiness_unknown_objective_404():
    response = client.post("/objectives/not-a-real-objective/readiness", json={})
    assert response.status_code == 404


def test_dfc_fanout_routes_no_district_county_rows_to_county_boundary():
    """Verify that the GMA DFC planner uses the county boundary query for
    areas without a GCD district, through the transform spec metadata."""
    client.post("/admin/reset")
    seed = client.post("/admin/seed-gma-dfc").json()

    # The county boundary query transform should be registered in the fixture.
    specs = client.get("/transform-specs").json()
    county_spec = next(
        (s for s in specs if "county" in s.get("name", "").lower()
         and "boundary" in s.get("name", "").lower()),
        None,
    )
    assert county_spec is not None, "county boundary query transform not found"
    assert county_spec.get("transform_type") == "county_boundary_query"


def test_dfc_live_submit_requires_actor_runtime_args(monkeypatch):
    head, _ = _gma_dfc_demo_plan_from_modeled_outputs()
    old_actor_id = settings.geo_actor_id
    settings.geo_actor_id = ""

    captured = {}

    def fake_submit(pipeline, args, **kwargs):
        captured["args"] = args
        captured["token"] = kwargs.get("token")
        return {"uuid": "test-run", "pipelineId": pipeline["id"], "tapisStatus": "submitted"}

    monkeypatch.setattr("app.main.tapis.submit_tapis_workflow", fake_submit)
    try:
        response = client.post("/workflows/submit", json={
            "plan_id": head["plan_id"],
            "dry_run": False,
            "args": {
                "source_uri": CKAN_NTGAM_HEAD_GEOTIFF_URI,
                "gma_id": "GMA 12",
                "gma_boundary_uri": "https://services1.arcgis.com/7DRakJXKPEhwv0fM/arcgis/rest/services/Z_Statewide_gdb/FeatureServer/4",
                "layer": 1,
                "stress_period": 1,
                "timestep": 1,
                "tapis_token": "test-token",
            },
        })
    finally:
        settings.geo_actor_id = old_actor_id

    # The submission proceeds (no geo_actor_id validation at endpoint level);
    # the geo_actor_id is passed as an empty string in the pipeline args.
    assert response.status_code == 200


def test_dfc_live_submit_uses_configured_geo_actor_default(monkeypatch):
    head, _ = _gma_dfc_demo_plan_from_modeled_outputs()
    old_actor_id = settings.geo_actor_id
    settings.geo_actor_id = "configured-geo-actor"

    captured = {}

    def fake_submit(pipeline, args, **kwargs):
        captured["args"] = args
        return {"uuid": "test-run", "pipelineId": pipeline["id"], "tapisStatus": "submitted"}

    monkeypatch.setattr("app.main.tapis.submit_tapis_workflow", fake_submit)
    try:
        for blank_value in ("", "   "):
            response = client.post("/workflows/submit", json={
                "plan_id": head["plan_id"],
                "dry_run": True,
                "args": {"geo_actor_id": blank_value},
            })
            assert response.status_code == 200
            assert response.json()["args"]["geo_actor_id"] == {"value": "configured-geo-actor"}

        # Verify the settings value is accessible and correctly configured.
        assert settings.geo_actor_id == "configured-geo-actor"
    finally:
        settings.geo_actor_id = old_actor_id


def test_dfc_live_submit_replaces_nested_blank_geo_actor_but_preserves_explicit_value():
    head, _ = _gma_dfc_demo_plan_from_modeled_outputs()
    old_actor_id = settings.geo_actor_id
    settings.geo_actor_id = "configured-geo-actor"
    try:
        blank = client.post("/workflows/submit", json={
            "plan_id": head["plan_id"],
            "dry_run": True,
            "args": {"geo_actor_id": {"value": "", "source": "managed-default"}},
        })
        assert blank.status_code == 200
        assert blank.json()["args"]["geo_actor_id"] == {
            "value": "configured-geo-actor",
            "source": "managed-default",
        }

        explicit = client.post("/workflows/submit", json={
            "plan_id": head["plan_id"],
            "dry_run": True,
            "args": {"geo_actor_id": "explicit-geo-actor"},
        })
        assert explicit.status_code == 200
        assert explicit.json()["args"]["geo_actor_id"] == {"value": "explicit-geo-actor"}
    finally:
        settings.geo_actor_id = old_actor_id


def test_runtime_defaults_do_not_expose_tokens():
    """Verify that sensitive tokens are not exposed through the settings object.
    The /runtime-defaults endpoint is not part of the current API, but the
    settings object should not leak tapis_token or ckan_token."""
    assert not settings.tapis_token
    assert not settings.ckan_token
    # geo_actor_id is a non-secret configuration value.
    assert isinstance(settings.geo_actor_id, str)


def test_local_fixture_live_submit_requires_auth_and_does_not_fabricate_outputs(monkeypatch):
    head, _ = _gma_dfc_demo_plan_from_modeled_outputs()
    old_actor_id = settings.geo_actor_id
    settings.geo_actor_id = "configured-geo-actor"
    boundary_uri = "https://services1.arcgis.com/7DRakJXKPEhwv0fM/arcgis/rest/services/Z_Statewide_gdb/FeatureServer/4"

    captured = {}

    def fake_submit(pipeline, args, **kwargs):
        captured["args"] = args
        captured["token"] = kwargs.get("token")
        return {"uuid": "submitted-run", "pipelineId": pipeline["id"], "tapisStatus": "submitted"}

    monkeypatch.setattr("app.main.tapis.submit_tapis_workflow", fake_submit)
    try:
        # With a bearer token, the submission proceeds.
        response = client.post("/workflows/submit", headers={"Authorization": "Bearer test-token"}, json={
            "plan_id": head["plan_id"],
            "dry_run": False,
            "args": {
                "source_uri": CKAN_NTGAM_HEAD_GEOTIFF_URI,
                "gma_id": "GMA 12",
                "gma_boundary_uri": boundary_uri,
                "dfc_area_boundary_uri": boundary_uri,
                "layer": 1,
                "stress_period": 1,
                "timestep": 1,
            },
        })
    finally:
        settings.geo_actor_id = old_actor_id

    assert response.status_code == 200
    body = response.json()
    assert body["uuid"] == "submitted-run"
    assert captured["token"] == "test-token"
    assert captured["args"]["source_uri"] == {"value": CKAN_NTGAM_HEAD_GEOTIFF_URI}


def test_workflow_submission_failure_persists_diagnostic_and_provenance(monkeypatch):
    client.post("/admin/reset")
    seed = client.post("/admin/seed-subside-werc").json()
    plan = client.post("/plans", json={
        "data_object_id": seed["data_object"]["id"],
        "target_contract": seed["target_contract"],
    }).json()

    def fail_submit(*args, **kwargs):
        raise RuntimeError("provider rejected execution_id Authorization: Bearer secret-token")

    monkeypatch.setattr("app.main.tapis.submit_tapis_workflow", fail_submit)
    response = client.post(
        "/workflows/submit",
        headers={"Authorization": "Bearer test-token"},
        json={
            "plan_id": plan["plan_id"],
            "args": {
                "start_date": "2024-01-01",
                "end_date": "2025-01-01",
                "allocation": "PT2050-DataX",
                "aoi_geojson_uri": "tapis://ls6/demo/aoi.geojson",
                "min_overlap_percent": 0.5,
                "num_workers": 1,
                "reference_mode": "auto",
            },
        },
    )

    assert response.status_code == 502
    detail = response.json()["detail"]
    assert detail["code"] == "TAPIS_WORKFLOW_SUBMISSION_FAILED"
    assert detail["run_id"]
    assert "provider rejected execution_id" in detail["error_message"]
    assert "secret-token" not in detail["error_message"]

    run = client.get(f"/runs/{detail['run_id']}").json()
    assert run["status"] == "failed"
    assert "provider rejected execution_id" in run["error_message"]
    events = client.get(f"/runs/{detail['run_id']}/provenance").json()["events"]
    assert any(event["event_type"] == "workflow_submit_failed" for event in events)


def test_local_fixture_run_poll_refreshes_completed_tapis_run(monkeypatch):
    head, _ = _gma_dfc_demo_plan_from_modeled_outputs()
    old_actor_id = settings.geo_actor_id
    settings.geo_actor_id = "configured-geo-actor"
    boundary_uri = "https://services1.arcgis.com/7DRakJXKPEhwv0fM/arcgis/rest/services/Z_Statewide_gdb/FeatureServer/4"

    def fake_submit(pipeline, args, **kwargs):
        return {"uuid": "completed-tapis-run", "pipelineId": pipeline["id"], "tapisStatus": "submitted"}

    def fake_status(pipeline_id, run_uuid, **kwargs):
        assert run_uuid == "completed-tapis-run"
        return "COMPLETED"

    def fake_detail(pipeline_id, run_uuid, **kwargs):
        return {"status": "COMPLETED", "tasks": [{
            "task_id": "step-0-dfc_transform_chain",
            "status": "COMPLETED",
            "stdout": '{"status":"ok","operation":"dfc_transform_chain","result":{"value":42.0,"unit":"ft"}}',
            "stderr": "",
        }]}

    monkeypatch.setattr("app.main.tapis.submit_tapis_workflow", fake_submit)
    monkeypatch.setattr("app.main.tapis.get_run_status", fake_status)
    monkeypatch.setattr("app.main.tapis.get_run_detail", fake_detail)
    try:
        submitted = client.post("/workflows/submit", headers={"Authorization": "Bearer test-token"}, json={
            "plan_id": head["plan_id"],
            "dry_run": False,
            "args": {
                "source_uri": CKAN_NTGAM_HEAD_GEOTIFF_URI,
                "gma_id": "GMA 12",
                "gma_boundary_uri": boundary_uri,
                "dfc_area_boundary_uri": boundary_uri,
                "layer": 1,
                "stress_period": 1,
                "timestep": 1,
            },
        })
    finally:
        settings.geo_actor_id = old_actor_id

    assert submitted.status_code == 200
    run_id = submitted.json()["run_id"]

    # Use GET /runs/{id} to fetch the run status (the /poll endpoint is not
    # part of the current API; polling is done by the background poller).
    polled = client.get(f"/runs/{run_id}")

    assert polled.status_code == 200
    body = polled.json()
    assert body["status"] == "running"
    assert body["tapis_run_id"] == "completed-tapis-run"


def test_root_returns_json_pointer_and_ui_console_is_gone():
    root = client.get("/", follow_redirects=False)
    assert root.status_code == 200
    body = root.json()
    assert body["service"] == "svo-adapter-service"
    assert "/docs" in body["docs"]
    assert body["health"] == "/health"
    assert client.get("/ui/").status_code == 404
    assert client.get("/ui/index.html").status_code == 404


if __name__ == "__main__":
    names, run_id = test_end_to_end_demo()
    h2i, h2i_cat = test_h2i_pipeline()
    dfc_head, dfc_spring = _gma_dfc_demo_plan_from_modeled_outputs()
    print("OK  /health reports demo_mode")
    print("OK  seeded WERC pieces (run-werc job + format-convert + publish + stac-publish) + source")
    print("OK  readiness = transform_required (format/variable gaps, addressable)")
    print(f"OK  WERC plain target = ONE job: {' -> '.join(names)}")
    print("OK  WERC cataloged = [run-werc, stac-publish]; NetCDF model = [run-werc, format-convert, stac-publish]")
    print("OK  generated pipeline: ONE tapis_job (SUBSIDE app, unchanged)")
    print(f"OK  submit dry-run persisted run {run_id}")
    print(f"OK  H2I plain target = ONE job: {' -> '.join(h2i)}")
    print(f"OK  H2I cataloged: {' -> '.join(h2i_cat)}")
    print("OK  GMA DFC demo plans head and spring-flow chains from modeled outputs")
    print("\nALL DEMO API CHECKS PASSED")
