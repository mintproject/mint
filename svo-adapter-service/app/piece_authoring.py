"""Registering a piece from a repository commit, and what an approval page shows.

Design: docs/design/2026-11-20-flow-authoring-in-the-ui.md, parts D1 and D2.

A piece's code is never typed into a browser. The author names a PUBLIC GitHub
repository, a full commit SHA and the path of one Python file; the adapter fetches
that file from ``raw.githubusercontent.com`` and stores it, as fetched, with its
SHA-256. Nothing here writes: building the catalog row, vetting the fetch and
describing a piece for approval are pure or read-only, so each can be tested
without a network or a database.
"""
from __future__ import annotations

import ast
import collections
import hashlib
import http.client
import json
import re
import secrets as _secrets
import ssl
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Any

from . import gather_fetch, step_secrets, stored_source

ETL_ID_PREFIX = "https://w3id.org/okn/i/mint/etl/"
GITHUB_RAW_HOST = "raw.githubusercontent.com"
# Same ceiling the MCP's piece tool applies to Python source.
MAX_SOURCE_BYTES = 64_000
FETCH_SECONDS = 20
MAX_CONTRACTS = 32
MAX_ARGUMENTS = 32
VISIBILITIES = ("private", "shared", "public")
ARGUMENT_TYPES = ("string", "number", "integer", "boolean")

_OWNER_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
_REPO_RE = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
_COMMIT_RE = re.compile(r"^[0-9a-fA-F]{40}$")
_PATH_RE = re.compile(r"^[A-Za-z0-9._/-]{1,300}$")
_ARGUMENT_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_ENV_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_SLUG_RE = re.compile(r"[^a-z0-9]+")
_ID_RE = re.compile(r"^https://[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]{1,300}$")

CONTRACT_FIELDS = ("standard_variable_uri", "unit", "format", "dimensionality", "spatial_type",
                   "crs_requirement", "temporal_resolution")


class PieceError(Exception):
    """A refusal with the HTTP status and detail to answer with."""

    def __init__(self, status: int, code: str, message: str, **details: Any) -> None:
        super().__init__(code)
        self.status = status
        self.detail = {"code": code, "message": message, **details}


# ---------------------------------------------------------------------------
# Where the source comes from
# ---------------------------------------------------------------------------
def source_address(repository: str, commit: str, path: str) -> tuple[str, str, str]:
    """``(repository, commit, path)`` as they will be used, or a PieceError.

    The commit must be a full 40-character SHA: a branch or tag can move, and an
    approval is given to the bytes that were read, so the address must name them
    for good. The path is a relative path to a ``.py`` file.
    """
    owner, slash, name = (repository or "").partition("/")
    if not (slash and _OWNER_RE.fullmatch(owner) and _REPO_RE.fullmatch(name) and name not in (".", "..")
            and not name.endswith(".git")):
        raise PieceError(422, "PIECE_REPOSITORY_INVALID",
                         "the repository is written owner/name, for a public GitHub repository")
    if not isinstance(commit, str) or not _COMMIT_RE.fullmatch(commit):
        raise PieceError(422, "PIECE_COMMIT_INVALID",
                         "the commit is the full 40-character SHA of a commit; a branch, a tag or "
                         "a short SHA can move or be ambiguous, so none is accepted")
    segments = (path or "").split("/")
    if (not _PATH_RE.fullmatch(path or "") or any(s in ("", ".", "..") for s in segments)
            or not path.endswith(".py")):
        raise PieceError(422, "PIECE_PATH_INVALID",
                         "the path is a relative path to one .py file in the repository")
    return f"{owner}/{name}", commit.lower(), path


def raw_url(repository: str, commit: str, path: str) -> str:
    return f"https://{GITHUB_RAW_HOST}/{repository}/{commit}/{path}"


def _too_large(code: str = "PIECE_SOURCE_TOO_LARGE", limit: int = MAX_SOURCE_BYTES) -> PieceError:
    return PieceError(422, code, f"the response is larger than {limit} bytes", limit_bytes=limit)


