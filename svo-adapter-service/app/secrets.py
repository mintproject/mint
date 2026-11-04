"""Adapter-held secrets store (design: docs/design/2026-11-04-svo-adapter-secrets-store.md).

A model configuration declares the secrets it needs (``parameter_type="secret"``
catalog rows); the model's owner stores them encrypted in ``adapter.secret``;
the adapter resolves them at submit time and hands them to the composite model
task through ``GET /runs/{id}/credentials``. Nothing here is ever readable back
through an API: values exist in memory only inside ``put`` (to encrypt) and the
credentials endpoint (to decrypt and return).

Fernet has no associated-data parameter, so the encrypted JSON embeds the row's
binding tuple and ``open`` verifies it against the row after decrypting (the
``run_tokens.encrypt_run_token`` pattern): a ciphertext copied onto another row,
owner, configuration, name or version is refused.
"""
from __future__ import annotations

import contextvars
import json
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol

from .config import settings
from .hasura import (
    DELETE_SECRET, FIND_SECRET, GET_SECRET, GET_SECRET_CONFIGURATION,
    INSERT_SECRET, INSERT_SECRET_EVENT, TOUCH_SECRET, UPDATE_SECRET,
)

SCOPE_MODEL_OWNER = "model_owner"
SOURCE_OWNER_ONLY = "owner_only"
SECRET_PARAMETER_TYPE = "secret"

NAME_RE = re.compile(r"^[a-z0-9_-]{1,64}$")
FIELD_RE = re.compile(r"^[a-z0-9_]{1,32}$")
OWNER_UNSET_MESSAGE = "the model configuration has no owner; set owner_username before storing a secret"
ENV_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
MAX_FIELDS = 16
MAX_TOTAL_BYTES = 4096


class SecretError(Exception):
    """Storage failure; the message never carries a value or key material."""


class SecretValidationError(SecretError):
    pass


class SecretResolutionError(Exception):
    """A submit-time resolution failure, carrying the HTTP status and detail."""

    def __init__(self, status: int, detail: dict[str, Any]) -> None:
        super().__init__(detail.get("code", "SECRET_ERROR"))
        self.status = status
        self.detail = detail


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------
def validate_name(name: str) -> str:
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise SecretValidationError("secret name must match [a-z0-9_-]{1,64}")
    return name


def validate_fields(fields: dict[str, str]) -> dict[str, str]:
    """Field names ``[a-z0-9_]{1,32}``, at most 16, 4 KiB total, no NUL/newline."""
    if not isinstance(fields, dict) or not fields:
        raise SecretValidationError("fields must be a non-empty object")
    if len(fields) > MAX_FIELDS:
        raise SecretValidationError(f"at most {MAX_FIELDS} fields are allowed")
    total = 0
    for key, value in fields.items():
        if not isinstance(key, str) or not FIELD_RE.match(key):
            raise SecretValidationError("field names must match [a-z0-9_]{1,32}")
        if not isinstance(value, str) or not value:
            raise SecretValidationError(f"field {key!r} must be a non-empty string")
        if "\x00" in value or "\n" in value or "\r" in value:
            raise SecretValidationError(f"field {key!r} must not contain NUL or newlines")
        total += len(key.encode()) + len(value.encode())
    if total > MAX_TOTAL_BYTES:
        raise SecretValidationError(f"fields exceed {MAX_TOTAL_BYTES} bytes in total")
    return fields


# --------------------------------------------------------------------------
# Encryption
# --------------------------------------------------------------------------
def secrets_configured() -> bool:
    """True when a dedicated key ring is set. Independent of the token keeper."""
    return bool(settings.secrets_encryption_key_list)


def _ring():
    from cryptography.fernet import Fernet, MultiFernet  # noqa: PLC0415

    keys = settings.secrets_encryption_key_list
    if not keys:
        raise SecretError("no secrets encryption key configured")
    return MultiFernet([Fernet(k.encode()) for k in keys])


def _binding(row: dict[str, Any]) -> dict[str, Any]:
    return {"id": str(row["id"]), "scope": row["scope"], "owner": row["owner_username"],
            "name": row["name"], "configuration_id": row["configuration_id"],
            "version": int(row["version"])}


