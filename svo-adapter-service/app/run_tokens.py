"""Bounded per-run Tapis tokens for adapter-submitted workflows.

The caller's UI token can expire while a long workflow (e.g. the composite model
stage) is still running. When ``run_token_enabled`` is set, submission swaps the
``tapis_token`` workflow arg for a separate user-associated token minted through
the Tapis Tokens API with a bounded TTL. The token is never stored or logged;
natural expiry is its only cleanup (see
docs/design/2026-10-28-svo-adapter-workflow-token-lifecycle.md).
"""
from __future__ import annotations

import base64
import json
import uuid
from typing import Any

import httpx

from .config import settings


class RunTokenError(RuntimeError):
    """Raised when a per-run token cannot be minted. Messages carry no secrets."""


def _jwt_username(token: str) -> str:
    """Read the Tapis username claim from an (unverified) JWT payload.

    The Tokens API authenticates the same caller token, so Tapis remains the
    authority on whether this identity may mint.
    """
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload))
    except Exception as exc:
        raise RunTokenError("could not read the caller's Tapis identity") from exc
    username = claims.get("tapis/username")
    if not username:
        raise RunTokenError("caller token has no Tapis username claim")
    return str(username)


def run_token_ttl() -> int:
    """Configured TTL clamped to the server-side min/max."""
    low = min(settings.run_token_ttl_min_seconds, settings.run_token_ttl_max_seconds)
    high = max(settings.run_token_ttl_min_seconds, settings.run_token_ttl_max_seconds)
    return max(low, min(settings.run_token_ttl_seconds, high))


def mint_run_token(caller_token: str) -> str:
    """Mint a bounded user token for one workflow run; returns the raw JWT."""
    username = _jwt_username(caller_token)
    body: dict[str, Any] = {
        "token_tenant_id": settings.tapis_tenant or "portals",
        "account_type": "user",
        "token_username": username,
        "target_site_id": f"{settings.run_token_target_prefix}-{uuid.uuid4().hex[:8]}",
        "access_token_ttl": run_token_ttl(),
    }
    try:
        resp = httpx.post(
            f"{settings.tapis_base_url.rstrip('/')}/v3/tokens",
            headers={"X-Tapis-Token": caller_token, "Content-Type": "application/json"},
            json=body,
            timeout=settings.request_timeout_seconds,
        )
    except Exception as exc:
        raise RunTokenError("Tapis run-token mint request failed") from exc
    if resp.status_code >= 400:
        raise RunTokenError(f"Tapis run-token mint failed (HTTP {resp.status_code})")
    try:
        token = ((resp.json().get("result") or {}).get("access_token") or {}).get("access_token")
    except Exception as exc:
        raise RunTokenError("Tapis run-token mint returned an invalid response") from exc
    if not token:
        raise RunTokenError("Tapis run-token mint returned no access token")
    return token


def apply_run_token(args: dict[str, dict[str, Any]], caller_token: str | None) -> dict[str, dict[str, Any]]:
    """Replace ``args['tapis_token']`` with a per-run token when enabled.

    Fails closed: if the feature is enabled and a token cannot be minted, the
    error propagates and the caller's own token is never used for the run.
    """
    if not settings.run_token_enabled or not caller_token or "tapis_token" not in args:
        return args
    return {**args, "tapis_token": {"value": mint_run_token(caller_token)}}


# ---------------------------------------------------------------------------
# Token keeper (rev 2): encrypted at-rest copy, renewal, revocation
# ---------------------------------------------------------------------------
# The Workflows engine can start the model task hours after dispatch, past the
# expiry of the token baked into the run args. The keeper holds an encrypted
# copy of the current per-run token on the run row, renews it (on demand at
# fetch time, optionally in the poller sweep) and hands the live one to the
# task through POST /runs/{id}/token. Everything here is hermetic except
# mint_run_token/revoke_token, which call the Tapis Tokens API.

import time as _time  # noqa: E402
from datetime import datetime as _datetime, timedelta as _timedelta, timezone as _timezone  # noqa: E402

_JWT_SHAPE = ("eyJ",)


def keeper_configured() -> bool:
    """True when the keeper may store, serve and renew tokens.

    Requires per-run tokens (there is nothing else worth keeping), at least one
    encryption key, and run signals (the fetch credential is derived from the
    same secrets). A half-configured keeper is treated as off; startup
    validation (validate_keeper_config) turns that into a loud error instead.
    """
    return bool(
        settings.run_token_keeper_enabled
        and settings.run_token_enabled
        and settings.run_token_encryption_key_list
        and settings.run_signal_secret_list
        and settings.public_base_url
    )


