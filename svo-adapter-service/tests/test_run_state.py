"""Transition rules for run signals, staleness and cancel (app/run_state.py)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app import run_state
from app.config import settings

NOW = datetime(2026, 11, 2, 14, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _secrets(monkeypatch):
    monkeypatch.setattr(settings, "run_signal_secrets", "current,previous")
    monkeypatch.setattr(settings, "public_base_url", "https://svo.example")
    monkeypatch.setattr(settings, "cancel_admins", "ops-admin")


def _run(**over):
    row = {
        "id": "run-1", "status": "running", "health": None, "signals_armed": True,
        "dispatched_at": (NOW - timedelta(minutes=1)).isoformat(),
        "started_at": None, "last_signal_at": None,
        "model_job_uuid": None, "model_job_name": None, "model_job_verified": False,
        "submitted_by": "alice",
    }
    row.update(over)
    return row


# --- token --------------------------------------------------------------------
def test_token_round_trips_and_binds_run_id_and_expiry():
    expires = int((NOW + timedelta(hours=2)).timestamp())
    token = run_state.make_signal_token("run-1", expires)
    assert run_state.verify_signal_token("run-1", str(expires), token, now=NOW)
    assert not run_state.verify_signal_token("run-2", str(expires), token, now=NOW)
    assert not run_state.verify_signal_token("run-1", str(expires + 1), token, now=NOW)


def test_expired_token_is_rejected_even_when_signature_matches():
    expires = int((NOW - timedelta(seconds=1)).timestamp())
    token = run_state.make_signal_token("run-1", expires)
    assert not run_state.verify_signal_token("run-1", str(expires), token, now=NOW)


def test_previous_secret_still_verifies_during_rotation():
    expires = int((NOW + timedelta(hours=2)).timestamp())
    token = run_state.make_signal_token("run-1", expires, secret="previous")
    assert run_state.verify_signal_token("run-1", str(expires), token, now=NOW)
    stranger = run_state.make_signal_token("run-1", expires, secret="stranger")
    assert not run_state.verify_signal_token("run-1", str(expires), stranger, now=NOW)


def test_malformed_headers_are_rejected():
    assert not run_state.verify_signal_token("run-1", None, "abc", now=NOW)
    assert not run_state.verify_signal_token("run-1", "soon", "abc", now=NOW)
    assert not run_state.verify_signal_token("run-1", "123", None, now=NOW)


def test_signals_configured_needs_secret_and_public_url(monkeypatch):
    assert run_state.signals_configured()
    monkeypatch.setattr(settings, "public_base_url", "")
    assert not run_state.signals_configured()
    assert run_state.signal_url("run-1") == "/runs/run-1/signal"


# --- validation -----------------------------------------------------------------
def test_validate_signal_rejects_unknown_event_task_and_oversized_fields():
    assert isinstance(run_state.validate_signal({"event": "heartbeat"}), str)
    assert isinstance(run_state.validate_signal({"event": "started", "task_id": "step-0"}), str)
    assert isinstance(run_state.validate_signal({"event": "started", "job_uuid": "x" * 201}), str)
    assert isinstance(run_state.validate_signal({"event": "started", "attempt": 0}), str)
    event = run_state.validate_signal({"event": "finished", "code": "X", "message": "m" * 5000})
    assert isinstance(event, dict) and len(event["message"]) == 2000


# --- apply_signal -----------------------------------------------------------------
def test_started_marks_the_run_alive_and_running():
    update = run_state.apply_signal(_run(status="submitting"), {"event": "started"}, NOW)
    assert update["status"] == "running"
    assert update["started_at"] == NOW.isoformat()
    assert update["last_signal_at"] == NOW.isoformat()
    assert update["health"] == run_state.HEALTH_OK


def test_started_does_not_rewrite_an_existing_started_at():
    update = run_state.apply_signal(_run(started_at="earlier"), {"event": "started"}, NOW)
    assert "started_at" not in update


def test_any_signal_clears_a_stall_verdict():
    for event in ({"event": "started"}, {"event": "job_submitted", "job_uuid": "j"}, {"event": "finished"}):
        update = run_state.apply_signal(_run(health="stalled"), event, NOW)
        assert update["health"] == run_state.HEALTH_OK


def test_job_submitted_records_an_unverified_job_identity():
    update = run_state.apply_signal(
        _run(), {"event": "job_submitted", "job_uuid": "job-1", "job_name": "mint-workflow-model-x"}, NOW,
    )
    assert update["model_job_uuid"] == "job-1"
    assert update["model_job_verified"] is False
    assert update["model_job_name"] == "mint-workflow-model-x"


def test_repeated_job_submitted_with_same_uuid_changes_nothing_but_liveness():
    update = run_state.apply_signal(
        _run(model_job_uuid="job-1", model_job_verified=True),
        {"event": "job_submitted", "job_uuid": "job-1"}, NOW,
    )
    assert "model_job_uuid" not in update and "model_job_verified" not in update


def test_finished_with_code_reports_failure_but_never_fails_status():
    update = run_state.apply_signal(
        _run(), {"event": "finished", "code": "MODEL_PROVIDER_JOB_FAILED", "message": "job died"}, NOW,
    )
    assert update["health"] == run_state.HEALTH_REPORTED_FAILED
    assert "MODEL_PROVIDER_JOB_FAILED" in update["error_message"]
    assert "status" not in update


def test_finished_ok_clears_a_reported_failure_from_an_earlier_attempt():
    update = run_state.apply_signal(_run(health="reported_failed"), {"event": "finished"}, NOW)
    assert update["health"] == run_state.HEALTH_OK


def test_signals_never_change_a_terminal_run():
    for status in ("completed", "failed", "cancelled"):
        assert run_state.apply_signal(_run(status=status), {"event": "started"}, NOW) is None


# --- stall_decision --------------------------------------------------------------
def _decide(run, now=NOW):
    return run_state.stall_decision(run, now, after_seconds=900, after_started_seconds=300)


def test_silent_armed_run_is_stalled_after_the_dispatch_window():
    run = _run(dispatched_at=(NOW - timedelta(minutes=16)).isoformat())
    phase, message = _decide(run)
    assert phase == "no_signal"
    assert "no signal has been received" in message and "cancel and resubmit" in message


def test_silent_armed_run_inside_the_window_is_left_alone():
    assert _decide(_run(dispatched_at=(NOW - timedelta(minutes=14)).isoformat())) is None


def test_unarmed_runs_are_never_judged():
    run = _run(signals_armed=False, dispatched_at=(NOW - timedelta(hours=9)).isoformat())
    assert _decide(run) is None


def test_started_without_job_is_stalled_after_the_submit_window():
    run = _run(last_signal_at=NOW.isoformat(), started_at=(NOW - timedelta(minutes=6)).isoformat())
    assert _decide(run)[0] == "no_job"
    run["started_at"] = (NOW - timedelta(minutes=4)).isoformat()
    assert _decide(run) is None


def test_a_submitted_job_has_no_staleness_cutoff():
    run = _run(last_signal_at=(NOW - timedelta(hours=17)).isoformat(),
               started_at=(NOW - timedelta(hours=17)).isoformat(), model_job_uuid="job-1")
    assert _decide(run) is None


def test_already_stalled_and_terminal_runs_are_not_rejudged():
    old = (NOW - timedelta(hours=1)).isoformat()
    assert _decide(_run(health="stalled", dispatched_at=old)) is None
    assert _decide(_run(status="failed", dispatched_at=old)) is None


def test_windows_can_be_disabled():
    run = _run(dispatched_at=(NOW - timedelta(hours=1)).isoformat())
    assert run_state.stall_decision(run, NOW, after_seconds=0, after_started_seconds=0) is None


# --- cancel authorisation ------------------------------------------------------------
def test_only_the_submitter_or_an_admin_may_cancel():
    assert run_state.may_cancel(_run(), "alice")
    assert run_state.may_cancel(_run(), "ops-admin")
    assert not run_state.may_cancel(_run(), "mallory")
    assert not run_state.may_cancel(_run(submitted_by=None), "alice")
    assert not run_state.may_cancel(_run(), None)