def _get(host: str, target: str, *, limit: int, headers: dict[str, str] | None = None,
         too_large: str = "PIECE_SOURCE_TOO_LARGE") -> tuple[int, Any, bytes]:
    """GET ``https://host/target`` and return ``(status, response, body)``.

    The same care as the gather task (``gather_fetch``): the host is resolved
    here and refused unless every address is public, and the connection is made
    to an address that was checked. A redirect is never followed (``PIECE_SOURCE_
    REDIRECTED``), nothing is sent that could authenticate, and the body is cut
    off at ``limit`` bytes and ``FETCH_SECONDS``. Only the transport is judged
    here; what a status means is left to the caller. Blocking.
    """
    try:
        place = gather_fetch.check_url(f"https://{host}{target}")
        addresses = gather_fetch.resolve_public(place["host"])
    except ValueError as error:
        raise PieceError(422, "PIECE_PATH_INVALID", str(error))
    except gather_fetch.GatherError as error:
        raise PieceError(502, "PIECE_SOURCE_ADDRESS_REFUSED", error.message)
    except gather_fetch.Transient as error:
        raise PieceError(502, "PIECE_SOURCE_UNREACHABLE", error.message)

    failure: BaseException | None = None
    for address in addresses:
        connection = gather_fetch.PinnedHTTPSConnection(place["host"], address, FETCH_SECONDS)
        try:
            connection.request("GET", place["target"], headers={
                "User-Agent": "dynamo-piece-fetch/1", "Accept": "*/*",
                "Accept-Encoding": "identity", **(headers or {})})
            response = connection.getresponse()
            break
        except ssl.SSLCertVerificationError:
            connection.close()
            raise PieceError(502, "PIECE_SOURCE_UNREACHABLE", "the server's certificate was not accepted")
        except (OSError, http.client.HTTPException) as error:
            connection.close()
            failure = error
    else:
        raise PieceError(502, "PIECE_SOURCE_UNREACHABLE",
                         f"could not connect ({type(failure).__name__})")
    try:
        status = response.status
        if status in gather_fetch._REDIRECTS:
            raise PieceError(422, "PIECE_SOURCE_REDIRECTED",
                             "GitHub redirected the request; a redirect is not followed")
        declared = response.getheader("Content-Length")
        if declared is not None and declared.isdigit() and int(declared) > limit:
            raise _too_large(too_large, limit)
        deadline = time.monotonic() + FETCH_SECONDS
        body = bytearray()
        while True:
            if time.monotonic() > deadline:
                raise PieceError(502, "PIECE_SOURCE_UNAVAILABLE", "the response took too long to arrive")
            chunk = response.read(gather_fetch.CHUNK)
            if not chunk:
                break
            body.extend(chunk)
            if len(body) > limit:
                raise _too_large(too_large, limit)
        return status, response, bytes(body)
    except (OSError, http.client.HTTPException) as error:
        raise PieceError(502, "PIECE_SOURCE_UNAVAILABLE", f"the transfer failed ({type(error).__name__})")
    finally:
        response.close()
        connection.close()


def fetch_source(repository: str, commit: str, path: str) -> dict[str, Any]:
    """Read the file at that commit over https and return it as fetched.

    Private repositories are not read (no credential is sent), so GitHub answers
    404 and so do we. NOTE: ``raw.githubusercontent.com`` also serves commits that
    exist only in a fork of the named repository; ``verify_commit`` is what
    ties the commit to the repository.

    Blocking: call it from a worker thread.
    """
    repository, commit, path = source_address(repository, commit, path)
    url = raw_url(repository, commit, path)
    status, _response, body = _get(GITHUB_RAW_HOST, f"/{repository}/{commit}/{path}", limit=MAX_SOURCE_BYTES,
                                   headers={"Accept": "text/plain, */*"})
    if status in (401, 403, 404):
        raise PieceError(404, "PIECE_SOURCE_NOT_FOUND",
                         "no such file at that commit in a public repository (a private "
                         "repository is not supported)")
    if status in (408, 429) or status >= 500:
        raise PieceError(502, "PIECE_SOURCE_UNAVAILABLE", f"GitHub answered HTTP {status}; try again")
    if status != 200:
        raise PieceError(422, "PIECE_SOURCE_FAILED", f"GitHub answered HTTP {status}")
    try:
        code = body.decode("utf-8")
    except UnicodeDecodeError:
        raise PieceError(422, "PIECE_SOURCE_NOT_TEXT", "the file is not UTF-8 text")
    return {"repository": repository, "commit": commit, "path": path, "url": url,
            "code": code, "sha256": stored_source.source_sha256(code),
            "bytes": len(body),
            "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}


GITHUB_API_HOST = "api.github.com"
MAX_API_BYTES = 1_000_000
_API_HEADERS = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}


