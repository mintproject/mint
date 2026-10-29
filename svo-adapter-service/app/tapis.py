"""Emit a Tapis Workflows pipeline from a stored plan, and submit it.

This deliberately mirrors how SUBSIDE registers + runs its pipelines
(subside/api/services/manager.py + subside/tapis/workflows/register.py) so an
adapter-generated pipeline is *interchangeable* with SUBSIDE's:

  * the generated definition has the same shape SUBSIDE registers — a workflow
    with a `params` block and chained tasks (here, one `tapis_job` task per
    transform step, depends_on'd into a DAG);
  * it is registered into a Tapis Workflows group via the V3 HTTP API (same as
    register.py), then run via `client.workflows.runPipeline(group_id,
    pipeline_id, name, args={param: {value: ...}})` — the exact call SUBSIDE's
    manager._trigger_pipeline makes;
  * run args use the same param names SUBSIDE uses (start_date, end_date,
    aoi_geojson_uri, earthdata_netrc_uri, allocation, tapis_base_url,
    tapis_token), so the same caller-side arg builder drives either pipeline.

The Tapis Workflows V3 surface is still moving; where tapipy lacks a typed
method we fall back to raw HTTP via the authenticated session (the same stance
register.py takes). Verify endpoint paths against the live tenant on first run.

Live execution additionally requires the caller to hold the Tapis `workflows`
service grant in the tenant — the documented SUBSIDE blocker. That is an
account grant, not a code gap: once granted, this path runs unchanged.
"""
from __future__ import annotations

import base64
import json
import time
import textwrap
from typing import Any

from .config import settings
from .etl_contract import normalize_env_from_args
from .run_tokens import run_token_ttl

try:
    from .config import settings
except ImportError:  # pydantic-settings absent (e.g. offline generation tests)
    class _Defaults:
        tapis_base_url = "https://portals.tapis.io"
        tapis_tenant = None
        tapis_token = None
        tapis_workflow_group = "adapter-ops"
        tapis_workflow_owner = "${apiUserId}"
        tapis_exec_system = "ls6"
        tapis_allocation = "PT2050-DataX"
        request_timeout_seconds = 30.0
    settings = _Defaults()

# Run params the generated pipeline declares. Names + intent match SUBSIDE's
# werc-opera.yaml so a SUBSIDE-style arg builder is interchangeable. Each task's
# tapis_job_def pulls concrete values from these at run time.
STANDARD_PARAMS: dict[str, dict[str, Any]] = {
    "start_date": {"type": "string", "required": True},
    "end_date": {"type": "string", "required": True},
    "aoi_geojson_uri": {"type": "string", "required": True},
    "earthdata_netrc_uri": {"type": "string", "default": "", "required": False},
    "allocation": {
        "type": "string",
        "default": settings.tapis_allocation,
        "required": False,
    },
    "tapis_base_url": {"type": "string", "default": "https://portals.tapis.io"},
    "tapis_token": {"type": "string", "required": True,
                    "description": "User Tapis bearer token for the job submissions"},
    # Point-location params — first-class pipeline params like any MINT model
    # parameter. Tasks that need them declare LAT/LON in their env_from_args.
    "lat": {"type": "number", "required": False, "description": "Point latitude (WGS84)"},
    "lon": {"type": "number", "required": False, "description": "Point longitude (WGS84)"},
    # Tapis Abaco actor ID for the dso-geo GDAL/MODFLOW actor (mcp-suite/servers/geo).
    "geo_actor_id": {
        "type": "string",
        "default": getattr(settings, "geo_actor_id", "") or "",
        "required": False,
    },
    # CKAN + STAC dual-write (the stac-publish piece). Blank disables publishing,
    # matching SUBSIDE's werc-opera.yaml.
    "stac_url": {"type": "string", "default": "", "required": False},
    "stac_collection": {"type": "string", "default": "subsidence-rates", "required": False},
    "ckan_url": {"type": "string", "default": "https://ckan.tacc.utexas.edu", "required": False},
    "ckan_token": {"type": "string", "default": "", "required": False},
}


