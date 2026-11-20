"""Python source stored with a transform spec, and its approval state.

A spec can carry source in two places inside ``parameters_schema_json.metadata``:
``source`` (specs registered straight into the adapter) and ``runtime.source``
(specs synced from a catalog ETL process). Either may be ``{"code": "..."}`` or
a plain string.
"""
from __future__ import annotations

import ast
import hashlib
import json
from typing import Any, Iterable, Iterator

from .config import settings
from .step_secrets import raw_declaration


def _code(source: Any) -> str | None:
    if isinstance(source, dict):
        source = source.get("code")
    return source if isinstance(source, str) and source.strip() else None


def stored_source(spec: dict[str, Any]) -> str | None:
    """The spec's stored Python source, or None when it runs built-in code."""
    metadata = (spec.get("parameters_schema_json") or {}).get("metadata") or {}
    runtime = metadata.get("runtime") if isinstance(metadata.get("runtime"), dict) else {}
    return _code(metadata.get("source")) or _code(runtime.get("source"))


def stored_entrypoint(spec: dict[str, Any]) -> str | None:
    """Name of the function the piece's author asked to have called, if any."""
    metadata = (spec.get("parameters_schema_json") or {}).get("metadata") or {}
    runtime = metadata.get("runtime") if isinstance(metadata.get("runtime"), dict) else {}
    for source in (metadata.get("source"), runtime.get("source")):
        if isinstance(source, dict) and isinstance(source.get("entrypoint"), str) and source["entrypoint"]:
            return source["entrypoint"]
    name = runtime.get("entrypoint")
    return name if isinstance(name, str) and name else None


def defines_function(source: str, name: str) -> bool:
    """Whether ``source`` defines a top-level function called ``name``."""
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        return False
    return any(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name
               for node in tree.body)


_CALL_ENTRYPOINT = '''

# --- appended by the SVO adapter: call the piece's entrypoint -----------------
# Tapis Workflows runs this file as a script and never calls a named function,
# so the call is made here. The function receives its task inputs as one dict
# (or nothing, if it takes no parameters) and its return value becomes the
# task's "result" output.
import inspect as _svo_inspect
import json as _svo_json
from owe_python_sdk.runtime import execution_context as _svo_ctx

_svo_inputs = {_name: _svo_ctx.get_input(_name) for _name in __INPUT_NAMES__}
_svo_fn = __ENTRYPOINT__
if _svo_inspect.iscoroutinefunction(_svo_fn):
    raise TypeError("the entrypoint must be a plain function, not async")
_svo_result = _svo_fn(_svo_inputs) if _svo_inspect.signature(_svo_fn).parameters else _svo_fn()
if _svo_result is not None:
    _svo_ctx.set_output(
        "result", _svo_result if isinstance(_svo_result, str) else _svo_json.dumps(_svo_result))
'''

# Used instead of the last block above when the step has more than one output. The
# entrypoint may then return {"svo_flow": {"outputs": {position: value}, "values":
# {name: value}}}; each is set as its own task output so that a later step can
# read it. Anything else it returns is the first output, as before.
_SET_FLOW_OUTPUTS = '''
_svo_ids = __OUTPUT_IDS__
_svo_flow = _svo_result.get("svo_flow") if isinstance(_svo_result, dict) else None
if isinstance(_svo_flow, dict):
    _svo_sets = {}
    for _svo_position, _svo_value in (_svo_flow.get("outputs") or {}).items():
        _svo_sets[_svo_ids["outputs"].get(str(_svo_position))] = _svo_value
    for _svo_name, _svo_value in (_svo_flow.get("values") or {}).items():
        _svo_sets[_svo_ids["values"].get(str(_svo_name))] = _svo_value
    if None in _svo_sets:
        raise ValueError("the piece returned an output or value this step does not declare")
elif _svo_result is not None:
    _svo_sets = {"result": _svo_result}
else:
    _svo_sets = {}
_svo_sets = {_k: _v if isinstance(_v, str) else _svo_json.dumps(_v) for _k, _v in _svo_sets.items()}
for _svo_id, _svo_value in _svo_sets.items():
    _svo_ctx.set_output(_svo_id, _svo_value)
# Tapis Workflows does not report a task's named outputs, so they are printed here,
# last, for the adapter to read back from the task's stdout.
print(_svo_json.dumps({"svo_flow_outputs": _svo_sets}))
'''
_SET_ONE_OUTPUT = '''if _svo_result is not None:
    _svo_ctx.set_output(
        "result", _svo_result if isinstance(_svo_result, str) else _svo_json.dumps(_svo_result))
'''


