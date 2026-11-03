from __future__ import annotations

import asyncio
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
    # With the token keeper off (default) the update set is unchanged; the
    # keeper-on variant is covered in test_run_token_keeper.py.
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
    monkeypatch.setattr(poller.settings, "poll_coordinator_runs", True)
    fake = _patch_poll(monkeypatch, [dict(_COORDINATOR_RUN)], "FAILED")

    updates = asyncio.run(poller.poll_once("token"))

    assert [(u["run_id"], u["adapter_status"]) for u in updates] == [("run-1", "failed")]
    assert any(v and v.get("set", {}).get("status") == "failed" for _, v in fake.writes)


def test_poller_leaves_coordinator_run_when_tapis_unreadable(monkeypatch):
    monkeypatch.setattr(poller.settings, "poll_coordinator_runs", True)
    fake = _patch_poll(monkeypatch, [dict(_COORDINATOR_RUN)], None)

    assert asyncio.run(poller.poll_once("token")) == []
    assert fake.writes == []


def test_poller_skips_coordinator_runs_when_disabled(monkeypatch):
    monkeypatch.setattr(poller.settings, "poll_coordinator_runs", False)
    fake = _patch_poll(monkeypatch, [dict(_COORDINATOR_RUN)], "FAILED")

    assert asyncio.run(poller.poll_once("token")) == []
    assert fake.writes == []


def test_poller_does_not_record_success_when_task_detail_is_unreadable(monkeypatch):
    monkeypatch.setattr(poller.settings, "poll_coordinator_runs", True)
    fake = _patch_poll(
        monkeypatch, [dict(_COORDINATOR_RUN)], "COMPLETED",
        detail={"tasks_error": "ApiException: 403"},
    )

    assert asyncio.run(poller.poll_once("token")) == []
    assert fake.writes == []


def test_poller_records_completed_coordinator_run_without_binding_output(monkeypatch):
    monkeypatch.setattr(poller.settings, "poll_coordinator_runs", True)
    fake = _patch_poll(monkeypatch, [dict(_COORDINATOR_RUN)], "COMPLETED", detail={"tasks": []})

    updates = asyncio.run(poller.poll_once("token"))

    assert [(u["run_id"], u["adapter_status"]) for u in updates] == [("run-1", "completed")]
    assert not any("output_data_object_id" in str(v) for _, v in fake.writes)


def test_poll_coordinator_runs_defaults_on():
    from app.config import Settings

    assert Settings().poll_coordinator_runs is True


# --- staleness sweep -----------------------------------------------------------------
def _armed_run(**over):
    from datetime import timedelta
    now = datetime.now(tz=timezone.utc)
    row = {
        "id": "run-s", "status": "running", "tapis_workflow_id": "p", "tapis_run_id": "u",
        "execution_id": "ue_s", "signals_armed": True, "health": None,
        "dispatched_at": (now - timedelta(minutes=20)).isoformat(),
        "started_at": None, "last_signal_at": None, "model_job_uuid": None,
    }
    row.update(over)
    return row


def _patch_sweep(monkeypatch, runs):
    import app.hasura as hasura

    monkeypatch.setattr(poller.settings, "run_signal_secrets", "s")
    monkeypatch.setattr(poller.settings, "public_base_url", "https://svo.example")
    monkeypatch.setattr(poller.settings, "stall_after_seconds", 900)
    monkeypatch.setattr(poller.settings, "stall_after_started_seconds", 300)
    fake = _FakeHasura(runs)
    monkeypatch.setattr(hasura, "get_client", lambda *_a, **_k: fake)
    return fake


def test_sweep_marks_a_silent_armed_run_stalled_without_touching_status(monkeypatch):
    fake = _patch_sweep(monkeypatch, [_armed_run()])

    flagged = asyncio.run(poller.sweep_stalled())

    assert flagged == [{"run_id": "run-s", "phase": "no_signal"}]
    update = next(v["set"] for _, v in fake.writes if v and "set" in v)
    assert update["health"] == "stalled" and "status" not in update
    assert "cancel and resubmit" in update["error_message"]
    assert any(v["obj"]["event_type"] == "run.stalled" for _, v in fake.writes if v and "obj" in v)


def test_sweep_ignores_unarmed_fresh_and_already_stalled_runs(monkeypatch):
    from datetime import timedelta
    fresh = (datetime.now(tz=timezone.utc) - timedelta(minutes=5)).isoformat()
    fake = _patch_sweep(monkeypatch, [
        _armed_run(id="unarmed", signals_armed=False),
        _armed_run(id="fresh", dispatched_at=fresh),
        _armed_run(id="stalled", health="stalled"),
        _armed_run(id="queued", last_signal_at=fresh, started_at=fresh, model_job_uuid="job-1"),
    ])

    assert asyncio.run(poller.sweep_stalled()) == []
    assert fake.writes == []


def test_sweep_flags_a_task_that_started_but_never_submitted_a_job(monkeypatch):
    from datetime import timedelta
    started = (datetime.now(tz=timezone.utc) - timedelta(minutes=6)).isoformat()
    _patch_sweep(monkeypatch, [_armed_run(last_signal_at=started, started_at=started)])

    assert asyncio.run(poller.sweep_stalled()) == [{"run_id": "run-s", "phase": "no_job"}]
