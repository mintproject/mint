from __future__ import annotations

from datetime import datetime, timezone

from app import poller


def test_completed_pipeline_with_failed_child_task_is_failed():
    status, update = poller._terminal_update_set(
        "COMPLETED",
        {
            "tasks": [
                {"task_id": "step-0-format_convert", "status": "COMPLETED"},
                {"task_id": "step-2-geo_aggregate", "status": "FAILED", "last_message": "[]"},
            ]
        },
    )

    assert status == "failed"
    assert update["status"] == "failed"
    assert "step-2-geo_aggregate" in update["error_message"]


def test_completed_pipeline_without_failed_tasks_records_completed_at():
    now = datetime(2026, 8, 12, tzinfo=timezone.utc)

    status, update = poller._terminal_update_set("COMPLETED", {"tasks": []}, now=now)

    assert status == "completed"
    assert update == {"status": "completed", "completed_at": "2026-08-12T00:00:00+00:00"}


def test_completed_pipeline_with_json_error_stdout_is_failed():
    status, update = poller._terminal_update_set(
        "COMPLETED",
        {
            "tasks": [
                {
                    "task_id": "step-0-budget_extract_drain",
                    "status": "COMPLETED",
                    "stdout": '{"status":"error","message":"GEO_ACTOR_ID is required"}',
                }
            ]
        },
    )

    assert status == "failed"
    assert update["status"] == "failed"
    assert "GEO_ACTOR_ID is required" in update["error_message"]


def test_failed_pipeline_without_failed_tasks_preserves_provider_error():
    status, update = poller._terminal_update_set(
        "FAILED",
        {"status": "FAILED", "message": "Workflow submission validation error: missing execution_id"},
    )

    assert status == "failed"
    assert update["status"] == "failed"
    assert update["error_message"] == "Workflow submission validation error: missing execution_id"


def test_failed_pipeline_without_provider_error_gets_actionable_fallback():
    status, update = poller._terminal_update_set("FAILED", {"tasks": []})

    assert status == "failed"
    assert update["error_message"] == "Tapis workflow reported FAILED"


class _FakeHasura:
    def __init__(self, runs):
        self.runs = runs
        self.writes = []

    async def execute(self, query, variables=None):
        if "ListActiveRuns" in query:
            return {"adapter_workflow_run": self.runs}
        self.writes.append((query, variables))
        return {}


def _patch_poll(monkeypatch, runs, tapis_status, detail=None):
    import app.hasura as hasura

    fake = _FakeHasura(runs)
    monkeypatch.setattr(hasura, "get_client", lambda *_a, **_k: fake)
    monkeypatch.setattr(poller.tapis_mod, "get_run_status", lambda *_a, **_k: tapis_status)
    monkeypatch.setattr(poller.tapis_mod, "get_run_detail", lambda *_a, **_k: detail or {})
    return fake


_COORDINATOR_RUN = {
    "id": "run-1",
    "tapis_workflow_id": "pipe-1",
    "tapis_run_id": "uuid-1",
    "execution_id": "ue_abc",
    "workflow_plan_id": "plan-1",
}


def test_poller_syncs_coordinator_run_status(monkeypatch):
    import asyncio

    monkeypatch.setattr(poller.settings, "poll_coordinator_runs", True)
    fake = _patch_poll(monkeypatch, [dict(_COORDINATOR_RUN)], "FAILED")

    updates = asyncio.run(poller.poll_once("token"))

    assert [(u["run_id"], u["adapter_status"]) for u in updates] == [("run-1", "failed")]
    assert "auto_bind" not in updates[0]
    assert any(v and v.get("set", {}).get("status") == "failed" for _, v in fake.writes)


def test_poller_leaves_coordinator_run_when_tapis_unreadable(monkeypatch):
    import asyncio

    monkeypatch.setattr(poller.settings, "poll_coordinator_runs", True)
    fake = _patch_poll(monkeypatch, [dict(_COORDINATOR_RUN)], None)

    assert asyncio.run(poller.poll_once("token")) == []
    assert fake.writes == []


def test_poller_skips_coordinator_runs_when_disabled(monkeypatch):
    import asyncio

    monkeypatch.setattr(poller.settings, "poll_coordinator_runs", False)
    fake = _patch_poll(monkeypatch, [dict(_COORDINATOR_RUN)], "FAILED")

    assert asyncio.run(poller.poll_once("token")) == []
    assert fake.writes == []