# Inserted before the entrypoint is called when the step is bound to a runner's
# secret (design 2026-11-19-user-secrets-for-flows.md, section 8). The wrapper trades
# the runner's token and the step's own fetch credential for the secret values. It
# never prints them: a failed fetch is one line with a code and a status, no
# response body and no exception text. Masking what the piece prints or returns is
# a best-effort guard, not a guarantee (a value split across writes, or transformed
# by the piece, is not found).
_FETCH_SECRETS = '''
import sys as _svo_sys
import urllib.request as _svo_request


def _svo_fetch_failed(_status):
    print(_svo_json.dumps({"status": "error", "code": "STEP_SECRET_FETCH_FAILED", "http_status": _status}))
    _svo_sys.exit(1)


class _SvoNoRedirect(_svo_request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def _svo_fetch_secrets(_values):
    _status = 0
    try:
        _url = "%s/runs/%s/steps/__STEP__/secrets" % (
            str(_values.get("SVO_ADAPTER_URL") or "").rstrip("/"), _values.get("SVO_RUN_ID"))
        _req = _svo_request.Request(_url, headers={
            "Authorization": "Bearer " + str(_values.get("TAPIS_TOKEN") or ""),
            "X-Step-Secret-Token": str(_values.get("SVO_STEP_SECRET_TOKEN") or "")})
        with _svo_request.build_opener(_SvoNoRedirect).open(_req, timeout=30) as _resp:
            _status = _resp.status
            _fetched = _svo_json.loads(_resp.read().decode("utf-8")).get("inputs")
        if _status == 200 and isinstance(_fetched, dict) and all(
                isinstance(_k, str) and isinstance(_v, str) for _k, _v in _fetched.items()):
            return _fetched
    except Exception as _exc:
        _code = getattr(_exc, "code", 0)
        _status = _code if isinstance(_code, int) and _code else _status
    _svo_fetch_failed(_status)


_svo_fetched = _svo_fetch_secrets(_svo_inputs)
_svo_inputs.update(_svo_fetched)
_svo_inputs.pop("SVO_STEP_SECRET_TOKEN", None)
_svo_hidden = sorted({_v for _v in _svo_fetched.values() if len(_v) >= 4}, key=len, reverse=True)


def _svo_mask(_obj):
    if isinstance(_obj, str):
        for _v in _svo_hidden:
            _obj = _obj.replace(_v, "***")
        return _obj
    if isinstance(_obj, dict):
        return {_svo_mask(_k): _svo_mask(_v) for _k, _v in _obj.items()}
    if isinstance(_obj, (list, tuple)):
        return [_svo_mask(_v) for _v in _obj]
    return _obj


class _SvoMaskedStream:
    def __init__(self, _inner):
        self._inner = _inner

    def write(self, _text):
        return self._inner.write(_svo_mask(_text))

    def flush(self):
        return self._inner.flush()

    def __getattr__(self, _name):
        return getattr(self._inner, _name)


def _svo_call_masked(_fn, _args):
    _out, _err = _svo_sys.stdout, _svo_sys.stderr
    _svo_sys.stdout, _svo_sys.stderr = _SvoMaskedStream(_out), _SvoMaskedStream(_err)
    try:
        return _svo_mask(_fn(*_args))
    except Exception as _exc:
        raise RuntimeError(_svo_mask("%s: %s" % (type(_exc).__name__, _exc))) from None
    finally:
        _svo_sys.stdout, _svo_sys.stderr = _out, _err
'''
_CALL_UNMASKED = "_svo_result = _svo_fn(_svo_inputs) if _svo_inspect.signature(_svo_fn).parameters else _svo_fn()"
_CALL_MASKED = (
    "_svo_result = _svo_call_masked(\n"
    "    _svo_fn, (_svo_inputs,) if _svo_inspect.signature(_svo_fn).parameters else ())")


def runnable_code(
    source: str,
    entrypoint: str | None,
    input_names: Iterable[str],
    output_ids: dict[str, dict[str, str]] | None = None,
    secret_step: int | None = None,
) -> str:
    """The code to hand Tapis Workflows for a stored-source step.

    When the source defines the named entrypoint function, a call to it is
    appended. Otherwise the source is a script that sets its own output and is
    returned unchanged.

    ``output_ids`` is given for a flow step with more than one output: the task
    output id for each output position and each value name.

    ``secret_step`` is the step's position when the step is bound to a runner's
    secret: the code then fetches the values before calling the entrypoint.
    """
    if not entrypoint or not entrypoint.isidentifier() or not defines_function(source, entrypoint):
        return source
    call = _CALL_ENTRYPOINT.replace(
        "__INPUT_NAMES__", json.dumps(sorted(input_names))).replace("__ENTRYPOINT__", entrypoint)
    if secret_step is not None:
        head, marker, tail = call.partition("\n_svo_fn = ")
        assert marker and _CALL_UNMASKED in tail
        call = (head + _FETCH_SECRETS.replace("__STEP__", str(int(secret_step))) + marker
                + tail.replace(_CALL_UNMASKED, _CALL_MASKED))
    if output_ids:
        assert call.endswith(_SET_ONE_OUTPUT)
        call = call[:-len(_SET_ONE_OUTPUT)] + _SET_FLOW_OUTPUTS.lstrip("\n").replace(
            "__OUTPUT_IDS__", json.dumps(output_ids, sort_keys=True))
    return source.rstrip("\n") + call