def seal(row: dict[str, Any], fields: dict[str, str]) -> str:
    """Ciphertext of ``fields`` bound to the identity tuple in ``row``."""
    payload = json.dumps({**_binding(row), "fields": fields}).encode()
    return _ring().encrypt(payload).decode("ascii")


def open_(row: dict[str, Any], ciphertext: str | None = None) -> dict[str, str]:
    """Inverse of ``seal``; every binding field must match the row."""
    from cryptography.fernet import InvalidToken  # noqa: PLC0415

    try:
        data = json.loads(_ring().decrypt((ciphertext or row["ciphertext"]).encode("ascii")).decode())
    except (InvalidToken, ValueError, TypeError, KeyError) as exc:
        raise SecretError("stored secret could not be decrypted") from exc
    if not isinstance(data, dict) or any(data.get(k) != v for k, v in _binding(row).items()):
        raise SecretError("stored secret does not belong to this row")
    fields = data.get("fields")
    if not isinstance(fields, dict):
        raise SecretError("stored secret is malformed")
    return {str(k): str(v) for k, v in fields.items()}


def _metadata(row: dict[str, Any]) -> dict[str, Any]:
    """The row without its ciphertext: all that any API ever returns."""
    return {k: v for k, v in row.items() if k != "ciphertext"}


# --------------------------------------------------------------------------
# Store
# --------------------------------------------------------------------------
class SecretStore(Protocol):
    async def put(self, *, scope: str, owner: str, name: str, configuration_id: str,
                  pinned_app_id: str, pinned_app_version: str,
                  fields: dict[str, str], actor: str) -> dict[str, Any]: ...

    async def get(self, secret_id: str) -> tuple[dict[str, Any], dict[str, str]] | None: ...

    async def delete(self, row: dict[str, Any], *, actor: str) -> None: ...


class FernetSecretStore:
    """Phase A backend: Fernet ciphertext in ``adapter.secret`` through Hasura."""

    def __init__(self, hasura) -> None:
        self._h = hasura

    async def find(self, scope: str, owner: str, name: str, configuration_id: str) -> dict[str, Any] | None:
        """Metadata row for an identity tuple; never decrypts."""
        rows = (await self._h.execute(FIND_SECRET, {
            "scope": scope, "owner": owner, "name": name, "cfg": configuration_id,
        }))["adapter_secret"]
        return rows[0] if rows else None

    async def put(self, *, scope, owner, name, configuration_id, pinned_app_id,
                  pinned_app_version, fields, actor) -> dict[str, Any]:
        validate_name(name)
        validate_fields(fields)
        existing = await self.find(scope, owner, name, configuration_id)
        now = datetime.now(tz=timezone.utc).isoformat()
        row = {
            "id": existing["id"] if existing else str(uuid.uuid4()),
            "scope": scope, "owner_username": owner, "name": name,
            "configuration_id": configuration_id,
            "version": int(existing["version"]) + 1 if existing else 1,
        }
        columns = {
            "pinned_app_id": pinned_app_id, "pinned_app_version": pinned_app_version,
            "ciphertext": seal(row, fields), "fields": sorted(fields),
            "acknowledged_at": now, "updated_at": now,
        }
        if existing:
            saved = (await self._h.execute(UPDATE_SECRET, {
                "id": row["id"], "set": {"version": row["version"], **columns},
            }))["update_adapter_secret_by_pk"]
        else:
            saved = (await self._h.execute(INSERT_SECRET, {"obj": {
                **row, **columns,
                "configuration_ref": configuration_id if scope == SCOPE_MODEL_OWNER else None,
            }}))["insert_adapter_secret_one"]
        saved = _metadata(saved)
        await record_event(self._h, "replaced" if existing else "created", saved, actor=actor)
        return saved

    async def get(self, secret_id: str):
        """(row, decrypted fields) or None when the row is gone."""
        row = (await self._h.execute(GET_SECRET, {"id": secret_id}))["adapter_secret_by_pk"]
        if not row:
            return None
        fields = open_(row)
        register_values(fields.values())
        return _metadata(row), fields

    async def delete(self, row: dict[str, Any], *, actor: str) -> None:
        await self._h.execute(DELETE_SECRET, {"id": row["id"]})
        await record_event(self._h, "deleted", row, actor=actor)

    async def touch(self, secret_id: str) -> None:
        await self._h.execute(TOUCH_SECRET, {
            "id": secret_id, "at": datetime.now(tz=timezone.utc).isoformat()})