def _model_execution_code(model_task: dict[str, Any]) -> str:
    """Return the SVO-owned model submit/poll/output-discovery function.

    The function captures the provider UUID returned by ``/v3/jobs/submit``.
    Every later Jobs request uses that exact UUID; no workflow execution ID,
    job-name search, or guessed archive directory is used as identity.
    """
    job_definition = model_task.get("job_definition") or {}
    output_name = model_task.get("output_name") or ""
    output_format = model_task.get("output_format") or ""
    # Renewal only when per-run tokens are on; otherwise the stage keeps the
    # token it was given for the whole wait, as before.
    renew_ttl = run_token_ttl() if settings.run_token_enabled else 0
    source = textwrap.dedent(
        """
        import base64, http.client, json, socket, time, urllib.error as _ue, urllib.parse as _up, urllib.request as _ur
        try:
            from owe_python_sdk.runtime import execution_context as _ctx
        except Exception:
            _ctx = None

        def _input(name, default="", allow_environment=True):
            value = None
            if _ctx is not None:
                try:
                    value = _ctx.get_input(name)
                except Exception:
                    value = None
            # Hosted composite tasks must receive the caller's token through
            # the workflow argument binding.  Environment fallback remains
            # useful for local/generated-code tests, but is never consulted
            # when the hosted execution context is present and the caller
            # token is requested with allow_environment=False.
            if value in (None, "") and (allow_environment or _ctx is None):
                import os
                value = os.environ.get(name, default)
            return default if value in (None, "") else value

        _attempts = []

        def _die(message, code="MODEL_OUTPUT_DISCOVERY_FAILED", details=None):
            payload = {"schema_version": 1, "status": "error", "code": code,
                       "message": message, "attempts": _attempts[-40:]}
            if details:
                payload["details"] = details
            text = json.dumps(payload)
            if _ctx is not None:
                try:
                    _ctx.set_output("result", text)
                except Exception:
                    pass
            print(text)
            # SystemExit is rendered by Tapis Workflows as `Task Failed: []`,
            # discarding the structured diagnostic.  A bounded RuntimeError
            # keeps the task failed while preserving the safe category/message
            # in the workflow task's last_message.
            raise RuntimeError("%s: %s" % (code, message))

        _base = _input("TAPIS_BASE_URL", "https://portals.tapis.io").rstrip("/")
        _token = _input("TAPIS_TOKEN", "", allow_environment=False).strip()
        _job_definition = __JOB_DEFINITION__
        _job_name = __JOB_NAME__
        _output_name = __OUTPUT_NAME__.lower()
        _output_format = __OUTPUT_FORMAT__.lower()
        _renew_ttl = __RENEW_TTL__
        if not _token:
            _die("TAPIS_TOKEN is required for the composite model stage", "MODEL_SUBMISSION_AUTH_REQUIRED")
        # The live token sits in a dict so renewal can swap it without rebinding a global.
        _auth = {"token": _token, "retry_at": 0.0}

        def _claims(token):
            try:
                payload = token.split(".")[1]
                payload += "=" * (-len(payload) % 4)
                return json.loads(base64.urlsafe_b64decode(payload))
            except Exception:
                return {}

        def _renew_if_due():
            # Mint a fresh token from the live one before it expires, so the wait is
            # bounded by the job and not by any single token's lifetime. A failed
            # renewal is retried shortly; the current token keeps working until it
            # actually expires, and a rejected token still ends the stage.
            if not _renew_ttl or time.time() < _auth["retry_at"]:
                return
            claims = _claims(_auth["token"])
            expires_at = claims.get("exp")
            if not expires_at or int(expires_at) - time.time() > max(300, _renew_ttl // 4):
                return
            body = {
                "token_tenant_id": claims.get("tapis/tenant_id") or "portals",
                "account_type": "user",
                "token_username": claims.get("tapis/username"),
                "target_site_id": "__TARGET_PREFIX__-%x" % int(time.time()),
                "access_token_ttl": _renew_ttl,
            }
            request = _ur.Request(
                _base + "/v3/tokens", data=json.dumps(body).encode(),
                headers={"X-Tapis-Token": _auth["token"], "Content-Type": "application/json"},
                method="POST")
            try:
                with _ur.urlopen(request, timeout=90) as response:
                    fresh = (((json.loads(response.read().decode()) or {}).get("result") or {})
                             .get("access_token") or {}).get("access_token")
            except Exception:
                fresh = None
            if fresh:
                _auth["token"] = fresh
            else:
                _auth["retry_at"] = time.time() + 30

        class _Transient(Exception):
            pass

        def _note(entry):
            _attempts.append(entry)
            del _attempts[:-200]

        def _request(path, method="GET", payload=None, tolerate=False):
            # tolerate=True raises _Transient for network errors and 5xx/429 so a
            # long wait can ride out an outage; auth failures always end the stage.
            body = None if payload is None else json.dumps(payload).encode()
            headers = {"X-Tapis-Token": _auth["token"], "Accept": "application/json"}
            if body is not None:
                headers["Content-Type"] = "application/json"
            request = _ur.Request(_base + path, data=body, headers=headers, method=method)
            try:
                with _ur.urlopen(request, timeout=90) as response:
                    _note({"method": method, "path": path, "status": response.getcode()})
                    return json.loads(response.read().decode())
            except _ue.HTTPError as exc:
                _note({"method": method, "path": path, "status": exc.code})
                if exc.code in (401, 403):
                    _die(
                        "the UI Tapis token was rejected during model %s (HTTP %s)"
                        % (method.lower(), exc.code),
                        "MODEL_PROVIDER_AUTH_FAILED",
                        {"http_status": exc.code, "operation": method.lower(), "path": path},
                    )
                if tolerate and (exc.code >= 500 or exc.code in (408, 429)):
                    raise _Transient()
                _die("Tapis model request failed with HTTP %s" % exc.code,
                     "MODEL_PROVIDER_REQUEST_FAILED")
            except (_ue.URLError, OSError, http.client.HTTPException, ValueError) as exc:
                _note({"method": method, "path": path,
                       "status": "transport_error", "error": type(exc).__name__})
                if tolerate:
                    raise _Transient()
                _die("Tapis model request failed: %s" % type(exc).__name__,
                     "MODEL_PROVIDER_REQUEST_FAILED")

        def _request_retry(path):
            # One-off reads after the job finished: a blip here must not discard the run.
            for _try in range(6):
                try:
                    return _request(path, tolerate=True)
                except _Transient:
                    time.sleep(10)
            _die("Tapis kept failing after the model job finished",
                 "MODEL_PROVIDER_REQUEST_FAILED")

        def _find(value, names):
            if isinstance(value, dict):
                for name in names:
                    if value.get(name):
                        return value[name]
                for child in value.values():
                    found = _find(child, names)
                    if found:
                        return found
            elif isinstance(value, list):
                for child in value:
                    found = _find(child, names)
                    if found:
                        return found
            return None

        _submitted = _request("/v3/jobs/submit", method="POST", payload=_job_definition)
        _job_uuid = _find(_submitted, {"uuid", "jobUuid", "jobUUID"})
        if not _job_uuid:
            _die("Tapis did not return a model job UUID", "MODEL_PROVIDER_JOB_ID_MISSING")
        _job_uuid = str(_job_uuid)
        _status_path = "/v3/jobs/%s/status" % _up.quote(_job_uuid, safe="")
        _terminal = None
        _last_ok = time.time()
        while True:
            _renew_if_due()
            try:
                _status_payload = _request(_status_path, tolerate=True)
            except _Transient:
                # Ride out a Tapis/network outage; give up only if it persists.
                if time.time() - _last_ok > __OUTAGE_SECONDS__:
                    _die("Tapis job status was unreachable for over %d seconds" % __OUTAGE_SECONDS__,
                         "MODEL_PROVIDER_REQUEST_FAILED", {"job_uuid": _job_uuid})
                time.sleep(15)
                continue
            _last_ok = time.time()
            _status_result = ((_status_payload or {}).get("result")
                              if isinstance(_status_payload, dict) else None)
            _status = str(_find(_status_result, {"status", "state", "job_status", "jobStatus"})
                          or _find(_status_payload, {"state", "job_status", "jobStatus"})
                          or "").upper().replace(" ", "_")
            if _status in {
                "FINISHED",
                "COMPLETED",
                "SUCCESS",
                "SUCCEEDED",
                "NORMAL_COMPLETION",
            }:
                _terminal = _status
                break
            if _status in {"FAILED", "CANCELLED", "CANCELED", "KILLED", "SYSTEM_ERROR"}:
                _die("model job %s ended with status %s" % (_job_uuid, _status),
                     "MODEL_PROVIDER_JOB_FAILED", {"job_uuid": _job_uuid, "status": _status})
            time.sleep(5)

        _detail = _request_retry("/v3/jobs/%s" % _up.quote(_job_uuid, safe=""))
        _job = (_detail.get("result") if isinstance(_detail, dict) else None) or {}
        _files_payload = _request_retry("/v3/jobs/%s/output/list/" % _up.quote(_job_uuid, safe=""))
        _files_result = (_files_payload or {}).get("result") or []
        if isinstance(_files_result, dict):
            _files_result = (_files_result.get("files") or _files_result.get("items") or
                             _files_result.get("results") or [])
        _files = [entry for entry in _files_result if isinstance(entry, dict) and entry.get("type") != "dir"]
        _wanted = _output_name
        _exact = [entry for entry in _files if str(entry.get("name") or "").lower() == _wanted]
        if len(_exact) == 1:
            _selected = _exact[0]
        else:
            _extensions = ([".cbc", ".cbb"] if _wanted in {"cbc", "cbb"} or "cbc" in _output_format
                           else (["." + _wanted] if _wanted else []))
            _matches = [entry for entry in _files if any(
                str(entry.get("name") or "").lower().endswith(ext) for ext in _extensions)]
            if len(_matches) != 1:
                _die("model output %s was not uniquely matched" % _output_name,
                     "MODEL_OUTPUT_AMBIGUOUS",
                     {"job_uuid": _job_uuid, "archived_files": [str(e.get("name") or "") for e in _files[:40]]})
            _selected = _matches[0]

        _url = str(_selected.get("url") or _selected.get("uri") or "")
        _parsed = _up.urlparse(_url)
        if _parsed.scheme == "tapis" and _parsed.netloc and _parsed.path:
            _resource_uri = _url
        else:
            _system = str(_job.get("archiveSystemId") or _job.get("archive_system_id") or
                          _job_definition.get("archiveSystemId") or "")
            _path = str(_selected.get("path") or "").lstrip("/")
            if not _system or not _path:
                _die("Tapis did not return a complete path for the selected model output",
                     "MODEL_OUTPUT_PATH_MISSING", {"job_uuid": _job_uuid})
            _resource_uri = "tapis://%s/%s" % (_system, _path)
        _manifest = {"schema_version": 1, "status": "ok", "resource_uri": _resource_uri,
                     "model_output_key": _output_name, "model_job_name": _job_name,
                     "model_job_uuid": _job_uuid, "archived_name": _selected.get("name")}
        if _ctx is not None:
            try:
                _ctx.set_output("result", _resource_uri)
            except Exception:
                pass
        print(json.dumps(_manifest))
        """
    )
    return (
        source.replace("__JOB_DEFINITION__", repr(job_definition))
        .replace("__JOB_NAME__", repr(job_definition.get("name") or ""))
        .replace("__OUTPUT_NAME__", repr(output_name))
        .replace("__OUTPUT_FORMAT__", repr(output_format))
        .replace("__RENEW_TTL__", str(renew_ttl))
        .replace("__OUTAGE_SECONDS__", str(max(0, int(settings.model_poll_outage_seconds))))
        .replace("__TARGET_PREFIX__", settings.run_token_target_prefix)
    )


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------
def generate_tapis_workflow(
    plan: dict[str, Any],
    *,
    group_id: str | None = None,
    owner: str | None = None,
    tenant: str | None = None,
    exec_system: str | None = None,
    params: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Turn a stored plan's plan_json into a Tapis Workflows pipeline definition.

    Each transform step → one `tapis_job` task running the step's Tapis app,
    chained to the previous step via depends_on. Steps that declare no
    tapis_app_id fall back to a `function` task placeholder (the transform runs
    as hosted code rather than a batch job).
    """
    plan_json = plan.get("plan_json") or {}
    steps = plan_json.get("steps", [])
    pipeline_id = str(plan.get("id") or "adapter-plan")
    group_id = group_id or settings.tapis_workflow_group
    owner = owner or settings.tapis_workflow_owner
    exec_system = exec_system or settings.tapis_exec_system
    params = {
        name: dict(definition)
        for name, definition in (params or STANDARD_PARAMS).items()
    }
    # Transform-specific defaults (including CBC label candidates) are stored
    # in the immutable plan snapshot.  Declare them in the workflow alongside
    # the standard runtime params so task env bindings resolve for new plans;
    # old plans remain supported by the task-code fallback candidates.
    for definition in plan_json.get("parameters") or []:
        name = definition.get("name") if isinstance(definition, dict) else None
        if name and name not in params:
            params[name] = dict(definition)

    # A composite MINT run supplies a server-generated model job definition.
    # Keep it in the same provider pipeline as the adapter transforms. The
    # bearer token is intentionally not part of this descriptor; it is injected
    # by the submission client at the Tapis boundary.
    # The API stores composite metadata inside the immutable plan snapshot;
    # keep the top-level form for direct generator callers and older tests.
    model_task = plan_json.get("model_task") or plan.get("model_task")
    if model_task:
        params.setdefault("execution_id", {
            "type": "string",
            "required": True,
            "description": "Ensemble Manager logical workflow execution",
        })
        # A composite model produces this URI inside the workflow.  A saved
        # adapter plan may still carry the legacy `required: true` contract,
        # so setdefault is not sufficient here: Tapis validates pipeline args
        # before it can evaluate the model task's task_output handoff.
        params["source_uri"] = {
            **params.get("source_uri", {}),
            "type": "string",
            "required": False,
            "description": "Server-owned model-output handoff URI",
        }

    tasks: list[dict[str, Any]] = []
    prev_id: str | None = None
    if model_task:
        job_definition = dict(model_task.get("job_definition") or {})
        if not job_definition.get("appId") or not job_definition.get("appVersion"):
            raise ValueError("composite model task requires appId and appVersion")
        job_definition.setdefault("execSystemInputDir", "${JobWorkingDir}")
        job_definition.setdefault("execSystemOutputDir", "${JobWorkingDir}/output")
        model_id = str(model_task.get("stage_id") or "model")
        tasks.append({
            "id": model_id,
            "type": "function",
            "runtime": "python:3.11",
            "installer": "pip",
            "description": "Run the model and resolve its declared output for adapter stages",
            "output": {"result": {"type": "string"}},
            "code": _model_execution_code({**model_task, "job_definition": job_definition}),
            "input": {
                "TAPIS_BASE_URL": {
                    "type": "string",
                    "value_from": {"args": "tapis_base_url"},
                },
                "TAPIS_TOKEN": {
                    "type": "string",
                    "value_from": {"args": "tapis_token"},
                },
            },
            "execution_profile": {
                "max_retries": 0,
                "max_exec_time": settings.model_task_max_exec_seconds,
            },
        })
        prev_id = model_id
    # Keep each transform as its own task. Hosted function tasks publish a
    # named `result` output, and scalar-consuming transforms bind explicitly to
    # that output. Task ordering alone is not a data handoff.
    from . import task_code as _task_code
    task_ids_by_step: dict[int, str] = {}
    function_task_ids_by_step: dict[int, str] = {}
    for s in steps:
        task_id = f"step-{s['step']}-{(s.get('transform_type') or 'transform')}"
        app_id = s.get("tapis_app_id")
        declared_dependencies = [int(dep) for dep in (s.get("depends_on") or [])]
        dependency_ids = [
            task_ids_by_step[dep]
            for dep in declared_dependencies
            if dep in task_ids_by_step
        ]
        if app_id:
            task = {
                "id": task_id,
                "type": "tapis_job",
                "execution_profile": {"max_retries": 1},
                "tapis_job_def": {
                    "name": f"{pipeline_id}-{task_id}",
                    "appId": app_id,
                    "appVersion": s.get("app_version") or "${LATEST}",
                    "nodeCount": 1,
                    "execSystemId": exec_system,
                    "archiveOnAppError": True,
                    # fileInputs / envVariables are bound from the pipeline `args`
                    # at run time. Values use Tapis Workflows arg interpolation
                    # (${args.<name>}); VERIFY the exact syntax against the live
                    # tenant on first run, as register.py warns.
                    "fileInputs": _file_inputs(s),
                    "parameterSet": {
                        "envVariables": _env_variables(s),
                        "schedulerOptions": [
                            {"name": "TACC Allocation", "arg": "-A ${args.allocation}"}
                        ],
                    },
                },
            }
        else:
            # No Tapis app → hosted OWE function task. Code is looked up from
            # task_code.get_code(transform_type) so MINT-sourced transforms get
            # the right builder. env_from_args wires pipeline args into the
            # task's env at runtime.
            transform_type = s.get("transform_type")
            task = {
                "id": task_id,
                "type": "function",
                "runtime": "python:3.11",
                "installer": "pip",
                "description": s.get("name"),
                "code": s.get("python_source") or _task_code.get_code(transform_type),
                # Built-in and custom hosted transforms use this stable output
                # name for typed task-to-task handoffs. Custom code must call
                # ctx.set_output("result", json_text) to populate it.
                "output": {"result": {"type": "string"}},
            }
            if s.get("python_entrypoint"):
                task["entrypoint"] = s["python_entrypoint"]
            inputs = {
                key: {"type": "string", "value_from": {"args": arg}}
                for key, arg in (
                    normalize_env_from_args(s.get("env_from_args") or {}) or {}
                ).items()
            }
            # unit_convert is the first scalar consumer in the transform
            # registry. Its input is the preceding function's named result,
            # not another copy of the original pipeline argument.
            source_task_id = next(
                (
                    function_task_ids_by_step[dep]
                    for dep in declared_dependencies
                    if dep in function_task_ids_by_step
                ),
                None,
            )
            if transform_type == "unit_convert" and source_task_id:
                inputs.pop("SOURCE_URI", None)
                inputs["SOURCE_RESULT"] = {
                    "type": "string",
                    "value_from": {
                        "task_output": {
                            "task_id": source_task_id,
                            "output_id": "result",
                        }
                    },
                }
            # The model task publishes the verified URI as a named output. A
            # planned source_uri is only a descriptor and must never be passed
            # directly to the first adapter transform.
            model_task_id = str(model_task.get("stage_id") or "model") if model_task else None
            if model_task and prev_id == model_task_id:
                inputs["SOURCE_URI"] = {
                    "type": "string",
                    "value_from": {
                        "task_output": {
                            "task_id": model_task_id,
                            "output_id": "result",
                        }
                    },
                }
            if inputs:
                task["input"] = inputs
        if dependency_ids:
            task["depends_on"] = [{"id": dep_id} for dep_id in dependency_ids]
        elif prev_id:
            # Older plans omitted depends_on for a simple chain. Preserve that
            # compatibility while honoring explicit DAG edges above.
            task["depends_on"] = [{"id": prev_id}]
        tasks.append(task)
        task_ids_by_step[int(s["step"])] = task_id
        if not app_id:
            function_task_ids_by_step[int(s["step"])] = task_id
        prev_id = task_id

    if model_task:
        # Composite MINT runs use the adapter's task-specific arguments. The
        # SUBSIDE-compatible defaults also declare date/AOI arguments, but
        # those must not block a run when no task references them.
        referenced_args: set[str] = set()

        def collect_arg_references(value: Any) -> None:
            if isinstance(value, dict):
                arg_name = value.get("args")
                if isinstance(arg_name, str):
                    referenced_args.add(arg_name)
                for child in value.values():
                    collect_arg_references(child)
            elif isinstance(value, list):
                for child in value:
                    collect_arg_references(child)
            elif isinstance(value, str):
                for name in params:
                    if f"args.{name}" in value:
                        referenced_args.add(name)

        collect_arg_references(tasks)
        for name in ("start_date", "end_date", "aoi_geojson_uri"):
            if name in params and name not in referenced_args:
                params[name] = {**params[name], "required": False}

    return {
        "id": pipeline_id,
        "type": "workflow",
        "description": f"svo-adapter generated ETL pipeline ({len(steps)} step(s))",
        "owner": owner,
        "group_id": group_id,
        **({"tenant_id": tenant or settings.tapis_tenant}
           if (tenant or settings.tapis_tenant) else {}),
        "params": params,
        "tasks": tasks,
        # TODO: append a final "bind-to-model-input" task once the target
        # ModelConfiguration + DatasetSpecification mapping is wired to the
        # Ensemble Manager. Left unbound, as in the first cut.
        "binds_model_input": plan.get("target_dataset_specification_id"),
    }


def _env_variables(step: dict[str, Any]) -> list[dict[str, str]]:
    """Per-step Tapis env vars. STAGE selects the app subcommand (SUBSIDE pattern:
    one image, many stages dispatched by STAGE); the rest bind from pipeline args."""
    env = [{"key": "STAGE", "value": step.get("stage") or step.get("name") or "run"}]
    for key, arg in (normalize_env_from_args(step.get("env_from_args") or {}) or {}).items():
        env.append({"key": key, "value": f"${{args.{arg}}}"})
    return env


def _file_inputs(step: dict[str, Any]) -> list[dict[str, str]]:
    """Per-step Tapis fileInputs, bound from pipeline args (e.g. the AOI GeoJSON)."""
    inputs = []
    for spec in (step.get("file_inputs") or []):
        inputs.append({
            "name": spec["name"],
            "sourceUrl": f"${{args.{spec['from_arg']}}}",
            "targetPath": spec["target_path"],
        })
    return inputs


# ---------------------------------------------------------------------------
# NTGAM forecast pipeline — hosted function tasks that mirror the BFS plan's DAG:
# one function task per ETL input branch, then a converging forecast task.
# OWE transforms ctx.get_input() to os.environ[] but does NOT set those vars from
# value_from.args, so all values are embedded via base64 instead.
# ETL tasks write their output to the OWE shared work dir so the forecast task
# can optionally read them; the forecast task also embeds a full scenario fallback.
# ---------------------------------------------------------------------------
_OWE_WORK_DIR = "/mnt/open-workflow-engine/pipeline/work"

# Maps transform name → the scenario key that transform produces.
_TRANSFORM_OUTPUT_KEY: dict[str, str] = {
    "head-m-to-ft-msl": "current_water_level_ft_msl",
    "elevation-m-to-ft": "land_surface_ft_msl",
    "storativity-passthrough": "aquifer_storage_coefficient",
}


def _task_id(step_idx: int, name: str) -> str:
    safe = "".join(c if (c.isalnum() or c == "-") else "-" for c in name)
    return f"step{step_idx}-{safe[:30]}"


def _build_etl_task_code(
    step_idx: int,
    source_uri: str,
    transform_name: str,
    output_key: str,
    scenario_value: Any,
) -> str:
    """Function task for one input branch: records what data was fetched, applies
    the transform (using the pre-assembled scenario value since rasterio/GDAL aren't
    available in OWE function tasks), and writes the result to the shared work dir
    so the forecast task can override its fallback scenario."""
    result = {
        "step": step_idx,
        "transform": transform_name,
        "source_uri": source_uri,
        output_key: scenario_value,
    }
    result_b64 = base64.b64encode(json.dumps(result).encode()).decode()
    fname = repr(f"step{step_idx}.json")
    return (
        "import json, base64, os\n"
        f"os.makedirs({repr(_OWE_WORK_DIR)}, exist_ok=True)\n"
        f"result = json.loads(base64.b64decode({repr(result_b64)}))\n"
        f"open(os.path.join({repr(_OWE_WORK_DIR)}, {fname}), 'w').write(json.dumps(result))\n"
        "print(json.dumps(result))\n"
    )


def _build_forecast_code(scenario: dict[str, Any], repo: str) -> str:
    """Forecast function task: full scenario embedded as base64 fallback; also reads
    any step*.json files written by upstream ETL tasks from the shared work dir."""
    scenario_b64 = base64.b64encode(json.dumps(scenario).encode()).decode()
    repo_repr = repr(repo)
    _skip = repr({"step", "transform", "source_uri"})
    return (
        "import json, base64, glob, subprocess, sys, os\n"
        f"subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'numpy', 'pandas'], check=True)\n"
        f"subprocess.run(['git', 'clone', '--depth', '1', {repo_repr}, '/tmp/subside'], check=True)\n"
        "sys.path.insert(0, '/tmp/subside')\n"
        "from analysis.subsidence.forecast import run_forecast\n"
        f"scenario = json.loads(base64.b64decode({repr(scenario_b64)}))\n"
        # Merge in any ETL task outputs (best-effort — no-op if work dir absent)
        f"for p in glob.glob(os.path.join({repr(_OWE_WORK_DIR)}, 'step*.json')):\n"
        "    try:\n"
        f"        d = json.load(open(p)); skip = {_skip}\n"
        "        scenario.update({k: v for k, v in d.items() if k not in skip})\n"
        "    except Exception: pass\n"
        "result = run_forecast(scenario)\n"
        "print(json.dumps(result))\n"
    )


def build_forecast_pipeline(
    pipeline_id: str,
    *,
    scenario: dict[str, Any] | None = None,
    plan_steps: list[dict[str, Any]] | None = None,
    group_id: str | None = None,
    owner: str | None = None,
    tenant: str | None = None,
    subside_repo: str = "https://github.com/wmobley/subside.git",
) -> dict[str, Any]:
    """Build a Tapis Workflows pipeline for the SUBSIDE subsidence forecast.

    When `plan_steps` is supplied (from build_model_run_plan_json), the pipeline
    mirrors the BFS DAG: one function task per ETL input branch (all steps except
    the last), then a converging forecast task that depends on them all.
    Without plan_steps, falls back to a single forecast task."""
    group_id = group_id or settings.tapis_workflow_group
    owner = owner or settings.tapis_workflow_owner
    scen = scenario or {}
    tasks: list[dict[str, Any]] = []

    if plan_steps and len(plan_steps) > 1:
        # Split into ETL steps (all but last) + the model-run step (last)
        etl_steps = plan_steps[:-1]

        # step_idx → task_id for depends_on resolution
        sid: dict[int, str] = {}
        for s in etl_steps:
            idx = s["step"]
            name = s.get("name") or s.get("transform_type") or f"step{idx}"
            tid = _task_id(idx, name)
            sid[idx] = tid
            output_key = _TRANSFORM_OUTPUT_KEY.get(name, f"step{idx}_value")
            task: dict[str, Any] = {
                "id": tid,
                "type": "function",
                "runtime": "python:3.11",
                "installer": "pip",
                "description": f"{name} — source: {s.get('source') or 'unknown'}",
                "code": _build_etl_task_code(
                    idx,
                    s.get("source") or "",
                    name,
                    output_key,
                    scen.get(output_key),
                ),
            }
            deps = [sid[d] for d in (s.get("depends_on") or []) if d in sid]
            if deps:
                task["depends_on"] = [{"id": d} for d in deps]
            tasks.append(task)

        run_step = plan_steps[-1]
        run_idx = run_step["step"]
        forecast_task: dict[str, Any] = {
            "id": _task_id(run_idx, "forecast"),
            "type": "function",
            "runtime": "python:3.11",
            "installer": "pip",
            "description": "Run SUBSIDE subsidence forecast (converges all input branches)",
            "code": _build_forecast_code(scen, subside_repo),
        }
        if sid:
            forecast_task["depends_on"] = [{"id": tid} for tid in sid.values()]
        tasks.append(forecast_task)
    else:
        tasks.append({
            "id": "forecast",
            "type": "function",
            "runtime": "python:3.11",
            "installer": "pip",
            "description": "Run the SUBSIDE subsidence screening model",
            "code": _build_forecast_code(scen, subside_repo),
        })

    return {
        "id": pipeline_id,
        "type": "workflow",
        "description": f"svo-adapter NTGAM subsidence forecast ({len(tasks)} task(s))",
        "owner": owner,
        "group_id": group_id,
        **({"tenant_id": tenant or settings.tapis_tenant}
           if (tenant or settings.tapis_tenant) else {}),
        "tasks": tasks,
    }


# ---------------------------------------------------------------------------
# Submission — emulates SUBSIDE (register into a group, then runPipeline)
# ---------------------------------------------------------------------------
def _make_client(token: str | None = None):
    """Build a tapipy client. Lazy import so the module loads without tapipy
    (the planner/generation tests need neither tapipy nor a live tenant)."""
    try:
        from tapipy.tapis import Tapis
    except ImportError as exc:  # pragma: no cover - env-dependent
        raise RuntimeError(
            "tapipy is required to submit to Tapis Workflows. `pip install tapipy`."
        ) from exc
    tok = token or settings.tapis_token
    if not tok:
        raise RuntimeError(
            "No Tapis token: forward the caller's bearer token or set "
            "SVO_ADAPTER_TAPIS_TOKEN."
        )
    return Tapis(base_url=settings.tapis_base_url.rstrip("/"), jwt=tok)


def _session_token(client) -> str:
    access = getattr(client, "access_token", None)
    if access is not None:
        return getattr(access, "access_token", None) or str(access)
    return settings.tapis_token or ""


def _api_headers(client) -> dict[str, str]:
    return {"X-Tapis-Token": _session_token(client), "Content-Type": "application/json"}


def _api(client, method: str, path: str, body: dict | None = None):
    import requests
    url = f"{client.base_url.rstrip('/')}{path}"
    return requests.request(
        method, url, headers=_api_headers(client),
        data=json.dumps(body) if body is not None else None,
        timeout=settings.request_timeout_seconds,
    )


def _ensure_group(client, group_id: str) -> None:
    resp = _api(client, "GET", f"/v3/workflows/groups/{group_id}")
    if 200 <= resp.status_code < 300:
        return
    create = _api(client, "POST", "/v3/workflows/groups",
                  {"id": group_id, "owner": getattr(client, "username", None) or "user"})
    if not (200 <= create.status_code < 300):
        raise RuntimeError(
            f"could not ensure Workflows group {group_id}: "
            f"HTTP {create.status_code} {create.text[:300]}"
        )


def _encode_function_code(pipeline: dict[str, Any]) -> dict[str, Any]:
    """Base64-encode any function-task `code` for the Workflows byte-string field
    (mirrors register._encode_function_task_code). Returns a shallow copy."""
    out = dict(pipeline)
    tasks = []
    for task in pipeline.get("tasks", []) or []:
        if task.get("type") == "function" and isinstance(task.get("code"), str):
            task = {**task, "code": base64.b64encode(task["code"].encode()).decode("ascii")}
        tasks.append(task)
    out["tasks"] = tasks
    return out


def register_pipeline(client, pipeline: dict[str, Any], group_id: str, recreate: bool = False) -> None:
    """Create (or recreate) the pipeline in the Workflows group via the V3 API.

    Mirrors register._register_pipeline: PUT isn't supported, so a re-sync is
    delete + create. We default to create-if-absent / recreate-on-demand because
    a PATCH cannot update task definitions."""
    base = f"/v3/workflows/groups/{group_id}/pipelines"
    pid = pipeline["id"]
    body = _encode_function_code(pipeline)
    exists = 200 <= _api(client, "GET", f"{base}/{pid}").status_code < 300
    if exists and recreate:
        _api(client, "DELETE", f"{base}/{pid}")
        exists = False
    if not exists:
        resp = _api(client, "POST", base, body)
        if not (200 <= resp.status_code < 300):
            raise RuntimeError(
                f"failed to register pipeline {pid}: HTTP {resp.status_code} {resp.text[:300]}"
            )


def run_pipeline(client, group_id: str, pipeline_id: str, name: str,
                 args: dict[str, dict[str, Any]], description: str = "svo-adapter run") -> str | None:
    """Trigger the pipeline and return the run uuid. Falls back to diffing
    listPipelineRuns when runPipeline doesn't echo a uuid (SUBSIDE's pattern)."""
    before: set = set()
    try:
        prior = client.workflows.listPipelineRuns(group_id=group_id, pipeline_id=pipeline_id)
        before = {getattr(r, "uuid", None) for r in (prior or [])}
    except Exception:
        pass

    result = client.workflows.runPipeline(
        group_id=group_id, pipeline_id=pipeline_id,
        name=name, description=description, args=args,
    )
    run_uuid = getattr(result, "uuid", None)
    if run_uuid:
        return run_uuid
    for _ in range(8):
        time.sleep(1)
        try:
            now = client.workflows.listPipelineRuns(group_id=group_id, pipeline_id=pipeline_id)
        except Exception:
            continue
        new = {getattr(r, "uuid", None) for r in (now or [])} - before
        new.discard(None)
        if new:
            return sorted(new)[0]
    return None


def get_run_status(pipeline_id: str, run_uuid: str, *,
                   token: str | None = None, group_id: str | None = None) -> str | None:
    """Return just the Tapis pipeline run status string (e.g. 'RUNNING', 'COMPLETED').

    Cheaper than get_run_detail — used by the background poller to check whether
    a run has reached a terminal state without fetching full task logs.
    Returns None when the run cannot be fetched (connectivity/auth error).
    """
    client = _make_client(token)
    gid = group_id or settings.tapis_workflow_group
    try:
        run = client.workflows.getPipelineRun(
            group_id=gid, pipeline_id=pipeline_id, pipeline_run_uuid=run_uuid)
        return getattr(run, "status", None)
    except Exception:  # noqa: BLE001 — caller decides what to do with None
        return None


def get_run_detail(pipeline_id: str, run_uuid: str, *, token: str | None = None,
                   client=None, group_id: str | None = None) -> dict[str, Any]:
    """Fetch a pipeline run + its task executions (status, last_message, stdout, stderr)
    so the UI can show whether a run worked and why a task failed. Mirrors dump_run.py."""
    client = client or _make_client(token)
    group_id = group_id or settings.tapis_workflow_group
    out: dict[str, Any] = {"group_id": group_id, "pipeline_id": pipeline_id, "run_uuid": run_uuid}
    try:
        run = client.workflows.getPipelineRun(
            group_id=group_id, pipeline_id=pipeline_id, pipeline_run_uuid=run_uuid)
        out["status"] = getattr(run, "status", None)
        out["logs"] = getattr(run, "logs", None)
    except Exception as exc:  # noqa: BLE001
        out["run_error"] = f"{type(exc).__name__}: {exc}"
    try:
        execs = client.workflows.listTaskExecutions(
            group_id=group_id, pipeline_id=pipeline_id, pipeline_run_uuid=run_uuid) or []
        out["tasks"] = [{
            "task_id": getattr(e, "task_id", None), "status": getattr(e, "status", None),
            "last_message": getattr(e, "last_message", None),
            "stdout": getattr(e, "stdout", None), "stderr": getattr(e, "stderr", None),
        } for e in execs]
    except Exception as exc:  # noqa: BLE001
        out["tasks_error"] = f"{type(exc).__name__}: {exc}"
    return out


def validate_tapis(token: str | None = None, group_id: str | None = None) -> dict:
    """Walk each layer of the Tapis stack and report what works.

    Checks (in order):
    1. tapipy importable
    2. Token accepted (GET /v3/oauth2/userinfo)
    3. Workflows service reachable (GET /v3/workflows/groups)
    4. Target group exists or can be created
    5. Minimal pipeline can be dry-registered (POST + DELETE)

    Each check is independent: a failure stops that check but the rest still run.
    Returns a dict with one key per check, each either {"ok": true} or {"ok": false, "error": "..."}.
    """
    result: dict[str, dict] = {}

    # 1 — tapipy importable
    try:
        from tapipy.tapis import Tapis as _Tapis  # noqa: F401
        result["tapipy"] = {"ok": True}
    except ImportError as exc:
        result["tapipy"] = {"ok": False, "error": str(exc)}
        return result  # nothing else will work

    # 2 — token / auth
    try:
        client = _make_client(token)
        resp = _api(client, "GET", "/v3/oauth2/userinfo")
        if 200 <= resp.status_code < 300:
            username = resp.json().get("username") or resp.json().get("sub")
            result["auth"] = {"ok": True, "username": username,
                              "base_url": settings.tapis_base_url}
        else:
            result["auth"] = {"ok": False, "status": resp.status_code, "body": resp.text[:300]}
            return result
    except Exception as exc:  # noqa: BLE001
        result["auth"] = {"ok": False, "error": str(exc)}
        return result

    # 3 — Workflows service reachable
    gid = group_id or settings.tapis_workflow_group
    try:
        resp = _api(client, "GET", "/v3/workflows/groups")
        if 200 <= resp.status_code < 300:
            result["workflows_service"] = {"ok": True}
        elif resp.status_code == 403:
            result["workflows_service"] = {
                "ok": False,
                "error": "403 — workflows service grant missing; contact help@tacc.utexas.edu",
            }
            return result
        else:
            result["workflows_service"] = {"ok": False, "status": resp.status_code,
                                           "body": resp.text[:300]}
            return result
    except Exception as exc:  # noqa: BLE001
        result["workflows_service"] = {"ok": False, "error": str(exc)}
        return result

    # 4 — group exists / can be created
    try:
        resp = _api(client, "GET", f"/v3/workflows/groups/{gid}")
        if 200 <= resp.status_code < 300:
            result["group"] = {"ok": True, "group_id": gid, "action": "exists"}
        else:
            owner = getattr(client, "username", None) or "user"
            create = _api(client, "POST", "/v3/workflows/groups",
                          {"id": gid, "owner": owner})
            if 200 <= create.status_code < 300:
                result["group"] = {"ok": True, "group_id": gid, "action": "created"}
            else:
                result["group"] = {"ok": False, "group_id": gid,
                                   "status": create.status_code, "body": create.text[:300]}
    except Exception as exc:  # noqa: BLE001
        result["group"] = {"ok": False, "error": str(exc)}

    # 5 — dry pipeline registration (create a minimal pipeline then immediately delete it)
    probe_id = f"svo-adapter-probe-{gid}"
    probe = {
        "id": probe_id,
        "type": "workflow",
        "description": "svo-adapter connectivity probe — safe to delete",
        "owner": result.get("auth", {}).get("username") or "user",
        "group_id": gid,
        "params": {"probe": {"type": "string", "default": "ok"}},
        "tasks": [{
            "id": "probe-task",
            "type": "function",
            "runtime": "python:3.11",
            "installer": "pip",
            "code": base64.b64encode(b'print("probe ok")').decode(),
        }],
    }
    base = f"/v3/workflows/groups/{gid}/pipelines"
    try:
        reg = _api(client, "POST", base, probe)
        if 200 <= reg.status_code < 300:
            _api(client, "DELETE", f"{base}/{probe_id}")
            result["pipeline_registration"] = {"ok": True, "probe_id": probe_id}
        else:
            result["pipeline_registration"] = {
                "ok": False, "status": reg.status_code, "body": reg.text[:300],
            }
    except Exception as exc:  # noqa: BLE001
        result["pipeline_registration"] = {"ok": False, "error": str(exc)}

    return result


def get_output_uri(
    pipeline_id: str,
    run_uuid: str,
    *,
    token: str | None = None,
    group_id: str | None = None,
) -> str | None:
    """Best-effort: find the primary output URI from a completed pipeline run.

    Tries (in order):
    1. Parse the last https:// or tapis:// URI from any task stdout / last_message
       (publish/stac-publish tasks typically print the output URL).
    2. Tapis Jobs API archive path for tapis_job task executions when a job_uuid
       is present on the task execution object.

    Returns None when no URI can be determined — the caller should fall back to
    requiring a manual /register-output call.
    """
    import json
    import re

    URI_RE = re.compile(r'(?:https?|tapis)://[^\s"\'<>\]]+')
    client = _make_client(token)
    gid = group_id or settings.tapis_workflow_group

    try:
        execs = client.workflows.listTaskExecutions(
            group_id=gid, pipeline_id=pipeline_id, pipeline_run_uuid=run_uuid,
        ) or []
    except Exception:  # noqa: BLE001
        return None

    def field(execution: Any, *names: str) -> Any:
        if isinstance(execution, dict):
            for name in names:
                if execution.get(name) is not None:
                    return execution[name]
            return None
        for name in names:
            value = getattr(execution, name, None)
            if value is not None:
                return value
        return None

    from urllib.parse import quote

    def archived_stdout_uri(execution: Any) -> str | None:
        task_id = field(execution, "task_id", "taskId", "task_name", "taskName")
        if not task_id:
            return None
        data = field(execution, "data") or {}
        if isinstance(data, str):
            try:
                data = json.loads(data)
            except (TypeError, ValueError):
                data = {}
        archive_system = (
            field(execution, "archive_system_id", "archiveSystemId", "exec_system_id", "execSystemId")
            or (data.get("archive_system_id") if isinstance(data, dict) else None)
            or (data.get("archiveSystemId") if isinstance(data, dict) else None)
            or settings.tapis_exec_system
        )
        if not archive_system:
            return None
        return (
            f"tapis://{quote(str(archive_system), safe='')}"
            f"/workflows/archive/{quote(str(run_uuid), safe='')}"
            f"/{quote(str(task_id), safe='')}/output/.stdout"
        )

    # A scalar result is the durable output of a hosted transform. Prefer its
    # archived stdout over a URI in an earlier model-output handoff, because
    # that handoff URI identifies the input artifact rather than the result.
    scalar_keys = (
        "value", "spring_flow", "stream_flow", "baseflow", "flow",
        "total_flow", "mean", "average", "average_value", "modeled_value",
    )
    for execution in reversed(execs):
        text_value = field(execution, "stdout")
        if not text_value:
            continue
        try:
            payload = json.loads(str(text_value))
        except (TypeError, ValueError):
            continue
        node = payload.get("result", payload) if isinstance(payload, dict) else None
        if not isinstance(node, dict):
            continue
        if any(isinstance(node.get(key), (int, float)) and not isinstance(node.get(key), bool) for key in scalar_keys):
            result_uri = archived_stdout_uri(execution)
            if result_uri:
                return result_uri

    # Pass 1: any URI in stdout / last_message. The last URI in the last task's
    # output is typically the result (publish/stac-publish prints the CKAN/STAC URL).
    found: list[str] = []
    for e in execs:
        for text in (getattr(e, "stdout", None), getattr(e, "last_message", None)):
            if not text:
                continue
            text_value = str(text)
            # Hosted function tasks commonly print a JSON result whose URI
            # contains spaces (for example, a model output label). Parse that
            # structured value before falling back to the whitespace-delimited
            # URI scan, which would otherwise truncate the path.
            try:
                payload = json.loads(text_value)
            except (TypeError, ValueError):
                payload = None
            if isinstance(payload, dict):
                for key in ("output_uri", "resource_uri", "url"):
                    value = payload.get(key)
                    if isinstance(value, str) and value:
                        found.append(value.rstrip(".,;"))
                        break
                continue
            found.extend(URI_RE.findall(text_value))
    if found:
        return found[-1]

    # Pass 2: Tapis Jobs API archive path. tapipy may expose job_uuid on the
    # task execution object under different attribute names across versions.
    for e in execs:
        data = getattr(e, "data", None) or {}
        if isinstance(data, str):
            try:
                data = json.loads(data)
            except Exception:  # noqa: BLE001
                data = {}
        job_uuid = (
            data.get("job_uuid") or data.get("jobUuid")
            or getattr(e, "job_uuid", None) or getattr(e, "jobUuid", None)
        )
        if not job_uuid:
            continue
        try:
            job = client.jobs.getJob(jobUuid=str(job_uuid))
            sys_id = getattr(job, "archiveSystemId", None)
            sys_dir = getattr(job, "archiveSystemDir", None)
            if sys_id and sys_dir:
                return f"tapis://{sys_id}/{sys_dir.strip('/')}"
        except Exception:  # noqa: BLE001
            continue

    # Pass 3: hosted OWE function tasks do not have a Jobs API UUID, but their
    # stdout is archived by Tapis Workflows.  DFC transforms commonly return a
    # scalar JSON result rather than a URL, so the archived stdout is the
    # discoverable artifact that should be registered for the downstream model
    # output handoff.
    for execution in reversed(execs):
        result_uri = archived_stdout_uri(execution)
        if result_uri:
            return result_uri

    return None


def submit_tapis_workflow(
    pipeline: dict[str, Any],
    args: dict[str, dict[str, Any]],
    *,
    client=None,
    token: str | None = None,
    run_name: str | None = None,
    recreate: bool = False,
) -> dict[str, Any]:
    """Register the generated pipeline into its Workflows group and run it.

    `client` is injectable for tests; otherwise one is built from settings/token.
    Returns a descriptor mirroring SUBSIDE's submit_run result.
    """
    client = client or _make_client(token)
    group_id = pipeline.get("group_id") or settings.tapis_workflow_group
    pipeline_id = pipeline["id"]
    run_name = run_name or f"adapter-{pipeline_id}"

    _ensure_group(client, group_id)
    register_pipeline(client, pipeline, group_id, recreate=recreate)
    run_uuid = run_pipeline(client, group_id, pipeline_id, run_name, args)
    return {
        "uuid": run_uuid,
        "name": run_name,
        "pipelineId": pipeline_id,
        "groupId": group_id,
        "tapisStatus": "submitted",
    }