def source_sha256(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def approval_sha256(spec: dict[str, Any]) -> str | None:
    """What an approval is given for: the piece's source, the function called in
    it, the run arguments it is handed, the arguments it declares, the secrets it
    asks for and the statement of where it sends data.

    The source alone is not enough. A piece runs with the token of whoever runs
    it, and which arguments reach the code decides what it can do with that:
    an approved piece that later bound one more argument would still read as
    approved. Returns None for a piece with no stored source.
    """
    source = stored_source(spec)
    if not source:
        return None
    schema = spec.get("parameters_schema_json")
    declared = {k: v for k, v in schema.items() if k != "metadata"} if isinstance(schema, dict) else {}
    covered = {
        "source": source,
        "entrypoint": stored_entrypoint(spec),
        "env_from_args": spec.get("env_from_args") or {},
        "arguments": declared,
    }
    # Only when declared, so an approval given before this existed still holds for a
    # piece that declares neither.
    for key in ("secrets", "sends_data_to"):
        declaration = raw_declaration(spec, key)
        if declaration:
            covered[key] = declaration
    text = json.dumps(covered, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def is_approved(spec: dict[str, Any]) -> bool:
    """True only while the piece is as it was when an admin approved it."""
    approved = spec.get("approved_source_sha256")
    return bool(approved and approval_sha256(spec) == approved)


# ---------------------------------------------------------------------------
# Who may run a piece's stored source
# ---------------------------------------------------------------------------

def decision(spec: dict[str, Any], username: str | None, opt_in_ids: Iterable[str] = ()) -> str:
    """Why ``username`` may (or may not) run this piece.

    ``builtin``   no stored source: runs code reviewed in this repository
    ``own``       the caller owns the piece
    ``approved``  shared or public, and an admin approved the current source
    ``opt_in``    shared or public, unapproved, and the caller named it
    ``denied``    anything else, and every stored-source piece while
                  ``stored_source_enabled`` is off
    """
    if not stored_source(spec):
        return "builtin"
    if not settings.stored_source_enabled:
        return "denied"
    owner = spec.get("owner_username")
    if username and owner and owner == username:
        return "own"
    if (spec.get("visibility") or "public") in ("shared", "public"):
        if is_approved(spec):
            return "approved"
        if username and spec.get("id") in set(opt_in_ids):
            return "opt_in"
    return "denied"


def plannable(registry: list[dict[str, Any]], username: str | None,
              opt_in_ids: Iterable[str] = ()) -> list[dict[str, Any]]:
    """The pieces the planner may choose for this caller."""
    opt_in = set(opt_in_ids)
    return [spec for spec in registry if decision(spec, username, opt_in) != "denied"]


def annotate_step(step: dict[str, Any], spec: dict[str, Any], source: str) -> None:
    """Record on a plan step which stored source it carries, so the submit-time
    check can tell whether the piece changed after the plan was made."""
    step["python_source"] = source
    step["stored_source"] = {
        "spec_id": spec.get("id"),
        "owner_username": spec.get("owner_username"),
        "visibility": spec.get("visibility") or "public",
        "sha256": source_sha256(source),
        "approved": is_approved(spec),
    }


def iter_stored_steps(node: Any) -> Iterator[dict[str, Any]]:
    """Every step carrying stored source anywhere in a plan (main steps and the
    steps nested under input stages)."""
    if isinstance(node, dict):
        if isinstance(node.get("python_source"), str):
            yield node
        for value in node.values():
            yield from iter_stored_steps(value)
    elif isinstance(node, list):
        for value in node:
            yield from iter_stored_steps(value)


def check_plan(plan_json: dict[str, Any], registry: list[dict[str, Any]],
               username: str | None, opt_in_ids: Iterable[str] = ()) -> list[dict[str, Any]]:
    """Problems that stop ``username`` submitting this plan. Empty = allowed.

    Evaluated against the submitter, not whoever made the plan, and against the
    piece as it is now, not as it was when the plan was made.
    """
    by_id = {spec.get("id"): spec for spec in registry}
    opt_in = set(opt_in_ids)
    problems: list[dict[str, Any]] = []
    for step in iter_stored_steps(plan_json):
        recorded = step.get("stored_source") or {}
        spec_id = step.get("transform_spec_id") or recorded.get("spec_id")
        spec = by_id.get(spec_id)

        def problem(code: str) -> None:
            problems.append({"code": code, "transform_spec_id": spec_id})

        if not settings.stored_source_enabled:
            problem("STORED_SOURCE_DISABLED")
        elif spec is None:
            problem("STORED_SOURCE_PIECE_NOT_VISIBLE")
        elif not (recorded.get("sha256") == source_sha256(step["python_source"])
                  == source_sha256(stored_source(spec) or "")):
            problem("STORED_SOURCE_CHANGED")
        elif decision(spec, username, opt_in) == "denied":
            problem("STORED_SOURCE_NOT_PERMITTED")
    return problems


def allowed_args(step: dict[str, Any], secret_params: Iterable[str]) -> set[str]:
    """Pipeline args a stored-source step may bind: its Tapis token, its source
    URI and the run arguments the piece declares, never another secret."""
    declared = set(((step.get("parameters_schema_json") or {}).get("properties") or {}))
    return ({"tapis_token", "source_uri"} | declared) - (set(secret_params) - {"tapis_token"})
