"""Run liveness derived from model-task signals and the staleness sweep.

Design: docs/design/2026-11-02-run-signal-and-staleness.md.

The composite model task (tapis._model_execution_code) posts three events to
POST /runs/{id}/signal: ``started`` as its first action, ``job_submitted`` once
``/v3/jobs/submit`` has returned a uuid, and ``finished`` from its success and
error paths. Every write that those signals, the sweep, cancel and /poll make
to a run goes through the pure functions here, so the transition rules live in
one place:

- a signal never moves ``status`` to a terminal value; Tapis, read with the
  user's token in /poll, is the only source of ``completed``/``failed``.
- ``health`` is a liveness verdict beside ``status``: ``ok``, ``stalled`` (sweep),
  ``reported_failed`` (the task said it failed; awaiting Tapis confirmation).
- terminal statuses are sticky against signals; ``cancelled`` is sticky
  against everything.
- the sweep only ever writes ``health``.
"""
from __future__ import annotations

import hashlib
import hmac
from datetime import datetime, timedelta, timezone
from typing import Any

from .config import settings
from .error_handling import safe_error_message

SIGNAL_EVENTS = ("started", "job_submitted", "finished")
SIGNAL_TASK_ID = "model"

TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled"})
ACTIVE_STATUSES = frozenset({"generated", "submitting", "running", "cancelling"})

HEALTH_OK = "ok"
HEALTH_STALLED = "stalled"
HEALTH_REPORTED_FAILED = "reported_failed"

# Domain separation so this HMAC can never be confused with another one made
# from the same secret.
_TOKEN_DOMAIN = "run-signal:v1:"
# Extra life past the run's own max_minutes, so a slow queue never outlives
# the token while the task is still legitimately reporting.
TOKEN_SLACK_SECONDS = 24 * 3600


# ---------------------------------------------------------------------------
# Signal token
# ---------------------------------------------------------------------------
def signals_configured() -> bool:
    return bool(settings.run_signal_secret_list and settings.public_base_url)


def signal_url(run_id: str) -> str:
    """Where the task posts to. Config-only by design; see Settings.public_base_url."""
    return f"{settings.public_base_url.rstrip('/')}/runs/{run_id}/signal"


def signal_expiry(created_at: datetime, max_minutes: int) -> int:
    return int((created_at + timedelta(minutes=max(1, max_minutes), seconds=TOKEN_SLACK_SECONDS)).timestamp())


# The token-fetch credential (POST /runs/{id}/token, rev 2 of the token
# lifecycle design) is derived from the same secrets under its own domain, so a
# leaked signal token cannot fetch a Tapis token and vice versa.
_TOKEN_FETCH_DOMAIN = "run-token:v1:"


def _digest(secret: str, run_id: str, expires: int, domain: str = _TOKEN_DOMAIN) -> str:
    message = f"{domain}{run_id}:{expires}".encode()
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def _make(run_id: str, expires: int, domain: str, secret: str | None) -> str:
    secrets = [secret] if secret else settings.run_signal_secret_list
    if not secrets:
        raise RuntimeError("run signal secrets are not configured")
    return _digest(secrets[0], run_id, expires, domain)


def _verify(run_id: str, expires_header: str | None, token: str | None, domain: str,
            now: datetime | None) -> bool:
    if not token or not expires_header:
        return False
    try:
        expires = int(expires_header)
    except (TypeError, ValueError):
        return False
    now_ts = (now or datetime.now(tz=timezone.utc)).timestamp()
    # Compare against every secret even after a match so timing does not reveal
    # which one is current.
    matched = False
    for secret in settings.run_signal_secret_list:
        if hmac.compare_digest(_digest(secret, run_id, expires, domain), token):
            matched = True
    return matched and expires > now_ts


def make_signal_token(run_id: str, expires: int, *, secret: str | None = None) -> str:
    return _make(run_id, expires, _TOKEN_DOMAIN, secret)


def verify_signal_token(run_id: str, expires_header: str | None, token: str | None,
                        *, now: datetime | None = None) -> bool:
    """Constant-time check against every configured secret (current + previous)."""
    return _verify(run_id, expires_header, token, _TOKEN_DOMAIN, now)


def token_url(run_id: str) -> str:
    """Where the task fetches a live token. Config-only, like signal_url."""
    return f"{settings.public_base_url.rstrip('/')}/runs/{run_id}/token"


def make_token_fetch_credential(run_id: str, expires: int, *, secret: str | None = None) -> str:
    return _make(run_id, expires, _TOKEN_FETCH_DOMAIN, secret)


def verify_token_fetch_credential(run_id: str, expires_header: str | None, token: str | None,
                                  *, now: datetime | None = None) -> bool:
    return _verify(run_id, expires_header, token, _TOKEN_FETCH_DOMAIN, now)


def token_fetch_expiry(dispatched_at: datetime) -> int:
    """The fetch credential dies with the keeper deadline: after that the
    adapter neither serves nor renews, so a leaked credential is worthless."""
    from .run_tokens import keeper_deadline  # noqa: PLC0415 — avoid import cycle
    return int(keeper_deadline(dispatched_at).timestamp())


def clear_token_update() -> dict[str, Any]:
    """Update set that drops the keeper's copy of a run's token."""
    return {"run_token_enc": None, "run_token_expires_at": None}