def _api(target: str) -> tuple[int, Any]:
    status, response, body = _get(GITHUB_API_HOST, target, limit=MAX_API_BYTES, headers=_API_HEADERS,
                                  too_large="PIECE_PROVENANCE_UNAVAILABLE")
    if status == 429 or (status == 403 and response.getheader("X-RateLimit-Remaining") == "0"):
        reset = response.getheader("X-RateLimit-Reset")
        raise PieceError(503, "PIECE_PROVENANCE_RATE_LIMITED",
                         "GitHub's limit for unauthenticated requests was reached, so the commit could "
                         "not be checked against the repository; try again later"
                         + (f" (the limit resets at epoch second {reset})" if reset else ""))
    if status >= 500 or status in (401, 403, 408):
        raise PieceError(502, "PIECE_PROVENANCE_UNAVAILABLE",
                         f"GitHub answered HTTP {status} when the commit was checked against the repository")
    try:
        return status, json.loads(body.decode("utf-8")) if body else None
    except (UnicodeDecodeError, ValueError):
        raise PieceError(502, "PIECE_PROVENANCE_UNAVAILABLE", "GitHub's answer could not be read")


def verify_commit(repository: str, commit: str) -> str:
    """The branch whose history holds ``commit``, or a PieceError.

    A raw.githubusercontent.com address serves a commit that exists only in a
    fork as if it were in the named repository, so a repository name alone says
    nothing about who wrote the code. This asks GitHub's REST API (no token) for
    the repository's default branch, then compares ``default_branch...commit``:
    status ``identical`` or ``behind`` means the commit is the tip of that branch
    or an ancestor of it. ``ahead`` and ``diverged`` (a fork's commit, or one on
    a side branch) and a commit GitHub cannot find are refused. Blocking.
    """
    repository, commit, _ = source_address(repository, commit, "x.py")
    status, repo = _api(f"/repos/{repository}")
    if status == 404 or not isinstance(repo, dict) or not isinstance(repo.get("default_branch"), str):
        raise PieceError(404, "PIECE_SOURCE_NOT_FOUND", "no such public repository on GitHub")
    branch = repo["default_branch"]
    status, comparison = _api(
        f"/repos/{repository}/compare/{urllib.parse.quote(branch, safe='/')}...{commit}?per_page=1")
    if status in (404, 422):
        raise PieceError(422, "PIECE_COMMIT_NOT_IN_REPOSITORY",
                         f"GitHub does not find this commit in {repository}; it may belong to a fork")
    result = comparison.get("status") if isinstance(comparison, dict) else None
    if status != 200 or result not in ("identical", "behind", "ahead", "diverged"):
        raise PieceError(502, "PIECE_PROVENANCE_UNAVAILABLE", "GitHub's answer about the commit was not understood")
    if result not in ("identical", "behind"):
        raise PieceError(422, "PIECE_COMMIT_NOT_ON_BRANCH",
                         f"this commit is not in the history of {repository}'s default branch "
                         f"({branch}); it may only exist in a fork or on a side branch")
    return branch


def fetch_verified_source(repository: str, commit: str, path: str) -> dict[str, Any]:
    """``fetch_source`` for a commit that is also shown to belong to the repository."""
    fetched = fetch_source(repository, commit, path)
    fetched["verified_on_branch"] = verify_commit(fetched["repository"], fetched["commit"])
    return fetched


# ---------------------------------------------------------------------------
# Limits on registering
# ---------------------------------------------------------------------------
class RateLimiter:
    """At most ``limit`` calls per user in any ``window`` seconds. In memory, so it
    is per adapter process."""

    def __init__(self, limit: int, window: float) -> None:
        self.limit, self.window = limit, window
        self._calls: dict[str, collections.deque[float]] = {}

    def take(self, user: str, now: float | None = None) -> float | None:
        """None when the call is allowed (and counted); else seconds until it would be."""
        now = time.monotonic() if now is None else now
        calls = self._calls.setdefault(user, collections.deque())
        while calls and now - calls[0] >= self.window:
            calls.popleft()
        if len(calls) >= self.limit:
            return self.window - (now - calls[0])
        calls.append(now)
        if len(self._calls) > 4096:
            self._calls = {u: c for u, c in self._calls.items() if c and now - c[-1] < self.window}
        return None


REGISTRATIONS_PER_HOUR = 30
MAX_PIECES_PER_OWNER = 200
registration_limiter = RateLimiter(REGISTRATIONS_PER_HOUR, 3600.0)


