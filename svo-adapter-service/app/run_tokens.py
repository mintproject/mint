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
