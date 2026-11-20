"""A runner's own secrets for the steps of a flow.

Design: docs/design/2026-11-19-user-secrets-for-flows.md (sections 2-5 and 8).

A piece declares the secrets it needs in its catalog row (``runtime_json.secrets``).
The adapter checks the declaration, finds the runner's own stored secret at plan
and submit, binds ids and versions (never a value) to the run, and hands each
bound step a fetch credential. The step's wrapper trades the runner's token and
that credential for the values (``GET /runs/{run_id}/steps/{step}/secrets``).

Nothing here reads or writes a value. The model-owner path (``app/secrets.py``
scope ``model_owner``) is separate and is never touched from here.
"""
from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime, timezone
from typing import Any, Iterable

from .secrets import ENV_KEY_RE, FIELD_RE, NAME_RE

MAX_SECRETS = 16
MAX_SENDS = 16
SERVICE_MAX = 200
WHAT_MAX = 300
LABEL_MAX = 100

# Task inputs a flow step is handed by the adapter, or reads data through. A secret
# may fill none of them, whatever the case it is written in.
RESERVED_INPUT_PREFIXES = ("SOURCE_", "TAPIS_", "SVO_")

ADAPTER_FIXED_INPUTS = ("SVO_RUN_ID", "SVO_ADAPTER_URL", "SVO_STEP_SECRET_TOKEN")

# Pipeline arguments the adapter fills in for a step bound to a secret.
RUN_ID_ARG = "svo_run_id"
ADAPTER_URL_ARG = "svo_adapter_url"
TOKEN_ARG_PREFIX = "step_secret_token_"

_CREDENTIAL_DOMAIN = "step-secret:v1:"
# Time past the sum of the pipeline's task limits, for queueing and engine delays.
CREDENTIAL_SLACK_SECONDS = 3600


class StepSecretError(ValueError):
    """A refusal that carries its HTTP status and detail (never a value)."""

    def __init__(self, status: int, detail: dict[str, Any]) -> None:
        super().__init__(detail.get("code", "STEP_SECRET_ERROR"))
        self.status = status
        self.detail = detail


# ---------------------------------------------------------------------------
# Declarations
# ---------------------------------------------------------------------------
def _invalid(why: str, piece: Any = None) -> StepSecretError:
    return StepSecretError(422, {
        "code": "SECRET_DECLARATION_INVALID", "message": why,
        **({"piece": str(piece)} if piece else {})})


def parse_secrets(value: Any, piece: Any = None) -> list[dict[str, Any]]:
    """The normalised ``secrets`` declaration: ``[{name, label, env}]``, or [].

    An entry may also carry ``optional``: a list of field names (each a value of
    its ``env``) the step can run without. It is kept only when non-empty, so a
    declaration without it normalises exactly as it always did."""
    if value in (None, [], ()):
        return []
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_SECRETS:
        raise _invalid(f"secrets must be a list of 1 to {MAX_SECRETS} entries", piece)
    out: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    seen_env: set[str] = set()
    for entry in value:
        if not isinstance(entry, dict) or not set(entry) <= {"name", "label", "env", "optional"}:
            raise _invalid("each secret is an object with name, label, env and optionally optional", piece)
        name = entry.get("name")
        if not isinstance(name, str) or not NAME_RE.match(name):
            raise _invalid("a secret name must match [a-z0-9_-]{1,64}", piece)
        if name in seen_names:
            raise _invalid(f"secret {name!r} is declared twice", piece)
        seen_names.add(name)
        label = entry.get("label", name)
        if not isinstance(label, str) or not 1 <= len(label) <= LABEL_MAX:
            raise _invalid(f"the label of secret {name!r} must be 1 to {LABEL_MAX} characters", piece)
        env = entry.get("env")
        if not isinstance(env, dict) or not 1 <= len(env) <= MAX_SECRETS:
            raise _invalid(f"secret {name!r} needs an env map of 1 to {MAX_SECRETS} entries", piece)
        for key, field_name in env.items():
            if not isinstance(key, str) or not ENV_KEY_RE.match(key):
                raise _invalid("an env key must be a task input name [A-Z][A-Z0-9_]{0,63}", piece)
            if not isinstance(field_name, str) or not FIELD_RE.match(field_name):
                raise _invalid("an env value must be a secret field name [a-z0-9_]{1,32}", piece)
            if key.upper() in seen_env:
                raise _invalid(f"the task input {key} is filled by two secrets", piece)
            seen_env.add(key.upper())
        declared = {"name": name, "label": label, "env": dict(env)}
        optional = _parse_optional(entry.get("optional"), name, env, piece)
        if optional:
            declared["optional"] = optional
        out.append(declared)
    return out


