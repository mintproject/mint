"""Output-side publication through a registered catalog_register piece
(design 2026-11-05-output-publish-etl.md): planning, the publish arguments,
the owner and allow-list checks at bound submit, GET /publishers and the
`publication` derived from the publish task. Tapis, CKAN and Hasura are stubbed."""
from __future__ import annotations

import base64
import json
import os
import sys
from pathlib import Path

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main as main_module  # noqa: E402
from app import publication, tapis  # noqa: E402
from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402
from app.models import DataObjectContract  # noqa: E402
from app.planner import build_plan_json, find_path  # noqa: E402
from app.store import STORE  # noqa: E402
from app.task_code import get_code  # noqa: E402

client = TestClient(app)
SECRET = {"X-Ensemble-Manager-Secret": "em-secret"}
GEOTIFF = {"format": "geotiff"}


def _jwt(username: str) -> str:
    def enc(obj):
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()
    return f"{enc({'alg': 'none'})}.{enc({'tapis/username': username})}.sig"


ALICE, BOB = _jwt("alice"), _jwt("bob")


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(autouse=True)
def seeded(monkeypatch):
    client.post("/admin/reset")
    client.post("/admin/seed-subside-werc")
    monkeypatch.setattr(settings, "internal_service_secret", "em-secret")
    monkeypatch.setattr(settings, "publish_enabled", True)
    monkeypatch.setattr(tapis, "userinfo_username", lambda token: json.loads(
        base64.urlsafe_b64decode(token.split(".")[1] + "==")).get("tapis/username"))
    yield


def _deferred(target_catalog="ckan+stac", **extra):
    return client.post("/plans/deferred", json={
        "source_contract": GEOTIFF,
        "target_contract": {**GEOTIFF, "catalog": target_catalog},
        "model_output_key": "out", **extra})


# --- planning ------------------------------------------------------------------------
def test_geotiff_to_cataloged_geotiff_plans_exactly_the_catalog_register_piece():
    registry = list(STORE.transform_spec.values())
    path = find_path(DataObjectContract(format="geotiff", resource_uri="x"),
                     DataObjectContract(format="geotiff", catalog="ckan+stac"), registry)
    assert [s["transform_type"] for s in path] == ["catalog_register"]

    response = _deferred()
    assert response.status_code == 200
    steps = response.json()["plan_json"]["steps"]
    assert [(s["transform_type"], s["publishes"]) for s in steps] == [("catalog_register", True)]


def test_a_single_catalog_token_is_satisfied_by_the_ckan_stac_piece():
    steps = _deferred("stac").json()["plan_json"]["steps"]
    assert [s["transform_type"] for s in steps] == ["catalog_register"]


def test_an_unknown_catalog_has_no_path():
    response = _deferred("zenodo")
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "NO_DEFERRED_TRANSFORM_PATH"


def test_an_identity_plan_has_no_steps():
    response = client.post("/plans/deferred", json={
        "source_contract": GEOTIFF, "target_contract": GEOTIFF, "model_output_key": "out"})
    assert response.json()["plan_json"]["steps"] == []


def test_plan_parameters_expose_user_values_and_hide_managed_ones():
    params = {p["name"]: p for p in _deferred().json()["plan_json"]["parameters"]}
    assert params["stac_collection"]["allowed_values"] == ["subsidence-rates-dev"]
    assert params["stac_collection"]["default"] == "subsidence-rates-dev"
    assert params["ckan_org"]["allowed_values"] == [settings.publish_default_org]
    assert params["public"]["default"] is False and params["public"]["type"] == "boolean"
    for name in ("stac_url", "ckan_url", "stac_item_id", "execution_id", "product_pattern"):
        assert params[name]["managed"] is True
    assert "tapis_token" not in params and "ckan_token" not in params
    assert "opera_disp_s1_cumulative.tif" in params["product_pattern"]["default"]


