"""A run is readable by the user who submitted it, by the Ensemble Manager and by an
admin. Before this, GET /runs, GET /runs/{id}, its provenance and POST /runs/{id}/poll
answered any caller, signed in or not, with every user's runs."""
from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main as main_module  # noqa: E402
from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402
from app.store import STORE  # noqa: E402

client = TestClient(app)
ALICE = {"Authorization": "Bearer alice.jwt"}
BOB = {"Authorization": "Bearer bob.jwt"}
ROOT = {"Authorization": "Bearer root.jwt"}
SERVICE = {"X-Ensemble-Manager-Secret": "service-secret"}
USERS = {"alice.jwt": "alice", "bob.jwt": "bob", "root.jwt": "root"}


@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    monkeypatch.setattr(settings, "cancel_admins", "root")
    monkeypatch.setattr(settings, "internal_service_secret", "service-secret")
    monkeypatch.setattr("app.main.tapis.userinfo_username", lambda token: USERS.get(token))
    main_module._CALLER_CACHE.clear()
    client.post("/admin/reset")
    for run_id, owner in (("run-a", "alice"), ("run-b", "bob"), ("run-old", None)):
        STORE.run[run_id] = {
            "id": run_id, "status": "completed", "tapis_workflow_id": None, "tapis_run_id": None,
            "execution_id": None, "workflow_plan_id": None, "started_at": None,
            "submitted_by": owner,
        }
    yield
    main_module._CALLER_CACHE.clear()


def _ids(response):
    assert response.status_code == 200, response.text
    return sorted(run["id"] for run in response.json()["runs"])


def test_list_shows_a_user_only_their_own_runs():
    assert _ids(client.get("/runs", headers=ALICE)) == ["run-a"]
    assert client.get("/runs", headers=ALICE).json()["total"] == 1
    assert _ids(client.get("/runs", headers=BOB)) == ["run-b"]


def test_list_shows_the_ensemble_manager_and_an_admin_every_run():
    assert _ids(client.get("/runs", headers=SERVICE)) == ["run-a", "run-b", "run-old"]
    assert _ids(client.get("/runs", headers=ROOT)) == ["run-a", "run-b", "run-old"]


@pytest.mark.parametrize("path", ["/runs/run-a", "/runs/run-a/provenance"])
def test_another_users_run_is_reported_as_missing(path):
    assert client.get(path, headers=ALICE).status_code == 200
    assert client.get(path, headers=BOB).status_code == 404
    assert client.get(path, headers=SERVICE).status_code == 200
    assert client.get(path, headers=ROOT).status_code == 200


def test_another_users_run_cannot_be_polled():
    assert client.post("/runs/run-a/poll", headers=ALICE).status_code == 200
    assert client.post("/runs/run-a/poll", headers=BOB).status_code == 404


def test_a_run_with_no_recorded_submitter_is_not_readable_by_users():
    assert client.get("/runs/run-old", headers=ALICE).status_code == 404
    assert client.get("/runs/run-old", headers=ROOT).status_code == 200


def test_a_wrong_service_secret_grants_nothing():
    wrong = {"X-Ensemble-Manager-Secret": "nope", **BOB}
    assert client.get("/runs/run-a", headers=wrong).status_code == 404
    assert _ids(client.get("/runs", headers=wrong)) == ["run-b"]


def test_an_unverified_token_is_refused():
    stranger = {"Authorization": "Bearer unknown.jwt"}
    for call in (
        lambda: client.get("/runs", headers=stranger),
        lambda: client.get("/runs/run-a", headers=stranger),
        lambda: client.get("/runs/run-a/provenance", headers=stranger),
        lambda: client.post("/runs/run-a/poll", headers=stranger),
    ):
        response = call()
        assert response.status_code == 401
        assert response.json()["detail"]["code"] == "TAPIS_AUTH_REQUIRED"


def test_no_token_is_refused_outside_the_local_demo(monkeypatch):
    monkeypatch.setattr(settings, "demo_mode", False)
    with pytest.raises(Exception) as caught:
        import asyncio
        asyncio.run(main_module._run_reader(None, None))
    assert getattr(caught.value, "status_code", None) == 401


def test_the_local_demo_stays_open_without_a_token():
    assert _ids(client.get("/runs")) == ["run-a", "run-b", "run-old"]