def _parse_optional(value: Any, name: str, env: dict[str, str], piece: Any) -> list[str]:
    """The ``optional`` field names of one secret: strings, field-shaped, each a
    value of ``env``, none twice."""
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise _invalid(f"optional of secret {name!r} must be a list of field names", piece)
    for item in value:
        if not FIELD_RE.match(item):
            raise _invalid("an optional field must be a secret field name [a-z0-9_]{1,32}", piece)
        if item not in env.values():
            raise _invalid(f"optional field {item!r} of secret {name!r} is not a value of its env map", piece)
    if len(set(value)) != len(value):
        raise _invalid(f"optional of secret {name!r} lists a field twice", piece)
    return list(value)


def parse_sends_data_to(value: Any, piece: Any = None) -> list[dict[str, str]]:
    """The normalised ``sends_data_to`` statement: ``[{service, what}]``, or []."""
    if value in (None, [], ()):
        return []
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_SENDS:
        raise _invalid(f"sends_data_to must be a list of 1 to {MAX_SENDS} entries", piece)
    out = []
    for entry in value:
        if not isinstance(entry, dict) or set(entry) != {"service", "what"}:
            raise _invalid("each sends_data_to entry is an object with service and what", piece)
        service, what = entry["service"], entry["what"]
        if not isinstance(service, str) or not 1 <= len(service) <= SERVICE_MAX:
            raise _invalid(f"service must be 1 to {SERVICE_MAX} characters", piece)
        if not isinstance(what, str) or not 1 <= len(what) <= WHAT_MAX:
            raise _invalid(f"what must be 1 to {WHAT_MAX} characters", piece)
        out.append({"service": service, "what": what})
    return out


def _places(spec: dict[str, Any]) -> list[dict[str, Any]]:
    """Where a registry row may carry a declaration: top level (fixtures), the
    packed job hints, and the catalog runtime that the sync keeps whole."""
    schema = spec.get("parameters_schema_json") if isinstance(spec.get("parameters_schema_json"), dict) else {}
    hints = schema.get("tapis") if isinstance(schema.get("tapis"), dict) else {}
    metadata = schema.get("metadata") if isinstance(schema.get("metadata"), dict) else {}
    runtime = metadata.get("runtime") if isinstance(metadata.get("runtime"), dict) else {}
    return [spec, hints, runtime]


def raw_declaration(spec: dict[str, Any], key: str) -> Any:
    """The declaration as stored, unvalidated (what an approval hash covers)."""
    for place in _places(spec):
        if place.get(key) is not None:
            return place[key]
    return None


def declared_secrets(spec: dict[str, Any]) -> list[dict[str, Any]]:
    return parse_secrets(raw_declaration(spec, "secrets"), spec.get("id"))


def declared_sends_data_to(spec: dict[str, Any]) -> list[dict[str, str]]:
    return parse_sends_data_to(raw_declaration(spec, "sends_data_to"), spec.get("id"))