async def record_event(hasura, event: str, row: dict[str, Any], *, run_id: str | None = None,
                       actor: str = "system", token_kind: str | None = None,
                       version: int | None = None) -> None:
    """Insert-only audit trail; carries ids and names, never a value."""
    await hasura.execute(INSERT_SECRET_EVENT, {"obj": {
        "secret_id": row.get("id"), "scope": row.get("scope"),
        "owner_username": row.get("owner_username"), "name": row.get("name"),
        "configuration_id": row.get("configuration_id"), "event": event,
        "run_id": run_id, "actor": actor, "actor_token_kind": token_kind,
        "secret_version": version if version is not None else row.get("version"),
    }})


async def rotate_all(hasura, *, apply: bool) -> dict[str, int]:
    """Re-encrypt every row under the ring's first key (``MultiFernet.rotate``).

    Every row is decrypted and its binding verified first, so a corrupt row is
    counted, not silently carried. Dry-run counts only. Returns
    ``{"rows", "rotated", "failed"}``.
    """
    from .hasura import LIST_SECRETS  # noqa: PLC0415

    rows = (await hasura.execute(LIST_SECRETS, {}))["adapter_secret"]
    counts = {"rows": len(rows), "rotated": 0, "failed": 0}
    ring = _ring()
    for row in rows:
        try:
            open_(row)
            if apply:
                rotated = ring.rotate(row["ciphertext"].encode("ascii")).decode("ascii")
                await hasura.execute(UPDATE_SECRET, {"id": row["id"], "set": {"ciphertext": rotated}})
                await record_event(hasura, "replaced", row, actor="rotate")
            counts["rotated"] += 1
        except SecretError:
            counts["failed"] += 1
    return counts


# --------------------------------------------------------------------------
# Catalog declarations and resolution
# --------------------------------------------------------------------------
@dataclass
class Declaration:
    name: str
    env: dict[str, str]  # field -> env key
    source: str = SOURCE_OWNER_ONLY

    @property
    def fields(self) -> list[str]:
        return sorted(self.env)


def parse_declarations(configuration: dict[str, Any] | None) -> list[Declaration]:
    """``parameter_type == "secret"`` rows: label = name, ``has_accepted_values``
    = ``field=ENV_KEY`` entries. Phase A: every source is ``owner_only``."""
    out: list[Declaration] = []
    for wrapper in (configuration or {}).get("parameters") or []:
        param = wrapper.get("parameter") or wrapper
        if param.get("parameter_type") != SECRET_PARAMETER_TYPE:
            continue
        label = str(param.get("label") or "")
        invalid = lambda why: SecretResolutionError(422, {  # noqa: E731
            "code": "SECRET_DECLARATION_INVALID",
            "message": f"secret parameter {label!r}: {why}"})
        if not NAME_RE.match(label):
            raise invalid("label must match [a-z0-9_-]{1,64}")
        env: dict[str, str] = {}
        for entry in param.get("has_accepted_values") or []:
            field_name, sep, env_key = str(entry).partition("=")
            if not sep or not FIELD_RE.match(field_name) or not ENV_KEY_RE.match(env_key):
                raise invalid("has_accepted_values entries must be field=ENV_KEY")
            env[field_name] = env_key
        if not env:
            raise invalid("has_accepted_values must map at least one field")
        out.append(Declaration(label, env, SOURCE_OWNER_ONLY))
    return out


@dataclass
class Resolution:
    bound: list[dict[str, Any]] = field(default_factory=list)  # {id, version, name, env, app}
    missing: list[dict[str, Any]] = field(default_factory=list)
    mismatched: list[dict[str, Any]] = field(default_factory=list)  # secret rows
    incomplete: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not (self.missing or self.mismatched or self.incomplete)

    def raise_if_failed(self) -> None:
        if self.mismatched:
            raise SecretResolutionError(403, {
                "code": "SECRET_APP_MISMATCH",
                "message": "a stored secret is pinned to a different Tapis app than this "
                           "configuration now runs; the owner must store it again",
                "names": [r["name"] for r in self.mismatched]})
        if self.incomplete:
            raise SecretResolutionError(422, {
                "code": "SECRET_FIELDS_INCOMPLETE",
                "message": "a stored secret lacks fields the configuration maps to the app",
                "names": self.incomplete})
        if self.missing:
            raise SecretResolutionError(422, {
                "code": "SECRET_REQUIRED",
                "message": "this model needs credentials provided by the model owner",
                "missing": self.missing})