def check_source(code: str, entrypoint: str) -> list[str]:
    """Warnings about the fetched file; a PieceError when it cannot be a piece."""
    if not code.strip():
        raise PieceError(422, "PIECE_SOURCE_EMPTY", "the file is empty")
    try:
        tree = ast.parse(code)
    except (SyntaxError, ValueError, RecursionError, MemoryError) as error:
        raise PieceError(422, "PIECE_SOURCE_INVALID",
                         f"the file does not parse as Python ({type(error).__name__})")
    if not isinstance(entrypoint, str) or not entrypoint.isidentifier():
        raise PieceError(422, "PIECE_ENTRYPOINT_INVALID", "the entrypoint is a Python function name")
    found = [n for n in tree.body
             if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == entrypoint]
    if not found:
        raise PieceError(422, "PIECE_ENTRYPOINT_INVALID",
                         f"the file defines no top-level function named {entrypoint!r}")
    if isinstance(found[-1], ast.AsyncFunctionDef):
        raise PieceError(422, "PIECE_ENTRYPOINT_INVALID", "the entrypoint must be a plain function, not async")
    function = found[-1]
    if len(function.args.args) + len(function.args.posonlyargs) > 1:
        return ["the entrypoint is called with one argument, a dict of its task inputs"]
    return []


# ---------------------------------------------------------------------------
# The catalog row
# ---------------------------------------------------------------------------
def _slug(text: str) -> str:
    return _SLUG_RE.sub("-", text.lower()).strip("-")[:60] or "piece"


def new_process_id(label: str) -> str:
    return f"{ETL_ID_PREFIX}{_slug(label)}-{_secrets.token_hex(3)}"


def _refused_arguments() -> set[str]:
    from . import tapis
    from .planner import MANAGED_PARAMS
    return set(tapis._INPUT_SECRET_PARAMS) | set(MANAGED_PARAMS) | {"tapis_token", "source_uri"}