def declared_from_catalog_row(row: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """(secrets, sends_data_to) of a catalog ETL process (``runtime_json``), or of a
    registry-shaped row, which is what the demo catalog returns."""
    if isinstance(row.get("runtime_json"), dict):
        runtime = row["runtime_json"]
        return (parse_secrets(runtime.get("secrets"), row.get("id")),
                parse_sends_data_to(runtime.get("sends_data_to"), row.get("id")))
    return declared_secrets(row), declared_sends_data_to(row)


def refuse_stale(piece_id: str, catalog_row: dict[str, Any], spec: dict[str, Any]) -> None:
    """Fail closed: a piece must never run without the key it declared. The
    adapter's copy of the piece is made by the catalog sync; when the catalog row
    says something else about secrets, the copy is stale."""
    if declared_from_catalog_row(catalog_row) != (declared_secrets(spec), declared_sends_data_to(spec)):
        raise StepSecretError(409, {
            "code": "PIECE_REGISTRY_STALE", "piece_id": piece_id,
            "message": "the catalog declares different secrets for this piece than the adapter's "
                       "copy; run the catalog sync and plan again"})


# ---------------------------------------------------------------------------
# What a bound step may be
# ---------------------------------------------------------------------------
def check_supported(step: dict[str, Any], *, in_flow: bool) -> None:
    """A secret is handed only to a stored-source function piece with an entrypoint
    in a flow: only that has a wrapper that can fetch it."""
    from .stored_source import defines_function  # noqa: PLC0415 — keeps imports acyclic

    position = step.get("step")

    def unsupported(reason: str) -> StepSecretError:
        return StepSecretError(422, {
            "code": "SECRET_PIECE_UNSUPPORTED", "step": position, "reason": reason,
            "message": f"step {position}: {reason}"})

    if not in_flow:
        raise unsupported("only a step of a flow can be given a secret")
    if step.get("tapis_app_id"):
        raise unsupported("a piece that runs as a Tapis app cannot be given a secret")
    source, entrypoint = step.get("python_source"), step.get("python_entrypoint")
    if not source:
        raise unsupported("a built-in piece cannot be given a secret")
    if not entrypoint or not defines_function(source, entrypoint):
        raise unsupported("a script-style piece (no entrypoint function) cannot be given a secret")


def step_inputs_check(step: dict[str, Any], inputs: Iterable[str], env_keys: Iterable[str]) -> None:
    """The destination rule: a task input a secret fills may not also be a run
    argument (``env_from_args``), a flow setting, a link, a ``SOURCE_*`` input or
    one the adapter manages. ``inputs`` is what the step finally receives and
    ``env_keys`` what its ``env_from_args`` names, whether or not a link took it
    away. Names are compared without regard to case."""
    taken = {str(name).upper() for name in inputs} | {str(name).upper() for name in env_keys}
    # The inputs the adapter fills in itself, however a piece writes them.
    fixed = taken & set(ADAPTER_FIXED_INPUTS)
    if fixed:
        raise StepSecretError(422, {
            "code": "FLOW_SECRET_INPUT_TAKEN", "step": step.get("step"), "input": sorted(fixed)[0],
            "message": f"step {step.get('step')}: {sorted(fixed)[0]} is filled by the adapter"})
    for declaration in step.get("secrets") or []:
        for env in declaration["env"]:
            upper = env.upper()
            if upper in taken or upper.startswith(RESERVED_INPUT_PREFIXES):
                raise StepSecretError(422, {
                    "code": "FLOW_SECRET_INPUT_TAKEN", "step": step.get("step"), "input": env,
                    "message": f"step {step.get('step')}: the task input {env} is filled by the secret "
                               f"{declaration['name']!r}, so nothing else may set it"})


def fixed_inputs(position: int) -> dict[str, dict[str, Any]]:
    """The task inputs the adapter gives a bound step: where to fetch, for which
    run, and the step's own fetch credential, plus the runner's token."""
    def arg(name: str) -> dict[str, Any]:
        return {"type": "string", "value_from": {"args": name}}
    return {
        "TAPIS_TOKEN": arg("tapis_token"),
        "SVO_RUN_ID": arg(RUN_ID_ARG),
        "SVO_ADAPTER_URL": arg(ADAPTER_URL_ARG),
        "SVO_STEP_SECRET_TOKEN": arg(f"{TOKEN_ARG_PREFIX}{position}"),
    }


def fixed_params(position: int) -> dict[str, dict[str, Any]]:
    return {name: {"type": "string", "default": "", "required": False}
            for name in (RUN_ID_ARG, ADAPTER_URL_ARG, f"{TOKEN_ARG_PREFIX}{position}")}


def is_managed_argument(name: str) -> bool:
    return name in (RUN_ID_ARG, ADAPTER_URL_ARG) or name.startswith(TOKEN_ARG_PREFIX)


def secret_steps(plan_json: dict[str, Any]) -> list[dict[str, Any]]:
    return [step for step in plan_json.get("steps") or [] if isinstance(step, dict) and step.get("secrets")]


# ---------------------------------------------------------------------------
# The plan's account of them
# ---------------------------------------------------------------------------
def needs(steps: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """By secret name: its label, the sorted field names the steps need (``fields``),
    the sorted fields they only use when present (``optional``, left out when
    there are none, so older plans keep their shape) and the positions of
    the steps that use it. A field any step requires is required. A secret whose
    fields are all optional still has to be stored: ``fields`` is then empty and
    the secret's presence is the whole requirement."""
    found: dict[str, dict[str, Any]] = {}
    for step in steps:
        for declaration in step.get("secrets") or []:
            entry = found.setdefault(declaration["name"], {
                "name": declaration["name"], "label": declaration.get("label") or declaration["name"],
                "fields": set(), "optional": set(), "steps": []})
            skippable = set(declaration.get("optional") or [])
            entry["fields"].update(set(declaration["env"].values()) - skippable)
            entry["optional"].update(skippable)
            entry["steps"].append(step.get("step"))
    out: dict[str, dict[str, Any]] = {}
    for name, entry in sorted(found.items()):
        optional = sorted(entry["optional"] - entry["fields"])
        out[name] = {**entry, "fields": sorted(entry["fields"]), "steps": sorted(entry["steps"]),
                     **({"optional": optional} if optional else {})}
        if not optional:
            out[name].pop("optional", None)
    return out


def sends_data_summary(steps: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"step": step.get("step"), "piece": step.get("name"),
             "service": item["service"], "what": item["what"]}
            for step in steps for item in step.get("sends_data_to") or []]


# ---------------------------------------------------------------------------
# The per-step fetch credential
# ---------------------------------------------------------------------------
MIN_KEY_BYTES = 32


def key_long_enough(key: str | None) -> bool:
    return bool(key) and len(key.encode()) >= MIN_KEY_BYTES


def configured(key: str | None, public_base_url: str | None) -> bool:
    return key_long_enough(key) and bool(public_base_url)


def _message(run_id: str, position: int, secrets: Iterable[dict[str, Any]], expires: int) -> bytes:
    pairs = sorted([str(item["id"]), int(item["version"])] for item in secrets)
    return (_CREDENTIAL_DOMAIN + json.dumps([run_id, int(position), pairs, int(expires)],
                                            separators=(",", ":"))).encode()


def make_credential(key: str, run_id: str, position: int,
                    secrets: Iterable[dict[str, Any]], expires: int) -> str:
    """``<expiry>.<hmac>``: an HMAC-SHA256 over the run, the step, the sorted
    ids and versions of the secrets bound to it, and the expiry."""
    mac = hmac.new(key.encode(), _message(run_id, position, secrets, expires), hashlib.sha256).hexdigest()
    return f"{int(expires)}.{mac}"


def verify_credential(key: str, token: str | None, run_id: str, position: int,
                      secrets: Iterable[dict[str, Any]], *, now: datetime | None = None) -> bool:
    if not token or not key or "." not in token:
        return False
    expires_text, _, _ = token.partition(".")
    try:
        expires = int(expires_text)
    except ValueError:
        return False
    expected = make_credential(key, run_id, position, secrets, expires)
    matched = hmac.compare_digest(expected.encode(), token.encode())
    return matched and expires > (now or datetime.now(tz=timezone.utc)).timestamp()


def pipeline_seconds(pipeline: dict[str, Any], default: int) -> int:
    """The run's longest possible length: the sum of its tasks' time limits."""
    total = 0
    for task in pipeline.get("tasks") or []:
        profile = task.get("execution_profile") if isinstance(task.get("execution_profile"), dict) else {}
        total += int(profile.get("max_exec_time") or default)
    return total


# ---------------------------------------------------------------------------
# The shape stored in the run row (ids, versions, names, env maps; no value)
# ---------------------------------------------------------------------------
def bound_entry(position: int, secrets: list[dict[str, Any]]) -> dict[str, Any]:
    """``secrets``: ``[{id, version, name, env}]`` for one step."""
    return {"step": int(position), "secrets": secrets, "issued": False}


def bound_steps(bound_secrets: Any) -> list[dict[str, Any]] | None:
    """The step entries of a flow run's ``bound_secrets``, or None for a value that
    is not one (a model run's is a list of owner secrets, a different thing)."""
    if isinstance(bound_secrets, dict) and isinstance(bound_secrets.get("steps"), list):
        return [entry for entry in bound_secrets["steps"] if isinstance(entry, dict)]
    return None


def mark_issued(bound_secrets: dict[str, Any], position: int, at: str) -> dict[str, Any]:
    return {**bound_secrets, "steps": [
        {**entry, "issued": True, "issued_at": at} if entry.get("step") == position else entry
        for entry in bound_secrets["steps"]]}