def check_required_hint(required: Any, declarations: list[Declaration]) -> None:
    """The EM's ``required_secrets`` is a hint; its names must be a subset of the catalog's."""
    if required in (None, [], ()):
        return
    names = {d.name for d in declarations}
    hinted = {str(r.get("name")) for r in required if isinstance(r, dict)} if isinstance(required, list) else None
    if hinted is None or not hinted <= names:
        raise SecretResolutionError(422, {
            "code": "SECRET_DECLARATION_MISMATCH",
            "message": "required_secrets must be a subset of the configuration's secret declarations"})


async def fetch_configuration(hasura, configuration_id: str) -> dict[str, Any] | None:
    return (await hasura.execute(GET_SECRET_CONFIGURATION, {"id": configuration_id}))[
        "modelcatalog_configuration_by_pk"]


async def resolve(store: FernetSecretStore, configuration: dict[str, Any],
                  declarations: list[Declaration], job_definition: dict[str, Any]) -> Resolution:
    """Resolve each declaration to its stored row without decrypting anything."""
    result = Resolution()
    owner = configuration.get("owner_username")
    if declarations and not owner:
        raise SecretResolutionError(422, {"code": "SECRET_OWNER_UNSET", "message": OWNER_UNSET_MESSAGE})
    app = (str(job_definition.get("appId") or ""), str(job_definition.get("appVersion") or ""))
    for decl in declarations:
        row = await store.find(SCOPE_MODEL_OWNER, owner, decl.name, configuration["id"]) if owner else None
        if row is None:
            result.missing.append({"name": decl.name, "source": decl.source, "fields": decl.fields})
        elif (row.get("pinned_app_id"), str(row.get("pinned_app_version"))) != app:
            result.mismatched.append(row)
        elif not set(decl.env) <= set(row.get("fields") or []):
            result.incomplete.append(decl.name)
        else:
            result.bound.append({"id": str(row["id"]), "version": int(row["version"]),
                                 "name": decl.name, "env": decl.env,
                                 "app": f"{app[0]}@{app[1]}"})
    return result


# --------------------------------------------------------------------------
# By-value redaction
# --------------------------------------------------------------------------
_scrub_values: contextvars.ContextVar[frozenset[str] | None] = contextvars.ContextVar(
    "svo_adapter_scrub_values", default=None)


def register_values(values) -> None:
    """Remember decrypted values for this request so any text that would carry
    one (log record, error message) is scrubbed. Values under 4 chars are
    skipped: replacing them would shred unrelated text."""
    current = _scrub_values.get() or frozenset()
    _scrub_values.set(current | {v for v in values if isinstance(v, str) and len(v) >= 4})


def scrub_text(text: str) -> str:
    values = _scrub_values.get()
    if not values:
        return text
    for value in sorted(values, key=len, reverse=True):
        text = text.replace(value, "[redacted]")
    return text


class ValueScrubber:
    """Request-scoped scrubber facade over the shared context variable."""

    register = staticmethod(register_values)
    scrub = staticmethod(scrub_text)

    @staticmethod
    def clear() -> None:
        _scrub_values.set(None)


_factory_installed = False


def install_log_scrubber() -> None:
    """Scrub registered values out of every log record created afterwards.

    A record factory (not a handler filter) so it covers every logger and
    handler, including ones added later by the server.
    """
    global _factory_installed
    if _factory_installed:
        return
    base = logging.getLogRecordFactory()

    def factory(*args, **kwargs):
        record = base(*args, **kwargs)
        if _scrub_values.get():
            record.msg = scrub_text(record.getMessage())
            record.args = None
        return record

    logging.setLogRecordFactory(factory)
    _factory_installed = True