def _contracts(role: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not items:
        raise PieceError(422, "PIECE_CONTRACT_INVALID", f"at least one {role} is required")
    if len(items) > MAX_CONTRACTS:
        raise PieceError(422, "PIECE_CONTRACT_INVALID", f"at most {MAX_CONTRACTS} {role}s")
    rows = []
    for position, item in enumerate(items):
        uri = (item or {}).get("standard_variable_uri")
        if not isinstance(uri, str) or not uri.strip():
            raise PieceError(422, "PIECE_CONTRACT_INVALID",
                             f"{role}s[{position}]: a standard variable is required")
        rows.append({"role": role, "position": position,
                     **{k: item[k] for k in CONTRACT_FIELDS if item.get(k) not in (None, "")}})
    return rows


def _arguments(arguments: list[dict[str, Any]]) -> tuple[dict[str, Any], list[str]]:
    """The declared run arguments as a JSON-schema object, and the required ones."""
    if len(arguments) > MAX_ARGUMENTS:
        raise PieceError(422, "PIECE_ARGUMENT_INVALID", f"at most {MAX_ARGUMENTS} arguments")
    refused = _refused_arguments()
    properties: dict[str, Any] = {}
    required: list[str] = []
    for argument in arguments:
        name = argument.get("name")
        if not isinstance(name, str) or not _ARGUMENT_RE.fullmatch(name):
            raise PieceError(422, "PIECE_ARGUMENT_INVALID",
                             "an argument name is lowercase letters, digits and underscores, "
                             "starting with a letter")
        if name in properties:
            raise PieceError(422, "PIECE_ARGUMENT_INVALID", f"argument {name!r} is declared twice")
        if name in refused or step_secrets.is_managed_argument(name):
            raise PieceError(422, "PIECE_ARGUMENT_INVALID",
                             f"{name!r} is filled in by the adapter or carries a credential, "
                             "so a piece may not declare it")
        kind = argument.get("type") or "string"
        if kind not in ARGUMENT_TYPES:
            raise PieceError(422, "PIECE_ARGUMENT_INVALID",
                             f"argument {name!r}: type is one of {', '.join(ARGUMENT_TYPES)}")
        schema: dict[str, Any] = {"type": kind}
        if argument.get("description"):
            schema["description"] = str(argument["description"])[:500]
        default = argument.get("default")
        if default is not None:
            if not _fits_type(default, kind):
                raise PieceError(422, "PIECE_ARGUMENT_INVALID",
                                 f"argument {name!r}: the default is not a {kind}")
            schema["default"] = default
        properties[name] = schema
        if argument.get("required"):
            required.append(name)
    return properties, required


def _fits_type(value: Any, kind: str) -> bool:
    if kind == "string":
        return isinstance(value, str)
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def build_piece(request: dict[str, Any], fetched: dict[str, Any], process_id: str) -> dict[str, Any]:
    """The ``insert_modelcatalog_etl_process_one`` object for this request, and
    what the author is told about it. Raises PieceError for a request that
    cannot be a piece. The row is built from the same values that are previewed,
    so what is shown is what is stored."""
    label = (request.get("label") or "").strip()
    if not label or len(label) > 200:
        raise PieceError(422, "PIECE_LABEL_INVALID", "a label of 1 to 200 characters is required")
    if not _ID_RE.fullmatch(process_id):
        raise PieceError(422, "PIECE_ID_INVALID", "the process id is an https URI")
    visibility = request.get("visibility") or "private"
    if visibility not in VISIBILITIES:
        raise PieceError(422, "PIECE_VISIBILITY_INVALID", "visibility is private, shared or public")
    entrypoint = request.get("entrypoint")
    warnings = check_source(fetched["code"], entrypoint)

    contracts = [*_contracts("input", request.get("inputs") or []),
                 *_contracts("output", request.get("outputs") or [])]
    properties, required = _arguments(request.get("arguments") or [])

    env_from_args = request.get("env_from_args")
    if env_from_args is None:
        env_from_args = {name.upper(): name for name in properties}
    if not isinstance(env_from_args, dict) or len(env_from_args) > MAX_ARGUMENTS:
        raise PieceError(422, "PIECE_ARGUMENT_INVALID", "env_from_args maps task input names to arguments")
    refused = _refused_arguments()
    for key, argument in env_from_args.items():
        if not isinstance(key, str) or not _ENV_RE.fullmatch(key) or not isinstance(argument, str):
            raise PieceError(422, "PIECE_ARGUMENT_INVALID",
                             "env_from_args maps task input names (A-Z, 0-9, _) to argument names")
        if key.startswith(step_secrets.RESERVED_INPUT_PREFIXES):
            raise PieceError(422, "PIECE_ARGUMENT_INVALID", f"the task input {key} is filled by the adapter")
        if argument in refused - {"tapis_token", "source_uri"} or step_secrets.is_managed_argument(argument):
            raise PieceError(422, "PIECE_ARGUMENT_INVALID", f"env_from_args may not bind {argument}")
        if argument not in properties and argument not in ("tapis_token", "source_uri"):
            raise PieceError(422, "PIECE_ARGUMENT_INVALID",
                             f"env_from_args binds {argument!r}, which the piece does not declare")

    try:
        declared_secrets = step_secrets.parse_secrets(request.get("secrets"), process_id)
        declared_sends = step_secrets.parse_sends_data_to(request.get("sends_data_to"), process_id)
        step_secrets.step_inputs_check(
            {"step": None, "secrets": declared_secrets}, [], env_from_args.keys())
    except step_secrets.StepSecretError as error:
        raise PieceError(error.status, error.detail.get("code", "SECRET_DECLARATION_INVALID"),
                         error.detail.get("message", "invalid secret declaration"))

    runtime: dict[str, Any] = {
        "language": "python",
        "source": {"language": "python", "code": fetched["code"]},
        "entrypoint": entrypoint,
        # Where the code came from. Informational: what is approved is the stored
        # source, hashed, not this claim.
        "origin": {k: fetched[k] for k in ("repository", "commit", "path", "url", "sha256", "fetched_at",
                                 "verified_on_branch") if k in fetched},
    }
    if env_from_args:
        runtime["env_from_args"] = env_from_args
    if properties:
        runtime["parameters_schema_json"] = {"type": "object", "properties": properties, "required": required}
    if declared_secrets:
        runtime["secrets"] = declared_secrets
    if declared_sends:
        runtime["sends_data_to"] = declared_sends
    row = {
        "id": process_id, "label": label, "description": (request.get("description") or "").strip(),
        "version": (request.get("version") or "1.0.0").strip() or "1.0.0",
        "visibility": visibility, "runtime_kind": "tapis_function", "runtime_json": runtime,
        "contracts": {"data": contracts},
    }
    return {"object": row, "warnings": warnings}


def preview(built: dict[str, Any], spec_row: dict[str, Any] | None) -> dict[str, Any]:
    """What the author sees before anything is written."""
    row = built["object"]
    runtime = row["runtime_json"]
    summary: dict[str, Any] = {
        "process_id": row["id"], "label": row["label"], "description": row["description"],
        "version": row["version"], "visibility": row["visibility"],
        "origin": runtime["origin"], "entrypoint": runtime["entrypoint"],
        "source": runtime["source"]["code"], "source_sha256": runtime["origin"]["sha256"],
        "source_bytes": len(runtime["source"]["code"].encode("utf-8")),
        "contracts": row["contracts"]["data"],
        "arguments": (runtime.get("parameters_schema_json") or {}).get("properties", {}),
        "required": (runtime.get("parameters_schema_json") or {}).get("required", []),
        "env_from_args": runtime.get("env_from_args", {}),
        "secrets": runtime.get("secrets", []),
        "sends_data_to": runtime.get("sends_data_to", []),
        "warnings": built["warnings"],
    }
    # The hash an approval of this piece would record, as the adapter's copy
    # will read it once the catalog row is synced.
    summary["approval_sha256"] = stored_source.approval_sha256(spec_row) if spec_row else None
    return summary


# ---------------------------------------------------------------------------
# What an approval page shows
# ---------------------------------------------------------------------------
def _runtime(spec: dict[str, Any]) -> dict[str, Any]:
    metadata = (spec.get("parameters_schema_json") or {}).get("metadata") or {}
    return metadata.get("runtime") if isinstance(metadata.get("runtime"), dict) else {}


def latest_approvals(events: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """The most recent approval event of each spec, from events newest first."""
    latest: dict[str, dict[str, Any]] = {}
    for event in events:
        payload = event.get("payload_json") or {}
        spec_id = payload.get("transform_spec_id")
        if spec_id and spec_id not in latest:
            latest[spec_id] = event
    return latest


def _event_view(event: dict[str, Any]) -> dict[str, Any]:
    payload = event.get("payload_json") or {}
    return {
        "approved": bool(payload.get("approved_source_sha256")),
        "sha256": payload.get("approved_source_sha256"),
        # An event from the operator route names nobody.
        "by": payload.get("approved_by") or "operator",
        "at": payload.get("approved_at") or event.get("created_at"),
    }


def approval_state(spec: dict[str, Any], latest: dict[str, Any] | None) -> dict[str, Any]:
    """Whether the piece is approved as it is now, and by whom and when.

    ``lapsed``: an approval was recorded but the piece no longer matches it."""
    recorded = spec.get("approved_source_sha256")
    current = stored_source.approval_sha256(spec)
    approved = bool(recorded and current == recorded)
    state: dict[str, Any] = {
        "approved": approved, "lapsed": bool(recorded and not approved),
        "approved_sha256": recorded, "approval_sha256": current,
        "approved_by": None, "approved_at": None,
    }
    if approved and latest:
        view = _event_view(latest)
        if view["approved"] and view["sha256"] == recorded:
            state["approved_by"], state["approved_at"] = view["by"], view["at"]
    return state


def piece_summary(spec: dict[str, Any], latest: dict[str, Any] | None) -> dict[str, Any]:
    """One row of the approvals list."""
    return {
        "spec_id": spec.get("id"), "label": spec.get("name"), "version": spec.get("version"),
        "owner_username": spec.get("owner_username"),
        "visibility": spec.get("visibility") or "public",
        "source_sha256": stored_source.source_sha256(stored_source.stored_source(spec) or ""),
        "origin": _runtime(spec).get("origin"),
        **approval_state(spec, latest),
    }


def piece_detail(spec: dict[str, Any], events: list[dict[str, Any]]) -> dict[str, Any]:
    """Everything an approver is shown: exactly what the approval hash covers."""
    code = stored_source.stored_source(spec) or ""
    schema = spec.get("parameters_schema_json")
    declared = {k: v for k, v in schema.items() if k != "metadata"} if isinstance(schema, dict) else {}
    contracts = spec.get("contracts") or []
    if isinstance(contracts, dict):
        contracts = contracts.get("data") or []
    latest = events[0] if events else None
    return {
        **piece_summary(spec, latest),
        "description": spec.get("description"),
        "process_id": spec.get("mint_etl_process_id"),
        "source": code,
        "entrypoint": stored_source.stored_entrypoint(spec),
        "env_from_args": spec.get("env_from_args") or {},
        "arguments": declared,
        "secrets": step_secrets.raw_declaration(spec, "secrets") or [],
        "sends_data_to": step_secrets.raw_declaration(spec, "sends_data_to") or [],
        "contracts": [{k: c.get(k) for k in ("role", "standard_variable_uri", "unit", "format")}
                      for c in contracts],
        "history": [_event_view(e) for e in events],
    }