# ---------------------------------------------------------------------------
# Transitions
# ---------------------------------------------------------------------------
def parse_ts(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def dedupe_key(event: dict[str, Any]) -> str:
    return f"{event.get('task_id')}:{event.get('attempt') or 1}:{event.get('event')}"


def validate_signal(body: Any) -> dict[str, Any] | str:
    """Return the normalised event, or an error string for a 400."""
    if not isinstance(body, dict):
        return "body must be a JSON object"
    event = body.get("event")
    if event not in SIGNAL_EVENTS:
        return f"event must be one of {', '.join(SIGNAL_EVENTS)}"
    if body.get("task_id", SIGNAL_TASK_ID) != SIGNAL_TASK_ID:
        return "only the model task signals"
    attempt = body.get("attempt", 1)
    if not isinstance(attempt, int) or attempt < 1 or attempt > 1000:
        return "attempt must be a positive integer"
    out: dict[str, Any] = {"event": event, "task_id": SIGNAL_TASK_ID, "attempt": attempt}
    for key in ("job_uuid", "job_name", "job_status", "condition", "code"):
        value = body.get(key)
        if value is not None:
            if not isinstance(value, str) or len(value) > 200:
                return f"{key} must be a string of at most 200 characters"
            out[key] = value
    message = body.get("message")
    if message is not None:
        if not isinstance(message, str):
            return "message must be a string"
        out["message"] = message[:2000]
    if "attached" in body:
        out["attached"] = bool(body["attached"])
    return out


def apply_signal(run: dict[str, Any], event: dict[str, Any], now: datetime) -> dict[str, Any] | None:
    """Update set for one signal, or None when the run must not change.

    The caller records provenance either way; this only decides the row.
    """
    status = str(run.get("status") or "")
    if status in TERMINAL_STATUSES:
        return None

    update: dict[str, Any] = {"last_signal_at": now.isoformat()}
    health = run.get("health")
    kind = event["event"]

    if kind == "started":
        if not run.get("started_at"):
            update["started_at"] = now.isoformat()
        if status in {"generated", "submitting"}:
            update["status"] = "running"
        # Any signal proves the task is alive; a retry's `started` also
        # supersedes a failure the previous attempt reported.
        if health in {HEALTH_STALLED, HEALTH_REPORTED_FAILED}:
            update["health"] = HEALTH_OK
        elif health is None:
            update["health"] = HEALTH_OK
        return update

    if health == HEALTH_STALLED:
        update["health"] = HEALTH_OK

    if kind == "job_submitted":
        job_uuid = event.get("job_uuid")
        if job_uuid and job_uuid != run.get("model_job_uuid"):
            # First submission, or a re-attach to a different job after the
            # earlier one failed. Verified only once /poll has read it back
            # from Tapis under the user's token.
            update["model_job_uuid"] = job_uuid
            update["model_job_verified"] = False
        if event.get("job_name") and not run.get("model_job_name"):
            update["model_job_name"] = event["job_name"]
        return update

    # finished
    if event.get("code"):
        update["health"] = HEALTH_REPORTED_FAILED
        update["error_message"] = safe_error_message(
            f"model task reported {event['code']}: {event.get('message') or 'no detail'}"
        )
    elif health == HEALTH_REPORTED_FAILED:
        update["health"] = HEALTH_OK
    return update


def stall_decision(run: dict[str, Any], now: datetime, *,
                   after_seconds: int, after_started_seconds: int) -> tuple[str, str] | None:
    """(phase, message) when an armed run has gone silent for too long, else None."""
    if not run.get("signals_armed"):
        return None
    if str(run.get("status") or "") not in ACTIVE_STATUSES:
        return None
    if run.get("health") == HEALTH_STALLED:
        return None

    if not run.get("last_signal_at"):
        dispatched = parse_ts(run.get("dispatched_at"))
        if dispatched and after_seconds > 0 and (now - dispatched).total_seconds() > after_seconds:
            minutes = after_seconds // 60
            return (
                "no_signal",
                f"Dispatched to Tapis Workflows at {dispatched.strftime('%Y-%m-%d %H:%M')} UTC; "
                f"no signal has been received from the model task in {minutes} min. "
                "The task may not have started. Check the run in Tapis, or cancel and resubmit.",
            )
        return None

    if not run.get("model_job_uuid"):
        started = parse_ts(run.get("started_at"))
        if started and after_started_seconds > 0 and (now - started).total_seconds() > after_started_seconds:
            minutes = after_started_seconds // 60
            return (
                "no_job",
                f"The model task started at {started.strftime('%Y-%m-%d %H:%M')} UTC but has not "
                f"reported a submitted Tapis job in {minutes} min. Check the run in Tapis, or "
                "cancel and resubmit.",
            )
    return None


def stalled_update(message: str) -> dict[str, Any]:
    return {"health": HEALTH_STALLED, "error_message": message}


def observed_alive_update(run: dict[str, Any]) -> dict[str, Any] | None:
    """What /poll writes when Tapis shows the model job exists for a stalled run."""
    if run.get("health") == HEALTH_STALLED:
        return {"health": HEALTH_OK}
    return None


def may_cancel(run: dict[str, Any], username: str | None) -> bool:
    if not username:
        return False
    if username in settings.cancel_admin_list:
        return True
    submitter = run.get("submitted_by")
    return bool(submitter) and submitter == username
