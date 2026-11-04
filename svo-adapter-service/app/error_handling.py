"""Helpers for safely persisting provider error messages."""
from __future__ import annotations

import re
from typing import Any

from .secrets import scrub_text


_SECRET_KEY = re.compile(
    r"(?i)(?<![A-Za-z0-9_?&=-])(authorization|x-tapis-token|tapis_token|access_token|refresh_token|"
    r"client_secret|api_key|password|cookie|set-cookie|jwt|id_token|ckan_token|"
    r"token|secret|username|"
    r"netrc|private_key|signature)"
    r"(\s*[=:]\s*)(['\"]?)([^,}\]\s'\";&?#]+)\3"
)
_BEARER = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+")
_URL_SECRET = re.compile(
    r"(?i)([?&](?:access_token|refresh_token|signature|sig|jwt|token|"
    r"x-amz-[^=&#]+|x-tapis-token)=)[^&#\s]+"
)
_JWT = re.compile(r"\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")


def safe_error_message(value: Any, *, limit: int = 2000) -> str:
    """Return a bounded, single-line provider diagnostic without credentials."""
    text = scrub_text(" ".join(str(value).split()))
    text = _BEARER.sub("Bearer [REDACTED]", text)
    text = _URL_SECRET.sub(r"\1[REDACTED]", text)
    text = _SECRET_KEY.sub(r"\1\2[REDACTED]", text)
    text = _JWT.sub("[REDACTED_JWT]", text)
    return text[:limit]