def validate_keeper_config() -> None:
    """Fail closed at startup when the keeper is enabled but unusable."""
    if not settings.run_token_keeper_enabled:
        return
    problems = []
    if not settings.run_token_enabled:
        problems.append("SVO_ADAPTER_RUN_TOKEN_ENABLED must be true")
    if not settings.run_token_encryption_key_list:
        problems.append("SVO_ADAPTER_RUN_TOKEN_ENCRYPTION_KEYS is empty")
    if not settings.run_signal_secret_list:
        problems.append("SVO_ADAPTER_RUN_SIGNAL_SECRETS is empty (the fetch credential needs it)")
    if not settings.public_base_url:
        problems.append("SVO_ADAPTER_PUBLIC_URL (or SVO_ADAPTER_PUBLIC_BASE_URL) is empty")
    elif not settings.public_base_url.lower().startswith("https://"):
        problems.append("SVO_ADAPTER_PUBLIC_URL must be https:// (tokens travel over it)")
    if not problems:
        try:
            _fernet()
        except Exception:  # noqa: BLE001 — message must not echo the key
            problems.append("SVO_ADAPTER_RUN_TOKEN_ENCRYPTION_KEYS holds a malformed Fernet key")
    if problems:
        raise RunTokenError("run-token keeper misconfigured: " + "; ".join(problems))


def _fernet():
    from cryptography.fernet import Fernet, MultiFernet  # noqa: PLC0415 — optional dep until keeper is on

    keys = settings.run_token_encryption_key_list
    if not keys:
        raise RunTokenError("no run-token encryption key configured")
    return MultiFernet([Fernet(k.encode() if isinstance(k, str) else k) for k in keys])


def encrypt_run_token(run_id: str, token: str) -> str:
    """Ciphertext bound to the run id, so a row's ciphertext cannot be copied
    onto another run to make the endpoint serve a different run's token."""
    payload = json.dumps({"rid": run_id, "tok": token}).encode()
    return _fernet().encrypt(payload).decode("ascii")


def decrypt_run_token(run_id: str, ciphertext: str) -> str:
    """Inverse of encrypt_run_token; raises RunTokenError (no detail) on any failure."""
    from cryptography.fernet import InvalidToken  # noqa: PLC0415

    try:
        data = json.loads(_fernet().decrypt(ciphertext.encode("ascii")).decode())
    except (InvalidToken, ValueError, TypeError) as exc:
        raise RunTokenError("stored run token could not be decrypted") from exc
    if not isinstance(data, dict) or data.get("rid") != run_id or not data.get("tok"):
        raise RunTokenError("stored run token does not belong to this run")
    return str(data["tok"])


def token_expires_at(token: str) -> _datetime | None:
    """``exp`` claim of an (unverified) JWT as an aware datetime, or None."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        exp = json.loads(base64.urlsafe_b64decode(payload)).get("exp")
        return _datetime.fromtimestamp(int(exp), tz=_timezone.utc) if exp else None
    except Exception:  # noqa: BLE001
        return None


def renew_margin_seconds() -> int:
    """How close to expiry a token is renewed: a quarter of the TTL, at least 5 min.
    Matches the in-task self-renewal so both lineages agree on 'due'."""
    return max(300, run_token_ttl() // 4)


def keeper_deadline(dispatched_at: _datetime) -> _datetime:
    return dispatched_at + _timedelta(seconds=max(60, settings.run_token_keeper_deadline_seconds))


def renewal_due(expires_at: _datetime | None, now: _datetime | None = None) -> bool:
    # A token without an `exp` claim cannot be judged; serve it as-is rather
    # than mint (and revoke) on every fetch.
    if expires_at is None:
        return False
    now = now or _datetime.now(tz=_timezone.utc)
    return (expires_at - now).total_seconds() <= renew_margin_seconds()


def revoke_token(auth_token: str, token: str) -> bool:
    """Best-effort ``POST /v3/tokens/revoke`` (verified on portals 2026-11-03).
    Returns True on success; never raises and never logs either token."""
    try:
        resp = httpx.post(
            f"{settings.tapis_base_url.rstrip('/')}/v3/tokens/revoke",
            headers={"X-Tapis-Token": auth_token, "Content-Type": "application/json"},
            json={"token": token},
            timeout=settings.request_timeout_seconds,
        )
        return resp.status_code < 400
    except Exception:  # noqa: BLE001
        return False


def looks_like_secret(text: str) -> bool:
    """Guard used by tests and provenance writers: JWT or Fernet-shaped content."""
    value = str(text or "")
    return any(marker in value for marker in _JWT_SHAPE) or "gAAAA" in value