def test_plan_time_allow_list_rejects_a_foreign_collection_or_org():
    response = _deferred(parameter_values={"stac_collection": "subsidence-rates", "ckan_org": "elsewhere"})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "PUBLISH_VALUE_NOT_ALLOWED"
    assert set(detail["parameters"]) == {"stac_collection", "ckan_org"}
    assert _deferred(parameter_values={"stac_collection": "subsidence-rates-dev"}).status_code == 200


def test_a_misconfigured_default_is_refused_at_plan_time(monkeypatch):
    monkeypatch.setattr(settings, "publish_allowed_collections", "subsidence-rates")
    response = _deferred()
    assert response.status_code == 422
    assert response.json()["detail"]["parameters"] == {"stac_collection": "must be one of subsidence-rates"}


# --- the task code gate ----------------------------------------------------------------
def test_kill_switch_fails_the_task_closed(monkeypatch):
    monkeypatch.setattr(settings, "publish_enabled", False)
    code = get_code("catalog_register")
    assert "no code builder" in code and "sys.exit(2)" in code
    monkeypatch.setattr(settings, "publish_enabled", True)
    live = get_code("catalog_register")
    compile(live, "<catalog_register>", "exec")
    assert settings.stac_platform_ref in live and "__STAC_PLATFORM_REF__" not in live


def test_a_branch_name_is_not_a_valid_platform_pin(monkeypatch):
    monkeypatch.setattr(settings, "stac_platform_ref", "main")
    assert "no code builder" in get_code("catalog_register")


def test_publish_task_gets_its_own_time_limit_and_no_retries(monkeypatch):
    monkeypatch.setattr(settings, "publish_max_exec_seconds", 777)
    plan = _deferred().json()
    pipeline = tapis.generate_tapis_workflow({"id": "p", "plan_json": plan["plan_json"]})
    task = next(t for t in pipeline["tasks"] if t["id"].endswith("catalog_register"))
    assert task["execution_profile"] == {"max_retries": 0, "max_exec_time": 777}
    assert task["input"]["TAPIS_TOKEN"] == {"type": "string", "value_from": {"args": "tapis_token"}}
    assert "CKAN_TOKEN" not in task["input"]
    assert {"stac_item_id", "execution_id", "ckan_org", "public", "product_pattern"} <= set(pipeline["params"])


# --- bound submit ---------------------------------------------------------------------
def _bound_plan(execution_id="ue_1"):
    plan = _deferred().json()
    STORE.data_object["do-1"] = {
        "id": "do-1", "label": "out", "resource_uri": "tapis://ls6/work/runs/ue_1",
        "format": "geotiff", "owner_execution_id": execution_id, "variables": []}
    bound = client.post(f"/plans/deferred/{plan['plan_id']}/bind", headers={**SECRET, **_bearer(ALICE)}, json={
        "data_object_id": "do-1", "plan_hash": plan["plan_hash"], "parent_execution_id": execution_id,
        "model_child_id": "child", "parameter_values_hash": "h"})
    assert bound.status_code == 200, bound.text
    return bound.json()["bound_plan_id"]


def _parent_run(owner="alice", execution_id="ue_1"):
    STORE.run["parent"] = {"id": "parent", "execution_id": execution_id, "submitted_by": owner,
                           "model_job_name": "job", "status": "running"}


def _submit(bound_id, token=ALICE, args=None, dry_run=True, execution_id="ue_1"):
    return client.post("/workflows/submit", headers={**SECRET, **_bearer(token)}, json={
        "plan_id": bound_id, "dry_run": dry_run, "execution_id": execution_id,
        "args": {"execution_id": execution_id, "source_uri": "tapis://ls6/work/runs/ue_1", **(args or {})}})


def test_non_owner_is_refused_before_any_run_row_is_written():
    bound_id = _bound_plan()
    _parent_run(owner="alice")
    before = dict(STORE.run)
    response = _submit(bound_id, token=BOB)
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "RUN_OWNER_MISMATCH"
    assert STORE.run == before


def test_owner_submit_binds_managed_args_and_ignores_user_overrides(monkeypatch):
    bound_id = _bound_plan()
    _parent_run(owner="alice")
    response = _submit(bound_id, args={
        "stac_url": "https://evil.example", "ckan_url": "https://evil.example",
        "stac_item_id": "someone-elses-item", "product_pattern": "*",
        "stac_collection": "subsidence-rates-dev", "ckan_org": settings.publish_default_org, "public": True})
    assert response.status_code == 200, response.text
    args = {k: v["value"] for k, v in response.json()["args"].items()}
    assert args["stac_url"] == settings.stac_api_url
    assert args["ckan_url"] == settings.publish_ckan_url
    assert args["stac_item_id"] == "ue_1" and args["execution_id"] == "ue_1"
    assert args["product_pattern"] != "*"
    assert args["public"] is True
    assert "tapis_token" not in args


def test_submit_allow_list_rejects_values_the_plan_once_allowed(monkeypatch):
    bound_id = _bound_plan()
    _parent_run()
    monkeypatch.setattr(settings, "publish_allowed_collections", "something-else")
    response = _submit(bound_id, args={"stac_collection": "subsidence-rates-dev"})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "PUBLISH_VALUE_NOT_ALLOWED"
    assert response.json()["detail"]["parameters"] == {
        "stac_collection": "must be one of something-else"}
    response = _submit(bound_id, args={"ckan_org": "not-allowed"})
    assert response.json()["detail"]["parameters"] == {"ckan_org": f"must be one of {settings.publish_default_org}"}


def test_a_publish_submit_without_an_execution_id_is_refused():
    plan = _deferred().json()
    response = client.post("/workflows/submit", headers=_bearer(ALICE), json={
        "plan_id": plan["plan_id"], "dry_run": True, "args": {}})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "PUBLISH_EXECUTION_ID_REQUIRED"


# --- GET /publishers ------------------------------------------------------------------
class _Ckan:
    def __init__(self, status=200, orgs=("dso-internal",)):
        self.status, self.orgs, self.calls = status, orgs, []

    def __call__(self, url, **kwargs):
        self.calls.append((url, kwargs))
        outer = self

        class Response:
            status_code = outer.status

            def json(self):
                return {"success": True, "result": [{"name": o} for o in outer.orgs]}
        return Response()


@pytest.fixture
def werc_config():
    STORE.transform_spec["ts-subside-run-werc"]["mint_model_config_id"] = "cfg-werc"
    return "cfg-werc"


def _publishers(config, token=ALICE):
    return client.get("/publishers", params={"configuration_id": config}, headers=_bearer(token))


def test_publishers_lists_the_piece_with_user_parameters_and_membership(monkeypatch, werc_config):
    import requests
    ckan = _Ckan()
    monkeypatch.setattr(requests, "get", ckan)
    body = _publishers(werc_config).json()
    assert body["configuration_id"] == werc_config
    [publisher] = body["publishers"]
    assert publisher["transform_spec_id"] == "ts-subside-stac-publish"
    assert publisher["catalog_tokens"] == ["ckan", "stac"]
    assert publisher["can_publish"] == {"ok": True, "reason": None}
    names = {p["name"] for p in publisher["parameters"]}
    assert names == {"stac_collection", "ckan_org", "public"}
    collection = next(p for p in publisher["parameters"] if p["name"] == "stac_collection")
    assert collection["allowed_values"] == ["subsidence-rates-dev"]
    url, kwargs = ckan.calls[0]
    assert url == settings.publish_ckan_url.rstrip("/") + "/api/3/action/organization_list_for_user"
    assert kwargs["params"] == {"permission": "create_dataset"}
    assert kwargs["allow_redirects"] is False and kwargs["timeout"]
    assert kwargs["headers"] == {"Authorization": f"Bearer {ALICE}"}


@pytest.mark.parametrize("status, orgs, fragment", [
    (200, ("other-org",), "cannot create datasets"),
    (401, (), "HTTP 401"),
    (403, (), "HTTP 403"),
    (500, (), "HTTP 500"),
])
def test_publishers_can_publish_reports_why_not(monkeypatch, werc_config, status, orgs, fragment):
    import requests
    monkeypatch.setattr(requests, "get", _Ckan(status, orgs))
    [publisher] = _publishers(werc_config).json()["publishers"]
    assert publisher["can_publish"]["ok"] is False
    assert fragment in publisher["can_publish"]["reason"]


def test_publishers_unknown_configuration_is_404():
    assert _publishers("cfg-missing").status_code == 404


def test_publishers_empty_without_a_reachable_publisher(monkeypatch, werc_config):
    del STORE.transform_spec["ts-subside-stac-publish"]
    assert _publishers(werc_config).json() == {"configuration_id": werc_config, "publishers": []}


# --- publication ------------------------------------------------------------------------
def _task(stdout, status="SUCCEEDED", message=None):
    return {"task_id": "step-0-catalog_register", "status": status, "stdout": stdout, "last_message": message}


def test_publication_published_from_the_task_result():
    result = {"catalog": "ckan+stac", "ckan_dataset": "https://ckan/dataset/d", "stac_item": "https://stac/i",
              "public": True}
    assert publication.publication_from_detail({"tasks": [_task(json.dumps(result))]}) == {
        "status": "published", **result}


def test_publication_failed_from_a_structured_error_is_scrubbed():
    body = json.dumps({"status": "error", "message": f"HTTPStatusError HTTP 403: Bearer {ALICE}"})
    out = publication.publication_from_detail({"tasks": [_task(body, status="FAILED")]})
    assert out["status"] == "failed" and ALICE not in out["error"]


def test_publication_failed_from_a_failed_task_without_output():
    out = publication.publication_from_detail({"tasks": [_task("", status="FAILED", message="killed")]})
    assert out == {"status": "failed", "error": "killed"}


def test_publication_absent_without_a_publish_task_or_while_it_runs():
    assert publication.publication_from_detail({"tasks": [{"task_id": "model", "status": "SUCCEEDED"}]}) is None
    assert publication.publication_from_detail({"tasks": [_task("", status="ACTIVE")]}) is None


def _run_with_plan(plan_json):
    STORE.plan["plan-x"] = {"id": "plan-x", "plan_json": plan_json}
    STORE.run["run-x"] = {"id": "run-x", "workflow_plan_id": "plan-x", "status": "completed",
                          "tapis_workflow_id": "pipe", "tapis_run_id": "run-uuid"}


def test_get_run_publication_is_null_without_a_publish_step():
    _run_with_plan({"steps": [{"transform_type": "unit_convert"}]})
    assert client.get("/runs/run-x", headers=_bearer(ALICE)).json()["publication"] is None


def test_get_run_publication_reads_the_task_result_and_poll_records_it_without_args(monkeypatch):
    _run_with_plan({"steps": [{"transform_type": "catalog_register"}]})
    result = {"catalog": "ckan+stac", "ckan_dataset": "d", "stac_item": "s", "public": False}
    detail = {"status": "COMPLETED", "tasks": [_task(json.dumps(result))]}
    monkeypatch.setattr(tapis, "get_run_detail", lambda *a, **k: detail)
    monkeypatch.setattr(tapis, "get_output_uri", lambda *a, **k: None)
    expected = {"status": "published", **result}
    assert client.get("/runs/run-x", headers=_bearer(ALICE)).json()["publication"] == expected

    polled = client.post("/runs/run-x/poll", headers=_bearer(ALICE)).json()
    assert polled["publication"] == expected
    [event] = [e for e in STORE.provenance if e.get("event_type") == "run.output.published"]
    assert event["payload_json"] == expected
    assert "args" not in event["payload_json"] and ALICE not in json.dumps(event)

    client.post("/runs/run-x/poll", headers=_bearer(ALICE))  # recorded once
    assert len([e for e in STORE.provenance if e.get("event_type") == "run.output.published"]) == 1
    # Once recorded the outcome no longer needs a live Tapis read.
    monkeypatch.setattr(tapis, "get_run_detail", lambda *a, **k: pytest.fail("unexpected Tapis read"))
    assert client.get("/runs/run-x").json()["publication"] == expected
