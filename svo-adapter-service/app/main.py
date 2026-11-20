"""SVO-to-SVO Semantic Adapter Service (FastAPI sidecar).

Responsibilities: planning + execution orchestration + provenance. Basic CRUD on
metadata is delegated to Hasura GraphQL; this service does not reimplement it.

Endpoints:
  GET  /transform-specs           list the transform registry (pieces + contracts)
  POST /transform-specs           register one ETL piece (transform_spec + contracts)
  POST /admin/seed-subside-werc   one-click demo seed of the SUBSIDE WERC pieces
  POST /data-objects              register a data object + its variable contract(s)
  POST /readiness/check           assess a data object vs a model-input requirement
  POST /plans                     generate (and persist) an ETL plan to close gaps
  POST /plans/model-inputs        preview the input-side ETL steps of a model's bound inputs
  GET  /plans/{id}                fetch a stored plan
  POST /workflows/generate        emit a Tapis Workflows pipeline for a plan
  POST /workflows/submit          register + run the pipeline (emulates SUBSIDE)
  GET  /runs/{id}                 fetch execution state of a run (with its publication)
  GET  /publishers                catalog_register pieces a model configuration's output can use
  POST /runs/{id}/register-output register a transformed output as a new data object

The DYNAMO web app drives this flow; GET / returns a small JSON pointer to /docs.
Demo mode (SVO_ADAPTER_DEMO_MODE=1) backs it with an in-memory store (see store.py).
"""
from __future__ import annotations

import asyncio
import hmac
import hashlib
import time
import json
import logging
import re
import urllib.parse
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict, StrictStr
from starlette.concurrency import run_in_threadpool

from pathlib import Path

from fastapi.responses import JSONResponse

# uvicorn configures only its own loggers, so without this the service's INFO
# messages (sync counts, edge recomputes) are dropped and only warnings show.
# HTTP client request lines are kept out: they add a line per outbound call.
if not logging.getLogger().handlers:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s:     %(name)s: %(message)s")
    for noisy in ("httpx", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

log = logging.getLogger(__name__)

from . import flow_graph, flow_propose, flow_run, flow_segments, flow_settings, gather_fetch, input_plan, ntgam, piece_authoring, publication, qaqc, run_state, run_tokens, stac, step_secrets, stored_source, tapis
from . import secrets as secrets_store
from .config import settings
from .hasura import (
    APPROVAL_EVENTS_QUERY,
    CATALOG_ADMIN_QUERY,
    COUNT_OWN_PIECES_QUERY,
    CREATE_ETL_PROCESS_MUTATION,
    DATA_OBJECT_CONTRACT_QUERY,
    GET_APPROVAL_SPEC_QUERY,
    GET_ETL_PROCESS_QUERY,
    GET_FLOW,
    GET_FLOW_PIECES,
    GET_VISIBLE_PIECES,
    HasuraClient,
    HasuraError,
    STANDARD_VARIABLES_QUERY,
    LIST_DATA_OBJECTS_QUERY,
    LIST_OWN_DATA_OBJECTS_QUERY,
    MODEL_INPUT_REQUIREMENT_QUERY,
    TRANSFORM_REGISTRY_QUERY,
    get_client,
)
from .models import (
    BindDeferredPlanIn,
    DataObjectContract,
    DataObjectIn,
    DeferredPlanIn,
    FlowCheckIn,
    FlowProposeIn,
    FlowPlanIn,
    GenerateWorkflowIn,
    ModelRunIn,
    PieceApprovalIn,
    PieceFromRepositoryIn,
    PlanIn,
    PlanModelInputsIn,
    ReadinessCheckIn,
    ReadinessResult,
    ReadinessStatus,
    RegisterOutputIn,
    ResumeRunIn,
    SpecApprovalIn,
    SubmitWorkflowIn,
    TransformSpecIn,
)
from .planner import (
    MANAGED_PARAMS,
    build_model_run_plan_json,
    build_plan_json,
    compatibility,
    _catalogs,
    _contract_from_registry,
    find_path,
    first_misfit,
    parameter_definitions,
    plan_model_run,
    reachable_variables,
)
from .etl_contract import (
    accepted_aliases,
    canonical_key,
    normalize_args,
    normalize_env_from_args,
    public_definitions,
)
from .error_handling import safe_error_message
from .poller import _terminal_update_set
from .result_contract import task_result


def _plan_with_parameters(plan_json: dict[str, Any]) -> dict[str, Any]:
    """Attach the public, plan-scoped parameter contract to a generated DAG."""
    steps = plan_json.get("steps") or []
    standard = tapis.STANDARD_PARAMS
    if tapis.plan_publishes(steps):
        standard = {**standard, **tapis.publish_params()}
    plan_json["parameters"] = parameter_definitions(steps, standard, tapis.FRAMING_PARAMS)
    # Use the backend-owned catalog as the final geometry default. Explicit
    # caller values and workflow-specific recommendations still take priority.
    transform_names = " ".join(
        str(step.get("name") or step.get("transform_type") or "").lower()
        for step in plan_json.get("steps") or []
    )
    if not any(
        parameter.get("default")
        for parameter in plan_json["parameters"]
        if parameter.get("name") == "geometry_source_uri"
    ):
        default_uri = settings.gma_boundary_layer_uri
        if "county" in transform_names:
            default_uri = settings.county_boundary_layer_uri
        elif "gcd" in transform_names or "district" in transform_names:
            default_uri = settings.gcd_boundary_layer_uri
        for parameter in plan_json["parameters"]:
            if parameter.get("name") == "geometry_source_uri":
                parameter["default"] = default_uri
    return plan_json

class TestTransformIn(BaseModel):
    args: dict[str, Any] = {}
    dry_run: bool = True
    run_name: str | None = None
    # Run a shared or public piece whose stored code has not been approved.
    allow_unapproved: bool = False

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start the background poller loop on startup; cancel it on shutdown.

    The loop runs when demo_mode is off and poll_interval_seconds > 0. Inside
    it, Tapis status polling needs tapis_token and the staleness sweep needs
    run signals configured (see poller.run_poller); either may be absent.
    """
    # Fail closed: a keeper that is switched on but cannot encrypt or
    # authenticate must stop the service, not silently store nothing.
    run_tokens.validate_keeper_config()
    secrets_store.install_log_scrubber()
    if settings.step_secret_key and not step_secrets.key_long_enough(settings.step_secret_key):
        log.error("SVO_ADAPTER_STEP_SECRET_KEY is shorter than %d bytes: steps cannot be given "
                  "secrets until it is longer", step_secrets.MIN_KEY_BYTES)
    task: asyncio.Task | None = None
    if not settings.demo_mode and settings.poll_interval_seconds > 0:
        from . import poller
        task = asyncio.create_task(poller.run_poller(), name="svo-adapter-poller")
    else:
        log.info(
            "poller disabled (demo_mode=%s, interval=%d)",
            settings.demo_mode,
            settings.poll_interval_seconds,
        )

    if not settings.demo_mode and settings.hasura_admin_secret:
        async def _reload_hasura_schema() -> None:
            """Force Hasura to re-introspect Postgres so newly migrated columns
            (e.g. tapis_app_id on modelcatalog_configuration) are visible in the
            GraphQL schema. Hasura's cached introspection survives restarts from
            its metadata DB but does not auto-pick up ALTER TABLE ADD COLUMN."""
            import httpx
            try:
                async with httpx.AsyncClient(timeout=10) as client:
                    base = settings.hasura_graphql_url.removesuffix("/v1/graphql")
                    r = await client.post(
                        f"{base}/v1/metadata",
                        headers={
                            "x-hasura-admin-secret": settings.hasura_admin_secret,
                            "Content-Type": "application/json",
                        },
                        json={"type": "reload_metadata",
                              "args": {"reload_remote_schemas": True, "reload_sources": True}},
                    )
                    log.info("hasura schema reload: %s", r.json().get("message", r.status_code))
            except Exception:
                log.warning("hasura schema reload failed (non-fatal)", exc_info=True)
        await _reload_hasura_schema()

    if settings.mint_sync_on_startup and not settings.demo_mode:
        async def _startup_sync() -> None:
            try:
                from .mint_sync import MintCatalogClient, sync_mint_to_adapter
                from .hasura import get_client as _get_client
                _h = _get_client()
                result = await sync_mint_to_adapter(
                    _h, MintCatalogClient(_h)
                )
                log.info(
                    "startup mint sync: created=%d updated=%d deleted=%d "
                    "skipped=%d warnings=%d",
                    result.created, result.updated, result.deleted,
                    result.skipped, len(result.warnings),
                )
                for w in result.warnings:
                    log.warning("mint_sync: %s", w)
            except Exception:
                log.exception("startup mint sync failed (non-fatal)")
        asyncio.create_task(_startup_sync(), name="svo-adapter-mint-sync")

    if settings.ckan_sync_on_startup and not settings.demo_mode:
        async def _startup_ckan_sync() -> None:
            try:
                from .ckan_sync import sync_ckan_to_adapter
                from .hasura import get_client as _get_client
                result = await sync_ckan_to_adapter(
                    _get_client(),
                    org=settings.ckan_sync_org or None,
                )
                log.info(
                    "startup ckan sync: upserted=%d deleted=%d skipped=%d warnings=%d",
                    result.upserted, result.deleted, result.skipped, len(result.warnings),
                )
            except Exception:
                log.exception("startup ckan sync failed (non-fatal)")
        asyncio.create_task(_startup_ckan_sync(), name="svo-adapter-ckan-sync")

    yield
    if task:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


OPENAPI_TAGS = [
    {
        "name": "Core: Registry",
        "description": "Reusable data-object, transform-spec, and standard-variable registry operations.",
    },
    {
        "name": "Core: Planning",
        "description": "Reusable compatibility, readiness, reachability, and ETL-plan operations.",
    },
    {
        "name": "Core: Workflows",
        "description": "Reusable generation and submission of Tapis Workflows from saved plans.",
    },
    {
        "name": "Core: Runs",
        "description": "Reusable workflow-run status, polling, output registration, and provenance operations.",
    },
    {
        "name": "Core: Catalog/objectives",
        "description": "Reusable objective, runtime-default, and catalog dataset helper operations.",
    },
    {
        "name": "Integrations",
        "description": "Optional MINT, CKAN, Hasura edge-cache, and Tapis operational integration.",
    },
    {
        "name": "DFC/GAM",
        "description": "Texas GMA/GAM DFC target planning and MODFLOW 6 QA/QC use case.",
    },
    {
        "name": "NTGAM forecast",
        "description": "NTGAM location, scenario, and subsidence forecast use case.",
    },
]

app = FastAPI(
    title="SVO Adapter Service",
    version="0.1.0",
    description=(
        "Plans and executes SVO-to-SVO data transformations. "
        "Core groups are reusable across deployments; DFC/GAM and NTGAM forecast "
        "groups identify bespoke application profiles."
    ),
    openapi_tags=OPENAPI_TAGS,
    lifespan=lifespan,
)


def _is_operator_route(method: str, path: str) -> bool:
    """Routes that act on the shared registry for every user: all of /admin/*
    and registry writes. /admin/secrets keeps its own dedicated credential."""
    path = path.rstrip("/")
    if path == "/admin/secrets":
        return False
    if path == "/admin" or path.startswith("/admin/"):
        return True
    return method == "POST" and path == "/transform-specs"


# Registered before CORS so CORS stays outermost and a refusal still carries
# CORS headers. Demo mode has no shared state to protect (in-memory store).
@app.middleware("http")
async def _operator_route_guard(request: Request, call_next):
    if (
        request.method != "OPTIONS"
        and not settings.demo_mode
        and _is_operator_route(request.method, request.url.path)
    ):
        expected = settings.admin_route_secret
        if not expected:
            return JSONResponse(
                {"detail": {"code": "ADMIN_ROUTES_NOT_CONFIGURED",
                            "message": "no admin route secret is configured"}},
                status_code=503,
            )
        supplied = request.headers.get("X-Admin-Secret")
        if not (supplied and hmac.compare_digest(supplied.encode(), expected.encode())):
            return JSONResponse({"detail": {"code": "ADMIN_AUTH_REQUIRED"}}, status_code=403)
    return await call_next(request)


# Routes a call needs no front door for, when SVO_ADAPTER_REQUIRE_FRONT_DOOR is on:
# the four Tapis-task callbacks (their own per-run HMAC), the operator routes (their
# own operator secrets), the public reference reads, and the adapter console's files.
# Everything else is a user route or a service-only route, and needs the shared secret.
_FRONT_DOOR_OPEN: tuple[tuple[str, str], ...] = (
    ("POST", r"/runs/[^/]+/signal"),
    ("GET", r"/runs/[^/]+/credentials"),
    ("POST", r"/runs/[^/]+/token"),
    # The running task fetches its one-time step secrets: no service secret, but the
    # route is gated by the runner's own Tapis token (it must be the run's submitter)
    # and the step's single-use HMAC credential (X-Step-Secret-Token).
    ("GET", r"/runs/[^/]+/steps/\d+/secrets"),
    ("GET", r"/"),
    ("GET", r"/health"),
    ("GET", r"/objectives"),
    ("GET", r"/objectives/[^/]+"),
    ("GET", r"/runtime-defaults"),
    ("GET", r"/spatial/layers"),
    ("GET", r"/etl/common-variables"),
    ("GET", r"/dfc-targets"),
    ("GET", r"/forecast/ntgam/options"),
    ("GET", r"/docs"),
    ("GET", r"/openapi\.json"),
)
_FRONT_DOOR_OPEN_RE = tuple((m, re.compile(p)) for m, p in _FRONT_DOOR_OPEN)


def _front_door_open(method: str, path: str) -> bool:
    path = path.rstrip("/") or "/"
    if path == "/admin" or path.startswith("/admin/"):
        return True  # operator routes, each with its own secret
    if method == "POST" and path == "/transform-specs":
        return True
    return any(m == method and rx.fullmatch(path) for m, rx in _FRONT_DOOR_OPEN_RE)


@app.middleware("http")
async def _front_door_guard(request: Request, call_next):
    """With the front door on, a user route is served only to a call that carries the
    Ensemble Manager / catalog shared secret and comes from no browser origin. The
    caller's own token is still checked by the route: the secret only proves the
    call came through the front door, never who the user is."""
    if (
        settings.require_front_door
        and request.method != "OPTIONS"
        and not settings.demo_mode
        and not _front_door_open(request.method, request.url.path)
    ):
        if not settings.internal_service_secret:
            return JSONResponse({"detail": {
                "code": "INTERNAL_SERVICE_NOT_CONFIGURED",
                "message": "the front door is on but no internal service secret is configured",
            }}, status_code=503)
        # The Ensemble Manager's own calls carry the secret as X-Ensemble-Manager-Secret,
        # which also grants powers (reading every run, owned model outputs, bound
        # plans). A user's call forwarded by the Ensemble Manager carries it as
        # X-Front-Door-Secret, which only opens the door: those routes check the
        # user's own token and never see the other header.
        if request.headers.get("Origin") or not (
            _internal_service_authorized(request.headers.get("X-Ensemble-Manager-Secret"))
            or _internal_service_authorized(request.headers.get("X-Front-Door-Secret"))
        ):
            return JSONResponse({"detail": {
                "code": "FRONT_DOOR_REQUIRED",
                "message": "call this route through the Ensemble Manager or the catalog API",
            }}, status_code=403)
    return await call_next(request)


def _cors_origins() -> list[str]:
    """The configured CORS origins. A literal ``*`` is refused while the front door is
    on: it would let any web page read the adapter's refusals and public routes."""
    origins = settings.cors_origin_list
    if "*" in origins and settings.require_front_door:
        log.error("SVO_ADAPTER_CORS_ORIGINS contains '*' while SVO_ADAPTER_REQUIRE_FRONT_DOOR is on; "
                  "ignoring it and allowing no browser origin")
        return []
    return origins


# Registered after the front-door guard so CORS stays outermost and a refusal still
# carries CORS headers for an allowed origin. No origins are allowed unless
# SVO_ADAPTER_CORS_ORIGINS lists them.
from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_methods=["*"],
    allow_headers=["*"],
)


def _bearer(authorization: str | None) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:]
    return None


async def _require_caller(token: str | None) -> str:
    """Username for the bearer token as verified by Tapis, or 401."""
    username = await run_in_threadpool(tapis.userinfo_username, token) if token else None
    if not username:
        raise HTTPException(401, detail={
            "code": "TAPIS_AUTH_REQUIRED",
            "message": "a valid Tapis bearer token is required",
        })
    return username


_CALLER_CACHE: dict[str, tuple[float, str | None]] = {}
_CALLER_CACHE_SECONDS = 60.0


async def _caller_or_none(token: str | None) -> str | None:
    """Tapis-verified username for the token, or None. Cached briefly by token
    hash so planning does not call Tapis on every request."""
    if not token:
        return None
    key = hashlib.sha256(token.encode()).hexdigest()
    now = time.monotonic()
    cached = _CALLER_CACHE.get(key)
    if cached and now - cached[0] < _CALLER_CACHE_SECONDS:
        return cached[1]
    username = await run_in_threadpool(tapis.userinfo_username, token)
    if len(_CALLER_CACHE) > 1024:
        _CALLER_CACHE.clear()
    _CALLER_CACHE[key] = (now, username)
    return username


def _internal_service_authorized(secret: str | None) -> bool:
    """True for the Ensemble Manager / catalog shared secret. It is a credential of
    its own: the Hasura admin secret is never accepted in its place."""
    expected = settings.internal_service_secret
    return bool(expected and secret and hmac.compare_digest(secret, expected))


def _require_internal_service(secret: str | None, message: str) -> None:
    """Refuse a call without the shared secret. An adapter with no secret set
    answers 503, so a missing setting is never an open door or a quiet 403."""
    if not settings.internal_service_secret:
        raise HTTPException(503, detail={
            "code": "INTERNAL_SERVICE_NOT_CONFIGURED",
            "message": "no internal service secret is configured on this adapter",
        })
    if not _internal_service_authorized(secret):
        raise HTTPException(403, detail={
            "code": "INTERNAL_SERVICE_AUTH_REQUIRED", "message": message})


async def _caller_or_demo(token: str | None) -> str | None:
    """Tapis username for a route that needs a signed-in user, or 401. The local
    demo has no accounts, so it answers None (an open caller) when no token is sent."""
    username = await _caller_or_none(token)
    if username:
        return username
    if settings.demo_mode and not token:
        return None
    raise HTTPException(401, detail={
        "code": "TAPIS_AUTH_REQUIRED",
        "message": "a valid Tapis bearer token is required",
    })


# Marks a reader that may see every run: the Ensemble Manager, or an admin.
_ANY_RUN = "*"


async def _run_reader(authorization: str | None, internal_secret: str | None) -> str:
    """Who is reading runs: a Tapis username, or ``_ANY_RUN``.

    A run belongs to the user who submitted it. Its record and provenance name
    their data, storage paths and outputs, so another user must not read them.
    The Ensemble Manager reads on a user's behalf with its service secret. The
    local demo has no accounts and is left open when no token is sent.
    """
    if _internal_service_authorized(internal_secret):
        return _ANY_RUN
    token = _bearer(authorization)
    if settings.demo_mode and not token:
        return _ANY_RUN
    username = await _caller_or_none(token)
    if not username:
        raise HTTPException(401, detail={
            "code": "TAPIS_AUTH_REQUIRED",
            "message": "a valid Tapis bearer token is required to read runs",
        })
    return _ANY_RUN if username in settings.cancel_admin_list else username


def _require_run_reader(run: dict[str, Any] | None, reader: str) -> dict[str, Any]:
    """The run, or 404. Another user's run is reported as missing, not forbidden,
    so that a run id tells a stranger nothing."""
    if not run or (reader != _ANY_RUN and run.get("submitted_by") != reader):
        raise HTTPException(404, "run not found")
    return run


# --- who may use a data object -------------------------------------------------
# A user may use a data object that is shared (catalog rows the CKAN sync registered
# from public datasets) or that they own. A row the Ensemble Manager registered for a
# model output carries its user's name when the EM forwarded their token;
# owner_execution_id alone grants a user nothing, because the adapter cannot tell who
# may read that execution. An unshared row with no owner (made before owners were
# recorded) is usable by no user, except in the local demo, which has no accounts.
# Only a call that already proved the shared secret (the deferred-plan bind) may use
# any row.

def _data_object_usable(row: dict[str, Any] | None, caller: str | None, *, service: bool = False) -> bool:
    if not row:
        return False
    if service or row.get("shared"):
        return True
    if settings.demo_mode and not row.get("owner_username"):
        return True  # the local demo has no accounts: its seeded and token-less rows are shared
    if caller is None:
        return False
    return row.get("owner_username") == caller


async def _data_object_caller(h: Any) -> str | None:
    """The signed-in caller, or 401. The local demo has no accounts, so there an
    unverifiable token is no caller rather than a refusal."""
    token = getattr(h, "_bearer", None)
    if settings.demo_mode:
        return await _caller_or_none(token)
    return await _caller_or_demo(token)


async def _contract_rows(h: Any, object_id: str, *, service: bool = False) -> list[dict[str, Any]]:
    """The contract rows for a data object the caller may use; none when it does not
    exist or is another user's, which are indistinguishable to the caller."""
    caller = None if service else await _data_object_caller(h)
    rows = (await h.execute(DATA_OBJECT_CONTRACT_QUERY, {"id": object_id}))["adapter_data_object"]
    return [row for row in rows if _data_object_usable(row, caller, service=service)]


async def _discoverable_objects(h: Any) -> list[dict[str, Any]]:
    """Data objects the planner may pick as sources for this caller: shared ones and
    their own. Never another user's."""
    caller = await _data_object_caller(h)
    rows = (await h.execute(LIST_DATA_OBJECTS_QUERY))["adapter_data_object"]
    return [row for row in rows if _data_object_usable(row, caller)]


def _refuse_data_object_clash(
    existing: dict[str, Any] | None, owner_username: str | None, owner_execution_id: str | None,
    *, user_write: bool = False,
) -> None:
    """Refuse a write that would replace a row someone else owns. The upsert would
    otherwise overwrite its label, location and owner columns. An execution may
    update its own row again; a user may update their own, and ``user_write`` (a plain
    user registration) also may not take a row that has no owner at all."""
    if not existing:
        return
    if existing.get("shared"):
        # A catalog row every user relies on: no user, and no output registration,
        # may replace it.
        raise HTTPException(403, detail={
            "code": "DATA_OBJECT_NOT_OWNED",
            "message": "this data object id belongs to the shared catalog",
        })
    existing_user = existing.get("owner_username")
    existing_execution = existing.get("owner_execution_id")
    if existing_execution is not None:
        clash = existing_execution != owner_execution_id or (
            existing_user is not None and owner_username is not None and existing_user != owner_username)
    else:
        clash = existing_user != owner_username if (existing_user is not None or (
            user_write and not settings.demo_mode)) else False
    if clash:
        raise HTTPException(403, detail={
            "code": "DATA_OBJECT_NOT_OWNED",
            "message": "this data object id belongs to another user or execution",
        })


def humanize_svo(uri: str | None) -> str:
    """SVO machine name -> readable label using the object__quantity grammar:
    'groundwater__hydraulic_head' -> 'Groundwater — hydraulic head'."""
    return flow_propose.humanize_variable(uri)


# --- mutations (kept here; reads live in hasura.py) ------------------------
INSERT_DATA_OBJECT = """
mutation InsertDataObject($obj: adapter_data_object_insert_input!) {
  insert_adapter_data_object_one(
    object: $obj
    on_conflict: {
      constraint: data_object_pkey
      update_columns: [label description resource_uri format extension mime_type source_catalog owner_execution_id owner_model_child_id owner_tenant]
    }
  ) { id label resource_uri }
}
"""

INSERT_TRANSFORM_SPEC = """
mutation InsertTransformSpec($obj: adapter_transform_spec_insert_input!) {
  insert_adapter_transform_spec_one(
    object: $obj
    on_conflict: {
      constraint: transform_spec_pkey
      update_columns: [
        name version description transform_type is_lossy method
        tapis_app_id app_version container_image parameters_schema_json
        stage env_from_args file_inputs
      ]
    }
  ) { id name }
}
"""

INSERT_READINESS = """
mutation InsertReadiness($obj: adapter_readiness_assessment_insert_input!) {
  insert_adapter_readiness_assessment_one(object: $obj) { id status }
}
"""

INSERT_PLAN = """
mutation InsertPlan($obj: adapter_workflow_plan_insert_input!) {
  insert_adapter_workflow_plan_one(object: $obj) { id status source_data_object_id plan_json }
}
"""

UPDATE_DEFERRED_PLAN_BINDING = """
mutation BindDeferredPlan($id: String!, $source_id: String!, $plan_json: jsonb!) {
  update_adapter_workflow_plan_by_pk(
    pk_columns: {id: $id}
    _set: {source_data_object_id: $source_id, plan_json: $plan_json, status: "ready"}
  ) { id status source_data_object_id plan_json }
}
"""

UPDATE_PLAN_WORKFLOW_DEF = """
mutation SetWorkflowDef($id: String!, $def: jsonb!) {
  update_adapter_workflow_plan_by_pk(
    pk_columns: {id: $id}, _set: {tapis_workflow_definition_json: $def, status: "ready"}
  ) { id }
}
"""

GET_PLAN = """
query GetPlan($id: String!) {
  adapter_workflow_plan_by_pk(id: $id) {
    id status source_data_object_id plan_json target_dataset_specification_id target_model_configuration_id
  }
}
"""

GET_RUN = """
query GetRun($id: String!) {
  adapter_workflow_run_by_pk(id: $id) {
    id status tapis_workflow_id tapis_run_id started_at completed_at
    output_data_object_id logs_uri error_message workflow_plan_id execution_id idempotency_key
    created_at dispatched_at signals_armed last_signal_at health
    model_job_uuid model_job_name model_job_verified submitted_by
    paused_after_step parent_run_id resumed_run_id
  }
}
"""

# A paused run's replayed arguments and an edit's record are read only here, and
# only for the run's own submitter.
GET_RUN_SEGMENT = """
query GetRunSegment($id: String!) {
  adapter_workflow_run_by_pk(id: $id) {
    id status tapis_workflow_id tapis_run_id completed_at error_message workflow_plan_id
    execution_id submitted_by paused_after_step parent_run_id resumed_run_id segment_json
  }
}
"""

# Compare-and-set: of two resumes of one paused run, one wins. A retry after a
# failed continuation names the child it replaces.
RESUME_RUN_IF = """
mutation ResumeRunIf($id: String!, $child: String!) {
  update_adapter_workflow_run(
    where: {id: {_eq: $id}, status: {_eq: "completed"}, resumed_run_id: {_is_null: true}}
    _set: {resumed_run_id: $child}
  ) { affected_rows }
}
"""

# Give a claim back (a resume that failed before its segment was submitted).
RESUME_ROLLBACK_IF = """
mutation ResumeRollbackIf($id: String!, $child: String!, $was: String) {
  update_adapter_workflow_run(
    where: {id: {_eq: $id}, resumed_run_id: {_eq: $child}}
    _set: {resumed_run_id: $was}
  ) { affected_rows }
}
"""

RESUME_RETRY_IF = """
mutation ResumeRetryIf($id: String!, $was: String!, $child: String!) {
  update_adapter_workflow_run(
    where: {id: {_eq: $id}, status: {_eq: "completed"}, resumed_run_id: {_eq: $was}}
    _set: {resumed_run_id: $child}
  ) { affected_rows }
}
"""

GET_RUN_BY_IDEMPOTENCY = """
query GetRunByIdempotency($key: String!) {
  adapter_workflow_run(where: {idempotency_key: {_eq: $key}}, limit: 1) {
    id status tapis_workflow_id tapis_run_id workflow_plan_id execution_id idempotency_key
  }
}
"""

GET_DATA_OBJECT = """
query GetDataObject($id: String!) {
  adapter_data_object_by_pk(id: $id) {
    id label resource_uri format extension mime_type source_catalog
    owner_execution_id owner_model_child_id owner_tenant owner_username shared
  }
}
"""

LIST_RUNS = """
query ListRuns($limit: Int!, $offset: Int!, $where: adapter_workflow_run_bool_exp!) {
  adapter_workflow_run(
    where: $where
    limit: $limit
    offset: $offset
    order_by: [{started_at: desc}, {created_at: desc}]
  ) {
    id status tapis_workflow_id tapis_run_id started_at completed_at
    output_data_object_id logs_uri error_message workflow_plan_id execution_id
    dispatched_at last_signal_at health model_job_uuid model_job_verified
  }
  adapter_workflow_run_aggregate(where: $where) { aggregate { count } }
}
"""

GET_PROVENANCE = """
query GetProvenance($run_id: String!, $limit: Int!) {
  adapter_provenance_event(
    where: {workflow_run_id: {_eq: $run_id}}
    limit: $limit
    order_by: {created_at: desc}
  ) {
    id workflow_run_id data_object_id event_type payload_json created_at
  }
}
"""

INSERT_RUN = """
mutation InsertRun($obj: adapter_workflow_run_insert_input!) {
  insert_adapter_workflow_run_one(
    object: $obj
    on_conflict: {constraint: workflow_run_idempotency_key_key, update_columns: []}
  ) {
    id status tapis_workflow_id tapis_run_id workflow_plan_id idempotency_key
  }
}
"""

UPDATE_RUN_IF = """
mutation UpdateRunIf($id: String!, $status: String!, $set: adapter_workflow_run_set_input!) {
  update_adapter_workflow_run(where: {id: {_eq: $id}, status: {_eq: $status}}, _set: $set) {
    affected_rows
  }
}
"""

GET_RUN_CREDENTIALS = """
query GetRunCredentials($id: String!) {
  adapter_workflow_run_by_pk(id: $id) {
    id status signals_armed bound_secrets credentials_issued
  }
}
"""

ISSUE_RUN_CREDENTIALS_IF = """
mutation IssueRunCredentialsIf($id: String!, $issued: Int!) {
  update_adapter_workflow_run(
    where: {id: {_eq: $id}, credentials_issued: {_eq: $issued}}
    _inc: {credentials_issued: 1}
  ) { affected_rows }
}
"""

# A flow step's fetch of its secrets (GET /runs/{id}/steps/{step}/secrets). The run's
# bound_secrets holds ids, versions, names and env maps per step; "issued" in a step's
# entry is the one-use flag, claimed by comparing the whole column with what was read.
GET_RUN_STEP_SECRETS = """
query GetRunStepSecrets($id: String!) {
  adapter_workflow_run_by_pk(id: $id) {
    id status submitted_by bound_secrets workflow_plan_id
  }
}
"""

# The user's runs that are still going, for the check that no run holding a runner's
# secret shares the user with a step that is not trusted with it.
USER_ACTIVE_RUNS = """
query UserActiveRuns($user: String!) {
  adapter_workflow_run(where: {submitted_by: {_eq: $user}, status: {_in: ["submitting", "running"]}}) {
    id workflow_plan_id bound_secrets tapis_workflow_id tapis_run_id
  }
}
"""

ISSUE_STEP_SECRETS_IF = """
mutation IssueStepSecretsIf($id: String!, $was: jsonb!, $now: jsonb!) {
  update_adapter_workflow_run(
    where: {id: {_eq: $id}, bound_secrets: {_eq: $was}}
    _set: {bound_secrets: $now}
  ) { affected_rows }
}
"""

UPDATE_RUN = """
mutation UpdateRun($id: String!, $set: adapter_workflow_run_set_input!) {
  update_adapter_workflow_run_by_pk(pk_columns: {id: $id}, _set: $set) {
    id status tapis_run_id
  }
}
"""

INSERT_PROVENANCE = """
mutation Provenance($obj: adapter_provenance_event_insert_input!) {
  insert_adapter_provenance_event_one(object: $obj) { id }
}
"""

# --- Ensemble Manager binding mutations (public schema, admin-secret only) ---
# Upsert a resource row so execution_data_binding can FK into it.
UPSERT_RESOURCE = """
mutation UpsertResource($obj: resource_insert_input!) {
  insert_resource_one(object: $obj, on_conflict: {
    constraint: resource_pkey, update_columns: [name, url]
  }) { id }
}
"""

# Bind a registered output to an EM execution input. On conflict (same binding
# already exists) do nothing — idempotent.
INSERT_EXECUTION_DATA_BINDING = """
mutation InsertExecutionDataBinding($obj: execution_data_binding_insert_input!) {
  insert_execution_data_binding_one(object: $obj, on_conflict: {
    constraint: execution_data_binding_pkey, update_columns: []
  }) { execution_id model_io_id resource_id }
}
"""


def _model_input_to_contract(rows: list[dict[str, Any]]) -> DataObjectContract:
    """Project a DatasetSpecification + presentation into the target contract."""
    if not rows:
        raise HTTPException(404, "dataset specification not found in model catalog")
    ds = rows[0]
    svo = unit = None
    pres = ds.get("presentations") or []
    if pres:
        vp = (pres[0] or {}).get("presentation") or {}
        # Prefer the standard-variable object's URI PK; fall back to the scalar column.
        svo = (vp.get("standard_variable") or {}).get("id") or vp.get("has_standard_variable")
        # Prefer the unit object's label; fall back to the scalar column.
        unit = (vp.get("unit") or {}).get("label") or vp.get("uses_unit")
    dim = ds.get("has_dimensionality")
    return DataObjectContract(
        standard_variable_uri=svo,
        unit=unit,
        format=ds.get("has_format"),
        dimensionality=str(dim) if dim is not None else None,  # has_dimensionality is Int
    )


def _data_object_to_contract(row: dict[str, Any]) -> DataObjectContract:
    var = (row.get("variables") or [{}])[0]
    return DataObjectContract(
        standard_variable_uri=var.get("standard_variable_uri"),
        local_name=var.get("local_name"),
        unit=var.get("unit"),
        format=row.get("format"),
        extension=row.get("extension"),
        mime_type=row.get("mime_type"),
        dimensionality=var.get("dimensionality"),
        spatial_type=var.get("spatial_type"),
        crs=var.get("crs"),
        grid_id=var.get("grid_id"),
        grid_description=var.get("grid_description"),
        temporal_resolution=var.get("temporal_resolution"),
        schema_json=var.get("schema_json"),
        resource_uri=row.get("resource_uri"),
    )


def _uri_scheme(uri: str | None) -> str:
    text = str(uri or "")
    return text.split(":", 1)[0].lower() if ":" in text else ""


def _source_uri_score(uri: str | None) -> int:
    """Rank candidate sources for an objective plan.

    Prefer live CKAN/HTTPS resources, then Tapis URIs, while keeping local and
    example fixture paths below remotely runnable sources.
    """
    text = str(uri or "")
    scheme = _uri_scheme(text)
    if text.startswith("https://ckan.tacc.utexas.edu/"):
        return 100
    if scheme in {"http", "https"} and "example.com" not in text:
        return 90
    if text.startswith("tapis://ls6/modflow/demo/"):
        return -10
    if scheme == "tapis":
        return 80
    if scheme in {"http", "https"}:
        return 30
    if scheme == "file":
        return 0
    return 10


async def _resolve_target(h, ds_id: str | None, inline: DataObjectContract | None) -> DataObjectContract:
    """The target requirement: supplied inline, else read from the model catalog."""
    if inline is not None:
        return inline
    if not ds_id:
        raise HTTPException(422, "provide either dataset_specification_id or target_contract")
    rows = (await h.execute(MODEL_INPUT_REQUIREMENT_QUERY, {"ds_id": ds_id}))[
        "modelcatalog_dataset_specification"
    ]
    return _model_input_to_contract(rows)


@app.get("/health", tags=["Core: Registry"])
async def health() -> dict[str, Any]:
    return {"status": "ok", "demo_mode": settings.demo_mode}


@app.post("/data-objects", tags=["Core: Registry"])
async def register_data_object(
    body: DataObjectIn,
    authorization: str | None = Header(None),
    internal_secret: str | None = Header(None, alias="X-Ensemble-Manager-Secret"),
):
    token = _bearer(authorization)
    h = get_client(token)
    owned = bool(body.owner_execution_id or body.owner_model_child_id or body.owner_tenant)
    if owned:
        # The server-owned model-output handoff: the Ensemble Manager's secret is the
        # credential. A token, when it forwards one, still names the owner.
        _require_internal_service(
            internal_secret, "owned model-output data objects require Ensemble Manager authentication")
        owner = await _caller_or_none(token)
    else:
        # Every other write is a user's, and is recorded against them. Without this
        # check the write ran on the adapter's admin Hasura credential for anyone.
        owner = await _caller_or_demo(token)
    if body.id:
        _refuse_data_object_clash(
            (await h.execute(GET_DATA_OBJECT, {"id": body.id}))["adapter_data_object_by_pk"],
            owner, body.owner_execution_id, user_write=not owned)
    obj = body.model_dump(exclude_none=True)
    if owner:
        obj["owner_username"] = owner
    variables = obj.pop("variables", [])
    if variables:
        obj["variables"] = {"data": variables}
    data = await h.execute(INSERT_DATA_OBJECT, {"obj": obj})
    created = data["insert_adapter_data_object_one"]
    await h.execute(INSERT_PROVENANCE, {"obj": {
        "data_object_id": created["id"], "event_type": "data_object_registered",
        "payload_json": {"label": created["label"]},
    }})
    return created


@app.get("/data-objects/{object_id}", tags=["Core: Registry"])
async def get_data_object(object_id: str, authorization: str | None = Header(None)):
    h = get_client(_bearer(authorization))
    caller = await _data_object_caller(h)
    obj = (await h.execute(GET_DATA_OBJECT, {"id": object_id}))["adapter_data_object_by_pk"]
    if not _data_object_usable(obj, caller):
        raise HTTPException(404, "data object not found")
    return obj


# Real adapter.transform_spec columns. Job-shaping hints with no column
# (app_version/stage/env_from_args/file_inputs) are packed into
# parameters_schema_json.tapis and read back by planner.build_plan_json.
_SPEC_COLUMNS = frozenset({
    "id", "name", "version", "description", "transform_type", "is_lossy",
    "method", "tapis_app_id", "container_image", "source_code_url",
    "parameters_schema_json",
})
_SPEC_TAPIS_HINTS = (
    "app_version", "tapis_app_version", "tapis_function_id", "stage",
    "env_from_args", "file_inputs", "secrets", "sends_data_to",
)

def _default_spatial_layers() -> list[dict[str, Any]]:
    return [
        {
            "id": "twdb_gma_boundaries",
            "label": "TWDB Statewide GMA Boundaries",
            "uri": settings.gma_boundary_layer_uri,
            "source_type": "feature-service",
            "geometry_type": "polygon",
            "default_filter_field": "GMAnum",
            "crs": "EPSG:4326",
            "format": "geojson",
            "tags": ["twdb", "gma", "boundary"],
            "registered_category_id": "hydrology",
        },
        {
            "id": "twdb_gcd_boundaries",
            "label": "TWDB Groundwater Conservation District Boundaries",
            "uri": settings.gcd_boundary_layer_uri,
            "source_type": "feature-service",
            "geometry_type": "polygon",
            "default_filter_field": "DistrictName",
            "crs": "EPSG:4326",
            "format": "geojson",
            "tags": ["twdb", "gcd", "boundary"],
            "registered_category_id": "hydrology",
        },
        {
            "id": "twdb_county_boundaries",
            "label": "TWDB Texas Counties FIPS Boundaries",
            "uri": settings.county_boundary_layer_uri,
            "source_type": "feature-service",
            "geometry_type": "polygon",
            "default_filter_field": "Name",
            "crs": "EPSG:4326",
            "format": "geojson",
            "tags": ["twdb", "county", "boundary"],
            "registered_category_id": "administrative",
        },
    ]


def _spec_insert_obj(spec: dict[str, Any]) -> dict[str, Any]:
    """Build a Hasura nested-insert object for a transform spec from registry-shaped
    input, packing the no-column job hints into parameters_schema_json.tapis."""
    spec = {k: v for k, v in spec.items() if not k.startswith("_")}
    contracts = spec.pop("contracts", []) or []
    hints = {k: spec.pop(k) for k in _SPEC_TAPIS_HINTS if spec.get(k) is not None}
    if "env_from_args" in hints:
        hints["env_from_args"] = normalize_env_from_args(hints.get("env_from_args"))
    if "tapis_app_version" in hints and "app_version" not in hints:
        hints["app_version"] = hints["tapis_app_version"]
    if hints:
        params = dict(spec.get("parameters_schema_json") or {})
        params["tapis"] = hints
        spec["parameters_schema_json"] = params
    metadata = spec.pop("metadata", None)
    if metadata:
        params = dict(spec.get("parameters_schema_json") or {})
        params["metadata"] = metadata
        spec["parameters_schema_json"] = params
    obj = {k: v for k, v in spec.items() if k in _SPEC_COLUMNS}
    if contracts:
        obj["contracts"] = {"data": [_contract_insert_obj(c) for c in contracts]}
    return obj


# Real adapter.transform_contract columns. `catalog` has no column, so it is
# packed into metadata_json (read back by planner._contract_from_registry).
_CONTRACT_COLUMNS = frozenset({
    "id", "role", "standard_variable_uri", "format", "unit", "dimensionality",
    "spatial_type", "crs_requirement", "temporal_resolution",
    "schema_requirement_json", "metadata_json",
})


def _normalize_svo_uri(value: str | None) -> str | None:
    if not value:
        return value
    value = str(value).strip()
    if "://" in value or "__" not in value:
        return value
    return f"https://w3id.org/okn/i/mint/{value}"


def _contract_insert_obj(c: dict[str, Any]) -> dict[str, Any]:
    c = {k: v for k, v in c.items() if not k.startswith("_")}
    meta = dict(c.get("metadata_json") or {})
    if c.get("standard_variable_uri"):
        c["standard_variable_uri"] = _normalize_svo_uri(c["standard_variable_uri"])
    for key in ("catalog", "data_type"):
        value = c.pop(key, None)
        if value is not None:
            meta[key] = value
    standard_variables = c.pop("standard_variables", None)
    if standard_variables:
        normalized = [
            _normalize_svo_uri(str(v).strip())
            for v in standard_variables
            if str(v).strip()
        ]
        if len(normalized) == 1 and not c.get("standard_variable_uri"):
            c["standard_variable_uri"] = normalized[0]
        meta["standard_variables"] = normalized
    if meta:
        c["metadata_json"] = meta
    return {k: v for k, v in c.items() if k in _CONTRACT_COLUMNS}


@app.get("/transform-specs", tags=["Core: Registry"])
async def list_transform_specs(authorization: str | None = Header(None)):
    """The transform registry (specs + their input/output contracts)."""
    token = _bearer(authorization)
    h = get_client(token)
    return _visible_pieces(await _registry(h, plannable=False), await _caller_or_none(token))


@app.post("/transform-specs", tags=["Core: Registry"])
async def register_transform_spec(body: TransformSpecIn, authorization: str | None = Header(None)):
    """Register one ETL piece (a transform_spec + its input/output contracts)."""
    h = get_client(_bearer(authorization))
    obj = _spec_insert_obj(body.model_dump(exclude_none=True))
    created = (await h.execute(INSERT_TRANSFORM_SPEC, {"obj": obj}))["insert_adapter_transform_spec_one"]
    await h.execute(INSERT_PROVENANCE, {"obj": {
        "event_type": "transform_spec_registered",
        "payload_json": {"transform_spec_id": created["id"], "name": created["name"]},
    }})
    # Recompute the edge cache in the background so the next /plans call gets
    # accelerated BFS without blocking this response.
    if not settings.demo_mode:
        asyncio.create_task(_recompute_edges_bg(), name="recompute-edges")
    return created


_EXAMPLES = Path(__file__).resolve().parents[1] / "examples"


def _clean(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if not k.startswith("_")}


DELETE_TRANSFORM_SPECS_BY_IDS = """
mutation DeleteTransformSpecsByIds($ids: [String!]!) {
  delete_adapter_transform_spec(where: { id: { _in: $ids } }) { affected_rows }
}
"""

DELETE_DATA_OBJECTS_BY_IDS = """
mutation DeleteDataObjectsByIds($ids: [String!]!) {
  delete_adapter_data_object(where: { id: { _in: $ids } }) { affected_rows }
}
"""


async def _seed(h, fixture: str) -> dict[str, Any]:
    """Register a pipeline fixture's transform pieces + its sample source data
    object; return the ids + targets. Delete-then-insert so re-seeding is safe."""
    data = json.loads((_EXAMPLES / fixture).read_text())
    # Skip comment-only objects (entries whose only keys start with "_")
    raw_specs = [s for s in data["transform_specs"] if any(not k.startswith("_") for k in s)]
    # Delete pre-existing rows so re-seeding doesn't hit duplicate key violations.
    spec_ids = [s["id"] for s in raw_specs if s.get("id")]
    if spec_ids and not settings.demo_mode:
        await h.execute(DELETE_TRANSFORM_SPECS_BY_IDS, {"ids": spec_ids})
    specs = []
    for s in raw_specs:
        obj = _spec_insert_obj(s)
        specs.append((await h.execute(INSERT_TRANSFORM_SPEC, {"obj": obj}))["insert_adapter_transform_spec_one"])
    async def _register_do(raw: dict[str, Any]) -> dict[str, Any]:
        do = _clean(raw)
        variables = do.pop("variables", [])
        if variables:
            do["variables"] = {"data": variables}
        return (await h.execute(INSERT_DATA_OBJECT, {"obj": do}))["insert_adapter_data_object_one"]

    created_do = await _register_do(data["source_data_object"])
    # Register all additional `sources` (e.g. the forecast's head/storativity/DEM),
    # so a multi-input model run can resolve every input. Skip any that duplicate
    # the primary source_data_object by resource_uri.
    primary_uri = data["source_data_object"].get("resource_uri")
    extra_sources = [await _register_do(s) for s in (data.get("sources") or [])
                     if s.get("resource_uri") != primary_uri]
    # All target_model_input[...] variants, keyed by suffix ("base", "cataloged", "netcdf", ...).
    targets = {
        (key[len("target_model_input"):].lstrip("_") or "base"): _clean(val)
        for key, val in data.items()
        if key.startswith("target_model_input") and isinstance(val, dict)
    }
    return {
        "transform_specs": specs,
        "data_object": created_do,
        "sources": [created_do, *extra_sources],
        "target_contract": targets.get("base"),
        # Cataloged variant: reaching it pulls the stac-publish backend piece into the plan.
        "target_contract_cataloged": targets.get("cataloged"),
        "targets": targets,
    }


@app.post("/admin/reset", tags=["Integrations"])
async def reset_demo():
    """Clear the in-memory demo registry (demo mode only). Lets the UI start clean
    without restarting the server."""
    if not settings.demo_mode:
        raise HTTPException(400, "reset is available only in demo mode")
    from .store import reset_store
    reset_store()
    return {"status": "reset"}

@app.post("/transform-specs/{spec_id}/test", tags=["Core: Workflows"])
async def test_transform_spec(spec_id: str, body: TestTransformIn, authorization: str | None = Header(None)):
    """Generate or submit a one-piece pipeline using the registered definition."""
    token = _bearer(authorization)
    if not settings.demo_mode:
        await _require_caller(token)
    h = get_client(token)
    specs = await _registry(h, plannable=False)
    spec = next((s for s in specs if s.get("id") == spec_id), None)
    if not spec:
        raise HTTPException(404, "transform spec not found")
    if stored_source.stored_source(spec):
        verdict = stored_source.decision(
            spec, await _caller_or_none(token), (spec_id,) if body.allow_unapproved else ())
        if verdict == "denied":
            raise HTTPException(403, detail={
                "code": "STORED_SOURCE_NOT_PERMITTED",
                "message": "this piece carries stored code you may not run",
            })
    step = build_plan_json([spec])["steps"][0]
    pipeline = tapis.generate_tapis_workflow({"id": f"test-{spec_id}", "plan_json": {"steps": [step]}})
    args = _wrap_args(body.args)
    if token and "tapis_token" in (pipeline.get("params") or {}) and not args.get("tapis_token", {}).get("value"):
        args["tapis_token"] = {"value": token}
    if body.dry_run:
        return {"status": "generated", "spec_id": spec_id, "tapis_workflow_definition": pipeline, "args": args}
    args = await _with_run_token(args, token)
    try:
        result = await run_in_threadpool(tapis.submit_tapis_workflow, pipeline, args, token=token, run_name=body.run_name, recreate=True)
    except Exception as exc:
        raise HTTPException(502, f"Tapis piece test failed: {exc}")
    return {"status": "submitted", "spec_id": spec_id, **result}


async def _registry(h: Any, *, plannable: bool = True,
                    opt_in: tuple[str, ...] = ()) -> list[dict[str, Any]]:
    """The transform registry as the caller may see it, and by default only the
    pieces the planner may choose for them (see stored_source.decision).
    ``plannable=False`` returns every visible piece, for listing.

    With ``registry_user_scoped`` on, the read goes to Hasura with the caller's
    own token (or none), so its select permissions return only public pieces,
    shared pieces and the caller's own. Otherwise every piece is returned.
    """
    client = h.as_user() if hasattr(h, "as_user") else h
    registry = (await client.execute(TRANSFORM_REGISTRY_QUERY))["adapter_transform_spec"]
    if not plannable or not any(stored_source.stored_source(s) for s in registry):
        return registry
    username = await _caller_or_none(getattr(h, "_bearer", None))
    return stored_source.plannable(registry, username, opt_in)


def _visible_pieces(registry: list[dict[str, Any]], username: str | None) -> list[dict[str, Any]]:
    """Pieces a caller may see: public ones, shared ones for a signed-in caller, and
    their own. The same rule as the Hasura select permissions on
    ``adapter.transform_spec``, applied here because the admin-secret read returns
    every row while ``registry_user_scoped`` is off. Applying it again to rows
    Hasura already filtered changes nothing."""
    def visible(spec: dict[str, Any]) -> bool:
        visibility = spec.get("visibility") or "public"
        if visibility == "public":
            return True
        if not username:
            return False
        return visibility == "shared" or spec.get("owner_username") == username
    return [spec for spec in registry if visible(spec)]


async def _load_edge_map(
    registry: list[dict[str, Any]],
) -> "dict[str, list[dict[str, Any]]] | None":
    """Fetch precomputed edges from Hasura and build the BFS index. Returns None
    in demo mode or when the edge table is empty (first run before recompute).

    Edges are read for every piece, but build_edge_map keeps only those leading
    into a piece in ``registry``, so a caller-scoped registry scopes the edges."""
    if settings.demo_mode:
        return None
    from . import edges as edges_mod
    edge_rows = (await get_client(None).execute(edges_mod.GET_EDGES))["adapter_transform_edge"]
    return edges_mod.build_edge_map(registry, edge_rows) if edge_rows else None


async def _recompute_edges_bg() -> None:
    """Recompute transform edges after a spec is registered (fire-and-forget)."""
    from . import edges as edges_mod
    try:
        result = await edges_mod.recompute(get_client(None))
        log.info("edges: recomputed %s", result)
    except Exception as exc:  # noqa: BLE001
        log.warning("edges: background recompute failed: %s", exc)


@app.post("/admin/validate-tapis", tags=["Integrations"])
async def validate_tapis(authorization: str | None = Header(None)):
    """Walk each Tapis layer (auth → Workflows service → group → pipeline registration)
    and report what works. Safe: the probe pipeline is created and immediately deleted.
    Use this to confirm the grant is active and the service is reachable before a real run."""
    token = _bearer(authorization) or settings.tapis_token
    if not token:
        raise HTTPException(401, "provide a Tapis bearer token or set SVO_ADAPTER_TAPIS_TOKEN")
    result = await run_in_threadpool(tapis.validate_tapis, token)
    all_ok = all(v.get("ok") for v in result.values())
    return {"all_ok": all_ok, "checks": result}


@app.post("/admin/recompute-edges", tags=["Integrations"])
async def trigger_recompute_edges(authorization: str | None = Header(None)):
    """Precompute all output→input transform compatibility edges into adapter.transform_edge.
    Fast O(n²) pass over the registry; call after bulk spec registration or schema changes."""
    if settings.demo_mode:
        raise HTTPException(400, "recompute-edges is not available in demo mode")
    from . import edges as edges_mod
    result = await edges_mod.recompute(get_client(None))
    return {"status": "ok", **result}


@app.post("/admin/poll", tags=["Integrations"])
async def trigger_poll(authorization: str | None = Header(None)):
    """Manually trigger one status-poll pass (useful for debugging without waiting
    for the next scheduled tick). Uses the caller's bearer token if provided,
    falling back to the service-level SVO_ADAPTER_TAPIS_TOKEN."""
    if settings.demo_mode:
        raise HTTPException(400, "poll is not available in demo mode")
    from . import poller
    token = _bearer(authorization) or settings.tapis_token
    if not token:
        raise HTTPException(401, "provide a Tapis bearer token or set SVO_ADAPTER_TAPIS_TOKEN")
    updates = await poller.poll_once(token)
    return {"polled": len(updates), "updates": updates}


@app.post("/admin/seed-subside-werc", tags=["Integrations"])
async def seed_subside_werc(authorization: str | None = Header(None)):
    """[DEPRECATED] Seed from fixture file. Use POST /admin/sync-from-mint instead
    once common transforms are registered in the MINT catalog."""
    return await _seed(get_client(_bearer(authorization)), "subside_werc_transforms.json")


@app.post("/admin/seed-subside-h2i", tags=["Integrations"])
async def seed_subside_h2i(authorization: str | None = Header(None)):
    """[DEPRECATED] Seed from fixture file. Use POST /admin/sync-from-mint instead."""
    return await _seed(get_client(_bearer(authorization)), "subside_h2i_transforms.json")


@app.post("/admin/seed-subside-forecast", tags=["Integrations"])
async def seed_subside_forecast(authorization: str | None = Header(None)):
    """[DEPRECATED] Seed from fixture file. Use POST /admin/sync-from-mint instead
    once the MINT catalog migration 1771300000004_svo_adapter_common_transforms has
    been applied and the BFS-relevant configs are registered in MINT."""
    return await _seed(get_client(_bearer(authorization)), "subside_forecast_transforms.json")


@app.post("/admin/seed-gma-dfc", tags=["DFC/GAM"])
async def seed_gma_dfc(authorization: str | None = Header(None)):
    """Seed GMA DFC ETL transforms: unit conversions for drawdown/saturated-thickness/
    spring-flow, HDS→GeoTIFF format convert, GMA spatial aggregation, budget extract
    specs for all MODFLOW versions, and the multi-input DFC compliance check.
    Also recomputes transform edges so /plans works immediately after seeding."""
    result = await _seed(get_client(_bearer(authorization)), "gma_dfc_transforms.json")
    # Await edge recompute synchronously so /plans works right after this endpoint returns.
    await _recompute_edges_bg()
    return result


@app.post("/admin/sync-from-mint", tags=["Integrations"])
async def sync_from_mint(
    dry_run: bool = Query(False),
    authorization: str | None = Header(None),
):
    """Pull all ModelConfigurations from the MINT catalog and reconcile
    adapter.transform_spec. MINT is the sole source of truth: rows for configs
    no longer in MINT are deleted; hand-created rows (null mint_model_config_id)
    are untouched.

    Pass dry_run=true to preview counts without writing to the database.
    """
    from .mint_sync import MintCatalogClient, sync_mint_to_adapter

    h = get_client(_bearer(authorization))
    mint = MintCatalogClient(h)
    result = await sync_mint_to_adapter(h, mint, dry_run=dry_run)

    edges_recomputed = False
    if not dry_run and (result.created or result.updated or result.deleted):
        asyncio.create_task(_recompute_edges_bg(), name="recompute-edges-post-sync")
        edges_recomputed = True

    return {
        "dry_run": dry_run,
        "created": result.created,
        "updated": result.updated,
        "deleted": result.deleted,
        "skipped": result.skipped,
        "unresolved_tapis_apps": result.unresolved_tapis_apps,
        "warnings": result.warnings,
        "edges_recomputed": edges_recomputed,
    }


@app.post("/admin/sync-from-ckan", tags=["Integrations"])
async def sync_from_ckan(
    dry_run: bool = Query(False),
    org: str | None = Query(None, description="Limit to a CKAN organization slug"),
    authorization: str | None = Header(None),
):
    """Pull CKAN resources and reconcile their resource-level SVO annotations
    as adapter data objects. Each usable resource becomes one data object whose
    SVO URI and format are resolved via the mapping tables in ckan_sync.py;
    removed annotations delete only the corresponding CKAN-owned object.

    Pass dry_run=true to preview counts without writing to the database.
    Pass org=<slug> to limit the sync to a single CKAN organization.
    """
    from .ckan_sync import sync_ckan_to_adapter

    h = get_client(_bearer(authorization))
    result = await sync_ckan_to_adapter(
        h,
        org=org or settings.ckan_sync_org or None,
        dry_run=dry_run,
    )

    if not dry_run and (result.upserted or result.deleted):
        asyncio.create_task(_recompute_edges_bg(), name="recompute-edges-post-ckan-sync")

    return {
        "dry_run": dry_run,
        "upserted": result.upserted,
        "deleted": result.deleted,
        "skipped": result.skipped,
        "warnings": result.warnings,
    }


@app.get("/admin/sync-status", tags=["Integrations"])
async def sync_status(authorization: str | None = Header(None)):
    """Return a summary of the current MINT sync state: total specs, how many
    were synced from MINT, how many have unresolved Tapis app IDs, and the
    timestamp of the last sync."""
    from .hasura import GET_SYNC_STATUS_QUERY

    if settings.demo_mode:
        return {"demo_mode": True, "spec_count": 0, "mint_synced_count": 0,
                "function_task_count": 0, "last_sync": None}
    h = get_client(_bearer(authorization))
    data = await h.execute(GET_SYNC_STATUS_QUERY)
    last_sync_rows = data.get("last_sync") or []
    return {
        "spec_count": data.get("all", {}).get("aggregate", {}).get("count", 0),
        "mint_synced_count": data.get("synced", {}).get("aggregate", {}).get("count", 0),
        "function_task_count": data.get("function_tasks", {}).get("aggregate", {}).get("count", 0),
        "last_sync": last_sync_rows[0]["mint_synced_at"] if last_sync_rows else None,
    }


@app.put("/admin/transform-spec-approval", tags=["Integrations"])
async def set_transform_spec_approval(body: SpecApprovalIn):
    """Approve, or withdraw approval of, the Python source stored with a piece.

    Approval records one hash over the source, the function called in it, the
    run arguments it is handed and the arguments it declares, so it lapses the
    moment any of them changes. Only pieces that carry stored source can be
    approved; built-in pieces run code reviewed in this repository.
    """
    from .hasura import GET_SPEC_FOR_APPROVAL_QUERY, SET_SPEC_APPROVAL_MUTATION
    from .stored_source import approval_sha256, stored_source

    h = get_client(None)
    spec = (await h.execute(GET_SPEC_FOR_APPROVAL_QUERY, {"id": body.spec_id}))[
        "adapter_transform_spec_by_pk"]
    if not spec:
        raise HTTPException(404, "transform spec not found")
    source = stored_source(spec)
    if body.approved and not source:
        raise HTTPException(400, detail={
            "code": "NO_STORED_SOURCE",
            "message": "this piece carries no stored source to approve",
        })
    sha = approval_sha256(spec) if body.approved else None
    await h.execute(SET_SPEC_APPROVAL_MUTATION, {"id": body.spec_id, "sha": sha})
    await h.execute(INSERT_PROVENANCE, {"obj": {
        "event_type": "transform_spec_approval_set",
        "payload_json": {
            "transform_spec_id": body.spec_id,
            "owner_username": spec.get("owner_username"),
            "approved_source_sha256": sha,
        },
    }})
    return {"spec_id": body.spec_id, "approved": body.approved, "approved_source_sha256": sha}


# ---------------------------------------------------------------------------
# Pieces from a repository commit, and approval from the web app
# (design 2026-11-20-flow-authoring-in-the-ui.md, parts D1 and D2)
# ---------------------------------------------------------------------------
def _caller_catalog(token: str | None) -> Any:
    """The catalog as the CALLER: their own token, never the admin secret, so the
    catalog's permissions decide what they may read and write."""
    return HasuraClient(token, user_scoped=True)


def _piece_error(error: "piece_authoring.PieceError") -> HTTPException:
    return HTTPException(error.status, detail=error.detail)


async def _is_catalog_admin(token: str | None, username: str, *, strict: bool) -> bool:
    """Whether the caller is a row of ``modelcatalog_admin``.

    Read from the catalog with the caller's own token, for the username Tapis
    verified for that token. A user can read only their own row of that table, so
    the answer cannot come from anything the client says. ``strict`` (approval
    itself) fails closed with a 503 when the catalog cannot be asked; a page that
    only decides whether to show the buttons treats that as "not an admin".
    """
    if not token:
        return False
    try:
        rows = (await _caller_catalog(token).execute(CATALOG_ADMIN_QUERY, {"username": username})
                ).get("modelcatalog_admin") or []
    except Exception as error:  # noqa: BLE001
        log.warning("catalog admin check failed: %s", safe_error_message(error, limit=200))
        if strict:
            raise HTTPException(503, detail={
                "code": "ADMIN_CHECK_UNAVAILABLE",
                "message": "could not check whether you are an administrator; nothing was changed"})
        return False
    return any(isinstance(row, dict) and row.get("username") == username for row in rows)


def _catalog_write_error(error: Exception) -> HTTPException:
    text = str(error).lower()
    if "uniqueness violation" in text or "duplicate key" in text:
        return HTTPException(409, detail={
            "code": "PIECE_EXISTS", "message": "a piece with this id already exists; nothing was changed"})
    if "not allowed" in text or "permission" in text or "access denied" in text or "jwt" in text:
        return HTTPException(403, detail={
            "code": "CATALOG_WRITE_REFUSED", "message": "the catalog did not allow you to register a piece"})
    return HTTPException(502, detail={
        "code": "CATALOG_WRITE_FAILED", "message": "the catalog could not be written; nothing was changed"})


@app.post("/pieces/from-repository", tags=["Core: Registry"])
async def register_piece_from_repository(
    body: PieceFromRepositoryIn, authorization: str | None = Header(None),
):
    """Register a piece whose code is one file of a public GitHub repository at a
    pinned commit.

    The adapter, not the browser, fetches the file over https and hashes it; the
    stored source is exactly what was fetched. ``dry_run`` (the default) does all of
    that and returns what would be stored, writing nothing. A live call writes the
    catalog row WITH THE CALLER'S TOKEN, so the catalog's permissions apply and the
    caller owns the piece, then puts it in the adapter's registry so it can be
    approved at once.
    """
    token = _bearer(authorization)
    username = await _require_caller(token)
    wait = piece_authoring.registration_limiter.take(username)
    if wait is not None:
        raise HTTPException(429, headers={"Retry-After": str(int(wait) + 1)}, detail={
            "code": "PIECE_RATE_LIMITED",
            "message": f"at most {piece_authoring.REGISTRATIONS_PER_HOUR} registrations (previews "
                       f"included) per hour; try again in {int(wait) // 60 + 1} minutes"})
    try:
        owned = (await _caller_catalog(token).execute(
            COUNT_OWN_PIECES_QUERY, {"owner": username, "limit": piece_authoring.MAX_PIECES_PER_OWNER})
        ).get("modelcatalog_etl_process") or []
    except Exception as error:  # noqa: BLE001
        log.warning("piece count failed: %s", safe_error_message(error, limit=200))
        raise HTTPException(502, detail={
            "code": "CATALOG_READ_FAILED", "message": "the catalog could not be asked how many pieces you own"})
    if len(owned) >= piece_authoring.MAX_PIECES_PER_OWNER:
        raise HTTPException(422, detail={
            "code": "PIECE_LIMIT_REACHED",
            "message": f"you own {piece_authoring.MAX_PIECES_PER_OWNER} pieces, the most one user may register"})
    try:
        fetched = await run_in_threadpool(
            piece_authoring.fetch_verified_source, body.repository, body.commit, body.path)
        # The id is always the adapter's own: it becomes a key of the adapter's
        # registry, so a caller must not choose it.
        process_id = piece_authoring.new_process_id(body.label)
        built = piece_authoring.build_piece(body.model_dump(), fetched, process_id)
    except piece_authoring.PieceError as error:
        raise _piece_error(error)
    row = built["object"]
    wanted = sorted({c["standard_variable_uri"] for c in row["contracts"]["data"]})
    try:
        known = {r["id"] for r in (await _caller_catalog(token).execute(
            STANDARD_VARIABLES_QUERY, {"ids": wanted})).get("modelcatalog_standard_variable") or []}
    except Exception as error:  # noqa: BLE001
        log.warning("standard variable check failed: %s", safe_error_message(error, limit=200))
        raise HTTPException(502, detail={
            "code": "CATALOG_READ_FAILED", "message": "the catalog could not be asked about the variables"})
    unknown = [uri for uri in wanted if uri not in known]
    if unknown:
        raise HTTPException(422, detail={
            "code": "PIECE_VARIABLE_UNKNOWN", "variables": unknown,
            "message": "these standard variables are not in the catalog"})

    from .mint_sync import etl_process_to_spec_row
    as_registered = {**row, "owner_username": username, "contracts": row["contracts"]["data"]}
    summary = piece_authoring.preview(built, etl_process_to_spec_row(as_registered, []))
    if body.dry_run:
        # The id is chosen again when the piece is registered.
        return {"dry_run": True, "valid": True, **{k: v for k, v in summary.items() if k != "process_id"}}

    try:
        created = (await _caller_catalog(token).execute(
            CREATE_ETL_PROCESS_MUTATION, {"object": row}))["insert_modelcatalog_etl_process_one"]
    except (HasuraError, httpx.HTTPError) as error:
        raise _catalog_write_error(error)
    # From here the piece exists. Nothing below may turn that into an error: what
    # could not be done is reported as a warning.
    warnings = list(summary["warnings"])
    event = {
        "event_type": "piece_registered_from_repository",
        "payload_json": {
            "process_id": process_id, "registered_by": username,
            "repository": fetched["repository"], "commit": fetched["commit"], "path": fetched["path"],
            "verified_on_branch": fetched.get("verified_on_branch"),
            "source_sha256": fetched["sha256"], "visibility": row["visibility"]},
    }
    recorded = False
    for _attempt in range(2):
        try:
            await get_client(None).execute(INSERT_PROVENANCE, {"obj": event})
            recorded = True
            break
        except Exception as error:  # noqa: BLE001
            log.warning("piece %s: provenance write failed: %s", process_id, safe_error_message(error, limit=200))
    if not recorded:
        warnings.append("The piece was registered, but the audit record of its registration could not be "
                        "written. The piece stays; tell an administrator.")
    in_registry = False
    try:
        from .mint_sync import sync_one_etl_process
        in_registry = bool(await sync_one_etl_process(get_client(None), {
            **row, "owner_username": created.get("owner_username") or username,
            "contracts": row["contracts"]["data"]}))
    except Exception as error:  # noqa: BLE001
        log.warning("piece %s written but not synced: %s", process_id, safe_error_message(error, limit=200))
    if not in_registry:
        warnings.append("The piece was registered in the catalog but is not in the adapter's registry yet; "
                        "it appears at the next catalog sync.")
    return {"dry_run": False, "status": "created", "process_id": created.get("id") or process_id,
            "owner_username": created.get("owner_username") or username,
            "in_registry": in_registry, "provenance_recorded": recorded,
            **{k: v for k, v in summary.items() if k not in ("process_id", "warnings")},
            "warnings": warnings}


def _may_read_piece(spec: dict[str, Any], username: str, is_admin: bool) -> bool:
    return bool(is_admin or spec.get("owner_username") == username
                or (spec.get("visibility") or "public") in ("shared", "public"))


@app.get("/pieces/approvals", tags=["Core: Registry"])
async def list_piece_approvals(authorization: str | None = Header(None)):
    """Pieces that carry stored source, as the caller may see them, with whether each
    is approved as it is now and by whom. ``is_admin`` says whether the caller may
    approve (the page shows buttons only then)."""
    token = _bearer(authorization)
    username = await _require_caller(token)
    is_admin = await _is_catalog_admin(token, username, strict=False)
    registry = await _registry(get_client(token), plannable=False)
    events = (await get_client(None).execute(
        APPROVAL_EVENTS_QUERY, {"contains": {}, "limit": 1000})).get("adapter_provenance_event") or []
    latest = piece_authoring.latest_approvals(events)
    return {"is_admin": is_admin, "pieces": [
        piece_authoring.piece_summary(spec, latest.get(str(spec.get("id"))))
        for spec in registry
        if stored_source.stored_source(spec) and _may_read_piece(spec, username, is_admin)]}


@app.get("/transform-specs/{spec_id:path}/approval", tags=["Core: Registry"])
async def get_piece_approval(spec_id: str, authorization: str | None = Header(None)):
    """What an approver is shown for one piece: the stored source and its hash, the
    function called, the arguments, the secrets, where data is sent, and who
    approved which hash when."""
    token = _bearer(authorization)
    username = await _require_caller(token)
    is_admin = await _is_catalog_admin(token, username, strict=False)
    spec = (await get_client(None).execute(GET_APPROVAL_SPEC_QUERY, {"id": spec_id}))[
        "adapter_transform_spec_by_pk"]
    if not spec or not stored_source.stored_source(spec) or not _may_read_piece(spec, username, is_admin):
        raise HTTPException(404, detail={"code": "PIECE_NOT_FOUND",
                                         "message": "no such piece with stored source is visible to you"})
    events = (await get_client(None).execute(
        APPROVAL_EVENTS_QUERY, {"contains": {"transform_spec_id": spec_id}, "limit": 50}
    )).get("adapter_provenance_event") or []
    return {"is_admin": is_admin, **piece_authoring.piece_detail(spec, events)}


@app.put("/transform-specs/{spec_id:path}/approval", tags=["Core: Registry"])
async def set_piece_approval(
    spec_id: str, body: PieceApprovalIn, authorization: str | None = Header(None),
):
    """Approve, or withdraw approval of, a piece's stored source: the same record as
    ``PUT /admin/transform-spec-approval``, but for a signed-in member of
    ``modelcatalog_admin`` instead of the operator secret.

    Approving needs ``reviewed_sha256``, the hash the page showed; it is refused
    (409) when the piece has changed since. The event written names the approver and
    the time, and the hash. Withdrawal clears the approval and writes the same event
    with a null hash.
    """
    token = _bearer(authorization)
    username = await _require_caller(token)
    if not await _is_catalog_admin(token, username, strict=True):
        raise HTTPException(403, detail={
            "code": "ADMIN_REQUIRED", "message": "only a catalog administrator may approve a piece"})
    admin = get_client(None)
    spec = (await admin.execute(GET_APPROVAL_SPEC_QUERY, {"id": spec_id}))["adapter_transform_spec_by_pk"]
    if not spec:
        # A piece registered a moment ago may not be in the registry yet. Read it
        # from the catalog as the approver, and put it there.
        from .mint_sync import sync_one_etl_process
        try:
            process = (await _caller_catalog(token).execute(
                GET_ETL_PROCESS_QUERY, {"id": spec_id})).get("modelcatalog_etl_process_by_pk")
            if process:
                await sync_one_etl_process(admin, process)
                spec = (await admin.execute(GET_APPROVAL_SPEC_QUERY, {"id": spec_id}))[
                    "adapter_transform_spec_by_pk"]
        except Exception as error:  # noqa: BLE001
            log.warning("could not sync piece %s for approval: %s", spec_id, safe_error_message(error, limit=200))
    if not spec:
        raise HTTPException(404, detail={"code": "PIECE_NOT_FOUND", "message": "transform spec not found"})
    current = stored_source.approval_sha256(spec)
    if body.approved:
        if not current:
            raise HTTPException(400, detail={
                "code": "NO_STORED_SOURCE", "message": "this piece carries no stored source to approve"})
        if body.reviewed_sha256 != current:
            raise HTTPException(409, detail={
                "code": "APPROVAL_STALE" if body.reviewed_sha256 else "REVIEWED_HASH_REQUIRED",
                "message": "send the approval hash the page showed; the piece may have changed since "
                           "you read it",
                "approval_sha256": current})
    elif not spec.get("approved_source_sha256"):
        return {"spec_id": spec_id, "approved": False, "approved_source_sha256": None}
    sha = current if body.approved else None
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    from .hasura import SET_SPEC_APPROVAL_MUTATION
    await admin.execute(SET_SPEC_APPROVAL_MUTATION, {"id": spec_id, "sha": sha})
    await admin.execute(INSERT_PROVENANCE, {"obj": {
        "event_type": "transform_spec_approval_set",
        "payload_json": {
            "transform_spec_id": spec_id, "owner_username": spec.get("owner_username"),
            "approved_source_sha256": sha, "approved_by": username, "approved_at": now,
            "action": "approved" if body.approved else "withdrawn"},
    }})
    return {"spec_id": spec_id, "approved": body.approved, "approved_source_sha256": sha,
            "approved_by": username, "approved_at": now}


_DFC_FIXTURE = Path(__file__).resolve().parents[1] / "examples" / "twdb_adopted_dfc_2021.json"
_OBJECTIVES_FIXTURE = Path(__file__).resolve().parents[1] / "examples" / "dfc_objectives.json"


@app.get("/dfc-targets", tags=["DFC/GAM"])
async def dfc_targets(
    gma_id: str | None = Query(None, description="Filter by GMA, e.g. 'GMA 12' or '12'"),
    aquifer: str | None = Query(None, description="Filter by aquifer name (case-insensitive)"),
    metric: str | None = Query(None, description="Filter by metric key"),
    limit: int = Query(1000, ge=1, le=10000),
):
    """Return adopted DFC target records from the bundled reference fixture."""
    if not _DFC_FIXTURE.is_file():
        raise HTTPException(500, "DFC fixture not found")
    fixture = json.loads(_DFC_FIXTURE.read_text())
    records = fixture.get("records", [])

    gma_num: int | None = None
    if gma_id:
        match = re.search(r"\d+", gma_id)
        gma_num = int(match.group()) if match else None

    out = []
    for record in records:
        if gma_num is not None and record.get("gma") != gma_num:
            continue
        if aquifer:
            record_aquifer = (record.get("aquifer_system") or record.get("aquifer") or "").lower()
            if aquifer.lower() not in record_aquifer and record_aquifer not in aquifer.lower():
                continue
        if metric and record.get("metric") != metric:
            continue
        out.append(record)
        if len(out) >= limit:
            break
    return {"count": len(out), "records": out}


@app.get("/objectives", tags=["Core: Catalog/objectives"])
async def list_objectives():
    """Return bundled DFC objective specifications."""
    if not _OBJECTIVES_FIXTURE.is_file():
        return {"objectives": []}
    fixture = json.loads(_OBJECTIVES_FIXTURE.read_text())
    return {"objectives": fixture.get("objectives", [])}


@app.get("/objectives/{objective_id}", tags=["Core: Catalog/objectives"])
async def get_objective(objective_id: str):
    """Return one bundled DFC objective specification."""
    if not _OBJECTIVES_FIXTURE.is_file():
        raise HTTPException(404, "objectives fixture not found")
    fixture = json.loads(_OBJECTIVES_FIXTURE.read_text())
    for objective in fixture.get("objectives", []):
        if objective.get("id") == objective_id:
            return objective
    raise HTTPException(404, f"objective {objective_id!r} not found")


@app.get("/runtime-defaults", tags=["Core: Catalog/objectives"])
async def runtime_defaults():
    """Return non-secret runtime settings used to prefill the standalone UI."""
    spatial_layers = _default_spatial_layers()
    default_boundary_uri = settings.gma_boundary_layer_uri or (spatial_layers[0]["uri"] if spatial_layers else "")
    return {
        "geo_actor_id": settings.geo_actor_id or "",
        "tapis_exec_system": settings.tapis_exec_system,
        "tapis_workflow_group": settings.tapis_workflow_group,
        "geometry_source_uri": default_boundary_uri,
        "spatial_layers": spatial_layers,
    }


@app.get("/spatial/layers", tags=["Core: Registry"])
async def list_spatial_layers():
    """Known backend spatial sources for ETL/UI selection."""
    return {"layers": _default_spatial_layers()}


@app.get("/etl/common-variables", tags=["Core: Registry"])
async def list_common_etl_variables(include_runtime: bool = Query(False)):
    """Canonical ETL/UI variables and accepted legacy aliases."""
    variables = [
        item for item in public_definitions()
        if include_runtime or not item.get("runtime_only")
    ]
    return {
        "variables": variables,
        "canonical": variables,
        "spatial_layers": _default_spatial_layers(),
    }


@app.post("/objectives/{objective_id}/evaluate-plan", tags=["Core: Catalog/objectives"])
async def evaluate_objective_plan(
    objective_id: str,
    body: dict[str, Any] | None = None,
    authorization: str | None = Header(None),
):
    """Find and persist the best current transform plan for an objective."""
    if not _OBJECTIVES_FIXTURE.is_file():
        raise HTTPException(404, "objectives fixture not found")
    fixture = json.loads(_OBJECTIVES_FIXTURE.read_text())
    objective = next(
        (item for item in fixture.get("objectives", []) if item.get("id") == objective_id),
        None,
    )
    if not objective:
        raise HTTPException(404, f"objective {objective_id!r} not found")

    h = get_client(_bearer(authorization))
    payload = body or {}
    target_contract = (
        payload.get("target_contract")
        or objective.get("source_requirement", {}).get("contract")
        or objective.get("targets", {}).get("contract", {})
    )
    if not target_contract:
        raise HTTPException(422, "objective has no target_contract; pass target_contract in request body")

    objects = await _discoverable_objects(h)
    if not objects:
        raise HTTPException(422, "no data objects registered — sync CKAN resources first")

    target_svo = target_contract.get("standard_variable_uri", "")
    target_fields = DataObjectContract.model_fields
    target = DataObjectContract(**{
        key: value for key, value in target_contract.items() if key in target_fields
    })
    registry = await _registry(h)
    edge_map = await _load_edge_map(registry)

    candidates = []
    for obj in objects:
        if target_svo and not any(
            variable.get("standard_variable_uri") == target_svo
            for variable in obj.get("variables", [])
        ):
            continue
        rows = await _contract_rows(h, obj["id"])
        if not rows:
            continue
        source = _data_object_to_contract(rows[0])
        path = find_path(source, target, registry, edge_map=edge_map)
        if path is not None:
            candidates.append((_source_uri_score(obj.get("resource_uri")), -len(path), obj, path))

    if not candidates:
        raise HTTPException(422, "no transform path found from any matching data object to target contract")
    _, _, best, path = max(
        candidates,
        key=lambda item: (item[0], item[1], item[2].get("label") or ""),
    )

    plan_json = _plan_with_parameters(build_plan_json(path)) if path else {
        "steps": [], "lossy": False, "parameters": []
    }
    plan_json["source"] = best.get("resource_uri", "")
    plan_json["source_data_object_id"] = best.get("id")
    plan_id = f"obj-{objective_id}"
    try:
        created = (await h.execute(INSERT_PLAN, {"obj": {
            "source_data_object_id": best["id"],
            "status": "draft",
            "plan_json": plan_json,
        }}))["insert_adapter_workflow_plan_one"]
        plan_id = created["id"]
    except Exception as exc:  # Keep evaluation useful if persistence is unavailable.
        log.warning("objective plan persistence failed: %s", exc)

    return {
        "plan_id": plan_id,
        "source": {"id": best["id"], "label": best.get("label", "")},
        "objective_id": objective_id,
        "plan_json": plan_json,
    }


@app.post("/plans/dfc-fanout", tags=["DFC/GAM"])
async def create_dfc_fanout_plan(
    body: dict[str, Any],
    authorization: str | None = Header(None),
):
    """Create one area-aggregation branch per adopted DFC target record."""
    data_object_id = body.get("data_object_id")
    target_contract_raw = body.get("target_contract")
    target_records = body.get("target_records") or []
    if not data_object_id:
        raise HTTPException(422, "data_object_id is required")
    if not target_contract_raw:
        raise HTTPException(422, "target_contract is required")
    if not isinstance(target_records, list) or not target_records:
        raise HTTPException(422, "target_records must be a non-empty list")

    h = get_client(_bearer(authorization))
    src_rows = await _contract_rows(h, data_object_id)
    if not src_rows:
        raise HTTPException(404, "data object not found")
    source = _data_object_to_contract(src_rows[0])
    target = DataObjectContract(**{
        key: value for key, value in target_contract_raw.items()
        if key in DataObjectContract.model_fields
    })
    registry = await _registry(h)
    edge_map = await _load_edge_map(registry)
    path = find_path(source, target, registry, edge_map=edge_map)
    if path is None:
        raise HTTPException(422, "no transform path found from source contract to target contract")

    base = _plan_with_parameters(build_plan_json(path))
    steps: list[dict[str, Any]] = []
    step_idx = 0
    for record in target_records:
        depends_on: list[int] = []
        for base_step in base.get("steps", []):
            step = dict(base_step)
            step["step"] = step_idx
            step["depends_on"] = depends_on.copy()
            area = record.get("area") or "GMA-wide"
            record_gma = record.get("gma")
            step["dfc_record_id"] = record.get("id")
            step["dfc_area"] = area
            step["env_values"] = {
                "AREA": area,
                "AREA_TYPE": record.get("area_type") or "gma",
                "GMA_ID": body.get("gma_id") or (f"GMA {record_gma}" if record_gma else None),
                "AQUIFER": record.get("aquifer") or record.get("aquifer_system"),
                "TARGET_YEAR": (record.get("period") or {}).get("target_year"),
                "DFC_RECORD_ID": record.get("id"),
            }
            steps.append(step)
            depends_on = [step_idx]
            step_idx += 1

    plan_json = {
        "steps": steps,
        "lossy": base.get("lossy", False),
        "dfc_fanout": True,
        "target_records": target_records,
    }
    created = (await h.execute(INSERT_PLAN, {"obj": {
        "source_data_object_id": data_object_id,
        "status": "draft",
        "plan_json": plan_json,
    }}))["insert_adapter_workflow_plan_one"]
    await h.execute(INSERT_PROVENANCE, {"obj": {
        "event_type": "dfc_fanout_plan_generated",
        "payload_json": {"plan_id": created["id"], "areas": len(target_records), "steps": len(steps)},
    }})
    return {"status": "transform_required", "plan_id": created["id"], "plan_json": plan_json}


def _stable_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    ).hexdigest()


def _contract_payload(contract: DataObjectContract) -> dict[str, Any]:
    return contract.model_dump(exclude_none=True)


def _publish_value_errors(values: dict[str, Any]) -> dict[str, str]:
    """Reasons a requested collection or organisation is outside the deployment
    allow-lists. An empty list allows nothing (fail closed)."""
    errors: dict[str, str] = {}
    for name, allowed in (("stac_collection", settings.publish_allowed_collection_list),
                          ("ckan_org", settings.publish_allowed_org_list)):
        value = values.get(name)
        if value in (None, "") or str(value) in allowed:
            continue
        errors[name] = "must be one of " + (", ".join(allowed) if allowed else "(none allowed)")
    return errors


def _reject_publish_values(values: dict[str, Any]) -> None:
    errors = _publish_value_errors(values)
    if errors:
        raise HTTPException(422, detail={
            "code": "PUBLISH_VALUE_NOT_ALLOWED",
            "message": "publication target is outside the deployment allow-list",
            "parameters": errors,
        })


def _spec_output_catalog(spec: dict[str, Any]) -> str | None:
    for contract in spec.get("contracts") or []:
        if contract.get("role") == "output":
            catalog = _contract_from_registry(contract).catalog
            if catalog:
                return catalog
    return None


@app.post("/plans/deferred", tags=["Core: Planning"])
async def create_deferred_plan(
    body: DeferredPlanIn,
    authorization: str | None = Header(None),
):
    """Plan an adapter chain whose source will be created by a model run."""
    h = get_client(_bearer(authorization))
    target = await _resolve_target(
        h, body.target_dataset_specification_id, body.target_contract
    )
    registry = await _registry(h)
    edge_map = await _load_edge_map(registry)
    # A deferred source is a model output that does not exist as a registered
    # data object yet.  Treat it as reachable while planning; the later bind
    # step verifies the materialized output's ownership and contract.
    planning_source = body.source_contract
    if not planning_source.resource_uri:
        planning_source = planning_source.model_copy(
            update={"resource_uri": "deferred-model-output"}
        )
    if _catalogs(target.catalog) and not settings.publish_enabled:
        raise HTTPException(422, detail={
            "code": "PUBLISH_DISABLED",
            "message": "publishing is disabled on this deployment",
        })
    path = find_path(planning_source, target, registry, edge_map=edge_map)
    if path is None:
        raise HTTPException(422, detail={
            "code": "NO_DEFERRED_TRANSFORM_PATH",
            "message": "no transform path found from model output to target contract",
        })

    plan_json = _plan_with_parameters(build_plan_json(path))
    # A step whose output contract names a catalog publishes the run's output;
    # the Ensemble Manager accepts such steps in an otherwise identity plan.
    for step, spec in zip(plan_json["steps"], path):
        step["publishes"] = bool(_catalogs(_spec_output_catalog(spec)))
    if any(step["publishes"] for step in plan_json["steps"]):
        if tapis.PUBLISH_REQUIRED_CATALOG not in _catalogs(target.catalog):
            raise HTTPException(422, detail={
                "code": "PUBLISH_CATALOG_UNSUPPORTED",
                "message": f"publishing needs the {tapis.PUBLISH_REQUIRED_CATALOG} catalog; "
                           "STAC assets are CKAN resources",
                "catalogs": sorted(_catalogs(target.catalog)),
            })
        _reject_publish_values({
            "stac_collection": settings.publish_default_collection,
            "ckan_org": settings.publish_default_org,
            **(body.parameter_values or {}),
        })
    plan_json.update({
        "deferred": True,
        "orchestration_mode": "em_deferred_post_model",
        "model_output_key": body.model_output_key,
        "deferred_source_contract": _contract_payload(body.source_contract),
        "target_contract": _contract_payload(target),
    })
    plan_hash = _stable_hash({
        "steps": plan_json.get("steps", []),
        "parameters": plan_json.get("parameters", []),
        "source_contract": plan_json["deferred_source_contract"],
        "target_contract": plan_json["target_contract"],
        "model_output_key": body.model_output_key,
    })
    plan_json["plan_hash"] = plan_hash
    created = (await h.execute(INSERT_PLAN, {"obj": {
        "source_data_object_id": None,
        "target_dataset_specification_id": body.target_dataset_specification_id,
        "status": "deferred",
        "plan_json": plan_json,
    }}))["insert_adapter_workflow_plan_one"]
    return {
        "status": "deferred",
        "plan_id": created["id"],
        "plan_hash": plan_hash,
        "source_contract": plan_json["deferred_source_contract"],
        "target_contract": plan_json["target_contract"],
        "plan_json": plan_json,
    }


def _input_plan_error(exc: "input_plan.InputPlanError") -> HTTPException:
    return HTTPException(422, detail={"code": exc.code, "message": exc.message})


async def _derive_input_plan(
    h, configuration_id: str, sources: list[dict[str, Any]], filled: "set[str] | list[str]",
) -> dict[str, Any]:
    registry = await _registry(h)
    edge_map = await _load_edge_map(registry)
    try:
        return input_plan.plan_model_inputs(registry, edge_map, configuration_id, sources, filled)
    except input_plan.InputPlanError as exc:
        raise _input_plan_error(exc)


@app.post("/plans/model-inputs", tags=["Core: Planning"])
async def plan_model_inputs(body: PlanModelInputsIn, authorization: str | None = Header(None)):
    """Preview the input-side ETL steps for a model's bound, unfilled file inputs.

    Nothing is written. The same derivation runs inside ``/workflows/submit``
    from ``model_task.input_sources``; ``steps_digest`` lets a submit detect a
    registry change since this preview.
    """
    h = get_client(_bearer(authorization))
    return await _derive_input_plan(h, body.configuration_id, body.sources, body.filled_app_inputs)


@app.post("/plans/deferred/{plan_id}/bind", tags=["Core: Planning"])
async def bind_deferred_plan(
    plan_id: str,
    body: BindDeferredPlanIn,
    authorization: str | None = Header(None),
    internal_secret: str | None = Header(None, alias="X-Ensemble-Manager-Secret"),
):
    """Bind one server-owned model output to a deferred adapter plan."""
    _require_internal_service(
        internal_secret, "deferred-plan binding is an internal Ensemble Manager operation")
    if not body.parent_execution_id.startswith("ue_"):
        raise HTTPException(422, detail={
            "code": "INVALID_PARENT_EXECUTION_ID",
            "message": "parent_execution_id must be a unified Ensemble Manager execution ID",
        })
    h = get_client(_bearer(authorization))
    plan = (await h.execute(GET_PLAN, {"id": plan_id}))["adapter_workflow_plan_by_pk"]
    if not plan:
        raise HTTPException(404, "plan not found")
    plan_json = dict(plan.get("plan_json") or {})
    if not plan_json.get("deferred"):
        raise HTTPException(409, detail={"code": "PLAN_NOT_DEFERRED"})
    if body.plan_hash != plan_json.get("plan_hash"):
        raise HTTPException(409, detail={"code": "PLAN_HASH_MISMATCH"})

    # The shared secret was proved above: the bind may use the model-output row.
    object_rows = await _contract_rows(h, body.data_object_id, service=True)
    object_row = object_rows[0] if object_rows else None
    if not object_row:
        raise HTTPException(404, "data object not found")
    metadata = (await h.execute(GET_DATA_OBJECT, {"id": body.data_object_id}))["adapter_data_object_by_pk"]
    if metadata and metadata.get("owner_execution_id") != body.parent_execution_id:
        raise HTTPException(403, detail={"code": "OUTPUT_OWNERSHIP_MISMATCH"})

    expected = plan_json.get("deferred_source_contract") or {}
    actual = _data_object_to_contract(object_row).model_dump(exclude_none=True)
    for key in ("standard_variable_uri", "format", "extension"):
        if expected.get(key) and expected.get(key) != actual.get(key):
            raise HTTPException(422, detail={
                "code": "OUTPUT_CONTRACT_MISMATCH",
                "field": key,
                "expected": expected.get(key),
                "actual": actual.get(key),
            })

    binding_key = _stable_hash({
        "parent_execution_id": body.parent_execution_id,
        "model_child_id": body.model_child_id,
        "data_object_id": body.data_object_id,
        "plan_hash": body.plan_hash,
        "parameter_values_hash": body.parameter_values_hash,
    })
    existing = plan_json.get("bound")
    if existing:
        if existing.get("binding_key") != binding_key:
            raise HTTPException(409, detail={"code": "PLAN_ALREADY_BOUND"})
        return {"status": "bound", **existing}

    bound_plan_id = f"bound:{plan_id}:{binding_key[:16]}"
    plan_json["bound"] = {
        "bound_plan_id": bound_plan_id,
        "binding_key": binding_key,
        "data_object_id": body.data_object_id,
        "parent_execution_id": body.parent_execution_id,
        "model_child_id": body.model_child_id,
        "parameter_values_hash": body.parameter_values_hash,
    }
    await h.execute(UPDATE_DEFERRED_PLAN_BINDING, {
        "id": plan_id,
        "source_id": body.data_object_id,
        "plan_json": plan_json,
    })
    return {
        "status": "bound",
        "bound_plan_id": bound_plan_id,
        "plan_id": plan_id,
        "plan_hash": body.plan_hash,
        "data_object_id": body.data_object_id,
    }


def _cannot(reason: str) -> dict[str, Any]:
    return {"ok": False, "reason": reason, "orgs_ok": []}


def _can_publish(token: str | None) -> dict[str, Any]:
    """Advisory precheck: may the caller create datasets in an allowed organisation?

    Reads the settings CKAN only, with the caller's token, a timeout and no
    redirects (the token must never follow a redirect). STAC accepts any Tapis
    user, so this is a convenience, not the authorization. ``orgs_ok`` lists the
    allowed organisations the caller may create datasets in, in allow-list order;
    ``ok`` is true when there is at least one.
    """
    org = settings.publish_default_org
    if not settings.publish_enabled:
        return _cannot("publishing is disabled on this deployment")
    if not token:
        return _cannot("no Tapis token supplied")
    import requests  # noqa: PLC0415 — only this endpoint needs it

    try:
        response = requests.get(
            settings.publish_ckan_url.rstrip("/") + "/api/3/action/organization_list_for_user",
            params={"permission": "create_dataset"},
            headers={"Authorization": f"Bearer {token}"},
            timeout=10, allow_redirects=False,
        )
    except requests.RequestException as exc:
        return _cannot(f"CKAN could not be reached ({type(exc).__name__})")
    if response.status_code == 401:
        return _cannot("CKAN rejected your token (HTTP 401); log in again")
    if response.status_code == 403:
        return _cannot("CKAN denied the organisation check (HTTP 403)")
    if response.status_code != 200:
        return _cannot(f"CKAN returned HTTP {response.status_code}")
    try:
        orgs = response.json().get("result") or []
    except ValueError:
        return _cannot("CKAN returned an unreadable response")
    names = {str(o.get("name")) for o in orgs if isinstance(o, dict)}
    names |= {str(o.get("id")) for o in orgs if isinstance(o, dict)}
    orgs_ok = [o for o in settings.publish_allowed_org_list if o in names]
    if orgs_ok:
        return {"ok": True, "reason": None, "orgs_ok": orgs_ok}
    allowed = ", ".join(settings.publish_allowed_org_list) or org
    return _cannot(f"you cannot create datasets in any organisation this deployment publishes to ({allowed})")


def _publisher_parameters(spec: dict[str, Any]) -> list[dict[str, Any]]:
    steps = build_plan_json([spec])["steps"]
    definitions = parameter_definitions(steps, {**tapis.STANDARD_PARAMS, **tapis.publish_params()})
    out = []
    for definition in definitions:
        if definition.get("managed") or definition["name"] in tapis._INPUT_SECRET_PARAMS:
            continue
        item = {k: definition.get(k) for k in ("name", "type", "required", "default")}
        for key in ("allowed_values", "description"):
            if definition.get(key) is not None:
                item[key] = definition[key]
        out.append(item)
    return out


@app.get("/publishers", tags=["Core: Planning"])
async def list_publishers(
    configuration_id: str = Query(...),
    authorization: str | None = Header(None),
):
    """Catalog publishers a model configuration's output can be routed through.

    Each publisher lists ``output_formats``: the declared formats of the model
    outputs that reach its catalog, so a caller can pick a publishable output.
    """
    token = _bearer(authorization)
    h = get_client(token)
    registry = await _registry(h)
    model = next((s for s in registry if s.get("mint_model_config_id") == configuration_id), None)
    if model is None:
        raise HTTPException(404, detail={"code": "CONFIGURATION_NOT_FOUND",
                                         "message": "the configuration is not in the adapter registry"})
    publishers = [s for s in registry if str(s.get("transform_type") or "").lower() == tapis.PUBLISH_STEP_TYPE]
    found: dict[str, dict[str, Any]] = {}
    # Every output contract is tried, not just the first that reaches a catalog:
    # a model declares several outputs (archive, manifest, GeoTIFF, ...) and the
    # Ensemble Manager needs to know which of them a publisher can take. The
    # formats are reported verbatim, as the catalog records them, so the EM
    # matches its own output list by equality instead of re-implementing the
    # planner's format aliases.
    for contract in (c for c in model.get("contracts") or [] if c.get("role") == "output"):
        source = _contract_from_registry(contract).model_copy(
            update={"resource_uri": "deferred-model-output", "catalog": None})
        for spec in publishers:
            catalog = _spec_output_catalog(spec)
            if not catalog:
                continue
            # The piece plus the ordinary ETL pieces, so no other publisher can stand in for it.
            usable = [s for s in registry if s is spec or s not in publishers]
            path = find_path(source, source.model_copy(update={"catalog": catalog}), usable)
            if path and any(step.get("id") == spec.get("id") for step in path):
                item = found.setdefault(spec["id"], {
                    "transform_spec_id": spec["id"],
                    "name": spec.get("name"),
                    "catalog_tokens": sorted(_catalogs(catalog)),
                    "parameters": _publisher_parameters(spec),
                    "output_formats": [],
                })
                output_format = contract.get("format")
                if output_format and output_format not in item["output_formats"]:
                    item["output_formats"].append(output_format)
    if not found:
        return {"configuration_id": configuration_id, "publishers": []}
    can_publish = await run_in_threadpool(_can_publish, token)
    return {"configuration_id": configuration_id,
            "publishers": [{**item,
                            "parameters": _user_scoped_parameters(item["parameters"], can_publish),
                            "catalog_options": tapis.publish_catalog_options(item["catalog_tokens"]),
                            "can_publish": can_publish}
                           for item in found.values()]}


def _user_scoped_parameters(parameters: list[dict[str, Any]], can_publish: dict[str, Any]) -> list[dict[str, Any]]:
    """The publisher's parameters with ``ckan_org`` narrowed to the organisations the
    caller may actually publish to (``orgs_ok``): the allow-list is the deployment's
    bound, the caller's CKAN memberships decide what the form offers. The default is
    the configured organisation when the caller belongs to it, else the first usable
    one. With no usable organisation the allow-list is shown unchanged; the control is
    disabled by ``can_publish`` anyway."""
    orgs_ok = [str(o) for o in can_publish.get("orgs_ok") or []]
    if not orgs_ok:
        return parameters
    out = []
    for parameter in parameters:
        if parameter.get("name") == "ckan_org":
            default = parameter.get("default")
            parameter = {**parameter, "allowed_values": orgs_ok,
                         "default": default if default in orgs_ok else orgs_ok[0]}
        out.append(parameter)
    return out


@app.post("/readiness/check", response_model=ReadinessResult, tags=["Core: Planning"])
async def readiness_check(body: ReadinessCheckIn, authorization: str | None = Header(None)):
    h = get_client(_bearer(authorization))
    src_rows = await _contract_rows(h, body.data_object_id)
    if not src_rows:
        raise HTTPException(404, "data object not found")
    src = _data_object_to_contract(src_rows[0])
    tgt = await _resolve_target(h, body.dataset_specification_id, body.target_contract)

    result = compatibility(src, tgt)
    await h.execute(INSERT_READINESS, {"obj": {
        "data_object_id": body.data_object_id,
        "model_configuration_id": body.model_configuration_id,
        "dataset_specification_id": body.dataset_specification_id,
        "status": result.status.value,
        "missing_requirements_json": {"missing": result.missing_requirements},
    }})
    return result


async def _named_path(h: Any, piece_ids: list[str], src: DataObjectContract,
                      tgt: DataObjectContract) -> list[dict[str, Any]]:
    """The registry rows for a chain the caller named by catalog piece id, in
    order, after checking that the chain fits. Nothing is searched for."""
    by_id: dict[str, dict[str, Any]] = {}
    for spec in await _registry(h, plannable=False):
        by_id.setdefault(str(spec.get("id")), spec)
        if spec.get("mint_etl_process_id"):
            by_id[str(spec["mint_etl_process_id"])] = spec
    missing = [piece_id for piece_id in piece_ids if piece_id not in by_id]
    if missing:
        raise HTTPException(422, detail={
            "code": "PIECE_NOT_IN_REGISTRY", "piece_ids": missing,
            "message": "not in the adapter's registry: the piece does not exist, is not visible "
                       "to you, or was registered after the last catalog sync"})
    path = [by_id[piece_id] for piece_id in piece_ids]
    misfit = first_misfit(src, tgt, path)
    if misfit:
        position, reason = misfit
        raise HTTPException(422, detail={
            "code": "PIECE_DOES_NOT_FIT", "position": position,
            "piece_id": piece_ids[position] if position < len(piece_ids) else None,
            "message": reason})
    return path


@app.post("/plans", tags=["Core: Planning"])
async def create_plan(body: PlanIn, authorization: str | None = Header(None)):
    h = get_client(_bearer(authorization))
    src_rows = await _contract_rows(h, body.data_object_id)
    if not src_rows:
        raise HTTPException(404, "data object not found")
    src = _data_object_to_contract(src_rows[0])
    tgt = await _resolve_target(h, body.target_dataset_specification_id, body.target_contract)

    opt_in = tuple(body.allow_unapproved_piece_ids)
    if body.piece_ids is not None:
        path = await _named_path(h, body.piece_ids, src, tgt)
        plan_json = _plan_with_parameters(build_plan_json(path))
        plan_json["piece_ids"] = list(body.piece_ids)
        # The same check as at submit, so a chain the caller may not run is
        # refused here and not after they have filled in its arguments.
        problems = stored_source.check_plan(
            plan_json, await _registry(h, plannable=False),
            await _caller_or_none(_bearer(authorization)), opt_in)
        if problems:
            raise HTTPException(403, detail={"code": "STORED_SOURCE_REFUSED", "problems": problems})
    else:
        if compatibility(src, tgt).status == ReadinessStatus.ready:
            return {"status": "ready", "plan": None, "message": "data object is already model-ready"}

        registry = await _registry(h, opt_in=opt_in)

        edge_map = await _load_edge_map(registry)
        path = find_path(src, tgt, registry, edge_map=edge_map)
        if path is None:
            raise HTTPException(422, "no transform path found from source contract to target contract")

        plan_json = _plan_with_parameters(build_plan_json(path))
    if opt_in:
        # The opt-in belongs to this caller and this plan; it is re-checked
        # against whoever submits.
        plan_json["stored_source_opt_in"] = {
            "username": await _caller_or_none(_bearer(authorization)),
            "piece_ids": sorted(opt_in),
        }
    created = (await h.execute(INSERT_PLAN, {"obj": {
        "source_data_object_id": body.data_object_id,
        "target_model_configuration_id": body.target_model_configuration_id,
        "target_dataset_specification_id": body.target_dataset_specification_id,
        "status": "draft",
        "plan_json": plan_json,
    }}))["insert_adapter_workflow_plan_one"]
    await h.execute(INSERT_PROVENANCE, {"obj": {
        "event_type": "plan_generated",
        "payload_json": {"plan_id": created["id"], "steps": len(path)},
    }})
    return {"status": "transform_required", "plan_id": created["id"], "plan_json": plan_json}


# ---------------------------------------------------------------------------
# Flows: a graph of pieces stored on a model configuration
# ---------------------------------------------------------------------------
def _piece_view(spec: dict[str, Any]) -> dict[str, Any]:
    """A piece as the flow check reads it, from a registry row or a catalog row.

    The two keep a contract's position in different places, and a piece
    registered straight into the adapter has none: those are numbered from 1
    within inputs and within outputs, in the order they were given.
    """
    contracts = spec.get("contracts") or []
    if isinstance(contracts, dict):
        contracts = contracts.get("data") or []
    counted = {"input": 0, "output": 0}
    view: list[dict[str, Any]] = []
    for contract in contracts:
        role = contract.get("role")
        if role not in counted:
            continue
        counted[role] += 1
        position = contract.get("position")
        if not isinstance(position, int):
            position = (contract.get("metadata_json") or {}).get("mint_position")
        if not isinstance(position, int):
            position = counted[role]
        view.append({**contract, "position": position})
    runtime = spec.get("runtime_json") if isinstance(spec.get("runtime_json"), dict) else {}
    schema = spec.get("parameters_schema_json")
    if not isinstance(schema, dict):
        nested = runtime.get("parameters_schema_json")
        schema = nested if isinstance(nested, dict) else {}
    runtime = runtime or ((schema.get("metadata") or {}).get("runtime") or {})
    return {
        "id": spec.get("mint_etl_process_id") or spec.get("id"),
        "contracts": view,
        "parameters_schema_json": schema,
        "value_outputs": runtime.get("value_outputs") or schema.get("value_outputs") or [],
    }


def _refused_flow_settings() -> set[str]:
    """Arguments a flow may neither set nor link: the ones the adapter fills in
    and the ones that carry a credential. A flow is written by one user and run
    by another."""
    return set(MANAGED_PARAMS) | set(tapis._INPUT_SECRET_PARAMS)


async def _catalog_pieces(h: Any, piece_ids: list[str | None]) -> dict[str, dict[str, Any]]:
    """Catalog pieces by id, as the CALLER may see them. Read from the catalog
    itself, not the adapter's synced copy, so a piece registered a minute ago can
    be put in a flow."""
    wanted = sorted({piece_id for piece_id in piece_ids if piece_id})
    if not wanted:
        return {}
    if settings.demo_mode:
        found: dict[str, dict[str, Any]] = {}
        for spec in await _registry(h, plannable=False):
            for key in (spec.get("mint_etl_process_id"), spec.get("id")):
                if key in wanted:
                    found.setdefault(str(key), spec)
        return found
    client = HasuraClient(getattr(h, "_bearer", None), user_scoped=True)
    rows = (await client.execute(GET_FLOW_PIECES, {"ids": wanted})).get("modelcatalog_etl_process") or []
    return {str(row["id"]): row for row in rows}


async def _load_flow(h: Any, configuration_id: str) -> dict[str, Any] | None:
    """A configuration's flow as the caller may see it, or None when there is no
    such configuration or it is a model, not a flow."""
    if settings.demo_mode:
        return None
    client = HasuraClient(getattr(h, "_bearer", None), user_scoped=True)
    row = (await client.execute(GET_FLOW, {"id": configuration_id})).get("modelcatalog_configuration_by_pk")
    if not row or not row.get("flow"):
        return None
    return {
        "configuration_id": row["id"],
        "label": row.get("label"),
        "parameters": [{"id": p["parameter"]["id"]} for p in row.get("parameters") or [] if p.get("parameter")],
        "outputs": row["flow"].get("outputs_json") or [],
        "thread_bindings": row["flow"].get("thread_bindings_json") or {},
        "settings": row["flow"].get("settings_json") or {},
        "steps": [{
            "position": step.get("position"),
            "etl_process_id": step.get("etl_process_id"),
            "settings": step.get("settings_json") or {},
            "wires": step.get("wires_json") or [],
            "pause_after": bool(step.get("pause_after")),
        } for step in row["flow"].get("steps") or []],
    }


def _unaccepted_flow_settings(plan_json: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
    """What a flow's author chose that this submission would use as it stands.

    A piece runs with the submitter's token, and approval covers a piece's code,
    not the arguments it is given. So a flow's defaults and the settings it links
    from earlier steps take effect only when the submitter accepts them. A value
    the submitter sends replaces the flow's default and needs no acceptance.
    """
    if not isinstance(plan_json.get("flow"), dict):
        return {"defaults": {}, "links": []}
    sent = set(accepted_aliases(str(name) for name in (args or {})))
    defaults = {
        str(parameter["name"]): parameter.get("default")
        for parameter in plan_json.get("parameters") or []
        if parameter.get("default_source") == "flow" and parameter.get("name") not in sent
    }
    return {"defaults": defaults, "links": list(plan_json["flow"].get("linked_settings") or [])}


def _fixed_flow_args(plan_json: dict[str, Any], args: dict[str, Any]) -> list[str]:
    """Arguments of a flow run that a submission may not send.

    A flow's datasets and region are checked against each piece's contract when
    the flow is planned, and are stored in the plan. A value sent at submit would
    replace one unchecked. The run's own identifiers are not the submitter's to
    choose either.
    """
    if not isinstance(plan_json.get("flow"), dict):
        return []
    fixed = accepted_aliases(
        str(parameter["name"]) for parameter in plan_json.get("parameters") or []
        if parameter.get("managed") and parameter.get("name"))
    # The Tapis address is where a step sends the runner's token, so it is the
    # adapter's own setting, never a value from the request.
    fixed.update({"execution_id", "source_uri", "tapis_token", "flow_staging_uri", "tapis_base_url"})
    sent = normalize_args(_wrap_args(args or {}))
    # What the adapter hands a step bound to a secret: the run, where to fetch, and
    # each step's own fetch credential.
    return sorted(name for name in sent if name in fixed or step_secrets.is_managed_argument(str(name)))


def _refused_flow_setting_args(plan_json: dict[str, Any], args: dict[str, Any]) -> dict[str, list[str]]:
    """Settings of a flow run that the runner sent and may not: the ones the author
    fixed and the ones the author hid. Enforced here, not only by the form, so the
    API cannot be used to override them. The dates the thread fills in are not the
    runner's choice and pass, even when the author hid them."""
    if not isinstance(plan_json.get("flow"), dict):
        return {}
    sent = set(normalize_args(_wrap_args(args or {})))
    thread_bound = flow_settings.thread_bound_names((plan_json["flow"]).get("thread_bindings"))
    refused: dict[str, list[str]] = {}
    for reason, applies in (("fixed", lambda p: p.get("fixed") is True),
                            ("hidden", lambda p: p.get("visibility") == "hidden")):
        names = sorted(
            str(parameter["name"]) for parameter in plan_json.get("parameters") or []
            if parameter.get("name") and parameter["name"] not in thread_bound and applies(parameter)
            and sent & accepted_aliases([str(parameter["name"])]))
        if names:
            refused[reason] = names
    return refused


def _collection_tapis_systems() -> list[str]:
    return [name.strip() for name in settings.flow_collection_tapis_systems.split(",") if name.strip()]


def _gatherable_https(url: Any) -> bool:
    """Whether ``url`` is an ``https`` link the gather task would fetch."""
    try:
        return isinstance(url, str) and gather_fetch.check_url(url)["scheme"] == "https"
    except ValueError:
        return False


def _flow_collections(body: FlowPlanIn, flow: dict[str, Any], used: list[str]) -> dict[str, str]:
    """The flow inputs this plan gathers, each with the id of its gather task
    (``gather-1``, ``gather-2`` ... in the order the steps first read the inputs).

    A collection may be given only for an input the flow marks as taking one, that
    a step reads, and that is neither bound to a data object nor the thread's
    region. Each link must be one a gather task will fetch (the address itself is
    checked when the task fetches it, where the name is resolved).
    """
    marked = (flow.get("thread_bindings") or {}).get("collections")
    marked = [item for item in marked if isinstance(item, str)] if isinstance(marked, list) else []
    region_input = body.region.get("input") if isinstance(body.region, dict) else None

    def refuse(code: str, input_id: str, message: str, **extra: Any) -> HTTPException:
        return HTTPException(422, detail={"code": code, "input": input_id, "message": message, **extra})

    for input_id, collection in body.collections.items():
        if input_id not in marked:
            raise refuse("FLOW_COLLECTION_REFUSED", input_id, "the flow does not mark this input as taking a collection")
        if input_id not in used:
            raise refuse("FLOW_COLLECTION_REFUSED", input_id, "no step of the flow reads this input")
        if input_id in body.inputs:
            raise refuse("FLOW_COLLECTION_REFUSED", input_id,
                         "the input is bound to a data object as well; give either one data object or a collection")
        if input_id == region_input:
            raise refuse("FLOW_COLLECTION_REFUSED", input_id, "the thread's region fills this input, not a collection")
        limit = settings.flow_collection_max_resources
        if len(collection.resources) > limit:
            raise refuse("FLOW_COLLECTION_REFUSED", input_id,
                         f"a collection holds at most {limit} resources; this one has {len(collection.resources)}",
                         limit=limit)
        tapis_systems = _collection_tapis_systems()
        for index, resource in enumerate(collection.resources):
            try:
                place = gather_fetch.check_url(resource.url)
            except ValueError as error:
                raise refuse("FLOW_COLLECTION_RESOURCE_REFUSED", input_id,
                             f"resource {index}: {error}", index=index) from error
            if place["scheme"] == "tapis" and place["system"] not in tapis_systems:
                # Read with the runner's token, from a list others may have edited.
                raise refuse("FLOW_COLLECTION_RESOURCE_REFUSED", input_id,
                             f"resource {index}: a collection may not read from the Tapis system "
                             f"{place['system']}", index=index)
    wanted = [input_id for input_id in used if input_id in body.collections]
    return {input_id: f"gather-{n}" for n, input_id in enumerate(wanted, start=1)}


def _flow_region(region: dict[str, Any] | None, used: list[str], inputs: dict[str, str],
                 flow: dict[str, Any]) -> tuple[str | None, str | None]:
    """The flow input that takes the thread's region, and the region as GeoJSON
    text, or (None, None) when the request sends no region.

    The region is checked with the limits a model's region input has (size, area,
    vertices). It may fill only the input the flow itself marks as its region, and
    only when no dataset is bound to that input.
    """
    if region is None:
        return None, None
    marked = ((flow.get("thread_bindings") or {}).get("region") or {}).get("input")
    input_id = region.get("input") if isinstance(region, dict) else None
    if not isinstance(input_id, str) or input_id != marked or input_id not in used or input_id in inputs:
        raise HTTPException(422, detail={
            "code": "FLOW_REGION_REFUSED",
            "message": "a region fills only the input the flow marks as its region, "
                       "and only when no dataset is bound to it"})
    try:
        normalized, _ = input_plan._validate_source(region.get("source"), 0)
    except input_plan.InputPlanError as error:
        raise HTTPException(422, detail={"code": error.code, "message": str(error)}) from error
    if normalized["kind"] == "geojson":
        geometry = normalized["geometry"]
    else:
        minx, miny, maxx, maxy = normalized["bbox"]
        geometry = {"type": "Polygon", "coordinates": [[
            [minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy], [minx, miny]]]}
    return input_id, json.dumps(geometry, sort_keys=True, separators=(",", ":"))


def _marked_input_contract(input_id: str, rows: list[dict[str, Any]],
                           specs: list[dict[str, Any] | None], resource_uri: str) -> DataObjectContract:
    """What an input with no registered dataset is taken to be for the fit check:
    whatever the first piece input linked to it asks for. The thread's region and
    a collection of files are such inputs: each fills the input the flow's author
    marked for it."""
    for step, spec in zip(rows, specs):
        if not spec:
            continue
        inputs = flow_graph.piece_inputs(_piece_view(spec))
        for wire in step.get("wires") or []:
            if not isinstance(wire, dict):
                continue
            source, target = wire.get("from") or {}, wire.get("to") or {}
            if source.get("flow_input") == input_id and target.get("input") in inputs:
                contract = _contract_from_registry(inputs[target["input"]])
                contract.resource_uri = resource_uri
                return contract
    return DataObjectContract(resource_uri=resource_uri)


async def _require_signed_in(bearer: str | None) -> str | None:
    """The caller's username, or 401. Flows are read from the catalog as the
    caller; someone who is not signed in may not read every column a check needs.
    The local demo has no accounts."""
    if settings.demo_mode:
        return await _caller_or_none(bearer)
    username = await _caller_or_none(bearer)
    if not username:
        raise HTTPException(401, detail={
            "code": "TAPIS_AUTH_REQUIRED",
            "message": "a valid Tapis bearer token is required to check or plan a flow",
        })
    return username


def _piece_summary(view: dict[str, Any]) -> dict[str, Any]:
    """What whoever registers a flow needs to know about a piece: where a link can
    go, and the settings a flow may give it with their type and default."""
    refused = {name.lower() for name in _refused_flow_settings()}
    properties = (view.get("parameters_schema_json") or {}).get("properties") or {}
    settings = sorted(name for name in flow_graph.piece_arguments(view) if name.lower() not in refused)

    def contracts(found: dict[int, dict[str, Any]]) -> dict[str, dict[str, Any]]:
        return {str(position): {key: contract.get(key) for key in ("standard_variable_uri", "unit", "format")
                                if contract.get(key) is not None}
                for position, contract in sorted(found.items())}

    return {
        "inputs": sorted(flow_graph.piece_inputs(view)),
        "outputs": sorted(flow_graph.piece_outputs(view)),
        "settings": settings,
        "values": sorted(flow_graph.piece_values(view)),
        "input_contracts": contracts(flow_graph.piece_inputs(view)),
        "output_contracts": contracts(flow_graph.piece_outputs(view)),
        "setting_details": {name: flow_settings.describe(properties.get(name)) for name in settings},
    }


def _flow_secret_problems(position: Any, piece_id: Any, row: dict[str, Any]) -> list[dict[str, Any]]:
    """What is wrong with a piece's secret declaration as a step of a flow
    (``/flows/check``): an invalid declaration, a piece kind that cannot be given a
    secret, or a task input that a secret fills and something else sets. ``row`` is
    a catalog ETL process, or a registry row (what the local demo returns)."""
    from_catalog = isinstance(row.get("runtime_json"), dict)
    runtime = row["runtime_json"] if from_catalog else {}
    seen = {"parameters_schema_json": {"metadata": {"runtime": runtime}}} if from_catalog else row
    try:
        declared, _ = step_secrets.declared_from_catalog_row(row)
        if not declared:
            return []
        env_from_args = runtime.get("env_from_args") if from_catalog else (
            row.get("env_from_args") or ((row.get("parameters_schema_json") or {}).get("tapis") or {}).get(
                "env_from_args"))
        step = {"step": position, "secrets": declared,
                "tapis_app_id": runtime.get("tapis_app_id") if from_catalog else row.get("tapis_app_id"),
                "python_source": stored_source.stored_source(seen),
                "python_entrypoint": stored_source.stored_entrypoint(seen)}
        step_secrets.check_supported(step, in_flow=True)
        step_secrets.step_inputs_check(step, [], normalize_env_from_args(env_from_args or {}) or {})
    except step_secrets.StepSecretError as error:
        return [{key: value for key, value in {**error.detail, "step": position}.items()
                 if key in ("code", "message", "step", "input", "reason")}]
    return []


@app.post("/flows/check", tags=["Core: Planning"])
async def check_flow(body: FlowCheckIn, authorization: str | None = Header(None)):
    """Check a flow before it is registered: every link against the pieces'
    declared inputs and outputs. Nothing is stored and no data is needed.

    Pieces are read from the catalog with the caller's token. One the caller
    cannot see is reported as an empty step, the same as one that does not exist.
    """
    await _require_signed_in(_bearer(authorization))
    h = get_client(_bearer(authorization))
    pieces = await _catalog_pieces(h, [step.etl_process_id for step in body.steps])
    views = {piece_id: _piece_view(spec) for piece_id, spec in pieces.items()}
    checked = flow_graph.check({
        "inputs": body.inputs,
        "parameters": body.parameters,
        "steps": [{
            "position": step.position, "piece": views.get(step.etl_process_id or ""),
            "settings": step.settings, "wires": step.wires, "pause_after": step.pause_after,
        } for step in body.steps],
        "outputs": body.outputs,
        "thread_bindings": body.thread_bindings,
        "settings": body.settings,
    }, refused_settings=_refused_flow_settings())
    secret_problems = [
        problem for step in body.steps if step.etl_process_id in pieces
        for problem in _flow_secret_problems(step.position, step.etl_process_id, pieces[step.etl_process_id])]
    return {
        "ok": checked.ok and not secret_problems,
        "problems": [problem.as_dict() for problem in checked.problems] + secret_problems,
        "depends_on": {str(position): after for position, after in checked.depends_on.items()},
        "pieces": {piece_id: _piece_summary(view) for piece_id, view in views.items()},
    }


async def _pieces_for_proposal(h: Any, caller: str | None) -> list[dict[str, Any]]:
    """Every piece the caller may see, as catalog or registry rows. Another user's
    private piece is dropped here as well as by Hasura's select rules."""
    if settings.demo_mode:
        rows = await _registry(h, plannable=False)
    else:
        client = HasuraClient(getattr(h, "_bearer", None), user_scoped=True)
        rows = (await client.execute(GET_VISIBLE_PIECES, {"limit": 1000})).get("modelcatalog_etl_process") or []
    return _visible_pieces(rows, caller)


@app.post("/flows/propose", tags=["Core: Planning"])
async def propose_for_flow(body: FlowProposeIn, authorization: str | None = Header(None)):
    """What fits in a flow, exactly, from the pieces' declared contracts. Nothing
    is stored and nothing is ranked.

    ``purpose`` is one of ``{"step": n, "input": k}`` (what can feed that input:
    the flow inputs and earlier outputs that fit, else the shortest converter
    chains), ``{"step": n, "output": j}`` (the pieces that can take it) or
    ``{"contract": {...}}`` (the pieces that make it, and what each still needs).
    A proposal passes the same fit rule as ``/flows/check``. Only pieces the
    caller may see are used; each carries the caller's approval state.
    """
    bearer = _bearer(authorization)
    caller = await _require_signed_in(bearer)
    h = get_client(bearer)
    specs = await _pieces_for_proposal(h, caller)

    views: dict[str, dict[str, Any]] = {}
    for spec in specs:
        view = _piece_view(spec)
        view["label"] = spec.get("label") or spec.get("name")
        view["lossy"] = bool(spec.get("is_lossy"))
        views.setdefault(str(view["id"]), view)
    approvals: dict[str, str | None] = {}
    registry = await _registry(h, plannable=False)
    for spec in registry:
        for key in (spec.get("mint_etl_process_id"), spec.get("id")):
            if key and str(key) in views and str(key) not in approvals:
                approvals[str(key)] = stored_source.decision(spec, caller)

    # Providers: model configurations (registry rows synced from MINT, visible to the
    # caller) and the data objects the caller may use (shared, or their own).
    models = []
    for spec in _visible_pieces(registry, caller):
        config_id = spec.get("mint_model_config_id")
        outputs = flow_graph.piece_outputs(_piece_view(spec)) if config_id else {}
        if outputs:
            models.append({"configuration_id": config_id, "label": spec.get("label") or spec.get("name"),
                           "outputs": outputs})
    datasets = [{"data_object_id": row["id"], "label": row.get("label"), "format": row.get("format"),
                 "description": row.get("description"), "resource_uri": row.get("resource_uri"),
                 "source_catalog": row.get("source_catalog"),
                 "contracts": [_data_object_to_contract({**row, "variables": [variable]})
                               for variable in row.get("variables") or []]}
                for row in await _discoverable_objects(h)]

    by_catalog_id = {str(step.etl_process_id): views.get(str(step.etl_process_id))
                     for step in body.steps if step.etl_process_id}
    try:
        return flow_propose.propose(
            {"inputs": body.inputs, "parameters": body.parameters,
             "steps": [{"position": step.position, "piece": by_catalog_id.get(str(step.etl_process_id)),
                        "settings": step.settings, "wires": step.wires} for step in body.steps],
             "outputs": body.outputs},
            views, body.purpose, approvals=approvals,
            max_chain=body.max_chain, max_results=body.max_results,
            models=models, datasets=datasets)
    except flow_propose.ProposeError as error:
        raise HTTPException(422, detail={"code": error.code, "message": error.message}) from error


@app.get("/flows/{configuration_id:path}/availability", tags=["Core: Planning"])
async def flow_availability(configuration_id: str, authorization: str | None = Header(None)):
    """Whether this caller could run each step of a stored flow, without planning it.

    The flow and the registry are read the way ``/plans/flow`` reads them, so a
    piece another user keeps private is reported as ``piece_missing`` and nothing
    else: no label, owner or id. A step is runnable when ``stored_source.decision``
    lets the caller run its piece; opting in to an unapproved piece is a choice
    made at plan time, so it is not offered here.
    """
    bearer = _bearer(authorization)
    caller = await _require_signed_in(bearer)
    h = get_client(bearer)
    flow = await _load_flow(h, configuration_id)
    if flow is None:
        raise HTTPException(422, detail={
            "code": "FLOW_NOT_FOUND", "flow_id": configuration_id,
            "message": "no such flow: the configuration does not exist or is not a flow"})

    by_id: dict[str, dict[str, Any]] = {}
    for spec in await _registry(h, plannable=False):
        if spec.get("visibility") == "private" and spec.get("owner_username") != caller:
            continue
        by_id.setdefault(str(spec.get("id")), spec)
        if spec.get("mint_etl_process_id"):
            by_id[str(spec["mint_etl_process_id"])] = spec

    steps_in = flow.get("steps") if isinstance(flow.get("steps"), list) else []
    rows = sorted((step for step in steps_in if isinstance(step, dict)),
                  key=lambda step: step.get("position") if type(step.get("position")) is int else 0)
    steps: list[dict[str, Any]] = []
    for step in rows:
        piece_id = step.get("etl_process_id")
        spec = by_id.get(piece_id) if isinstance(piece_id, str) and piece_id else None
        reason: str | None = None
        if spec is None:
            reason = "piece_missing"
        elif stored_source.decision(spec, caller) == "denied":
            reason = "stored_source_disabled" if not settings.stored_source_enabled else "not_approved"
        steps.append({
            "position": step.get("position") if type(step.get("position")) is int else 0,
            "runnable": reason is None,
            "reason": reason,
        })
    return {"flow_id": configuration_id, "available": all(step["runnable"] for step in steps), "steps": steps}


@app.get("/flows/{configuration_id:path}/settings", tags=["Core: Planning"])
async def flow_settings_for_run(configuration_id: str, authorization: str | None = Header(None)):
    """The settings of a stored flow as a runner meets them: the pieces' description
    of each (title, explanation, type, choices, bounds), the value a run starts from,
    whether the author fixed it, and whether it is shown, advanced or hidden. What a
    run would refuse (fixed and hidden settings) is the same resolution plan and submit use.

    Pieces are read with the caller's token; a piece the caller cannot see adds nothing.
    """
    bearer = _bearer(authorization)
    await _require_signed_in(bearer)
    h = get_client(bearer)
    flow = await _load_flow(h, configuration_id)
    if flow is None:
        raise HTTPException(422, detail={
            "code": "FLOW_NOT_FOUND", "flow_id": configuration_id,
            "message": "no such flow: the configuration does not exist or is not a flow"})
    rows = sorted((step for step in flow["steps"] if isinstance(step, dict)),
                  key=lambda step: step.get("position") if type(step.get("position")) is int else 0)
    pieces = await _catalog_pieces(h, [step.get("etl_process_id") for step in rows])
    prefix = f"{configuration_id}{flow_settings.PARAMETER_MARKER}"
    return {
        "flow_id": configuration_id,
        "settings": [
            {**item, "parameter_id": f"{prefix}{item['name']}"}
            for item in flow_settings.resolve(
                flow.get("settings"),
                [_piece_view(pieces[str(step["etl_process_id"])]) if str(step.get("etl_process_id")) in pieces
                 else None for step in rows],
                [step.get("settings") or {} for step in rows],
                refused=_refused_flow_settings())],
        "thread_bound": sorted(flow_settings.thread_bound_names(flow.get("thread_bindings"))),
    }


def _check_pause_builds(plan_json: dict[str, Any], flow_id: str) -> None:
    """Refuse a flow whose pause cannot be run, or whose segments do not build into
    pipelines, now rather than when someone runs it."""
    refused = flow_segments.problem(plan_json)
    if refused:
        raise HTTPException(422, detail={**refused, "flow_id": flow_id})
    clashing = flow_segments.reserved_parameters(plan_json)
    if clashing:
        raise HTTPException(422, detail={
            "code": "FLOW_PARAMETER_RESERVED", "flow_id": flow_id, "parameters": clashing,
            "message": f"a flow that pauses may not have a setting whose name starts with "
                       f"{flow_segments.RESERVED_PREFIX}: the resume uses those names"})
    pause = flow_segments.pause_of(plan_json)
    try:
        tapis.generate_tapis_workflow({
            "id": "check", "plan_json": flow_segments.first_segment(plan_json, pause)})
        declared = next(d for d in flow_segments.editable_outputs(plan_json) if d.get("step") == pause)
        key = declared["editable"].get("key")
        later, _ = flow_segments.second_segment(plan_json, pause, merge_key=key)
        tapis.generate_tapis_workflow({"id": "check", "plan_json": later})
    except step_secrets.StepSecretError:
        raise
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(422, detail={
            "code": "FLOW_DOES_NOT_BUILD", "flow_id": flow_id,
            "message": f"the flow's segments do not build into pipelines: {error}"}) from error


async def _flow_secret_plan(steps: list[dict[str, Any]], caller: str) -> dict[str, Any]:
    """What a flow plan says about the secrets its pieces ask for: each one's name,
    fields and steps, whether the caller has stored it, whether all are, and what
    each step sends to whom. The row's id and version are kept so that submit can
    tell whether the secret changed since. Ids, versions and names only."""
    store = secrets_store.FernetSecretStore(get_client(None))
    listed: list[dict[str, Any]] = []
    versions: dict[str, dict[str, Any]] = {}
    for name, need in step_secrets.needs(steps).items():
        row = await store.find(secrets_store.SCOPE_USER, caller, name, "")
        have = set(secrets_store.text_array(row.get("fields"))) if row else set()
        listed.append({**need, "stored": bool(row) and set(need["fields"]) <= have})
        if row:
            versions[name] = {"id": str(row["id"]), "version": int(row["version"]), "owner": caller}
    return {
        "secrets": listed,
        "secrets_ready": all(item["stored"] for item in listed),
        "sends_data_to": step_secrets.sends_data_summary(steps),
        **({"secret_bindings": versions} if versions else {}),
    }


@app.post("/plans/flow", tags=["Core: Planning"])
async def create_flow_plan(body: FlowPlanIn, authorization: str | None = Header(None)):
    """Plan a flow stored on a model configuration, with a data object for each
    of its inputs. The graph is taken from the flow; nothing is searched for.

    The flow is read with the caller's token and every piece is checked for this
    caller, here and again at submit. A flow grants nothing: it only names pieces.
    """
    bearer = _bearer(authorization)
    caller = await _require_signed_in(bearer)
    h = get_client(bearer)
    flow = await _load_flow(h, body.flow_id)
    if flow is None:
        raise HTTPException(422, detail={
            "code": "FLOW_NOT_FOUND", "flow_id": body.flow_id,
            "message": "no such flow: the configuration does not exist or is not a flow"})

    registry = await _registry(h, plannable=False)
    by_id: dict[str, dict[str, Any]] = {}
    for spec in registry:
        # Only pieces this caller could see in the catalog, whatever the registry
        # read returned: another user's private piece is an empty step here, as it
        # is in /flows/check, and nothing about it is reported.
        if spec.get("visibility") == "private" and spec.get("owner_username") != caller:
            continue
        by_id.setdefault(str(spec.get("id")), spec)
        if spec.get("mint_etl_process_id"):
            by_id[str(spec["mint_etl_process_id"])] = spec

    rows = sorted((step for step in flow["steps"] if isinstance(step, dict)),
                  key=lambda step: step.get("position") if type(step.get("position")) is int else 0)
    specs = [by_id.get(str(step.get("etl_process_id") or "")) for step in rows]

    # Flow inputs in the order the steps first read them. The first is the
    # argument a chain calls source_uri, so a piece written for a chain finds it.
    used: list[str] = []
    for step in rows:
        for wire in step.get("wires") or []:
            source = wire.get("from") if isinstance(wire, dict) else None
            if (isinstance(source, dict) and isinstance(source.get("flow_input"), str)
                    and source["flow_input"] not in used):
                used.append(source["flow_input"])
    collection_gathers = _flow_collections(body, flow, used)
    gathers = dict(collection_gathers)
    region_input, region_text = _flow_region(body.region, used, body.inputs, flow)
    unbound = [input_id for input_id in used
               if input_id not in body.inputs and input_id != region_input and input_id not in gathers]
    if unbound:
        raise HTTPException(422, detail={
            "code": "FLOW_INPUT_NOT_BOUND", "inputs": unbound,
            "message": "the flow needs a data object for each of these inputs"})
    bound: dict[str, dict[str, Any]] = {}
    for input_id in used:
        if input_id == region_input or input_id in gathers:
            continue
        found = await _contract_rows(h, body.inputs[input_id])
        if not found:
            raise HTTPException(404, detail={
                "code": "DATA_OBJECT_NOT_FOUND", "input": input_id, "data_object_id": body.inputs[input_id]})
        bound[input_id] = found[0]

    # An ordinary input bound to a file at an https link is gathered too: the pieces
    # read storage (tapis:// and local paths), not a web link. It becomes a gather of
    # one resource, and its steps read the staged file. A tapis:// data object is read
    # in place, as before; a link the gather task would refuse is left to the step.
    singles = [input_id for input_id in used
               if input_id in bound and _gatherable_https(bound[input_id].get("resource_uri"))]
    wanted = [input_id for input_id in used if input_id in gathers or input_id in singles]
    gathers = {input_id: f"gather-{n}" for n, input_id in enumerate(wanted, start=1)}

    checked = flow_graph.check({
        "inputs": [
            *({"id": input_id, "contract": _data_object_to_contract(row)} for input_id, row in bound.items()),
            # The thread's region is not a registered dataset. It is taken as fitting
            # the input the flow's author marked for it.
            *([{"id": region_input,
                "contract": _marked_input_contract(region_input, rows, specs, "inline:thread-region")}]
              if region_input else []),
            # Files gathered into one input are taken the same way.
            *({"id": input_id,
               "contract": _marked_input_contract(input_id, rows, specs, "inline:flow-collection")}
              for input_id in collection_gathers),
        ],
        "parameters": flow["parameters"],
        "steps": [{
            "position": step.get("position"), "piece": _piece_view(spec) if spec else None,
            "settings": step.get("settings"), "wires": step.get("wires"),
            # With pausing off a pause is not acted on, so it is not checked either.
            "pause_after": settings.flow_pause_enabled and step.get("pause_after") is True,
        } for step, spec in zip(rows, specs)],
        "outputs": (flow["outputs"] if settings.flow_pause_enabled else [
            {key: value for key, value in output.items() if key != "editable"} if isinstance(output, dict)
            else output for output in flow["outputs"]]),
        "thread_bindings": flow["thread_bindings"],
        "settings": flow.get("settings") or {},
    }, refused_settings=_refused_flow_settings())
    if not checked.ok:
        raise HTTPException(422, detail={
            "code": "FLOW_DOES_NOT_CHECK_OUT", "flow_id": body.flow_id,
            "problems": [problem.as_dict() for problem in checked.problems]})
    if any("flow_parameter" in (wire.get("from") or {}) for step in rows for wire in step.get("wires") or []):
        # Arguments are shared by name across a flow's steps, as in a chain, so a
        # flow parameter has nothing to rename yet.
        raise HTTPException(422, detail={
            "code": "FLOW_NOT_SUPPORTED",
            "message": "a link from a flow parameter is not supported yet; "
                       "steps that declare the same setting name already share it"})

    # Fail closed: a piece must never run without the key it declared, so a copy of
    # the piece that is out of date with the catalog is not planned.
    catalog = await _catalog_pieces(h, [step.get("etl_process_id") for step in rows])
    for step, spec in zip(rows, specs):
        found = catalog.get(str(step.get("etl_process_id")))
        if found is not None:
            step_secrets.refuse_stale(str(step["etl_process_id"]), found, spec)

    args = {input_id: "source_uri" if index == 0 else f"source_uri_{index + 1}"
            for index, input_id in enumerate(used)}
    plan_json = build_plan_json(specs)
    defaults: dict[str, Any] = {}
    conflicts: set[str] = set()
    for step_json, step, spec in zip(plan_json["steps"], rows, specs):
        position = int(step["position"])
        view = _piece_view(spec)
        step_json["step"] = position
        step_json["depends_on"] = checked.depends_on[position]
        step_json["wires"] = [
            {"to": wire["to"], "from": (
                {"gather": gathers[wire["from"]["flow_input"]]} if wire["from"].get("flow_input") in gathers
                else {"arg": args[wire["from"]["flow_input"]]} if "flow_input" in wire["from"]
                else wire["from"])}
            for wire in step.get("wires") or []]
        step_json["flow_outputs"] = {
            "outputs": sorted(flow_graph.piece_outputs(view)),
            "values": sorted(flow_graph.piece_values(view)),
            # For a piece that runs as a Tapis app: the file each output is, in the
            # job's archive. An output with none is the archive folder itself.
            "files": {
                str(output_position): contract["schema_requirement_json"]["archived_file"]
                for output_position, contract in flow_graph.piece_outputs(view).items()
                if isinstance(contract.get("schema_requirement_json"), dict)
                and contract["schema_requirement_json"].get("archived_file")},
        }
        if step.get("pause_after"):
            step_json["pause_after"] = True
        for name, value in (step.get("settings") or {}).items():
            if name in defaults and defaults[name] != value:
                conflicts.add(name)
            defaults[name] = value
    if conflicts:
        raise HTTPException(422, detail={
            "code": "FLOW_SETTING_CONFLICT", "settings": sorted(conflicts),
            "message": "two steps give different defaults for a setting they share by name"})

    plan_json = _plan_with_parameters(plan_json)
    by_name = {parameter.get("name"): parameter for parameter in plan_json["parameters"]}
    for name, value in defaults.items():
        if name in by_name:
            # The flow's default, marked as such. A value sent at submit still wins,
            # and the default is used only when the submitter accepts the flow's
            # settings: its author is not the one whose token the piece runs with.
            by_name[name]["default"] = value
            by_name[name]["required"] = False
            by_name[name]["default_source"] = "flow"
    # What the author decided about each setting: who sees it, and whether it is fixed.
    # A fixed setting runs on the author's value (or the piece's own default, when the
    # author gave none); a runner's value for it, or for a hidden one, is refused at submit.
    for item in flow_settings.resolve(
            flow.get("settings"), [_piece_view(spec) if spec else None for spec in specs],
            [step.get("settings") or {} for step in rows], refused=_refused_flow_settings()):
        definition = by_name.get(item["name"])
        if definition is None:
            continue
        definition["visibility"] = item["visibility"]
        if item.get("fixed"):
            definition.update({"fixed": True, "required": False, "default": item.get("default")})
    for input_id, arg in args.items():
        definition = by_name.get(arg)
        if input_id in gathers:
            # Nothing fills this argument: the step reads the gather task's folder.
            if definition is not None:
                definition.update({
                    "required": False, "managed": True, "managed_source": "gather",
                    "description": "Not set by anyone: this input is gathered by the run into its own folder"})
            continue
        if definition is None:
            definition = {"name": arg, "type": "string"}
            plan_json["parameters"].append(definition)
        definition.update({
            "required": False,
            "default": region_text if input_id == region_input else bound[input_id].get("resource_uri"),
            "managed": True,
            "managed_source": "thread_region" if input_id == region_input else "flow_input",
            "description": ("The thread's region, as GeoJSON text" if input_id == region_input
                            else "A dataset the flow takes as an input"),
        })

    flow_collections = [
        ({"input": input_id, "label": body.collections[input_id].label, "gather": gather_id,
          "resources": [{"name": r.name, "url": r.url} for r in body.collections[input_id].resources]}
         if input_id in body.collections else
         # One file: the step reads the staged file, not a folder holding it.
         {"input": input_id, "label": input_id, "gather": gather_id, "single": True,
          "resources": [{"name": "", "url": str(bound[input_id]["resource_uri"])}]})
        for input_id, gather_id in gathers.items()]
    # A flow that pauses keeps its staging folder for the whole run: the edited file
    # is stored there when the run resumes, whether or not the flow gathers anything.
    pausing = settings.flow_pause_enabled and any(step.get("pause_after") for step in rows)
    if flow_collections or pausing:
        # Filled in at submit, never by the caller: the run's own folder in the
        # runner's storage, where the gather tasks put what they copy.
        plan_json["parameters"].append({
            "name": "flow_staging_uri", "type": "string", "required": False, "managed": True,
            "managed_source": "run_folder",
            "description": "The folder this run stages gathered inputs in"})
        output_uri = by_name.get("output_uri")
        if output_uri and output_uri.get("required") and output_uri.get("default") is None:
            # A setting the flow needs and nobody gave: the run's own folder, once
            # there is one (at submit).
            output_uri.update({"required": False, "default_source": "run_folder"})

    opt_in = tuple(body.allow_unapproved_piece_ids)
    problems = stored_source.check_plan(plan_json, registry, caller, opt_in)
    if problems:
        raise HTTPException(403, detail={"code": "STORED_SOURCE_REFUSED", "problems": problems})
    if opt_in:
        plan_json["stored_source_opt_in"] = {"username": caller, "piece_ids": sorted(opt_in)}
    try:
        # Prove the plan builds into a pipeline now, not when someone submits it.
        tapis.generate_tapis_workflow({
            "id": "check", "plan_json": {**plan_json, "flow": {"collections": flow_collections}}})
    except step_secrets.StepSecretError:
        raise
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(422, detail={
            "code": "FLOW_DOES_NOT_BUILD", "flow_id": body.flow_id, "message": str(error)}) from error
    plan_json["flow"] = {
        "configuration_id": flow["configuration_id"],
        "linked_settings": [
            {"step": int(step["position"]), "setting": wire["to"]["setting"], "from": wire["from"]}
            for step in rows for wire in step.get("wires") or [] if "setting" in wire["to"]],
        "inputs": [{"input_id": input_id,
                    **({} if input_id in gathers else {"arg": arg}),
                    **({"region": True} if input_id == region_input
                       else {"collection": gathers[input_id]} if input_id in collection_gathers
                       else {"collection": gathers[input_id], "data_object_id": body.inputs[input_id]}
                       if input_id in gathers
                       else {"data_object_id": body.inputs[input_id]})}
                   for input_id, arg in args.items()],
        "collections": flow_collections,
        "outputs": flow["outputs"],
        "thread_bindings": flow["thread_bindings"],
        "pause_after": [int(step["position"]) for step in rows if step.get("pause_after")],
    }
    if pausing:
        _check_pause_builds(plan_json, body.flow_id)
    plan_json["planned_by"] = caller
    plan_json.update(await _flow_secret_plan(plan_json["steps"], caller))
    created = (await h.execute(INSERT_PLAN, {"obj": {
        "source_data_object_id": next(
            (body.inputs[input_id] for input_id in used
             if input_id != region_input and input_id not in gathers), None),
        "target_model_configuration_id": flow["configuration_id"],
        "status": "draft",
        "plan_json": plan_json,
    }}))["insert_adapter_workflow_plan_one"]
    await h.execute(INSERT_PROVENANCE, {"obj": {
        "event_type": "plan_generated",
        "payload_json": {"plan_id": created["id"], "steps": len(rows), "flow_id": flow["configuration_id"]},
    }})
    return {"status": "transform_required", "plan_id": created["id"], "plan_json": plan_json}


@app.post("/plans/discover", tags=["Core: Planning"])
async def discover_reachable_targets(body: dict[str, Any]):
    """Given a source contract (standard_variable_uri, unit, format), return all
    target contracts reachable via BFS through the transform registry.  Used by
    the UI to populate the target dropdown with only valid conversion options."""
    src = DataObjectContract(
        standard_variable_uri=body.get("standard_variable_uri") or None,
        unit=body.get("unit") or None,
        format=body.get("format") or None,
        # _check_accessibility requires a resource_uri; supply a probe URI so the
        # accessibility dimension doesn't block the BFS for hypothetical sources.
        resource_uri="https://example.com/discover-probe",
    )
    h = get_client(None)
    registry = await _registry(h)
    edge_map = await _load_edge_map(registry)

    # Build candidate targets: all unique output contracts across all specs
    seen: set[tuple[str | None, str | None, str | None]] = set()
    candidates: list[tuple[DataObjectContract, dict[str, Any]]] = []
    for spec in registry:
        for c in (spec.get("contracts") or []):
            if c.get("role") != "output":
                continue
            key = (c.get("standard_variable_uri"), c.get("unit"), c.get("format"))
            if key in seen:
                continue
            seen.add(key)
            candidates.append((
                DataObjectContract(
                    standard_variable_uri=c.get("standard_variable_uri") or None,
                    unit=c.get("unit") or None,
                    format=c.get("format") or None,
                ),
                {"standard_variable_uri": c.get("standard_variable_uri"),
                 "unit": c.get("unit"),
                 "format": c.get("format")},
            ))

    reachable = []
    for tgt_contract, tgt_raw in candidates:
        path = find_path(src, tgt_contract, registry, edge_map=edge_map)
        if path:  # non-empty path means a transform is needed and one was found
            reachable.append(tgt_raw)

    return {"reachable": reachable}


@app.post("/plans/discover-sources", tags=["Core: Planning"])
async def discover_reachable_sources(body: dict[str, Any]):
    """Given a target contract (standard_variable_uri, unit, format), return all
    source contracts that can reach it via reverse BFS through the transform registry.
    Used by the UI's Target→Source mode to show what input data is needed to
    produce a desired output (e.g. a DFC compliance report)."""
    tgt_key = (
        body.get("standard_variable_uri") or "",
        body.get("unit") or "",
        body.get("format") or "",
    )

    h = get_client(None)
    registry = await _registry(h)

    def _ck(c: dict) -> tuple[str, str, str]:
        return (c.get("standard_variable_uri") or "", c.get("unit") or "", c.get("format") or "")

    def _key_satisfied_by(frontier_key: tuple[str, str, str], output_keys: set[tuple[str, str, str]]) -> bool:
        """True if any output key satisfies this frontier key.
        Two format-wildcard rules (both symmetric around 'format: null = any format'):
          1. Frontier key has no format → matches any output with same (svo, unit).
             Allows null-format input contracts (e.g. unit-convert) to accept
             explicitly-formatted outputs (e.g. gma-scalar from budget extract).
          2. Output key has no format → matches any frontier key with same (svo, unit).
             Allows null-format outputs (e.g. unit-convert result) to feed into
             downstream specs that expect an explicit format (e.g. geotiff·ft)."""
        svo, unit, fmt = frontier_key
        for ok in output_keys:
            if ok == frontier_key:
                return True
            if not fmt and ok[0] == svo and ok[1] == unit:
                return True
            if not ok[2] and ok[0] == svo and ok[1] == unit:
                return True
        return False

    # Reverse BFS: frontier holds contract keys we still need to find producers for.
    frontier: set[tuple[str, str, str]] = {tgt_key}
    visited: set[tuple[str, str, str]] = set()
    seen_source_keys: set[tuple[str, str, str]] = set()
    reachable: list[dict[str, Any]] = []

    while True:
        new_keys = frontier - visited
        if not new_keys:
            break
        visited |= new_keys
        next_frontier: set[tuple[str, str, str]] = set()

        for spec in registry:
            contracts = spec.get("contracts") or []
            outputs = [c for c in contracts if c.get("role") == "output"]
            inputs  = [c for c in contracts if c.get("role") == "input"]
            output_keys = {_ck(o) for o in outputs}
            if not any(_key_satisfied_by(nk, output_keys) for nk in new_keys):
                continue
            for inp in inputs:
                k = _ck(inp)
                if k not in visited:
                    next_frontier.add(k)
                if k not in seen_source_keys:
                    seen_source_keys.add(k)
                    reachable.append({
                        "standard_variable_uri": inp.get("standard_variable_uri"),
                        "unit": inp.get("unit"),
                        "format": inp.get("format"),
                    })

        frontier = next_frontier

    # Verify each candidate with find_path to match the forward-BFS guarantee:
    # only show sources where an actual plan exists. Candidates without a
    # resource_uri get a probe URI so the accessibility check doesn't block them.
    tgt_contract = DataObjectContract(
        standard_variable_uri=tgt_key[0] or None,
        unit=tgt_key[1] or None,
        format=tgt_key[2] or None,
        resource_uri="https://example.com/discover-probe",
    )
    edge_map = await _load_edge_map(registry)
    verified: list[dict[str, Any]] = []
    seen_verified: set[tuple[str, str, str]] = set()
    for r in reachable:
        k = (r.get("standard_variable_uri") or "", r.get("unit") or "", r.get("format") or "")
        if k in seen_verified:
            continue
        candidate = DataObjectContract(
            standard_variable_uri=r.get("standard_variable_uri") or None,
            unit=r.get("unit") or None,
            format=r.get("format") or None,
            resource_uri="https://example.com/discover-probe",
        )
        path = find_path(candidate, tgt_contract, registry, edge_map=edge_map)
        if path is not None and len(path) > 0:
            seen_verified.add(k)
            verified.append(r)

    return {"reachable": verified}


@app.get("/data-objects", tags=["Core: Registry"])
async def list_data_objects(authorization: str | None = Header(None)):
    """The caller's own registered data objects — id, label, and each variable's
    standard_variable_uri + unit/format. Objects registered before owners were
    recorded have none, and are listed for no user."""
    token = _bearer(authorization)
    owner = await _caller_or_demo(token)
    h = get_client(token)
    if owner is None:  # the local demo, signed out
        return await _discoverable_objects(h)
    return (await h.execute(LIST_OWN_DATA_OBJECTS_QUERY, {"owner": owner}))["adapter_data_object"]


# ── MINT Data Catalog compatibility layer ─────────────────────────────────────
# The MINT UI calls POST /datasets/find and POST /datasets/dataset_resources.
# Results are grouped by CKAN package (source_catalog = "ckan:{pkg_name}") so
# the UI shows one selectable entry per dataset/package rather than one per file.

_FIND_DATA_OBJECTS_QUERY = """
query FindDataObjects($uris: [String!]!) {
  adapter_data_object(
    where: {
      _and: [
        {variables: {standard_variable_uri: {_in: $uris}}}
        {source_catalog: {_like: "ckan%"}}
      ]
    }
    order_by: {source_catalog: asc, label: asc}
  ) {
    id label resource_uri format source_catalog description
    variables { standard_variable_uri local_name }
  }
}
"""

_GET_PACKAGE_OBJECTS_QUERY = """
query GetPackageObjects($catalog: String!) {
  adapter_data_object(
    where: {source_catalog: {_eq: $catalog}}
    order_by: {label: asc}
  ) {
    id label resource_uri format description
  }
}
"""


class _DatasetsFindBody(BaseModel):
    standard_variable_names__in: list[str] = []
    spatial_coverage__intersects: Any = None
    start_time__gte: str | None = None
    end_time__lte: str | None = None
    limit: int = 1000


class _DatasetResourcesBody(BaseModel):
    dataset_id: str
    filter: dict = {}
    limit: int = 5000


@app.post("/datasets/find", tags=["Core: Catalog/objectives"])
async def datasets_find(body: _DatasetsFindBody, authorization: str | None = Header(None)):
    """MINT Data Catalog-compatible /datasets/find.

    Converts short SVO variable names to full URIs, queries local
    adapter_data_object rows, and groups results by CKAN package.  Each
    package becomes one "dataset" entry so the UI shows one option per
    dataset rather than one per individual file.
    """
    from .ckan_sync import STDVAR_TO_SVO, SVO_NS

    if not body.standard_variable_names__in:
        return {"result": "success", "datasets": []}

    # Convert short names → full SVO URIs (fall back to direct URI construction).
    uris = []
    for name in body.standard_variable_names__in:
        uri = STDVAR_TO_SVO.get(name.lower()) or f"{SVO_NS}{name}"
        uris.append(uri)

    h = get_client(_bearer(authorization))
    data = await h.execute(_FIND_DATA_OBJECTS_QUERY, {"uris": uris})
    objects = data.get("adapter_data_object") or []

    # Group by source_catalog (= "ckan:{pkg_name}" for synced CKAN resources,
    # or plain "ckan" for older records without a package name).
    packages: dict[str, dict[str, Any]] = {}
    for obj in objects:
        cat = obj.get("source_catalog") or "ckan"
        if cat not in packages:
            # Package display name: description field holds the CKAN package title
            # (set by the updated ckan_sync), or fall back to the catalog slug.
            pkg_title = obj.get("description") or cat.replace("ckan:", "").replace("-", " ").title()
            packages[cat] = {
                "catalog": cat,
                "title": pkg_title,
                "objects": [],
                "var_labels": set(),
            }
        packages[cat]["objects"].append(obj)
        for v in (obj.get("variables") or []):
            lbl = v.get("local_name") or v["standard_variable_uri"].rsplit("/", 1)[-1]
            packages[cat]["var_labels"].add(lbl)

    datasets = []
    for cat, pkg in list(packages.items())[: body.limit]:
        datasets.append({
            "dataset_id": cat,
            "dataset_name": pkg["title"],
            "dataset_metadata": {
                "datatype": "",
                "dataset_description": pkg["title"],
                "source": "ckan",
                "category_tags": sorted(pkg["var_labels"]),
                "resource_count": len(pkg["objects"]),
            },
        })

    return {"result": "success", "datasets": datasets}


@app.post("/datasets/dataset_resources", tags=["Core: Catalog/objectives"])
async def datasets_resources(
    body: _DatasetResourcesBody, authorization: str | None = Header(None)
):
    """MINT Data Catalog-compatible /datasets/dataset_resources.

    dataset_id is a source_catalog value ("ckan:{pkg_name}").  Returns all
    adapter_data_object rows for that package as individual resources.
    """
    h = get_client(_bearer(authorization))
    data = await h.execute(_GET_PACKAGE_OBJECTS_QUERY, {"catalog": body.dataset_id})
    rows = (data.get("adapter_data_object") or [])[: body.limit]
    if not rows:
        return {"resources": []}

    resources = [
        {
            "resource_id": obj["id"],
            "resource_name": obj["label"],
            "resource_metadata": {
                "resource_data_url": obj.get("resource_uri") or "",
                "datatype": obj.get("format") or "",
                "description": obj.get("description") or "",
            },
        }
        for obj in rows
    ]
    return {"resources": resources}


@app.get("/standard-variables", tags=["Core: Registry"])
async def list_standard_variables(authorization: str | None = Header(None)):
    """Distinct SVO standard variables the adapter knows — gathered from the
    transform registry's contracts + registered data objects. Drives the
    'want this SVO output' picker."""
    h = get_client(_bearer(authorization))
    specs = await _registry(h)
    objs = await _discoverable_objects(h)
    seen: dict[str, dict[str, Any]] = {}
    for s in specs:
        for c in s.get("contracts", []):
            uri = c.get("standard_variable_uri")
            if uri and uri not in seen:
                seen[uri] = {"uri": uri, "name": uri.rsplit("/", 1)[-1],
                             "display": humanize_svo(uri), "produced_by": [], "consumed_by": []}
            if uri:
                (seen[uri]["produced_by"] if c.get("role") == "output" else seen[uri]["consumed_by"]).append(s.get("name"))
    for o in objs:
        for v in o.get("variables", []):
            uri = v.get("standard_variable_uri")
            if uri and uri not in seen:
                seen[uri] = {"uri": uri, "name": uri.rsplit("/", 1)[-1],
                             "display": humanize_svo(uri), "produced_by": [], "consumed_by": []}
    return sorted(seen.values(), key=lambda x: x["display"])


@app.get("/qaqc/modflow6", tags=["DFC/GAM"])
async def modflow6_qaqc(authorization: str | None = Header(None)):
    """QA/QC report for the NTGAM MODFLOW 6 SVO adapter path.

    Checks CKAN resource-level SVO coverage, expected transform registration,
    and whether adapter source data objects exist for the model-run inputs.
    """
    h = get_client(_bearer(authorization))
    registry = None
    registry_error = None
    data_objects = None
    data_objects_error = None
    try:
        registry = await _registry(h)
    except Exception as exc:  # noqa: BLE001 - report dependency failure
        registry_error = f"{type(exc).__name__}: {exc}"
    try:
        data_objects = await _discoverable_objects(h)
    except Exception as exc:  # noqa: BLE001 - report dependency failure
        data_objects_error = f"{type(exc).__name__}: {exc}"
    return await qaqc.modflow6_report(
        registry=registry,
        registry_error=registry_error,
        data_objects=data_objects,
        data_objects_error=data_objects_error,
    )


@app.post("/qaqc/modflow6/tapis", tags=["DFC/GAM"])
async def modflow6_qaqc_tapis(body: dict[str, Any] | None = None,
                              authorization: str | None = Header(None)):
    """Generate or submit the MODFLOW 6 QA/QC test as a Tapis Workflows run.

    The remote task queries CKAN from Tapis and validates the adapter registry
    snapshot supplied in the run args. Set {"dry_run": true} to inspect the
    pipeline without submitting.
    """
    body = body or {}
    token = _bearer(authorization) or body.get("tapis_token")
    h = get_client(_bearer(authorization))
    registry = await _registry(h)
    data_objects = await _discoverable_objects(h)
    context = qaqc.tapis_context(registry=registry, data_objects=data_objects)
    pipeline_id = body.get("pipeline_id") or f"modflow6-svo-qaqc-{context['config']['name']}"
    pipeline = qaqc.build_tapis_pipeline(pipeline_id)
    args = qaqc.tapis_args(context)

    if body.get("dry_run", True):
        return {
            "status": "generated",
            "pipeline_id": pipeline_id,
            "tapis_workflow_definition": pipeline,
            "args": args,
        }
    if not token:
        raise HTTPException(401, "log in with a Tapis token to submit remote QA/QC")
    try:
        result = await run_in_threadpool(
            tapis.submit_tapis_workflow,
            pipeline,
            args,
            token=token,
            run_name=body.get("run_name") or f"{pipeline_id}-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}",
            recreate=bool(body.get("recreate", True)),
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Tapis Workflows QA/QC submission failed: {exc}")
    return {"status": "submitted", "pipeline_id": pipeline_id, **result}


@app.get("/qaqc/modflow6/tapis/{run_uuid}", tags=["DFC/GAM"])
async def modflow6_qaqc_tapis_detail(
    run_uuid: str,
    pipeline_id: str = Query("modflow6-svo-qaqc-ntgam-v301"),
    authorization: str | None = Header(None),
):
    token = _bearer(authorization)
    if not token:
        raise HTTPException(401, "log in with a Tapis token to inspect remote QA/QC")
    try:
        return await run_in_threadpool(tapis.get_run_detail, pipeline_id, run_uuid, token=token)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"could not fetch QA/QC run: {exc}")


@app.get("/reachable/{data_object_id}", tags=["Core: Planning"])
async def reachable(data_object_id: str, authorization: str | None = Header(None)):
    """The SVO standard variables reachable FROM this source via the registry
    (single-input transform chains), each with the shortest chain. Drives a
    source-aware target picker so the UI only offers achievable outputs."""
    h = get_client(_bearer(authorization))
    rows = await _contract_rows(h, data_object_id)
    if not rows:
        raise HTTPException(404, "data object not found")
    src = _data_object_to_contract(rows[0])
    registry = await _registry(h)
    reach = reachable_variables(src, registry)
    out = []
    for r in reach:
        uri = r["standard_variable_uri"]
        quals = " · ".join(x for x in (r.get("unit"), r.get("format")) if x)
        label = humanize_svo(uri) + (f" [{quals}]" if quals else "")
        out.append({
            "uri": uri, "name": uri.rsplit("/", 1)[-1], "display": label,
            "unit": r.get("unit"), "format": r.get("format"),
            "chain": [s.get("name") for s in r["path"]], "steps": len(r["path"]),
            "identity": len(r["path"]) == 0,
        })
    return sorted(out, key=lambda x: (x["display"], x["steps"]))


@app.post("/plans/model-run", tags=["Core: Planning"])
async def plan_model_run_endpoint(body: ModelRunIn, authorization: str | None = Header(None)):
    """Plan a full ETL DAG that resolves EVERY input of a multi-input model from
    the registered data objects and runs it (e.g. the SUBSIDE forecast). Returns
    the per-input resolution + the converging plan_json, and whether it's complete."""
    h = get_client(_bearer(authorization))
    registry = await _registry(h)
    run_spec = next((t for t in registry if t.get("id") == body.run_spec_id), None)
    if run_spec is None:
        raise HTTPException(404, f"run spec '{body.run_spec_id}' not found")

    rows = await _discoverable_objects(h)
    if body.source_ids:
        wanted = set(body.source_ids)
        rows = [r for r in rows if r["id"] in wanted]
    sources = [_data_object_to_contract(r) for r in rows]

    edge_map = await _load_edge_map(registry)
    plan = plan_model_run(run_spec, sources, registry, edge_map=edge_map)
    dag = _plan_with_parameters(build_model_run_plan_json(plan))
    branches = [
        {
            "standard_variable": (b.get("standard_variable_uri") or "").rsplit("/", 1)[-1],
            "satisfied": b["source"] is not None,
            "source": getattr(b["source"], "resource_uri", None) if b["source"] else None,
            "chain": [s["name"] for s in (b["path"] or [])],
        }
        for b in plan["branches"]
    ]
    return {"run_spec": run_spec.get("name"), "complete": plan["complete"],
            "branches": branches, "plan_json": dag}


@app.post("/workflows/generate", tags=["Core: Workflows"])
async def generate_workflow(body: GenerateWorkflowIn, authorization: str | None = Header(None)):
    h = get_client(_bearer(authorization))
    plan = (await h.execute(GET_PLAN, {"id": body.plan_id}))["adapter_workflow_plan_by_pk"]
    if not plan:
        raise HTTPException(404, "plan not found")
    definition = tapis.generate_tapis_workflow(plan)
    await h.execute(UPDATE_PLAN_WORKFLOW_DEF, {"id": body.plan_id, "def": definition})
    return {"plan_id": body.plan_id, "tapis_workflow_definition": definition}


def _wrap_args(args: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Accept both SUBSIDE-style {"k": {"value": v}} and plain {"k": v}."""
    out: dict[str, dict[str, Any]] = {}
    for key, val in (args or {}).items():
        out[key] = val if isinstance(val, dict) and "value" in val else {"value": val}
    return out


def _public_workflow_args(args: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Remove server-injected credentials from workflow responses."""
    return {key: value for key, value in args.items()
            if key not in {"tapis_token", "signal_token", "token_fetch_token"}
            and not str(key).startswith(step_secrets.TOKEN_ARG_PREFIX)}


async def _resolve_run_secrets(h, body, token: str | None) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """Resolve a composite run's declared secrets (app/secrets.py), before the
    run row or token exists so a rejection queues nothing.

    Returns ``(dry_run_report, bound_secrets)``. A dry run reports ``bound`` and
    ``missing`` names and never decrypts or raises on a missing secret.
    """
    task = body.model_task
    configuration_id = (task or {}).get("configuration_id")
    if task is None or not configuration_id:
        if task is not None:
            log.warning("composite submit without configuration_id: secret resolution skipped")
        if task is not None and task.get("required_secrets"):
            raise HTTPException(422, detail={
                "code": "SECRET_DECLARATION_MISMATCH",
                "message": "required_secrets needs the model_task configuration_id"})
        return None, []
    try:
        configuration = await secrets_store.fetch_configuration(h, str(configuration_id))
        declarations = secrets_store.parse_declarations(configuration)
        secrets_store.check_required_hint(task.get("required_secrets"), declarations)
        if not declarations:
            return ({"bound": [], "missing": []} if body.dry_run else None), []
        if not body.dry_run:
            if not run_state.signals_configured():
                raise secrets_store.SecretResolutionError(503, {
                    "code": "SIGNALS_REQUIRED",
                    "message": "this model needs credentials, which are delivered through run signals"})
            if not secrets_store.secrets_configured():
                raise secrets_store.SecretResolutionError(503, {
                    "code": "SECRETS_NOT_CONFIGURED",
                    "message": "the secrets store has no encryption key configured"})
        resolution = await secrets_store.resolve(
            secrets_store.FernetSecretStore(h), configuration, declarations,
            task.get("job_definition") or {})
        if body.dry_run:
            missing = [m["name"] for m in resolution.missing] + [
                r["name"] for r in resolution.mismatched] + list(resolution.incomplete)
            return {"bound": [b["name"] for b in resolution.bound], "missing": missing}, []
        if resolution.mismatched:
            actor = await run_in_threadpool(tapis.userinfo_username, token) if token else "unknown"
            for row in resolution.mismatched:
                await secrets_store.record_event(h, "mismatch", row, actor=actor or "unknown")
        resolution.raise_if_failed()
    except secrets_store.SecretResolutionError as exc:
        raise HTTPException(exc.status, detail=exc.detail)
    return None, resolution.bound


def _composite_task_contains_secret(value: Any) -> bool:
    """Reject credentials in coordinator-owned composite task descriptors."""
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).lower() in {"tapis_token", "authorization", "x-tapis-token",
                                    "credentials_url", "signal_token", "token_fetch_token"}:
                if item not in (None, "", {}, []):
                    return True
            if _composite_task_contains_secret(item):
                return True
        return False
    if isinstance(value, list):
        return any(_composite_task_contains_secret(item) for item in value)
    return isinstance(value, str) and bool(re.search(r"\bbearer\s+", value, flags=re.IGNORECASE))


_RESERVED_INPUT_ARGS = re.compile(r"^(in\d+_.*|input_staging_dir)$")
_EXECUTION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def _input_source_arg(source: dict[str, Any]) -> str:
    """The `in<k>_source` arg text: the normalized source object as compact JSON."""
    return json.dumps(source, sort_keys=True, separators=(",", ":"))


# Transform types a run may execute as an input-side ETL step.
INPUT_STEP_TRANSFORM_TYPES = input_plan.INPUT_STEP_TRANSFORM_TYPES


async def _scratch_root(token: str | None, system: str) -> str | None:
    """The caller's scratch root on ``system``, or None when it cannot be found."""
    username = await run_in_threadpool(tapis.userinfo_username, token) if token else None
    return (await run_in_threadpool(tapis.resolve_scratch_root, token, username, system)
            if token and username else None)


async def _resolve_flow_staging(token: str | None, run_id: str) -> str:
    """Where this run of a flow stages what its gather tasks copy:
    ``tapis://<exec system>/<scratch root>/dynamo-runs/<run id>``, or 422."""
    system = settings.tapis_exec_system
    root = await _scratch_root(token, system)
    if not root or not _EXECUTION_ID_RE.match(run_id):
        raise HTTPException(422, detail={
            "code": "FLOW_STAGING_UNRESOLVED",
            "message": f"could not find your scratch folder on {system}: run any job there once"})
    return f"tapis://{system}/{root.strip('/')}/dynamo-runs/{run_id}"


async def _resolve_input_staging(
    input_steps: list[dict[str, Any]], model_task: dict[str, Any], token: str | None,
    execution_id: str,
) -> str:
    """The run's scratch staging directory on the job's execution system, or 422."""
    system = str((model_task.get("job_definition") or {}).get("execSystemId") or "")
    inputs = ", ".join(item["app_input_name"] for item in input_steps)
    unresolved = lambda message: HTTPException(422, detail={  # noqa: E731
        "code": "INPUT_STAGING_UNRESOLVED", "message": message})
    if not system:
        raise unresolved(f"the model job definition has no execSystemId to stage {inputs} on")
    if not _EXECUTION_ID_RE.match(execution_id):
        raise unresolved("execution_id is not safe to use in a staging path")
    root = await _scratch_root(token, system)
    if not root:
        raise unresolved(f"could not find your scratch directory on {system}: run any job on "
                         f"{system} once, or bind a dataset to {inputs}")
    return f"{root}/dynamo-runs/{execution_id}/inputs"


def _arg_given(args: dict[str, Any], name: str) -> bool:
    """Whether a submission carries a value for ``name`` (plain or ``{value: ...}``)."""
    value = normalize_args(_wrap_args(args or {})).get(name, {}).get("value")
    return value not in (None, "")


def _resolve_bound_plan_id(plan_id: str) -> tuple[str, str | None]:
    """Resolve the opaque deferred binding token to its stored plan id."""
    if not plan_id.startswith("bound:"):
        return plan_id, None
    parts = plan_id.split(":")
    if len(parts) != 3 or not parts[1] or not parts[2]:
        raise HTTPException(404, "bound plan not found")
    return parts[1], plan_id


GET_PARENT_RUNS = """
query GetParentRuns($execution_id: String!) {
  adapter_workflow_run(where: {execution_id: {_eq: $execution_id}}, order_by: {created_at: asc}) {
    id submitted_by model_job_name
  }
}
"""


async def _enforce_run_owner(execution_id: str | None, token: str | None) -> None:
    """A bound post-model submission runs as the user who submitted the parent run.

    Whoever's poll observed the model finish may dispatch it, so the adapter
    refuses any other caller before it writes a row. It fails closed: a parent it
    cannot find, or one with no recorded owner, is a refusal. The lookup uses the
    adapter's own client so row-level permissions cannot hide the parent and let
    the check pass. Without an execution_id there is no parent to look up; that
    case is refused for publish plans by _validate_deferred_execution_id.
    """
    if not execution_id:
        return
    rows = (await get_client(None).execute(
        GET_PARENT_RUNS, {"execution_id": execution_id})).get("adapter_workflow_run") or []
    if not rows:
        raise HTTPException(409, detail={
            "code": "PARENT_RUN_UNKNOWN",
            "message": "no parent run is recorded for this execution; it cannot be dispatched",
        })
    owner = rows[0].get("submitted_by")
    caller = None
    if owner and token:
        caller = await run_in_threadpool(tapis.userinfo_username, token) if token else None
    if not owner or caller != owner:
        raise HTTPException(403, detail={
            "code": "RUN_OWNER_MISMATCH",
            "message": "this post-model step runs as the user who submitted the run; "
                       "it is dispatched on that user's next poll",
        })


def _bind_publish_args(
    service_args: dict[str, Any], execution_id: str | None, plan_json: dict[str, Any],
) -> None:
    """Validate a publish step's user values and bind its managed arguments.

    Managed values come from settings and the run and replace anything the
    caller sent; the collection and organisation are checked against the
    allow-lists now, because a stored plan's values are immutable but args are not.
    """
    if not execution_id:
        raise HTTPException(422, detail={
            "code": "PUBLISH_EXECUTION_ID_REQUIRED",
            "message": "a publish step needs the execution_id of the run it publishes",
        })
    supplied = normalize_args(_wrap_args(service_args))
    # An absent value falls back to the plan's default (else the configured one);
    # that effective value is checked too, since the stored default may be stale.
    defaults = {d.get("name"): d.get("default") for d in plan_json.get("parameters") or []}
    fallback = {"stac_collection": settings.publish_default_collection,
                "ckan_org": settings.publish_default_org}
    _reject_publish_values({
        name: (supplied.get(name) or {}).get("value") or defaults.get(name) or fallback[name]
        for name in ("stac_collection", "ckan_org")})
    managed = set(tapis.PUBLISH_MANAGED_ARGS)
    for key in [k for k in service_args if (canonical_key(str(k)) or str(k)) in managed]:
        del service_args[key]
    service_args["tapis_base_url"] = settings.tapis_base_url
    service_args["stac_url"] = settings.stac_api_url
    service_args["ckan_url"] = settings.publish_ckan_url
    service_args["stac_item_id"] = execution_id
    service_args["execution_id"] = execution_id
    service_args["catalogs"] = _plan_catalogs(plan_json)


def _plan_catalogs(plan_json: dict[str, Any]) -> str:
    """The catalogs a publish plan's target asks for, as the task reads them
    (``ckan+stac``). A plan from before the choice existed gets every catalog
    the piece writes, which is what it did then."""
    target = plan_json.get("target_contract") or {}
    requested = _catalogs(target.get("catalog") if isinstance(target, dict) else None)
    if not requested:
        requested = {tapis.PUBLISH_REQUIRED_CATALOG, *tapis.PUBLISH_OPTIONAL_CATALOGS}
    return "+".join(sorted(requested))


def _validate_deferred_execution_id(
    bound_plan_id: str | None,
    request_execution_id: str | None,
    service_args: dict[str, Any],
) -> None:
    """Require one consistent coordinator execution ID for bound plans."""
    if not bound_plan_id:
        return
    normalized = normalize_args(_wrap_args(service_args))
    argument_execution_id = normalized.get("execution_id", {}).get("value")
    if not request_execution_id or not argument_execution_id:
        raise HTTPException(422, detail={
            "code": "DEFERRED_EXECUTION_ID_REQUIRED",
            "message": "deferred workflow submission requires execution_id in request metadata and args",
        })
    if request_execution_id != argument_execution_id:
        raise HTTPException(409, detail={
            "code": "DEFERRED_EXECUTION_ID_MISMATCH",
            "message": "request execution_id must match args.execution_id",
        })


async def _with_run_token(args: dict[str, Any], caller_token: str | None) -> dict[str, Any]:
    """Swap the caller's token arg for a bounded per-run token (when enabled)."""
    try:
        return await run_in_threadpool(run_tokens.apply_run_token, args, caller_token)
    except run_tokens.RunTokenError as exc:
        raise HTTPException(502, detail={
            "code": "RUN_TOKEN_MINT_FAILED",
            "message": safe_error_message(exc),
        })


def _validate_plan_args(
    plan_json: dict[str, Any],
    args: dict[str, Any],
    authorization_token: str | None,
    require_required: bool = True,
) -> dict[str, dict[str, Any]]:
    """Validate submission values against the immutable plan snapshot.

    The adapter accepts legacy plain values and SUBSIDE-style ``{value: ...}``
    values, but validation always runs on the normalized representation.  The
    caller token is an execution credential, not a user-entered plan
    parameter, so it is injected after the user argument allowlist is checked.
    """
    normalized = normalize_args(_wrap_args(args))
    definitions = plan_json.get("parameters") or []
    allowed = accepted_aliases(str(d.get("name")) for d in definitions if d.get("name"))
    # The immutable plan contract only records parameters used by its transform
    # steps, while the generated Tapis workflow also declares pipeline-wide
    # runtime parameters (dates, AOI, allocation, publishing options, etc.).
    # Those values are supplied at submission time and must be accepted even
    # when a particular deferred plan does not consume them directly.
    allowed.update(accepted_aliases(tapis.STANDARD_PARAMS))
    allowed.add("tapis_token")
    if tapis.plan_publishes(plan_json.get("steps") or []):
        # A publish step's arguments are bound by the adapter itself
        # (_bind_publish_args) and declared on the generated pipeline even when
        # the stored plan predates one of them (catalogs, 2026-11-05); a plan
        # must not refuse the values the adapter just bound to it.
        allowed.update(accepted_aliases(tapis.publish_params()))
    if plan_json.get("model_task") or "execution_id" in normalized or "source_uri" in normalized:
        # These are coordinator-owned values for a composite model stage, not
        # user-entered adapter parameters.  Deferred post-model workflows also
        # receive execution_id in their submission args, while their bound
        # plan does not carry the composite model_task descriptor.
        allowed.update({"execution_id", "source_uri"})
    input_steps = (plan_json.get("model_task") or {}).get("input_steps")
    if input_steps:
        allowed.update(tapis.input_stage_arg_names(input_steps))
        allowed.add("input_staging_dir")
    unknown = sorted(set(normalized) - allowed)
    if unknown:
        raise HTTPException(
            422,
            detail={"code": "UNKNOWN_PARAMETERS", "parameters": unknown},
        )

    errors: dict[str, str] = {}
    for definition in definitions:
        name = str(definition.get("name"))
        if not name:
            continue
        if plan_json.get("model_task") and name == "source_uri":
            # The model stage produces this value inside the same workflow;
            # accepting a client-supplied placeholder would reintroduce the
            # output-discovery race this composite path is designed to avoid.
            continue
        canonical_name = canonical_key(name) or name
        if name == "dfc_area_boundary_uri":
            # DFC ETLs may require a second, semantically distinct boundary.
            # Do not let the primary canonical geometry URI satisfy it.
            canonical_name = name
        value = normalized.get(canonical_name, {}).get("value")
        if value is None or value == "":
            if definition.get("default") is not None:
                normalized[name] = {"value": definition["default"]}
            elif require_required and definition.get("required"):
                errors[name] = "required"
            continue

        expected = definition.get("type", "string")
        if expected in {"number", "integer", "int", "float"}:
            try:
                number = float(value)
                if expected in {"integer", "int"} and number != int(number):
                    raise ValueError
                if definition.get("minimum") is not None and number < float(definition["minimum"]):
                    errors[name] = f"must be >= {definition['minimum']}"
                if definition.get("maximum") is not None and number > float(definition["maximum"]):
                    errors[name] = f"must be <= {definition['maximum']}"
            except (TypeError, ValueError):
                errors[name] = f"must be {expected}"
        elif expected == "boolean" and not isinstance(value, bool):
            errors[name] = "must be boolean"

        allowed_values = definition.get("allowed_values")
        if allowed_values and value not in allowed_values:
            errors[name] = f"must be one of {', '.join(map(str, allowed_values))}"

    if require_required and not authorization_token:
        raise HTTPException(401, "provide a Tapis bearer token or set SVO_ADAPTER_TAPIS_TOKEN")
    if authorization_token:
        normalized["tapis_token"] = {"value": authorization_token}
    if errors:
        raise HTTPException(
            422,
            detail={"code": "INVALID_PARAMETERS", "parameters": errors},
        )
    return normalized


# Who may be handed a runner's secret: reviewed built-in code, a piece an admin
# approved as it is, or the runner's own piece. Never an opted-in unapproved piece.
_SECRET_TRUSTED = frozenset({"builtin", "approved", "own"})


def _step_untrusted(step: dict[str, Any], spec: dict[str, Any] | None, username: str | None) -> bool:
    """Whether a step is something other than built-in code, an approved piece, or
    the runner's own piece. Every step holds the runner's Tapis token (an app step
    receives it as TAPIS_TOKEN and its env arguments as well), so an app piece is held
    to the same rule: it counts only when it is the runner's own, or a seeded piece
    with no owner and no catalog author."""
    if step.get("python_source"):
        return spec is None or stored_source.decision(spec, username, ()) not in _SECRET_TRUSTED
    if step.get("tapis_app_id"):
        if spec is None:
            return True
        owner = spec.get("owner_username")
        return not ((owner and owner == username) or (not owner and not spec.get("mint_etl_process_id")))
    return False


def _untrusted_step(plan_json: dict[str, Any], registry: list[dict[str, Any]],
                    username: str | None) -> dict[str, Any] | None:
    """The first step of a plan that is not trusted with a runner's secret, if any."""
    by_id = {spec.get("id"): spec for spec in registry}
    return next((step for step in plan_json.get("steps") or []
                 if _step_untrusted(step, by_id.get(step.get("transform_spec_id")), username)), None)


def _check_secret_run_trust(plan_json: dict[str, Any], registry: list[dict[str, Any]],
                            username: str | None) -> None:
    """A run that binds any secret must consist only of trusted steps, because every
    step holds the runner's Tapis token and could otherwise ask for another step's
    secret (design section 3). Opt-in is never allowed here."""
    bad = _untrusted_step(plan_json, registry, username)
    if bad is not None:
        raise HTTPException(403, detail={
            "code": "SECRET_PIECE_NOT_TRUSTED", "step": bad.get("step"),
            "message": "a run that uses your secrets may contain only built-in pieces, approved "
                       "pieces and your own pieces; this step is none of those"})
    by_id = {spec.get("id"): spec for spec in registry}
    for step in step_secrets.secret_steps(plan_json):
        declared = step_secrets.declared_secrets(by_id[step.get("transform_spec_id")])
        if declared != step["secrets"]:
            raise HTTPException(409, detail={
                "code": "STEP_SECRET_DECLARATION_CHANGED", "step": step.get("step"),
                "message": "the piece declares different secrets than when the plan was made; plan again"})


async def _check_run_conflict(
    h: Any, username: str, registry: list[dict[str, Any]], *, this_run: str | None,
    secrets_here: bool, untrusted_here: bool, token: str | None = None,
) -> None:
    """Run arguments are taken to be readable by the run's owner, and an untrusted
    piece runs with the owner's token. So while the user has a run holding unissued
    secret credentials, none of their other active runs may hold an untrusted step,
    and the reverse. Refused with 409 SECRET_RUN_CONFLICT; finish or cancel the other
    run. (A run that starts between this check and the other's is not caught: a
    residual race, see docs/api.md.)

    A run stored as active may have finished in Tapis long ago, so when the caller's
    ``token`` is given their open runs are reconciled first (bounded:
    poller.reconcile_open_runs, as _guard_secret_change does) and only those Tapis still
    reports active conflict. A run that cannot be checked stays open and conflicts: this
    never fails open. Without a token (the step-credential fetch) the stored status is used."""
    runs = (await h.execute(USER_ACTIVE_RUNS, {"user": username}))["adapter_workflow_run"]
    if token and any(run["id"] != this_run for run in runs):
        from . import poller  # noqa: PLC0415 — deferred, as in lifespan
        await poller.reconcile_open_runs(h, [run for run in runs if run["id"] != this_run], token)
        runs = (await h.execute(USER_ACTIVE_RUNS, {"user": username}))["adapter_workflow_run"]
    for other in runs:
        if other["id"] == this_run:
            continue
        if untrusted_here and any(
                not entry.get("issued") for entry in step_secrets.bound_steps(other.get("bound_secrets")) or []):
            raise HTTPException(409, detail={
                "code": "SECRET_RUN_CONFLICT",
                "message": "another of your runs is still holding secrets for its steps; "
                           "wait for it to finish or cancel it"})
        if secrets_here:
            plan = (await h.execute(GET_PLAN, {"id": other.get("workflow_plan_id")}))["adapter_workflow_plan_by_pk"]
            if _untrusted_step((plan or {}).get("plan_json") or {}, registry, username) is not None:
                raise HTTPException(409, detail={
                    "code": "SECRET_RUN_CONFLICT",
                    "message": "another of your runs contains a piece that is not trusted with your "
                               "secrets; wait for it to finish or cancel it"})


async def _resolve_flow_secrets(
    h: Any, plan_json: dict[str, Any], registry: list[dict[str, Any]], submitter: str | None,
    *, has_model_task: bool, dry_run: bool,
) -> list[dict[str, Any]]:
    """Bind the submitter's own secrets to the steps of a flow run, before any run row
    or credential exists so that a refusal queues nothing. Returns the step entries
    for the run's ``bound_secrets``: ids, versions, names and env maps, never a value."""
    steps = step_secrets.secret_steps(plan_json)
    if not steps:
        return []
    if has_model_task:
        raise step_secrets.StepSecretError(422, {
            "code": "SECRET_PIECE_UNSUPPORTED", "step": steps[0].get("step"),
            "reason": "a composite model run cannot also give a flow step a secret",
            "message": "a composite model run cannot also give a flow step a secret"})
    for step in steps:
        step_secrets.check_supported(step, in_flow=isinstance(plan_json.get("flow"), dict))
    if not submitter:
        raise HTTPException(401, detail={"code": "TAPIS_AUTH_REQUIRED",
                                         "message": "a valid Tapis bearer token is required to use your secrets"})
    _check_secret_run_trust(plan_json, registry, submitter)
    if plan_json.get("planned_by") != submitter:
        # The plan's consent screen was somebody else's.
        raise HTTPException(403, detail={
            "code": "FLOW_PLAN_NOT_YOURS",
            "message": "this flow plan was made by someone else; plan the flow again to run it"})

    store = secrets_store.FernetSecretStore(get_client(None))
    rows: dict[str, dict[str, Any]] = {}
    missing: list[dict[str, Any]] = []
    for name, need in step_secrets.needs(steps).items():
        row = await store.find(secrets_store.SCOPE_USER, submitter, name, "")
        if row is None or not set(need["fields"]) <= set(secrets_store.text_array(row.get("fields"))):
            missing.append({"name": name, "fields": need["fields"]})
        else:
            rows[name] = row
    if missing:
        raise HTTPException(422, detail={
            "code": "FLOW_SECRET_MISSING", "secrets": missing,
            "message": "this flow needs credentials you have not stored; store them with PUT /secrets/{name}"})
    recorded = plan_json.get("secret_bindings") or {}
    for name, row in rows.items():
        was = recorded.get(name) or {}
        # No record at all means the secret was stored after the plan: plan again.
        if was.get("owner") != submitter or (
                was.get("id") != str(row["id"]) or was.get("version") != int(row["version"])):
            raise HTTPException(409, detail={
                "code": "FLOW_SECRET_CHANGED", "name": name,
                "message": "this secret changed after the flow was planned; plan again"})
    if not dry_run and not (step_secrets.configured(settings.step_secret_key, settings.public_base_url)
                            and secrets_store.secrets_configured()):
        raise HTTPException(503, detail={
            "code": "STEP_SECRETS_NOT_CONFIGURED",
            "message": "this service is not set up to hand secrets to a step"})
    return [step_secrets.bound_entry(step["step"], [
        {"id": str(rows[d["name"]]["id"]), "version": int(rows[d["name"]]["version"]),
         "name": d["name"], "env": d["env"]} for d in step["secrets"]]) for step in steps]


async def _bind_flow_secrets_and_check_conflict(
    h: Any, token: str | None, plan_json: dict[str, Any], *, has_model_task: bool, dry_run: bool,
) -> list[dict[str, Any]]:
    """Bind the submitter's secrets to the steps of ``plan_json`` and refuse a run
    that conflicts with another of theirs. Shared by a submit and a resume, so a
    resumed segment keeps every check a first segment has. Returns the bound steps."""
    flow_bound: list[dict[str, Any]] = []
    if step_secrets.secret_steps(plan_json):
        flow_bound = await _resolve_flow_secrets(
            h, plan_json, await _registry(h, plannable=False), await _caller_or_none(token),
            has_model_task=has_model_task, dry_run=dry_run)

    if not dry_run:
        submitter_now = await _caller_or_none(token)
        if submitter_now and (flow_bound or any(
                step.get("python_source") or step.get("tapis_app_id") for step in plan_json.get("steps") or [])):
            registry_now = await _registry(h, plannable=False)
            await _check_run_conflict(
                h, submitter_now, registry_now, this_run=None, secrets_here=bool(flow_bound),
                untrusted_here=_untrusted_step(plan_json, registry_now, submitter_now) is not None,
                token=token)
    return flow_bound


def _pause_for_submit(plan_json: dict[str, Any], body: SubmitWorkflowIn) -> int | None:
    """The step this submission runs through when the flow pauses, else None.

    With pausing off, a flow runs whole as it always did and a ``through_step`` is
    refused. With it on, a plan that pauses is run up to its pause whether or not
    ``through_step`` is sent, so no caller can skip a pause by leaving it out.
    """
    pauses = flow_segments.paused_steps(plan_json)
    if body.through_step is not None and not settings.flow_pause_enabled:
        raise HTTPException(422, detail={
            "code": "FLOW_PAUSE_DISABLED", "message": "this service is not set up to pause flows"})
    if not (settings.flow_pause_enabled and pauses):
        if body.through_step is not None:
            raise HTTPException(422, detail={
                "code": "FLOW_THROUGH_STEP_INVALID", "message": "this plan does not pause after any step"})
        return None
    if body.model_task is not None:
        raise HTTPException(422, detail={
            "code": flow_segments.CODE_UNSUPPORTED, "message": "a composite model run cannot pause"})
    refused = flow_segments.problem(plan_json)
    if refused:
        raise HTTPException(422, detail=refused)
    pause = pauses[0]
    if "flow_staging_uri" not in {p.get("name") for p in plan_json.get("parameters") or []}:
        raise HTTPException(409, detail={
            "code": "FLOW_PLAN_PREDATES_PAUSE",
            "message": "this plan was made before the service could pause flows; plan the flow again"})
    if body.through_step is not None and body.through_step != pause:
        raise HTTPException(422, detail={
            "code": "FLOW_THROUGH_STEP_INVALID", "through_step": body.through_step,
            "message": f"the flow pauses after step {pause}; through_step may only be that step"})
    return pause


def _replayable_args(args: dict[str, Any]) -> dict[str, Any]:
    """The arguments a resume starts the next segment with: what the submit validated,
    less anything that is a credential. Tokens, step-secret credentials and the
    run's own identifiers are made again at the resume, for the person resuming."""
    keep: dict[str, Any] = {}
    for name, entry in args.items():
        value = entry.get("value") if isinstance(entry, dict) else entry
        if (name in tapis._INPUT_SECRET_PARAMS or step_secrets.is_managed_argument(str(name))
                or "token" in str(name).lower() or run_tokens.looks_like_secret(str(value))):
            continue
        keep[name] = entry
    return keep


@app.post("/workflows/submit", tags=["Core: Workflows"])
async def submit_workflow(
    body: SubmitWorkflowIn,
    authorization: str | None = Header(None),
    idempotency_header: str | None = Header(None, alias="Idempotency-Key"),
    internal_secret: str | None = Header(None, alias="X-Ensemble-Manager-Secret"),
):
    """Register the generated pipeline into its Workflows group and run it,
    emulating SUBSIDE (workflows.runPipeline). The caller's bearer token is
    forwarded as the Tapis token used for registration + the run."""
    token = _bearer(authorization)
    h = get_client(token)
    if body.idempotency_key and idempotency_header and body.idempotency_key != idempotency_header:
        raise HTTPException(
            400,
            detail={
                "code": "IDEMPOTENCY_KEY_MISMATCH",
                "message": "body and Idempotency-Key header values must match",
            },
        )
    idempotency_key = body.idempotency_key or idempotency_header
    stored_plan_id, bound_plan_id = _resolve_bound_plan_id(body.plan_id)
    if bound_plan_id:
        _require_internal_service(
            internal_secret, "bound deferred plans require Ensemble Manager authentication")
    plan = (await h.execute(GET_PLAN, {"id": stored_plan_id}))["adapter_workflow_plan_by_pk"]
    if not plan:
        raise HTTPException(404, "plan not found")
    if bound_plan_id:
        bound = (plan.get("plan_json") or {}).get("bound") or {}
        if bound.get("bound_plan_id") != bound_plan_id:
            raise HTTPException(409, detail={"code": "BOUND_PLAN_INVALID"})
        if tapis.plan_publishes((plan.get("plan_json") or {}).get("steps") or []):
            await _enforce_run_owner(body.execution_id, token)

    fixed = _fixed_flow_args(plan.get("plan_json") or {}, body.args)
    if fixed:
        raise HTTPException(422, detail={
            "code": "FLOW_ARGUMENT_FIXED", "arguments": fixed,
            "message": "these were set when the flow was planned (its datasets and region) or belong "
                       "to the run itself; plan again to change them"})
    refused_settings = _refused_flow_setting_args(plan.get("plan_json") or {}, body.args)
    if refused_settings:
        raise HTTPException(422, detail={
            "code": "FLOW_SETTING_REFUSED", "arguments": sorted(
                {name for names in refused_settings.values() for name in names}),
            "fixed": refused_settings.get("fixed", []), "hidden": refused_settings.get("hidden", []),
            "message": "the flow's author fixed or hid these settings, so a run cannot change them; "
                       "remove them from the run"})
    unaccepted = _unaccepted_flow_settings(plan.get("plan_json") or {}, body.args)
    if (unaccepted["defaults"] or unaccepted["links"]) and not body.accept_flow_settings and not body.dry_run:
        raise HTTPException(422, detail={
            "code": "FLOW_SETTINGS_NOT_ACCEPTED", **unaccepted,
            "message": "this flow's author chose these settings for pieces that will run with your "
                       "token; send accept_flow_settings to use them, or send your own values"})

    stored_source_audit: dict[str, Any] | None = None
    stored_steps = list(stored_source.iter_stored_steps(plan.get("plan_json") or {}))
    if stored_steps:
        # Checked against the submitter and the pieces as they are now, so a plan
        # made by a piece's author cannot be handed to someone else to run.
        submitter = await _caller_or_none(token)
        recorded = (plan.get("plan_json") or {}).get("stored_source_opt_in") or {}
        opt_in = recorded.get("piece_ids") or [] if submitter and recorded.get("username") == submitter else []
        problems = stored_source.check_plan(
            plan.get("plan_json") or {}, await _registry(h, plannable=False), submitter, opt_in)
        if problems:
            raise HTTPException(403, detail={"code": "STORED_SOURCE_REFUSED", "problems": problems})
        stored_source_audit = {
            "plan_id": stored_plan_id,
            "submitted_by": submitter,
            "pieces": [step.get("stored_source") for step in stored_steps],
        }

    if idempotency_key:
        existing_rows = (await h.execute(
            GET_RUN_BY_IDEMPOTENCY,
            {"key": idempotency_key},
        )).get("adapter_workflow_run", [])
        if existing_rows:
            existing = existing_rows[0]
            if existing.get("workflow_plan_id") != stored_plan_id:
                raise HTTPException(
                    409,
                    detail={
                        "code": "IDEMPOTENCY_KEY_REUSED",
                        "message": "idempotency key is already associated with another workflow plan",
                    },
                )
            return {
                "run_id": existing["id"],
                "status": existing.get("status"),
                "tapis_workflow_id": existing.get("tapis_workflow_id"),
                "tapis_run_id": existing.get("tapis_run_id"),
                "idempotent_replay": True,
            }

    # The steps this submission runs: all of them, or for a flow that pauses, the
    # ones up to the pause. Secrets are bound, and conflicts judged, for these only;
    # the rest are bound the same way when the run is resumed.
    pause = _pause_for_submit(plan.get("plan_json") or {}, body)
    submit_plan_json = (flow_segments.first_segment(plan.get("plan_json") or {}, pause)
                        if pause is not None else plan.get("plan_json") or {})
    flow_bound = await _bind_flow_secrets_and_check_conflict(
        h, token, submit_plan_json, has_model_task=body.model_task is not None, dry_run=body.dry_run)

    service_args = dict(body.args or {})
    source_id = plan.get("source_data_object_id")
    if source_id and "source_uri" not in service_args:
        source = (await h.execute(GET_DATA_OBJECT, {"id": source_id})).get(
            "adapter_data_object_by_pk"
        )
        if source and source.get("resource_uri"):
            service_args["source_uri"] = source["resource_uri"]
    configured_geo_actor_id = (settings.geo_actor_id or "").strip()
    if configured_geo_actor_id:
        supplied_geo_actor = service_args.get("geo_actor_id")
        supplied_geo_actor_value = (
            supplied_geo_actor.get("value")
            if isinstance(supplied_geo_actor, dict)
            else supplied_geo_actor
        )
        if supplied_geo_actor_value is None or (
            isinstance(supplied_geo_actor_value, str)
            and not supplied_geo_actor_value.strip()
        ):
            if isinstance(supplied_geo_actor, dict):
                service_args["geo_actor_id"] = {
                    **supplied_geo_actor,
                    "value": configured_geo_actor_id,
                }
            else:
                service_args["geo_actor_id"] = configured_geo_actor_id

    _validate_deferred_execution_id(bound_plan_id, body.execution_id, service_args)
    if tapis.plan_publishes((plan.get("plan_json") or {}).get("steps") or []):
        _bind_publish_args(service_args, body.execution_id, plan.get("plan_json") or {})

    derived: dict[str, Any] | None = None
    if body.model_task is not None:
        _require_internal_service(
            internal_secret, "composite model descriptors require Ensemble Manager authentication")
        if _composite_task_contains_secret(body.model_task):
            raise HTTPException(422, detail={
                "code": "COMPOSITE_MODEL_TASK_SECRET",
                "message": "composite model descriptors must not contain bearer credentials",
            })
        if not body.execution_id:
            raise HTTPException(422, detail={
                "code": "COMPOSITE_EXECUTION_ID_REQUIRED",
                "message": "composite model submissions require execution_id metadata",
            })
        service_args.setdefault("execution_id", body.execution_id)
        if "input_steps" in body.model_task:
            raise HTTPException(422, detail={
                "code": "INPUT_STEPS_UNSUPPORTED",
                "message": "model_task.input_steps is no longer accepted; send "
                           "model_task.input_sources and the adapter plans the steps",
            })
        if body.model_task.get("output_file") not in (None, ""):
            output_file_problem = tapis.output_file_error(body.model_task["output_file"])
            if output_file_problem:
                raise HTTPException(422, detail={
                    "code": "MODEL_OUTPUT_FILE_INVALID",
                    "message": output_file_problem,
                    "output_file": str(body.model_task["output_file"])[:300],
                })
        input_sources = body.model_task.pop("input_sources", None)
        expected_digest = body.model_task.pop("expected_steps_digest", None)
        client_filled = body.model_task.pop("filled_app_inputs", None) or []
        if input_sources:
            # Server-owned: a caller may not set these through args.
            for key in [k for k in service_args if _RESERVED_INPUT_ARGS.match(str(k))]:
                del service_args[key]
            job = body.model_task.get("job_definition") or {}
            filled = set(map(str, client_filled)) | {
                str(f.get("name")) for f in job.get("fileInputs") or [] if isinstance(f, dict)}
            derived = await _derive_input_plan(
                h, str(body.model_task.get("configuration_id") or ""), input_sources, filled)
            if derived["registry"] == "missing":
                raise HTTPException(422, detail={
                    "code": "MODEL_NOT_IN_REGISTRY",
                    "message": "the model is not in the adapter registry; run sync-from-mint "
                               "after registering its typed inputs",
                })
            if derived.get("tapis_app_id") != job.get("appId"):
                raise HTTPException(422, detail={
                    "code": "MODEL_APP_MISMATCH",
                    "message": "the registry's Tapis app for this configuration differs from the job's appId",
                })
            if any(row["blocking"] for row in derived["considered"]):
                raise HTTPException(422, detail={
                    "code": "NO_INPUT_TRANSFORM_PATH",
                    "message": "no ETL path produces a required model input from the supplied sources",
                    "considered": derived["considered"],
                })
            if expected_digest and expected_digest != derived["steps_digest"]:
                raise HTTPException(409, detail={
                    "code": "INPUT_PLAN_CHANGED",
                    "message": "the input plan changed since it was previewed; plan again",
                    "steps_digest": derived["steps_digest"],
                })
            input_steps = derived["input_steps"]
            if input_steps:
                body.model_task["input_steps"] = input_steps
                for k, item in enumerate(input_steps):
                    service_args[f"in{k}_source"] = _input_source_arg(item["source"])
                    for name, value in (item.get("params") or {}).items():
                        service_args[f"in{k}_{name}"] = value
                if not body.dry_run:
                    service_args["input_staging_dir"] = await _resolve_input_staging(
                        input_steps, body.model_task, token, body.execution_id)

    # A flow with a collection input stages the files it gathers in a folder named for
    # this run, so the run's id is chosen here, before the pipeline and its arguments
    # are made, and the run is recorded under it. A dry run finds no folder.
    run_id = str(uuid.uuid4())
    plan_json_now = plan.get("plan_json") or {}
    if isinstance(plan_json_now.get("flow"), dict):
        # Every step of a flow sends the runner's token to this address. It is
        # refused from the request above; here it is set, so that no alias or
        # default can stand in for it.
        service_args["tapis_base_url"] = settings.tapis_base_url
    flow_staging: str | None = None
    if ((plan_json_now.get("flow") or {}).get("collections") or pause is not None) and not body.dry_run:
        flow_staging = await _resolve_flow_staging(token, run_id)
        service_args["flow_staging_uri"] = flow_staging
        run_folder_defaults = [
            str(parameter["name"]) for parameter in plan_json_now.get("parameters") or []
            if parameter.get("default_source") == "run_folder" and parameter.get("name")]
        if "output_uri" in run_folder_defaults and not _arg_given(service_args, "output_uri"):
            service_args["output_uri"] = f"{flow_staging}/outputs"

    # The model descriptor is server-generated and intentionally request-local:
    # it is part of this composite run, not mutable plan state.  The adapter
    # generator receives it through the same immutable plan-shaped contract as
    # normal transform steps.
    if body.model_task is not None:
        workflow_plan = {
            **plan,
            "plan_json": {
                **(plan.get("plan_json") or {}),
                "model_task": body.model_task,
            },
        }
    elif pause is not None:
        # Segment 1 is its own pipeline: the steps up to the pause, under an id of
        # its own so that segment 2's registration can never replace it.
        workflow_plan = {**plan, "id": flow_segments.segment_pipeline_id(stored_plan_id, 1),
                         "plan_json": submit_plan_json}
    else:
        workflow_plan = plan

    pipeline = tapis.generate_tapis_workflow(workflow_plan)
    args = _validate_plan_args(
        workflow_plan.get("plan_json") or {}, service_args, token, require_required=not body.dry_run
    )
    secret_report, bound_secrets = await _resolve_run_secrets(h, body, token)
    segment_args = _replayable_args(args) if pause is not None else None
    if not body.dry_run:
        args = await _with_run_token(args, token)

    submitted_by = None
    if token and not body.dry_run:
        # Resolved by Tapis, never decoded locally; /runs/{id}/cancel checks
        # the caller against it.
        submitted_by = await run_in_threadpool(tapis.userinfo_username, token)

    # Record the run before triggering, so a failed submit still leaves a trail.
    run_obj: dict[str, Any] = {
        "id": run_id,
        "workflow_plan_id": stored_plan_id,
        "tapis_workflow_id": pipeline["id"],
        "status": "submitting",
    }
    if body.execution_id:
        run_obj["execution_id"] = body.execution_id
    if idempotency_key:
        run_obj["idempotency_key"] = idempotency_key
    if submitted_by:
        run_obj["submitted_by"] = submitted_by
    if body.model_task is not None:
        # Known at generation time; /poll verifies a signalled job uuid against it.
        job_name = (body.model_task.get("job_definition") or {}).get("name")
        if job_name:
            run_obj["model_job_name"] = str(job_name)
    if bound_secrets:
        run_obj["bound_secrets"] = bound_secrets
    if flow_bound and not body.dry_run:
        run_obj["bound_secrets"] = {"steps": flow_bound}
    if pause is not None:
        # Segment 1 of a flow that pauses: where it ends, and what its successor
        # is started with. Never a token or a secret.
        run_obj["paused_after_step"] = pause
        run_obj["segment_json"] = {"args": segment_args}
    run = (await h.execute(INSERT_RUN, {"obj": run_obj}))["insert_adapter_workflow_run_one"]
    for item in bound_secrets:
        await secrets_store.record_event(
            h, "bound", {"id": item["id"], "scope": secrets_store.SCOPE_MODEL_OWNER, "name": item["name"],
                         "configuration_id": body.model_task.get("configuration_id")},
            run_id=run["id"], actor=submitted_by or "unknown", version=item["version"])
    for entry in flow_bound if not body.dry_run else []:
        for item in entry["secrets"]:
            await secrets_store.record_event(
                h, "bound", {"id": item["id"], "scope": secrets_store.SCOPE_USER, "name": item["name"],
                             "owner_username": submitted_by, "configuration_id": ""},
                run_id=run["id"], actor=submitted_by or "unknown", version=item["version"])
    # What the caller said the run is about (time period, area), whether or not
    # a piece reads it. Values a caller supplied only; nothing is inferred.
    framing = {
        name: args[name].get("value") for name in tapis.FRAMING_PARAMS
        if isinstance(args.get(name), dict) and args[name].get("value") not in (None, "")
    }
    await h.execute(INSERT_PROVENANCE, {"obj": {
        "workflow_run_id": run["id"], "event_type": "workflow_submit_requested",
        "payload_json": {"plan_id": body.plan_id, "dry_run": body.dry_run,
                         **({"through_step": pause} if pause is not None else {}),
                         **({"framing": framing} if framing else {})},
    }})
    if stored_source_audit is not None and not body.dry_run:
        # Recorded against the run, so its provenance shows whose code ran.
        await h.execute(INSERT_PROVENANCE, {"obj": {
            "workflow_run_id": run["id"], "event_type": "stored_source_run",
            "payload_json": stored_source_audit,
        }})
    if body.model_task is not None and body.model_task.get("input_steps"):
        # Names, step ids and the planner's decisions; the produced content is
        # never recorded here.
        await h.execute(INSERT_PROVENANCE, {"obj": {
            "workflow_run_id": run["id"], "event_type": "run.input.planned",
            "payload_json": {"inputs": [
                {"name": item["name"], "app_input_name": item["app_input_name"],
                 **({"derivation": item["derivation"]} if item.get("derivation") else {}),
                 "step_ids": [f"in{k}-step-{n}-{st.get('transform_type')}"
                              for n, st in enumerate(item["steps"])]}
                for k, item in enumerate(body.model_task["input_steps"])],
                "considered": derived["considered"] if derived else [],
                "steps_digest": derived["steps_digest"] if derived else None},
        }})

    if body.dry_run:
        await h.execute(UPDATE_RUN, {"id": run["id"], "set": {"status": "generated"}})
        return {"run_id": run["id"], "status": "generated",
                "tapis_workflow_definition": pipeline, "args": _public_workflow_args(args),
                **({"flow_staging": {
                    "resolved": False,
                    "message": "a real submission finds your scratch folder on "
                               f"{settings.tapis_exec_system} and stages gathered inputs under "
                               "dynamo-runs/<run id>/inputs/"}}
                   if (plan_json_now.get("flow") or {}).get("collections") or pause is not None else {}),
                **({"secrets": secret_report} if secret_report is not None else {})}

    if flow_bound:
        # One fetch credential per bound step, valid for the run's longest possible
        # length, delivered to that step only. It opens nothing without the runner's
        # own token (design section 8).
        expires = int(time.time()) + step_secrets.pipeline_seconds(
            pipeline, settings.stored_source_max_exec_seconds) + step_secrets.CREDENTIAL_SLACK_SECONDS
        args[step_secrets.RUN_ID_ARG] = {"value": run["id"]}
        args[step_secrets.ADAPTER_URL_ARG] = {"value": settings.public_base_url.rstrip("/")}
        for entry in flow_bound:
            args[f"{step_secrets.TOKEN_ARG_PREFIX}{entry['step']}"] = {"value": step_secrets.make_credential(
                settings.step_secret_key, run["id"], entry["step"], entry["secrets"], expires)}

    # Arm run signals for composite runs: the model task reports liveness to
    # this run's /signal endpoint with a token only this run can use. The sweep
    # only ever judges armed runs (see run_state.stall_decision).
    signals_armed = False
    if body.model_task is not None and run_state.signals_configured():
        expires = run_state.signal_expiry(
            datetime.now(tz=timezone.utc), int(body.model_task.get("max_minutes") or 60),
        )
        args["signal_url"] = {"value": run_state.signal_url(run["id"])}
        args["signal_token"] = {"value": run_state.make_signal_token(run["id"], expires)}
        args["signal_expires"] = {"value": str(expires)}
        if bound_secrets:
            args["credentials_url"] = {"value": run_state.credentials_url(run["id"])}
        signals_armed = True

    # Token keeper (run_tokens.py, design rev 2): keep an encrypted copy of the
    # per-run token so a task the engine starts late can fetch a live one from
    # POST /runs/{id}/token with a per-run credential derived like the signal
    # token. Stored before dispatch; a run the keeper cannot maintain is never
    # submitted.
    if signals_armed and run_tokens.keeper_configured():
        run_token_value = str((args.get("tapis_token") or {}).get("value") or "")
        if run_token_value:
            dispatch_estimate = datetime.now(tz=timezone.utc)
            try:
                ciphertext = run_tokens.encrypt_run_token(run["id"], run_token_value)
            except Exception as exc:  # noqa: BLE001 — never echo key material
                await h.execute(UPDATE_RUN, {"id": run["id"], "set": {
                    "status": "failed", "error_message": "run-token keeper could not store the token"}})
                raise HTTPException(502, detail={"code": "RUN_TOKEN_STORE_FAILED",
                                                 "message": safe_error_message(exc)})
            token_exp = run_tokens.token_expires_at(run_token_value)
            deadline = run_tokens.keeper_deadline(dispatch_estimate)
            await h.execute(UPDATE_RUN, {"id": run["id"], "set": {
                "run_token_enc": ciphertext,
                "run_token_expires_at": token_exp.isoformat() if token_exp else None,
                "run_token_deadline_at": deadline.isoformat(),
                "run_token_renewals": 0,
            }})
            fetch_expires = run_state.token_fetch_expiry(dispatch_estimate)
            args["token_url"] = {"value": run_state.token_url(run["id"])}
            args["token_fetch_token"] = {"value": run_state.make_token_fetch_credential(run["id"], fetch_expires)}
            args["token_fetch_expires"] = {"value": str(fetch_expires)}
            # A task that starts after the signal credential's normal lifetime
            # must still be able to report `started`; let it live as long as
            # the keeper does.
            if fetch_expires > expires:
                args["signal_token"] = {"value": run_state.make_signal_token(run["id"], fetch_expires)}
                args["signal_expires"] = {"value": str(fetch_expires)}
            await h.execute(INSERT_PROVENANCE, {"obj": {
                "workflow_run_id": run["id"], "event_type": "run.token.stored",
                "payload_json": {"expires_at": token_exp.isoformat() if token_exp else None,
                                 "deadline_at": deadline.isoformat()},
            }})

    try:
        result = await run_in_threadpool(
            tapis.submit_tapis_workflow, pipeline, args,
            token=token, run_name=body.run_name,
            # Composite and deferred post-model submissions share the stable
            # pipeline id.  A bound deferred plan has a different task
            # definition, so it must replace the composite registration before
            # it is run; otherwise the provider executes the stale model task.
            # Composite submissions must also replace an earlier registration
            # whose saved plan still marked the model-output handoff URI as a
            # required submission argument.
            recreate=body.recreate or bool(bound_plan_id) or body.model_task is not None,
        )
    except Exception as exc:  # surface the Tapis error, mark the run failed
        error_message = safe_error_message(f"{type(exc).__name__}: {exc}")
        # The keeper stored the run token before dispatch; a run that never
        # dispatched must not leave a live token behind.
        from . import poller  # noqa: PLC0415 — deferred, as in lifespan
        await poller.release_run_token(h, run["id"], "submit_failed")
        await h.execute(UPDATE_RUN, {"id": run["id"], "set": {
            "status": "failed", "error_message": error_message,
            **(run_state.clear_token_update() if run_tokens.keeper_configured() else {}),
        }})
        await h.execute(INSERT_PROVENANCE, {"obj": {
            "workflow_run_id": run["id"],
            "event_type": "workflow_submit_failed",
            "payload_json": {
                "code": "TAPIS_WORKFLOW_SUBMISSION_FAILED",
                "error_message": error_message,
            },
        }})
        raise HTTPException(502, detail={
            "code": "TAPIS_WORKFLOW_SUBMISSION_FAILED",
            "message": "Tapis Workflows submission failed",
            "error_message": error_message,
            "run_id": run["id"],
        })

    dispatched_at = datetime.now(tz=timezone.utc).isoformat()
    await h.execute(UPDATE_RUN, {"id": run["id"], "set": {
        "status": "running", "tapis_run_id": result.get("uuid"),
        "dispatched_at": dispatched_at, "signals_armed": signals_armed,
    }})
    if signals_armed:
        await h.execute(INSERT_PROVENANCE, {"obj": {
            "workflow_run_id": run["id"], "event_type": "run.signal.armed",
            "payload_json": {"dispatched_at": dispatched_at,
                             "stall_after_seconds": settings.stall_after_seconds},
        }})
    return {"run_id": run["id"], **result}


@app.get("/plans/{plan_id}", tags=["Core: Planning"])
async def get_plan(plan_id: str, authorization: str | None = Header(None)):
    h = get_client(_bearer(authorization))
    plan = (await h.execute(GET_PLAN, {"id": plan_id}))["adapter_workflow_plan_by_pk"]
    if not plan:
        raise HTTPException(404, "plan not found")
    return plan


@app.get("/runs", tags=["Core: Runs"])
async def list_runs(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    authorization: str | None = Header(None),
    internal_secret: str | None = Header(None, alias="X-Ensemble-Manager-Secret"),
):
    """List the caller's workflow runs, most recent first."""
    reader = await _run_reader(authorization, internal_secret)
    where = {} if reader == _ANY_RUN else {"submitted_by": {"_eq": reader}}
    h = get_client(_bearer(authorization))
    data = await h.execute(LIST_RUNS, {"limit": limit, "offset": offset, "where": where})
    total = data.get("adapter_workflow_run_aggregate", {}).get("aggregate", {}).get("count", 0)
    return {"runs": data.get("adapter_workflow_run", []), "total": total}


@app.get("/runs/{run_id}", tags=["Core: Runs"])
async def get_run(
    run_id: str,
    authorization: str | None = Header(None),
    internal_secret: str | None = Header(None, alias="X-Ensemble-Manager-Secret"),
):
    reader = await _run_reader(authorization, internal_secret)
    h = get_client(_bearer(authorization))
    run = _require_run_reader(
        (await h.execute(GET_RUN, {"id": run_id}))["adapter_workflow_run_by_pk"], reader)
    return {**run, "publication": await _run_publication(h, run, _bearer(authorization))}


async def _run_publication(h, run: dict[str, Any], token: str | None) -> dict[str, Any] | None:
    """The run's publication outcome, or None when it has no publish step or no
    outcome yet. Prefers the recorded provenance event; otherwise reads the
    publish task's result from the live run detail."""
    plan = (await h.execute(GET_PLAN, {"id": run.get("workflow_plan_id")}))["adapter_workflow_plan_by_pk"] \
        if run.get("workflow_plan_id") else None
    if not tapis.plan_publishes(((plan or {}).get("plan_json") or {}).get("steps") or []):
        return None
    recorded = await publication.recorded_publication(h, run["id"])
    if recorded:
        return recorded
    if not (token and run.get("tapis_workflow_id") and run.get("tapis_run_id")):
        return None
    try:
        detail = await run_in_threadpool(
            tapis.get_run_detail, run["tapis_workflow_id"], run["tapis_run_id"], token=token)
    except Exception:  # noqa: BLE001 — status read only; no outcome is not an error
        return None
    return publication.publication_from_detail(detail)


@app.post("/runs/{run_id}/poll", tags=["Core: Runs"])
async def poll_run(
    run_id: str,
    authorization: str | None = Header(None),
    internal_secret: str | None = Header(None, alias="X-Ensemble-Manager-Secret"),
):
    """Poll one Tapis workflow run and persist any status transition."""
    caller_token = _bearer(authorization)
    reader = await _run_reader(authorization, internal_secret)
    h = get_client(caller_token or settings.tapis_token)
    run = _require_run_reader(
        (await h.execute(GET_RUN, {"id": run_id}))["adapter_workflow_run_by_pk"], reader)
    if str(run.get("status") or "") == "cancelled":
        # A user cancelled this run; Tapis may still report it active or
        # terminated, neither of which revises the user's decision.
        return run
    # Composite model runs are owned by the user who submitted them. Never
    # substitute the unattended service account for a missing UI credential;
    # that account may be a different Tapis owner and cannot inspect the job.
    if run.get("execution_id") and not caller_token:
        raise HTTPException(401, "log in with a Tapis token to poll this run")
    token = caller_token or settings.tapis_token
    pipeline_id = run.get("tapis_workflow_id")
    run_uuid = run.get("tapis_run_id")
    if not pipeline_id or not run_uuid:
        return run
    if not token:
        raise HTTPException(401, "log in with a Tapis token to poll this run")

    detail = await run_in_threadpool(tapis.get_run_detail, pipeline_id, run_uuid, token=token)
    status_before = str(run.get("status") or "")
    tapis_status = str(detail.get("status") or "").upper()
    adapter_status, update = _terminal_update_set(tapis_status, detail)
    if run.get("completed_at"):
        # Set when the run first ended and kept: a run paused for an edit is
        # polled for days, and its timeout counts from the moment it paused.
        update.pop("completed_at", None)
    if adapter_status is None and tapis_status and str(run.get("status") or "").lower() in {
        "submitting", "generated"
    }:
        update = {"status": "running"}

    # A signalled job uuid is only trusted once Tapis confirms it under the
    # caller's token; a confirmed job also proves a `stalled` run is alive.
    health_update = await _verify_model_job(run, token)
    if update or health_update:
        updated_run = (await h.execute(UPDATE_RUN, {"id": run_id, "set": {**health_update, **update}}))["update_adapter_workflow_run_by_pk"]
        # The mutation returns only a projection of the row. Preserve the
        # workflow/parent identifiers needed by output registration and
        # reconciliation instead of replacing the full GET result with it.
        run = {**run, **(updated_run or {})}
    if update:
        await h.execute(INSERT_PROVENANCE, {"obj": {
            "workflow_run_id": run_id,
            "event_type": "run_status_polled",
            "payload_json": {"tapis_status": tapis_status, "adapter_status": update.get("status")},
        }})
        if adapter_status == "completed" and run.get("execution_id"):
            # Reuse the same output-registration path as the background poller
            # so a unified parent can reconcile even when the poller is disabled.
            from .poller import _auto_bind_completed_run
            bind_result = await _auto_bind_completed_run(
                h, get_client(None), {**run, **update}, token
            )
            run = {**run, "auto_bind": bind_result}
    # `detail` carries Tapis's own pipeline-run status under "status", which would
    # replace the run's. The adapter's status is the run's; Tapis's is `tapis_status`.
    response = {**run, **detail, "status": run.get("status"), "tapis_status": detail.get("status")}
    plan_row = (await h.execute(GET_PLAN, {"id": run.get("workflow_plan_id")}))["adapter_workflow_plan_by_pk"] \
        if run.get("workflow_plan_id") else None
    plan_json_now = (plan_row or {}).get("plan_json") or {}
    awaiting = await _awaiting_state(h, run)
    if (adapter_status == "completed" and status_before != "completed"
            and run.get("paused_after_step") is not None and awaiting is not None):
        await h.execute(INSERT_PROVENANCE, {"obj": {
            "workflow_run_id": run_id, "event_type": "run.paused",
            "payload_json": {"after_step": run.get("paused_after_step")}}})
    view_detail = detail
    segment: dict[str, Any] | None = None
    if run.get("parent_run_id"):
        # A resumed run shows the whole flow: its parent's steps, then its own.
        view_detail = await _with_parent_detail(h, run, detail, token)
        segment = (await h.execute(GET_RUN_SEGMENT, {"id": run_id}))["adapter_workflow_run_by_pk"]
        await _record_replacement(h, segment, detail)
    flow_view = flow_run.view(plan_json_now, view_detail, awaiting_edit=awaiting is not None)
    if flow_view is not None:
        # One entry per step with its status, and where each of the flow's outputs is.
        # The run's status in the adapter's own words: Tapis's raw status is also
        # in this response, and a caller following a flow must not have to map it.
        response["flow"] = {**flow_view, "status": str(run.get("status") or "")}
        if awaiting is None and run.get("paused_after_step") is not None and run.get("resumed_run_id") \
                and str(run.get("status") or "") == "completed":
            # This run paused and has been resumed: what follows is the other run.
            response["flow"]["status"] = "resumed"
            response["flow"]["resumed_run_id"] = run["resumed_run_id"]
        if awaiting is not None:
            response["flow"]["status"] = "awaiting_edit"
            response["flow"]["paused_after_step"] = run.get("paused_after_step")
            response["flow"]["paused_at"] = run.get("completed_at") or update.get("completed_at")
            if awaiting.get("error"):
                response["flow"]["resume_error"] = awaiting["error"]
        replacement = ((segment or {}).get("segment_json") or {}).get("replacement")
        if replacement:
            response["flow"]["replacement"] = replacement
    outcome = await _record_run_publication(h, run, detail)
    if outcome:
        response["publication"] = outcome
    safe_result, result_error = task_result(detail)
    if safe_result:
        response["result"] = safe_result
    if result_error and adapter_status == "failed":
        response["error_message"] = result_error
    # The workflow API exposes task stdout/stderr, but it does not attach a
    # legacy Tapis job archive to child tasks. Resolve the published output
    # from the task execution while that detail is already available so the
    # Ensemble Manager can register the final adapter artifact explicitly.
    if adapter_status == "completed":
        # A publish run's output is the model output it published, not the last URL
        # its publish task printed (the STAC Item); those stay in `publication`.
        output_uri = await _published_model_output(h, run)
        try:
            output_uri = output_uri or await run_in_threadpool(
                tapis.get_output_uri, pipeline_id, run_uuid, token=token,
            )
        except Exception:  # noqa: BLE001 — output discovery is best effort
            output_uri = None
        if output_uri:
            response["output_uri"] = output_uri
    return response


async def _awaiting_state(h: Any, run: dict[str, Any]) -> dict[str, Any] | None:
    """Whether a run is stopped at its pause for an edit, and why a resume failed.

    A run that paused is ``completed`` in the adapter's words (its Tapis run did
    finish). It is waiting while nothing has resumed it, and again when what resumed
    it failed. Returns None for any other run, else ``{"error": <message or None>}``.
    """
    if run.get("paused_after_step") is None or str(run.get("status") or "") != "completed":
        return None
    child_id = run.get("resumed_run_id")
    if not child_id:
        return {"error": None}
    child = (await h.execute(GET_RUN, {"id": child_id}))["adapter_workflow_run_by_pk"]
    if not child:
        # The claim was made but the run after it was never recorded: still paused.
        return {"error": "the run after the edit was not started"}
    if str(child.get("status") or "") == "failed":
        return {"error": child.get("error_message") or "the run after the edit failed"}
    return None


async def _with_parent_detail(h: Any, run: dict[str, Any], detail: dict[str, Any], token: str | None) -> dict[str, Any]:
    """This segment's task detail joined to its parent's, so the steps that ran
    before the pause still show. If the parent cannot be read, this segment alone."""
    parent = (await h.execute(GET_RUN, {"id": run["parent_run_id"]}))["adapter_workflow_run_by_pk"]
    if not (parent and parent.get("tapis_workflow_id") and parent.get("tapis_run_id") and token):
        return detail
    try:
        earlier = await run_in_threadpool(
            tapis.get_run_detail, parent["tapis_workflow_id"], parent["tapis_run_id"], token=token)
    except Exception:  # noqa: BLE001 — the view is best effort; this segment's own status is not
        return detail
    return flow_segments.merged_detail(earlier, detail)


async def _record_replacement(h: Any, segment: dict[str, Any] | None, detail: dict[str, Any]) -> None:
    """Once the gather step has fetched the edited file, record what it fetched: its
    hash and size, with who replaced what and when. Recorded once."""
    replacement = ((segment or {}).get("segment_json") or {}).get("replacement")
    if not replacement or replacement.get("sha256"):
        return
    task = next((t for t in detail.get("tasks") or []
                 if isinstance(t, dict) and t.get("task_id") == flow_run.EDIT_GATHER_ID), None)
    reported = flow_run.reported_outputs((task or {}).get("stdout"))
    digest = reported.get("sha256")
    if not (isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest)):
        return
    recorded = {**replacement, "sha256": digest, "bytes": reported.get("bytes"),
                "stored_as": reported.get("result")}
    await h.execute(UPDATE_RUN, {"id": segment["id"], "set": {
        "segment_json": {**segment["segment_json"], "replacement": recorded}}})
    await h.execute(INSERT_PROVENANCE, {"obj": {
        "workflow_run_id": segment["id"], "event_type": "run.input.replaced", "payload_json": recorded}})


async def _published_model_output(h, run: dict[str, Any]) -> str | None:
    """The bound source_uri of a run whose plan publishes, else None."""
    plan = (await h.execute(GET_PLAN, {"id": run.get("workflow_plan_id")}))["adapter_workflow_plan_by_pk"] \
        if run.get("workflow_plan_id") else None
    plan_json = (plan or {}).get("plan_json") or {}
    if not tapis.plan_publishes(plan_json.get("steps") or []):
        return None
    data_object_id = (plan_json.get("bound") or {}).get("data_object_id")
    if not data_object_id:
        return None
    row = (await h.execute(GET_DATA_OBJECT, {"id": data_object_id})).get("adapter_data_object_by_pk")
    return (row or {}).get("resource_uri") or None


async def _record_run_publication(h, run: dict[str, Any], detail: dict[str, Any]) -> dict[str, Any] | None:
    """Derive the publish task's outcome from a poll's task detail and record it once."""
    outcome = publication.publication_from_detail(detail)
    if outcome:
        try:
            await publication.record_publication(h, run["id"], outcome)
        except Exception:  # noqa: BLE001 — the poll must still answer
            log.warning("could not record publication for run %s", run.get("id"))
    return outcome


async def _verify_model_job(run: dict[str, Any], token: str | None) -> dict[str, Any]:
    """Confirm a signalled job uuid against Tapis; a verified job clears `stalled`."""
    job_uuid = run.get("model_job_uuid")
    if not job_uuid or not token:
        return {}
    out: dict[str, Any] = {}
    if not run.get("model_job_verified"):
        job = await run_in_threadpool(tapis.get_job, token, job_uuid)
        expected = run.get("model_job_name")
        if not job or (expected and job.get("name") != expected):
            return {}
        out["model_job_verified"] = True
        if not expected and job.get("name"):
            out["model_job_name"] = str(job["name"])
    alive = run_state.observed_alive_update(run)
    if alive:
        out.update(alive)
    return out


# Per-run signal rate limit: one run's token can only post this often.
_SIGNAL_RATE: dict[str, list[float]] = {}
_SIGNAL_RATE_LIMIT = 60
_SIGNAL_RATE_WINDOW = 60.0
_SIGNAL_BODY_LIMIT = 4096


def _signal_rate_ok(run_id: str, now_ts: float) -> bool:
    stamps = [t for t in _SIGNAL_RATE.get(run_id, []) if now_ts - t < _SIGNAL_RATE_WINDOW]
    if len(stamps) >= _SIGNAL_RATE_LIMIT:
        _SIGNAL_RATE[run_id] = stamps
        return False
    stamps.append(now_ts)
    _SIGNAL_RATE[run_id] = stamps
    return True


@app.post("/runs/{run_id}/signal", tags=["Core: Runs"])
async def signal_run(
    run_id: str,
    request: Request,
    signal_token: str | None = Header(None, alias="X-Run-Signal-Token"),
    signal_expires: str | None = Header(None, alias="X-Run-Signal-Expires"),
):
    """Liveness report from the composite model task (see run_state.py).

    Authenticated by a per-run HMAC token; validated before any database
    access. A bad token and an unknown run get the same 401. Signals update
    health and the job identity; they never move status to a terminal value.
    """
    if not run_state.signals_configured():
        raise HTTPException(503, detail={"code": "RUN_SIGNALS_DISABLED",
                                         "message": "run signals are not configured"})
    if not run_state.verify_signal_token(run_id, signal_expires, signal_token):
        raise HTTPException(401, detail={"code": "RUN_SIGNAL_REJECTED"})
    now = datetime.now(tz=timezone.utc)
    if not _signal_rate_ok(run_id, now.timestamp()):
        raise HTTPException(429, detail={"code": "RUN_SIGNAL_RATE_LIMITED"})
    raw = await request.body()
    if len(raw) > _SIGNAL_BODY_LIMIT:
        raise HTTPException(413, detail={"code": "RUN_SIGNAL_TOO_LARGE"})
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        raise HTTPException(400, detail={"code": "RUN_SIGNAL_INVALID", "message": "body must be JSON"})
    event = run_state.validate_signal(body)
    if isinstance(event, str):
        raise HTTPException(400, detail={"code": "RUN_SIGNAL_INVALID", "message": event})

    h = get_client(None)
    run = (await h.execute(GET_RUN, {"id": run_id}))["adapter_workflow_run_by_pk"]
    if not run:
        raise HTTPException(401, detail={"code": "RUN_SIGNAL_REJECTED"})

    key = run_state.dedupe_key(event)
    event_type = f"run.signal.{event['event']}"
    prior = (await h.execute(GET_PROVENANCE, {"run_id": run_id, "limit": 500})).get(
        "adapter_provenance_event", [])
    if any(p.get("event_type") == event_type and (p.get("payload_json") or {}).get("dedupe_key") == key
           for p in prior):
        await h.execute(INSERT_PROVENANCE, {"obj": {
            "workflow_run_id": run_id, "event_type": "run.signal.duplicate",
            "payload_json": {"dedupe_key": key, "received_at": now.isoformat()},
        }})
        return {"run_id": run_id, "accepted": True, "applied": False, "duplicate": True}

    update = run_state.apply_signal(run, event, now)
    applied = False
    if update:
        result = await h.execute(UPDATE_RUN_IF, {"id": run_id, "status": run.get("status"), "set": update})
        applied = (result.get("update_adapter_workflow_run") or {}).get("affected_rows", 0) == 1
    await h.execute(INSERT_PROVENANCE, {"obj": {
        "workflow_run_id": run_id, "event_type": event_type,
        "payload_json": {**event, "dedupe_key": key, "applied": applied,
                         "received_at": now.isoformat()},
    }})
    return {
        "run_id": run_id, "accepted": True, "applied": applied,
        "health": (update or {}).get("health", run.get("health")),
        "status": (update or {}).get("status", run.get("status")),
    }


# Credential fetches have their own bucket (not /signal's): a task needs one per
# job submit, and a leaked signal token must not be able to hammer the store.
_CREDENTIALS_RATE: dict[str, list[float]] = {}
_CREDENTIALS_RATE_WINDOW = 600.0
_CREDENTIALS_RATE_LIMIT = 10
_CREDENTIALS_MAX_ISSUES = 3


def _credentials_rate_ok(run_id: str, now_ts: float) -> bool:
    stamps = [t for t in _CREDENTIALS_RATE.get(run_id, []) if now_ts - t < _CREDENTIALS_RATE_WINDOW]
    ok = len(stamps) < _CREDENTIALS_RATE_LIMIT
    if ok:
        stamps.append(now_ts)
    _CREDENTIALS_RATE[run_id] = stamps
    return ok


@app.get("/runs/{run_id}/credentials", tags=["Core: Runs"])
async def fetch_run_credentials(
    run_id: str,
    signal_token: str | None = Header(None, alias="X-Run-Signal-Token"),
    signal_expires: str | None = Header(None, alias="X-Run-Signal-Expires"),
):
    """Hand the composite model task the secrets bound to its run.

    Authorised like /signal (the run's signal token) but with its own rate
    bucket, only while the run is active with signals armed, and at most three
    times per run. Returns ``{"env": {ENV_KEY: value}}`` built from the current
    rows of the secrets bound at submit; the task replaces those keys in its
    in-memory job definition. Values appear in this response only, which is
    marked uncacheable; events and provenance carry ids and names.
    """
    if not run_state.signals_configured():
        raise HTTPException(503, detail={"code": "RUN_SIGNALS_DISABLED",
                                         "message": "run signals are not configured"})
    if not run_state.verify_signal_token(run_id, signal_expires, signal_token):
        raise HTTPException(401, detail={"code": "RUN_SIGNAL_REJECTED"})
    now = datetime.now(tz=timezone.utc)
    if not _credentials_rate_ok(run_id, now.timestamp()):
        raise HTTPException(429, detail={"code": "RUN_CREDENTIALS_RATE_LIMITED"})
    h = get_client(None)
    run = (await h.execute(GET_RUN_CREDENTIALS, {"id": run_id}))["adapter_workflow_run_by_pk"]
    if not run:
        raise HTTPException(401, detail={"code": "RUN_SIGNAL_REJECTED"})
    bound = run.get("bound_secrets") or []
    if not bound or not isinstance(bound, list):
        # A flow run's bound_secrets (a runner's own secrets, bound per step) is not a
        # list and is never served here: this route is the model owner's path only.
        raise HTTPException(404, detail={"code": "RUN_CREDENTIAL_UNAVAILABLE"})
    if str(run.get("status") or "") not in {"running", "submitting"} or not run.get("signals_armed"):
        raise HTTPException(409, detail={"code": "RUN_NOT_ACTIVE"})
    if not secrets_store.secrets_configured():
        raise HTTPException(503, detail={"code": "SECRETS_NOT_CONFIGURED"})
    store = secrets_store.FernetSecretStore(h)
    env: dict[str, str] = {}
    issued_rows: list[tuple[dict[str, Any], int]] = []
    for item in bound:
        try:
            found = await store.get(item["id"])
        except secrets_store.SecretError:
            raise HTTPException(503, detail={"code": "SECRET_UNREADABLE"})
        if found is None:
            raise HTTPException(409, detail={"code": "SECRET_REMOVED", "name": item.get("name")})
        row, fields = found
        if row.get("scope") != secrets_store.SCOPE_MODEL_OWNER:
            # Defence in depth: whatever a bound id points at, a runner's own secret
            # is never handed to the model task.
            raise HTTPException(409, detail={"code": "SECRET_REMOVED", "name": item.get("name")})
        if f"{row.get('pinned_app_id')}@{row.get('pinned_app_version')}" != item.get("app"):
            await secrets_store.record_event(h, "mismatch", row, run_id=run_id, actor="credentials")
            raise HTTPException(403, detail={"code": "SECRET_APP_MISMATCH", "name": item.get("name")})
        try:
            for field_name, env_key in (item.get("env") or {}).items():
                env[env_key] = fields[field_name]
        except KeyError:
            raise HTTPException(409, detail={"code": "SECRET_FIELDS_INCOMPLETE", "name": item.get("name")})
        issued_rows.append((row, int(row["version"])))

    # The issue is consumed only once the bundle is fully assembled, so a
    # transient failure above never burns one of the capped issues. The
    # compare-and-set keeps the cap atomic across concurrent fetches.
    issued = int(run.get("credentials_issued") or 0)
    for attempt in range(2):
        if issued >= _CREDENTIALS_MAX_ISSUES:
            raise HTTPException(409, detail={"code": "CREDENTIALS_EXHAUSTED"})
        claimed = await h.execute(ISSUE_RUN_CREDENTIALS_IF, {"id": run_id, "issued": issued})
        if (claimed.get("update_adapter_workflow_run") or {}).get("affected_rows", 0) == 1:
            break
        if attempt == 0:  # lost a race: re-read the counter and retry once
            fresh = (await h.execute(GET_RUN_CREDENTIALS, {"id": run_id}))["adapter_workflow_run_by_pk"]
            issued = int((fresh or {}).get("credentials_issued") or 0)
    else:
        raise HTTPException(409, detail={"code": "CREDENTIALS_EXHAUSTED"})

    for row, version in issued_rows:
        # A version newer than the bound one is used as-is and noted in the event.
        await secrets_store.record_event(h, "issued", row, run_id=run_id, actor="task",
                                         token_kind="run_signal", version=version)
        if issued == 0:
            await store.touch(row["id"])
    await h.execute(INSERT_PROVENANCE, {"obj": {
        "workflow_run_id": run_id, "event_type": "run.credential.issued",
        "payload_json": {
            "secrets": [f"{r['name']}@v{v}" for r, v in issued_rows],
            "task_id": run_state.SIGNAL_TASK_ID},
    }})
    return JSONResponse({"env": env}, headers={"Cache-Control": "no-store"})


# --- a flow step fetches its runner's own secrets ----------------------------
_STEP_SECRET_ACTIVE = frozenset({"submitting", "running"})


def _refuse(status: int, code: str, **extra: Any) -> HTTPException:
    """A refusal with a code and nothing else about secrets, whoever asks."""
    return HTTPException(status, detail={"code": code, **extra}, headers=_NO_STORE)


# The step fetch's own rate limit, keyed by (caller, run) and kept small.
_STEP_FETCH_RATE: dict[tuple[str, str], list[float]] = {}
_STEP_FETCH_RATE_MAX_KEYS = 4096


def _step_fetch_rate_ok(caller: str, run_id: str, now_ts: float) -> bool:
    if len(_STEP_FETCH_RATE) >= _STEP_FETCH_RATE_MAX_KEYS:
        for key in [k for k, stamps in _STEP_FETCH_RATE.items()
                    if not stamps or now_ts - stamps[-1] >= _CREDENTIALS_RATE_WINDOW]:
            del _STEP_FETCH_RATE[key]
        while len(_STEP_FETCH_RATE) >= _STEP_FETCH_RATE_MAX_KEYS:  # still full: drop the oldest
            del _STEP_FETCH_RATE[min(_STEP_FETCH_RATE, key=lambda k: _STEP_FETCH_RATE[k][-1])]
    key = (caller, run_id)
    stamps = [t for t in _STEP_FETCH_RATE.get(key, []) if now_ts - t < _CREDENTIALS_RATE_WINDOW]
    ok = len(stamps) < _CREDENTIALS_RATE_LIMIT
    if ok:
        stamps.append(now_ts)
    _STEP_FETCH_RATE[key] = stamps
    return ok


@app.get("/runs/{run_id}/steps/{step}/secrets", tags=["Core: Runs"])
async def fetch_step_secrets(
    run_id: str,
    step: int,
    authorization: str | None = Header(None),
    step_credential: str | None = Header(None, alias="X-Step-Secret-Token"),
):
    """Hand one step of a flow run the runner's own secrets bound to it.

    Needs both the runner's Tapis token (Tapis says who it is; it must be the run's
    submitter) and the step's own fetch credential made at submit for exactly this
    run and step. Only while the run is active, only for a step bound to secrets,
    only while its piece (and every piece of the run) still passes the trust rule,
    only while each secret is still the submitter's row at the bound version, only
    once, and within the per-run rate limit. Values appear in this response only,
    which is marked uncacheable; events record ids and names.
    """
    if not (step_secrets.configured(settings.step_secret_key, settings.public_base_url)
            and secrets_store.secrets_configured()):
        raise _refuse(503, "STEP_SECRETS_NOT_CONFIGURED")
    token = _bearer(authorization)
    caller = await _caller_or_none(token)
    if not caller or not step_credential:
        raise _refuse(401, "STEP_SECRET_AUTH_REQUIRED")
    now = datetime.now(tz=timezone.utc)
    h = get_client(None)
    run = (await h.execute(GET_RUN_STEP_SECRETS, {"id": run_id}))["adapter_workflow_run_by_pk"]
    if not run or run.get("submitted_by") != caller:
        # The same answer whether the run is someone else's or does not exist.
        raise _refuse(403, "STEP_SECRET_REFUSED")
    # After ownership, so that nobody can spend another user's bucket.
    if not _step_fetch_rate_ok(caller, run_id, now.timestamp()):
        raise _refuse(429, "RUN_CREDENTIALS_RATE_LIMITED")
    if str(run.get("status") or "") not in _STEP_SECRET_ACTIVE:
        raise _refuse(409, "RUN_NOT_ACTIVE")
    entries = step_secrets.bound_steps(run.get("bound_secrets"))
    entry = next((e for e in entries or [] if e.get("step") == step), None)
    if entry is None:
        raise _refuse(404, "STEP_SECRET_NOT_BOUND")
    if not step_secrets.verify_credential(
            settings.step_secret_key, step_credential, run_id, step, entry.get("secrets") or [], now=now):
        raise _refuse(401, "STEP_SECRET_CREDENTIAL_REJECTED")
    if entry.get("issued"):
        raise _refuse(409, "STEP_SECRET_ALREADY_ISSUED")

    plan = (await h.execute(GET_PLAN, {"id": run.get("workflow_plan_id")}))["adapter_workflow_plan_by_pk"]
    plan_json = (plan or {}).get("plan_json") or {}
    plan_step = next((st for st in plan_json.get("steps") or [] if st.get("step") == step), None)
    if plan_step is None or not plan_step.get("secrets"):
        raise _refuse(404, "STEP_SECRET_NOT_BOUND")
    registry = await _registry(h, plannable=False)
    try:
        # Checked now, not as it was at submit: the trust rule over every step of the
        # run, the piece's declaration, and the destination rule on what the step
        # finally receives.
        if stored_source.check_plan(plan_json, registry, caller, ()):
            raise _refuse(403, "SECRET_PIECE_NOT_TRUSTED", step=step)
        _check_secret_run_trust(plan_json, registry, caller)
        await _check_run_conflict(h, caller, registry, this_run=run_id, secrets_here=True,
                                  untrusted_here=False)
        tapis.generate_tapis_workflow({"id": run_id, "plan_json": plan_json})
    except HTTPException as refusal:
        raise _refuse(refusal.status_code, refusal.detail["code"], step=step)
    except step_secrets.StepSecretError as refusal:
        raise _refuse(refusal.status, refusal.detail["code"], step=step)
    except (ValueError, KeyError, TypeError):
        raise _refuse(409, "STEP_SECRET_PLAN_UNBUILDABLE", step=step)

    store = secrets_store.FernetSecretStore(h)
    values: dict[str, str] = {}
    rows: list[tuple[dict[str, Any], int]] = []
    for item in entry["secrets"]:
        try:
            found = await store.get(item["id"])
        except secrets_store.SecretError:
            raise _refuse(503, "SECRET_UNREADABLE")
        if found is None:
            raise _refuse(409, "SECRET_REMOVED")
        row, fields = found
        if (row.get("scope") != secrets_store.SCOPE_USER or row.get("owner_username") != caller
                or row.get("name") != item.get("name") or row.get("configuration_id") != ""
                or int(row["version"]) != int(item["version"])):
            raise _refuse(409, "FLOW_SECRET_CHANGED")
        try:
            for env_key, field_name in (item.get("env") or {}).items():  # task input -> field
                values[env_key] = fields[field_name]
        except KeyError:
            raise _refuse(409, "SECRET_FIELDS_INCOMPLETE")
        rows.append((row, int(row["version"])))

    # The audit event is written first, as the intent to release: a failure after the
    # claim can never leave a release unrecorded. A response lost after the claim is
    # not retried; the credential is spent, the step fails, and submitting the flow
    # again is the recovery (see docs/api.md).
    for row, version in rows:
        await secrets_store.record_event(h, "issued", row, run_id=run_id, actor="step",
                                         token_kind="step_secret", version=version)

    # Consumed only once the answer is fully assembled, so a transient failure above
    # never burns the credential. Compare-and-set on the whole column; a concurrent
    # change by another step's fetch is read again and tried once more.
    for attempt in range(3):
        claimed = await h.execute(ISSUE_STEP_SECRETS_IF, {
            "id": run_id, "was": run["bound_secrets"],
            "now": step_secrets.mark_issued(run["bound_secrets"], step, now.isoformat())})
        if (claimed.get("update_adapter_workflow_run") or {}).get("affected_rows", 0) == 1:
            break
        fresh = (await h.execute(GET_RUN_STEP_SECRETS, {"id": run_id}))["adapter_workflow_run_by_pk"] or {}
        again = next((e for e in step_secrets.bound_steps(fresh.get("bound_secrets")) or []
                      if e.get("step") == step), None)
        if again is None or again.get("issued") or str(fresh.get("status")) not in _STEP_SECRET_ACTIVE:
            raise _refuse(409, "STEP_SECRET_ALREADY_ISSUED")
        run = fresh
    else:
        raise _refuse(409, "STEP_SECRET_ALREADY_ISSUED")

    for row, _version in rows:
        await store.touch(row["id"])
    await h.execute(INSERT_PROVENANCE, {"obj": {
        "workflow_run_id": run_id, "event_type": "run.step_secret.issued",
        "payload_json": {"step": step, "secrets": [f"{r['name']}@v{v}" for r, v in rows]},
    }})
    secrets_store.register_values(values.values())
    return JSONResponse({"inputs": values}, headers=_NO_STORE)


# --- admin seeding of model-owner secrets (Phase A) -------------------------
class AdminSecretIn(BaseModel):
    scope: str = "model_owner"
    owner_username: str
    configuration_id: str
    name: str
    fields: dict[str, str]
    acknowledged: bool = False


class AdminSecretRefIn(BaseModel):
    scope: str = "model_owner"
    owner_username: str
    configuration_id: str
    name: str


@app.exception_handler(step_secrets.StepSecretError)
async def _step_secret_error_handler(request: Request, exc: step_secrets.StepSecretError):
    """A refusal about a step's secrets: its status and code, never a value."""
    return JSONResponse({"detail": exc.detail}, status_code=exc.status, headers=_NO_STORE)


@app.exception_handler(RequestValidationError)
async def _validation_error_handler(request: Request, exc: RequestValidationError):
    """FastAPI's default 422 echoes each offending ``input``; on the secret
    routes that would reflect the credential back, so strip it (and ``ctx``)."""
    errors = exc.errors()
    if request.url.path.startswith(("/admin/secrets", "/secrets")):
        errors = [{k: v for k, v in e.items() if k not in {"input", "ctx", "url"}} for e in errors]
    return JSONResponse({"detail": jsonable_encoder(errors)}, status_code=422)


def _admin_secret_guard(admin_secret: str | None) -> None:
    """Only the dedicated secrets-admin secret opens /admin/secrets; there is
    no fallback to the Hasura admin or Ensemble Manager secrets."""
    expected = settings.secrets_admin_secret
    if not expected:
        raise HTTPException(503, detail={"code": "SECRETS_ADMIN_NOT_CONFIGURED",
                                         "message": "no secrets admin secret is configured"})
    if not (admin_secret and hmac.compare_digest(admin_secret.encode(), expected.encode())):
        raise HTTPException(403, detail={"code": "SECRETS_ADMIN_AUTH_REQUIRED"})
    if not secrets_store.secrets_configured():
        raise HTTPException(503, detail={"code": "SECRETS_NOT_CONFIGURED",
                                         "message": "no secrets encryption key is configured"})


def _require_owner_configuration(configuration_id: str) -> None:
    """A model owner's secret always belongs to a configuration. An empty one
    would mean the same as a runner's own secret (``scope='user'``)."""
    if not configuration_id.strip():
        raise HTTPException(422, detail={"code": "SECRET_CONFIGURATION_REQUIRED",
                                         "message": "a model-owner secret needs a configuration_id"})


@app.put("/admin/secrets", tags=["Integrations"])
async def admin_put_secret(
    body: AdminSecretIn,
    internal_secret: str | None = Header(None, alias="X-Secrets-Admin-Secret"),
):
    """Store or replace a model-owner secret. Returns metadata, never values."""
    secrets_store.register_values(body.fields.values())
    _admin_secret_guard(internal_secret)
    if body.scope != secrets_store.SCOPE_MODEL_OWNER:
        raise HTTPException(422, detail={"code": "SECRET_SCOPE_UNSUPPORTED"})
    _require_owner_configuration(body.configuration_id)
    if not body.acknowledged:
        raise HTTPException(422, detail={
            "code": "ACKNOWLEDGEMENT_REQUIRED",
            "message": "the owner must acknowledge that every runner's Tapis job record shows these values"})
    h = get_client(None)
    try:
        secrets_store.validate_name(body.name)
        secrets_store.validate_fields(body.fields)
        configuration = await secrets_store.fetch_configuration(h, body.configuration_id)
        if not configuration:
            raise HTTPException(404, detail={"code": "CONFIGURATION_NOT_FOUND"})
        if not configuration.get("owner_username"):
            raise HTTPException(422, detail={"code": "SECRET_OWNER_UNSET",
                                             "message": secrets_store.OWNER_UNSET_MESSAGE})
        if configuration["owner_username"] != body.owner_username:
            raise HTTPException(403, detail={"code": "SECRET_OWNER_MISMATCH",
                                             "message": "only the configuration's owner may store its secrets"})
        if not (configuration.get("tapis_app_id") and configuration.get("tapis_app_version")):
            raise HTTPException(422, detail={"code": "CONFIGURATION_APP_UNKNOWN"})
        declaration = next((d for d in secrets_store.parse_declarations(configuration)
                            if d.name == body.name), None)
        if declaration is None:
            raise HTTPException(422, detail={"code": "SECRET_NOT_DECLARED",
                                             "message": "the configuration declares no secret by this name"})
        if not set(declaration.env) <= set(body.fields):
            raise HTTPException(422, detail={"code": "SECRET_FIELDS_INCOMPLETE",
                                             "fields": declaration.fields})
        saved = await secrets_store.FernetSecretStore(h).put(
            scope=body.scope, owner=body.owner_username, name=body.name,
            configuration_id=body.configuration_id,
            pinned_app_id=str(configuration["tapis_app_id"]),
            pinned_app_version=str(configuration["tapis_app_version"]),
            fields=body.fields, actor="admin")
    except secrets_store.SecretResolutionError as exc:
        raise HTTPException(exc.status, detail=exc.detail)
    except secrets_store.SecretError as exc:
        raise HTTPException(422, detail={"code": "SECRET_INVALID", "message": str(exc)})
    return saved


@app.delete("/admin/secrets", tags=["Integrations"])
async def admin_delete_secret(
    body: AdminSecretRefIn,
    internal_secret: str | None = Header(None, alias="X-Secrets-Admin-Secret"),
):
    """Delete a stored secret. Returns metadata of the removed row."""
    _admin_secret_guard(internal_secret)
    if body.scope == secrets_store.SCOPE_MODEL_OWNER:
        _require_owner_configuration(body.configuration_id)
    store = secrets_store.FernetSecretStore(get_client(None))
    row = await store.find(body.scope, body.owner_username, body.name, body.configuration_id)
    if not row:
        raise HTTPException(404, detail={"code": "SECRET_NOT_FOUND"})
    await store.delete(row, actor="admin")
    return row


# --- a runner's own secrets (scope 'user') ----------------------------------
# Stored, listed and deleted with the runner's own Tapis token. No route returns a
# value. The adapter reads and writes the tables with its admin client; no Hasura
# role has any permission on them (graphql_engine/tests/test_adapter_secret_metadata.py).
class UserSecretIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fields: dict[str, StrictStr]


_SECRET_CHANGE_RATE: dict[str, list[float]] = {}
_SECRET_CHANGE_RATE_WINDOW = 600.0
_SECRET_CHANGE_RATE_LIMIT = 20
_NO_STORE = {"Cache-Control": "no-store"}


def _secret_change_rate_ok(username: str, now_ts: float) -> bool:
    stamps = [t for t in _SECRET_CHANGE_RATE.get(username, []) if now_ts - t < _SECRET_CHANGE_RATE_WINDOW]
    ok = len(stamps) < _SECRET_CHANGE_RATE_LIMIT
    if ok:
        stamps.append(now_ts)
    _SECRET_CHANGE_RATE[username] = stamps
    return ok


async def _secret_caller(authorization: str | None) -> str:
    """The signed-in caller (Tapis says who the token belongs to), or 401; 503
    when the store has no encryption key."""
    username = await _require_signed_in(_bearer(authorization))
    if not username:
        raise HTTPException(401, detail={"code": "TAPIS_AUTH_REQUIRED",
                                         "message": "a valid Tapis bearer token is required"})
    if not secrets_store.secrets_configured():
        raise HTTPException(503, detail={"code": "SECRETS_NOT_CONFIGURED",
                                         "message": "no secrets encryption key is configured"})
    return username


async def _guard_secret_change(h, username: str, token: str | None) -> None:
    """Rate limit, then refuse while the caller has a run in progress: a step of
    that run holds the same token and could otherwise swap the stored secret.

    A run stored as active may have finished in Tapis long ago, so the caller's open
    runs are reconciled first (bounded: poller.reconcile_open_runs) and only those
    Tapis still reports active block the change. A run that cannot be checked, for
    any reason, stays open and blocks it: this never fails open."""
    if not _secret_change_rate_ok(username, time.time()):
        raise HTTPException(429, detail={"code": "SECRET_RATE_LIMITED"}, headers=_NO_STORE)
    runs = await secrets_store.user_active_runs(h, username)
    if runs and token:
        from . import poller  # noqa: PLC0415 — deferred, as in lifespan
        await poller.reconcile_open_runs(h, runs, token)
        runs = await secrets_store.user_active_runs(h, username)
    if runs:
        run_id = runs[0]["id"]
        raise HTTPException(409, detail={
            "code": "SECRET_LOCKED_BY_RUN", "run_id": run_id,
            "message": f"you have a run in progress (run {run_id}); "
                       "change this credential when it has finished"},
            headers=_NO_STORE)


def _user_secret_summary(row: dict[str, Any], *, last_used: bool = False) -> dict[str, Any]:
    out = {"name": row["name"], "fields": secrets_store.text_array(row.get("fields")),
           "version": row["version"], "created_at": row.get("created_at"),
           "updated_at": row.get("updated_at")}
    if last_used:
        out["last_used_at"] = row.get("last_used_at")
    return out


@app.put("/secrets/{name}", tags=["Integrations"])
async def put_user_secret(
    name: str,
    body: UserSecretIn,
    authorization: str | None = Header(None),
):
    """Store or replace the caller's own secret. Returns names and dates, never values."""
    secrets_store.register_values(body.fields.values())
    username = await _secret_caller(authorization)
    h = get_client(None)
    await _guard_secret_change(h, username, _bearer(authorization))
    try:
        secrets_store.validate_name(name)
        secrets_store.validate_fields(body.fields)
        saved = await secrets_store.FernetSecretStore(h).put(
            scope=secrets_store.SCOPE_USER, owner=username, name=name, configuration_id="",
            pinned_app_id="", pinned_app_version="", fields=body.fields, actor=username)
    except secrets_store.SecretError as exc:
        raise HTTPException(422, detail={"code": "SECRET_INVALID", "message": str(exc)})
    return JSONResponse(jsonable_encoder(_user_secret_summary(saved)), headers=_NO_STORE)


@app.get("/secrets", tags=["Integrations"])
async def list_user_secrets(authorization: str | None = Header(None)):
    """The caller's own secrets: name, field names and dates. Never values."""
    username = await _secret_caller(authorization)
    rows = await secrets_store.list_user_secrets(get_client(None), username)
    return JSONResponse(jsonable_encoder([_user_secret_summary(r, last_used=True) for r in rows]), headers=_NO_STORE)


@app.delete("/secrets/{name}", tags=["Integrations"])
async def delete_user_secret(name: str, authorization: str | None = Header(None)):
    """Delete the caller's own secret. 404 when they have none by that name."""
    username = await _secret_caller(authorization)
    h = get_client(None)
    await _guard_secret_change(h, username, _bearer(authorization))
    store = secrets_store.FernetSecretStore(h)
    row = await store.find(secrets_store.SCOPE_USER, username, name, "")
    if not row:
        raise HTTPException(404, detail={"code": "SECRET_NOT_FOUND"}, headers=_NO_STORE)
    await store.delete(row, actor=username)
    return JSONResponse(jsonable_encoder(_user_secret_summary(row)), headers=_NO_STORE)


_TOKEN_FETCH_RATE: dict[str, list[float]] = {}
_TOKEN_FETCH_RATE_WINDOW = 600.0


def _token_fetch_rate_ok(run_id: str, now_ts: float) -> bool:
    stamps = [t for t in _TOKEN_FETCH_RATE.get(run_id, []) if now_ts - t < _TOKEN_FETCH_RATE_WINDOW]
    if len(stamps) >= max(1, settings.run_token_fetch_rate_limit):
        _TOKEN_FETCH_RATE[run_id] = stamps
        return False
    stamps.append(now_ts)
    _TOKEN_FETCH_RATE[run_id] = stamps
    return True


@app.post("/runs/{run_id}/token", tags=["Core: Runs"])
async def fetch_run_token(
    run_id: str,
    request: Request,
    fetch_token: str | None = Header(None, alias="X-Run-Token-Credential"),
    fetch_expires: str | None = Header(None, alias="X-Run-Token-Expires"),
):
    """Hand the composite model task the run's current Tapis token.

    For a task the Workflows engine starts after the token in its args has
    expired (see run_tokens.py, token lifecycle design rev 2). Authenticated by
    a per-run HMAC credential in its own domain, checked before any database
    access; a bad credential and an unknown run get the same 401. Serves only
    non-terminal runs inside the keeper deadline, and mints a successor on the
    way out when the stored token is close to expiry. The token appears in
    this response and nowhere else; the response is marked uncacheable.
    """
    unavailable = HTTPException(404, detail={"code": "RUN_TOKEN_UNAVAILABLE"})
    if not run_tokens.keeper_configured():
        raise unavailable
    if not run_state.verify_token_fetch_credential(run_id, fetch_expires, fetch_token):
        raise HTTPException(401, detail={"code": "RUN_TOKEN_FETCH_REJECTED"})
    now = datetime.now(tz=timezone.utc)
    if not _token_fetch_rate_ok(run_id, now.timestamp()):
        raise HTTPException(429, detail={"code": "RUN_TOKEN_FETCH_RATE_LIMITED"})

    from . import poller  # noqa: PLC0415 — deferred, as in lifespan
    h = get_client(None)
    state = (await h.execute(poller.GET_RUN_TOKEN_STATE, {"id": run_id}))["adapter_workflow_run_by_pk"]
    if not state:
        raise HTTPException(401, detail={"code": "RUN_TOKEN_FETCH_REJECTED"})
    audit = {"client_ip": request.client.host if request.client else None,
             "forwarded_for": request.headers.get("x-forwarded-for"),
             "user_agent": (request.headers.get("user-agent") or "")[:120],
             "requested_at": now.isoformat()}

    async def refuse(reason: str):
        await h.execute(INSERT_PROVENANCE, {"obj": {
            "workflow_run_id": run_id, "event_type": "run.token.refused",
            "payload_json": {**audit, "reason": reason}}})
        raise unavailable

    deadline = run_state.parse_ts(state.get("run_token_deadline_at"))
    if str(state.get("status") or "") not in {"running", "submitting"}:
        if state.get("run_token_enc"):
            # A row that ended without the clear (e.g. stuck in `cancelling`)
            # still holds a token; this is the moment to drop it.
            await poller.release_run_token(h, run_id, "run_not_active", state=state)
            await h.execute(UPDATE_RUN, {"id": run_id, "set": run_state.clear_token_update()})
        await refuse("run_not_active")
    if not state.get("run_token_enc"):
        await refuse("no_stored_token")
    if deadline and now >= deadline:
        await poller.release_run_token(h, run_id, "deadline", state=state)
        await h.execute(UPDATE_RUN, {"id": run_id, "set": run_state.clear_token_update()})
        await refuse("deadline_passed")

    try:
        token = run_tokens.decrypt_run_token(run_id, state["run_token_enc"])
    except run_tokens.RunTokenError:
        await h.execute(UPDATE_RUN, {"id": run_id, "set": run_state.clear_token_update()})
        await refuse("decrypt_failed")
    expires_at = run_state.parse_ts(state.get("run_token_expires_at")) or run_tokens.token_expires_at(token)
    if expires_at and expires_at <= now:
        await h.execute(UPDATE_RUN, {"id": run_id, "set": run_state.clear_token_update()})
        await refuse("stored_token_expired")

    renewed = False
    if run_tokens.renewal_due(expires_at, now):
        outcome = await poller.renew_stored_token(h, state, token, now=now)
        if outcome is not None:
            token, expires_at = outcome
            renewed = True

    await h.execute(INSERT_PROVENANCE, {"obj": {
        "workflow_run_id": run_id, "event_type": "run.token.fetched",
        "payload_json": {**audit, "renewed": renewed,
                         "expires_at": expires_at.isoformat() if expires_at else None},
    }})
    return JSONResponse(
        {"token": token, "expires_at": expires_at.isoformat() if expires_at else None},
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


@app.post("/runs/{run_id}/cancel", tags=["Core: Runs"])
async def cancel_run(run_id: str, request: Request, authorization: str | None = Header(None)):
    """Terminate the Workflows run and, when verified, cancel its Tapis job.

    A destructive write, so unlike /poll it needs the caller's identity: the
    bearer is resolved through Tapis userinfo and must match the submitter
    or be a configured cancel admin. `cancelled` is final; /poll never
    revises it.
    """
    token = _bearer(authorization)
    if not token:
        raise HTTPException(401, "log in with a Tapis token to cancel this run")
    h = get_client(token)
    run = (await h.execute(GET_RUN, {"id": run_id}))["adapter_workflow_run_by_pk"]
    if not run:
        raise HTTPException(404, "run not found")
    status = str(run.get("status") or "")
    # A run stopped at its pause is `completed` in the adapter's words but is not over.
    awaiting = await _awaiting_state(h, run)
    if status in run_state.TERMINAL_STATUSES and awaiting is None:
        return {"run_id": run_id, "status": status, "already_terminal": True}

    username = await run_in_threadpool(tapis.userinfo_username, token)
    if not username:
        raise HTTPException(401, detail={"code": "RUN_CANCEL_IDENTITY_UNKNOWN",
                                         "message": "Tapis did not confirm the caller's identity"})
    if not run_state.may_cancel(run, username):
        raise HTTPException(403, detail={"code": "RUN_CANCEL_FORBIDDEN",
                                         "message": "only the submitter or a cancel admin may cancel this run"})
    if awaiting is not None:
        # No Tapis run is open during a pause, so there is nothing to terminate.
        now = datetime.now(tz=timezone.utc)
        claimed = await h.execute(UPDATE_RUN_IF, {"id": run_id, "status": status, "set": {
            "status": "cancelled", "error_message": f"Cancelled by {username}"}})
        if (claimed.get("update_adapter_workflow_run") or {}).get("affected_rows", 0) != 1:
            raise HTTPException(409, detail={"code": "RUN_STATUS_CHANGED",
                                             "message": "the run changed state; reload and retry"})
        await h.execute(INSERT_PROVENANCE, {"obj": {
            "workflow_run_id": run_id, "event_type": "run.cancelled",
            "payload_json": {"username": username, "awaiting_edit": True, "requested_at": now.isoformat()}}})
        return {"run_id": run_id, "status": "cancelled", "terminated": False, "awaiting_edit": True}
    pipeline_id = run.get("tapis_workflow_id")
    run_uuid = run.get("tapis_run_id")
    if not (pipeline_id and run_uuid):
        raise HTTPException(409, detail={"code": "RUN_NOT_DISPATCHED",
                                         "message": "this run has no Tapis Workflows run to terminate"})

    now = datetime.now(tz=timezone.utc)
    if status != "cancelling":
        claimed = await h.execute(UPDATE_RUN_IF, {"id": run_id, "status": status, "set": {"status": "cancelling"}})
        if (claimed.get("update_adapter_workflow_run") or {}).get("affected_rows", 0) != 1:
            raise HTTPException(409, detail={"code": "RUN_STATUS_CHANGED",
                                             "message": "the run changed state; reload and retry"})

    terminated, terminate_code = await run_in_threadpool(
        tapis.terminate_pipeline_run, token, pipeline_id, run_uuid,
    )
    job_cancelled: bool | None = None
    job_code: int | None = None
    if terminated and run.get("model_job_uuid") and run.get("model_job_verified"):
        job_cancelled, job_code = await run_in_threadpool(tapis.cancel_job, token, run["model_job_uuid"])

    audit = {
        "username": username,
        "client_ip": request.client.host if request.client else None,
        "terminate_http_status": terminate_code,
        "job_uuid": run.get("model_job_uuid") if job_cancelled is not None else None,
        "job_cancel_http_status": job_code,
        "requested_at": now.isoformat(),
    }
    if terminated and job_cancelled is not False:
        from . import poller  # noqa: PLC0415 — deferred, as in lifespan
        released = await poller.release_run_token(h, run_id, "cancelled")
        await h.execute(UPDATE_RUN_IF, {"id": run_id, "status": "cancelling", "set": {
            "status": "cancelled", "completed_at": now.isoformat(),
            "error_message": f"Cancelled by {username}",
            **(run_state.clear_token_update() if run_tokens.keeper_configured() else {}),
        }})
        await h.execute(INSERT_PROVENANCE, {"obj": {
            "workflow_run_id": run_id, "event_type": "run.cancelled", "payload_json": audit,
        }})
        return {"run_id": run_id, "status": "cancelled", "terminated": True,
                "job_cancelled": job_cancelled}

    failure = (f"Tapis Workflows terminate returned HTTP {terminate_code}" if not terminated
               else f"Tapis job cancel returned HTTP {job_code}")
    await h.execute(UPDATE_RUN, {"id": run_id, "set": {
        "error_message": safe_error_message(f"Cancel requested by {username}; {failure}"),
    }})
    await h.execute(INSERT_PROVENANCE, {"obj": {
        "workflow_run_id": run_id, "event_type": "run.cancel_failed",
        "payload_json": {**audit, "failure": failure},
    }})
    raise HTTPException(502, detail={
        "code": "RUN_CANCEL_INCOMPLETE", "message": failure,
        "terminated": terminated, "job_cancelled": job_cancelled, "status": "cancelling",
    })


_CKAN_DOWNLOAD = re.compile(r"^/dataset/([^/]+)/resource/([^/]+)/download/([^/]+)$")


def _check_replacement_url(url: str, replacement: Any) -> None:
    """The edited file must be exactly a data-catalog resource download: an https
    address on the catalog's own host (the one host the gather step sends the runner's
    token to), ``/dataset/<dataset>/resource/<resource id>/download/<file>``, with the
    resource id given and the same as the address's. No query, no fragment: a signed
    link is not accepted. The path is decoded before it is judged, so ``%2e%2e`` and
    ``%2f`` are what they would be."""
    refuse = lambda message: HTTPException(422, detail={  # noqa: E731
        "code": "FLOW_REPLACEMENT_REFUSED", "message": message})
    catalog = (settings.flow_collection_catalog_host or "").strip().lower()
    try:
        place = gather_fetch.check_url(url)
    except ValueError as error:
        raise refuse(f"the edited file's address is not allowed: {error}")
    if place["scheme"] != "https" or not catalog or place["host"] != catalog:
        raise refuse("the edited file must be uploaded to the data catalog, and given by its catalog address")
    if "?" in url or "#" in url or "?" in place["target"]:
        raise refuse("the edited file's address may not carry a query or a fragment")
    for name in ("dataset_id", "resource_id"):
        value = getattr(replacement, name)
        if value is not None and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,199}", value):
            raise refuse(f"{name} is not a catalog id")
    if not replacement.resource_id:
        raise refuse("resource_id is required: it is the resource at the address")
    if re.search(r"%(2f|5c|2e|00)", place["target"], re.IGNORECASE):
        # An encoded slash, backslash, dot or NUL has no place in a catalog file address.
        raise refuse("the edited file's address must be a catalog resource download: "
                     "/dataset/<dataset>/resource/<resource id>/download/<file>")
    decoded = urllib.parse.unquote(place["target"])
    found = _CKAN_DOWNLOAD.match(decoded)
    if not found or any(part in (".", "..") for part in found.groups()) or "\\" in decoded:
        raise refuse("the edited file's address must be a catalog resource download: "
                     "/dataset/<dataset>/resource/<resource id>/download/<file>")
    if found.group(2) != replacement.resource_id:
        raise refuse("resource_id is not the resource at that address")


@app.post("/runs/{run_id}/resume", tags=["Core: Runs"])
async def resume_run(run_id: str, body: ResumeRunIn, request: Request, authorization: str | None = Header(None)):
    """Continue a run stopped at its pause, on the user's edited copy of its file.

    Only the run's submitter may resume it. The edit is a file the submitter
    uploaded to the data catalog; the next segment's first step fetches it as the
    runner, refuses a file the pieces could not load, and stores it in the run's
    folder. Segment 2 is its own pipeline and its own run, started under a token
    minted now, with the secrets of its own steps bound now. A resume after a
    failed continuation starts another segment 2; the earlier one stays on record.
    """
    if not settings.flow_pause_enabled:
        raise HTTPException(422, detail={"code": "FLOW_PAUSE_DISABLED",
                                         "message": "this service is not set up to pause flows"})
    token = _bearer(authorization)
    if not token:
        raise HTTPException(401, "log in with a Tapis token to resume this run")
    h = get_client(token)
    run = (await h.execute(GET_RUN_SEGMENT, {"id": run_id}))["adapter_workflow_run_by_pk"]
    if not run:
        raise HTTPException(404, "run not found")
    username = await _caller_or_none(token)
    if not username:
        raise HTTPException(401, detail={"code": "TAPIS_AUTH_REQUIRED",
                                         "message": "Tapis did not confirm the caller's identity"})
    if run.get("submitted_by") != username:
        raise HTTPException(403, detail={"code": "RUN_RESUME_FORBIDDEN",
                                         "message": "only the user who started this run may resume it"})
    # What the claim below is made against: the run as it was when it was found paused.
    previous = run.get("resumed_run_id")
    awaiting = await _awaiting_state(h, run)
    if awaiting is None:
        raise HTTPException(409, detail={"code": "RUN_NOT_AWAITING_EDIT",
                                         "message": "this run is not stopped at a pause"})

    plan = (await h.execute(GET_PLAN, {"id": run.get("workflow_plan_id")}))["adapter_workflow_plan_by_pk"]
    plan_json = (plan or {}).get("plan_json") or {}
    pause = run.get("paused_after_step")
    refused = flow_segments.problem(plan_json)
    if refused or flow_segments.pause_of(plan_json) != pause:
        raise HTTPException(422, detail=refused or {
            "code": flow_segments.CODE_INVALID, "message": "the plan no longer pauses where this run did"})
    declared = next(d for d in flow_segments.editable_outputs(plan_json) if d.get("step") == pause)
    key = flow_segments.output_key(declared)
    if set(body.replacements) != {key}:
        raise HTTPException(422, detail={
            "code": "FLOW_REPLACEMENT_NOT_EDITABLE", "editable": [key],
            "message": "a resume replaces the one editable output of the paused step, and nothing else"})
    replacement = body.replacements[key]
    _check_replacement_url(replacement.url, replacement)

    # What the first segment reported, read as the runner.
    if not (run.get("tapis_workflow_id") and run.get("tapis_run_id")):
        raise HTTPException(409, detail={"code": "RUN_NOT_DISPATCHED", "message": "this run has no Tapis run to read"})
    try:
        detail = await run_in_threadpool(
            tapis.get_run_detail, run["tapis_workflow_id"], run["tapis_run_id"], token=token)
    except Exception as error:  # noqa: BLE001
        raise HTTPException(502, detail={
            "code": "FLOW_RESUME_REPORT_UNAVAILABLE",
            "message": safe_error_message(f"could not read what the first part of the run reported: {error}")})
    steps = {int(step["step"]): step for step in plan_json.get("steps") or []}
    edited_id = (tapis.flow_output_ids(steps[pause]) or {"outputs": {}})["outputs"].get(str(declared["output"]))
    task = next((t for t in detail.get("tasks") or []
                 if isinstance(t, dict) and t.get("task_id") == flow_run.task_id(steps[pause])), None)
    paused_value = flow_run.reported_outputs((task or {}).get("stdout")).get(edited_id)
    try:
        later, needed = flow_segments.second_segment(
            plan_json, pause, merge_key=flow_segments.merge_key_for(plan_json, pause, paused_value))
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(422, detail={"code": "FLOW_DOES_NOT_BUILD", "message": str(error)}) from error
    values, missing = flow_segments.resume_values(plan_json, needed, detail)
    if missing or not isinstance(paused_value, str):
        raise HTTPException(409, detail={
            "code": "FLOW_RESUME_VALUE_MISSING", "arguments": missing,
            "message": "the first part of the run did not report a value the rest needs"})
    # What the first segment printed is data from a piece: it is passed on only if it
    # is a location the gather rules allow, and holds nothing that looks like a credential.
    unusable = flow_segments.refused_values(values, needed)
    if unusable:
        raise HTTPException(409, detail={
            "code": "FLOW_RESUME_VALUE_REFUSED", "arguments": unusable,
            "message": "the first part of the run reported a value that cannot be passed on"})

    # The checks a submit makes, on the steps this segment runs and the pieces as
    # they are now: stored source, then secrets and conflicts.
    registry = await _registry(h, plannable=False)
    recorded = plan_json.get("stored_source_opt_in") or {}
    opt_in = recorded.get("piece_ids") or [] if recorded.get("username") == username else []
    problems = stored_source.check_plan(plan_json, registry, username, opt_in)
    if problems:
        raise HTTPException(403, detail={"code": "STORED_SOURCE_REFUSED", "problems": problems})
    flow_bound = await _bind_flow_secrets_and_check_conflict(
        h, token, later, has_model_task=False, dry_run=False)

    service_args = dict((run.get("segment_json") or {}).get("args") or {})
    taken = sorted((set(values) | {flow_segments.EDIT_URL_ARG}) & set(service_args))
    if taken:
        # A user's value is never replaced by a reported one.
        raise HTTPException(409, detail={
            "code": "FLOW_RESUME_ARGUMENT_CLASH", "arguments": taken,
            "message": "the run was started with a value for an argument the resume sets itself"})
    service_args.update(values)
    service_args[flow_segments.EDIT_URL_ARG] = replacement.url
    service_args["tapis_base_url"] = settings.tapis_base_url
    if not _staging_given(service_args):
        raise HTTPException(409, detail={"code": "FLOW_STAGING_UNRESOLVED",
                                         "message": "the first part of the run left no staging folder to continue in"})
    child_id = str(uuid.uuid4())
    pipeline = tapis.generate_tapis_workflow({
        **plan, "id": flow_segments.segment_pipeline_id(plan["id"], 2), "plan_json": later})
    args = _validate_plan_args(later, service_args, token, require_required=True)

    # Claim the resume before anything is recorded or submitted: of two at once, one wins.
    claimed = await h.execute(
        RESUME_RETRY_IF if previous else RESUME_RUN_IF,
        {"id": run_id, "child": child_id, **({"was": previous} if previous else {})})
    if (claimed.get("update_adapter_workflow_run") or {}).get("affected_rows", 0) != 1:
        raise HTTPException(409, detail={"code": "RUN_STATUS_CHANGED",
                                         "message": "the run was resumed or cancelled meanwhile; reload"})
    try:
        return await _start_second_segment(
            h, token, username, run, run_id, previous, child_id, pipeline, args, later, flow_bound,
            plan_json, detail, key, declared, replacement)
    except BaseException:
        # Whatever went wrong before the next segment was handed to Tapis, the run is
        # let go: it is paused again, and the user may try again. (A refusal by Tapis
        # itself is recorded as a failed segment two, which also pauses it again.)
        await _release_resume_claim(h, run_id, child_id, previous)
        raise


async def _release_resume_claim(h: Any, run_id: str, child_id: str, previous: str | None) -> None:
    """Undo the claim of a resume that did not get as far as a submitted segment. The
    child row, if it was written, is marked failed; the guarded write only moves the
    claim this resume made."""
    try:
        await h.execute(UPDATE_RUN_IF, {"id": child_id, "status": "submitting", "set": {
            "status": "failed", "error_message": "the resume did not complete"}})
    except Exception:  # noqa: BLE001 — there may be no such row
        pass
    try:
        await h.execute(RESUME_ROLLBACK_IF, {"id": run_id, "child": child_id, "was": previous})
    except Exception:  # noqa: BLE001 — the awaiting state also treats a missing child as paused
        log.warning("could not release the resume claim of run %s", run_id)


async def _start_second_segment(
    h: Any, token: str | None, username: str, run: dict[str, Any], run_id: str, previous: str | None,
    child_id: str, pipeline: dict[str, Any], args: dict[str, Any], later: dict[str, Any],
    flow_bound: list[dict[str, Any]], plan_json: dict[str, Any], detail: dict[str, Any], key: str,
    declared: dict[str, Any], replacement: Any,
) -> dict[str, Any]:
    """Record segment two, bind its credentials and hand it to Tapis. Called after the
    claim, so that the run token is minted only for a resume that won it."""
    args = await _with_run_token(args, token)
    now = datetime.now(tz=timezone.utc)
    shown = flow_run.view(plan_json, detail, awaiting_edit=True) or {"outputs": []}
    original = next((o.get("file_location") for o in shown["outputs"] if o.get("key") == key), None)
    edit = {"output": key, "file": declared["editable"].get("file"),
            "check": declared["editable"].get("check") or None, "url": replacement.url.split("?", 1)[0],
            "dataset_id": replacement.dataset_id, "resource_id": replacement.resource_id,
            "replaced_by": username, "replaced_at": now.isoformat(),
            "original": original}
    run_obj: dict[str, Any] = {
        "id": child_id, "workflow_plan_id": run["workflow_plan_id"], "tapis_workflow_id": pipeline["id"],
        "status": "submitting", "submitted_by": username, "parent_run_id": run_id,
        "segment_json": {"replacement": edit},
    }
    if run.get("execution_id"):
        run_obj["execution_id"] = run["execution_id"]
    if flow_bound:
        run_obj["bound_secrets"] = {"steps": flow_bound}
    child = (await h.execute(INSERT_RUN, {"obj": run_obj}))["insert_adapter_workflow_run_one"]
    for entry in flow_bound:
        for item in entry["secrets"]:
            await secrets_store.record_event(
                h, "bound", {"id": item["id"], "scope": secrets_store.SCOPE_USER, "name": item["name"],
                             "owner_username": username, "configuration_id": ""},
                run_id=child["id"], actor=username, version=item["version"])
    await h.execute(INSERT_PROVENANCE, {"obj": {
        "workflow_run_id": run_id, "event_type": "run.resumed",
        "payload_json": {"resumed_by": username, "run_id": child["id"], "at": now.isoformat(),
                         "retry_of": previous}}})
    await h.execute(INSERT_PROVENANCE, {"obj": {
        "workflow_run_id": child["id"], "event_type": "workflow_submit_requested",
        "payload_json": {"plan_id": run["workflow_plan_id"], "dry_run": False, "resumes": run_id}}})
    if flow_bound:
        expires = int(time.time()) + step_secrets.pipeline_seconds(
            pipeline, settings.stored_source_max_exec_seconds) + step_secrets.CREDENTIAL_SLACK_SECONDS
        args[step_secrets.RUN_ID_ARG] = {"value": child["id"]}
        args[step_secrets.ADAPTER_URL_ARG] = {"value": settings.public_base_url.rstrip("/")}
        for entry in flow_bound:
            args[f"{step_secrets.TOKEN_ARG_PREFIX}{entry['step']}"] = {"value": step_secrets.make_credential(
                settings.step_secret_key, child["id"], entry["step"], entry["secrets"], expires)}
    try:
        # The edited file is part of this segment's gather task, so it is registered
        # afresh every time: a retry after a failed edit must not run the old one.
        result = await run_in_threadpool(
            tapis.submit_tapis_workflow, pipeline, args, token=token, run_name=None, recreate=True)
    except Exception as exc:  # noqa: BLE001
        error_message = safe_error_message(f"{type(exc).__name__}: {exc}")
        await h.execute(UPDATE_RUN, {"id": child["id"], "set": {"status": "failed", "error_message": error_message}})
        await h.execute(INSERT_PROVENANCE, {"obj": {
            "workflow_run_id": child["id"], "event_type": "workflow_submit_failed",
            "payload_json": {"code": "TAPIS_WORKFLOW_SUBMISSION_FAILED", "error_message": error_message}}})
        raise HTTPException(502, detail={
            "code": "TAPIS_WORKFLOW_SUBMISSION_FAILED", "message": "Tapis Workflows submission failed",
            "error_message": error_message, "run_id": child["id"]})
    try:
        await h.execute(UPDATE_RUN, {"id": child["id"], "set": {
            "status": "running", "tapis_run_id": result.get("uuid"),
            "dispatched_at": datetime.now(tz=timezone.utc).isoformat()}})
    except Exception:  # noqa: BLE001
        # Segment two is running in Tapis. Nothing after this point may undo the claim.
        log.warning("could not record the dispatch of resumed run %s", child["id"])
    return {"run_id": child["id"], "paused_run_id": run_id, "status": "running", **result}


def _staging_given(args: dict[str, Any]) -> bool:
    """Whether the replayed arguments carry the run's staging folder."""
    entry = args.get("flow_staging_uri")
    return bool(entry.get("value") if isinstance(entry, dict) else entry)


@app.get("/runs/{run_id}/provenance", tags=["Core: Runs"])
async def get_run_provenance(
    run_id: str,
    limit: int = Query(100, ge=1, le=500),
    authorization: str | None = Header(None),
    internal_secret: str | None = Header(None, alias="X-Ensemble-Manager-Secret"),
):
    """Return persisted provenance events associated with a workflow run."""
    reader = await _run_reader(authorization, internal_secret)
    h = get_client(_bearer(authorization))
    _require_run_reader(
        (await h.execute(GET_RUN, {"id": run_id}))["adapter_workflow_run_by_pk"], reader)
    data = await h.execute(GET_PROVENANCE, {"run_id": run_id, "limit": limit})
    return {"run_id": run_id, "events": data.get("adapter_provenance_event", [])}


@app.post("/runs/{run_id}/register-output", tags=["Core: Runs"])
async def register_output(
    run_id: str,
    body: RegisterOutputIn,
    authorization: str | None = Header(None),
    internal_secret: str | None = Header(None, alias="X-Ensemble-Manager-Secret"),
):
    _require_internal_service(
        internal_secret, "output registration is an internal Ensemble Manager operation")
    token = _bearer(authorization)
    h = get_client(token)
    owner = await _caller_or_none(token)
    output = body.output_data_object
    if output.id:
        _refuse_data_object_clash(
            (await h.execute(GET_DATA_OBJECT, {"id": output.id}))["adapter_data_object_by_pk"],
            owner, output.owner_execution_id)
    obj = output.model_dump(exclude_none=True)
    if owner:
        obj["owner_username"] = owner
    variables = obj.pop("variables", [])
    if variables:
        obj["variables"] = {"data": variables}
    created = (await h.execute(INSERT_DATA_OBJECT, {"obj": obj}))["insert_adapter_data_object_one"]
    await h.execute(INSERT_PROVENANCE, {"obj": {
        "workflow_run_id": run_id,
        "data_object_id": created["id"],
        "event_type": "output_registered",
        "payload_json": {"run_id": run_id},
    }})

    bound: dict[str, Any] | None = None
    if body.execution_id:
        bound = await _bind_output_to_execution(
            h, run_id=run_id, created=created, execution_id=body.execution_id,
        )

    return {"run_id": run_id, "output_data_object": created, "bound_to_execution": bound}


async def _bind_output_to_execution(
    h, *, run_id: str, created: dict[str, Any], execution_id: str,
) -> dict[str, Any]:
    """Upsert a resource row and insert an execution_data_binding so the
    registered output is visible as a bound input on the EM execution.

    Uses the admin-secret client (not the user JWT) because resource and
    execution_data_binding are in the public MINT schema and require broader
    write permissions than the adapter's own tables.

    Returns a summary dict; never raises — errors are captured and returned
    as {"error": ...} so the register-output call still succeeds even when
    the EM binding cannot be completed (e.g. execution_id doesn't exist yet).
    """
    # Admin client — the resource / execution_data_binding tables need it.
    admin = get_client(None)
    try:
        # Resolve the target DatasetSpecification from the plan the run was created from.
        run_row = (await h.execute(GET_RUN, {"id": run_id}))["adapter_workflow_run_by_pk"]
        ds_id: str | None = None
        if run_row and run_row.get("workflow_plan_id"):
            plan_row = (await h.execute(GET_PLAN, {"id": run_row["workflow_plan_id"]}))["adapter_workflow_plan_by_pk"]
            ds_id = (plan_row or {}).get("target_dataset_specification_id")

        if not ds_id:
            return {"error": "run has no target_dataset_specification_id — pass it in plan or supply model_io_id directly"}

        resource_uri = created.get("resource_uri")
        if not resource_uri:
            return {"error": "output data object has no resource_uri — cannot create EM resource row"}

        await admin.execute(UPSERT_RESOURCE, {"obj": {
            "id": created["id"],
            "name": created.get("label") or created["id"],
            "url": resource_uri,
        }})
        await admin.execute(INSERT_EXECUTION_DATA_BINDING, {"obj": {
            "execution_id": execution_id,
            "model_io_id": ds_id,
            "resource_id": created["id"],
        }})
        await h.execute(INSERT_PROVENANCE, {"obj": {
            "workflow_run_id": run_id,
            "data_object_id": created["id"],
            "event_type": "output_bound_to_execution",
            "payload_json": {"execution_id": execution_id, "model_io_id": ds_id,
                             "resource_id": created["id"]},
        }})
        return {"execution_id": execution_id, "model_io_id": ds_id, "resource_id": created["id"]}
    except Exception as exc:  # noqa: BLE001 — surface binding failures without blocking output registration
        return {"error": f"{type(exc).__name__}: {exc}"[:500], "execution_id": execution_id}


# --- NTGAM location -> forecast scenario (Phase 2/3) -----------------------
@app.get("/forecast/ntgam/options", tags=["NTGAM forecast"])
async def ntgam_options():
    """Registry-driven choices for the NTGAM forecast tab: available model layers,
    stress periods, extents (from the CKAN head rasters) + the forecast config's
    parameter defaults + which spatial inputs NTGAM can source. No hardcoded values."""
    try:
        return await run_in_threadpool(ntgam.options)
    except Exception as exc:  # noqa: BLE001 - surface CKAN/MINT connectivity cleanly
        raise HTTPException(502, f"could not load NTGAM options: {exc}")


@app.post("/forecast/scenario", tags=["NTGAM forecast"])
async def ntgam_scenario(body: dict[str, Any], authorization: str | None = Header(None)):
    """Plan-driven assembly: resolve the forecast inputs from the registry (planner),
    then EXECUTE each resolved branch's ETL on its source to fill the scenario — plus
    registered scalar params + physical derivations + provenance + honest ``missing``.
    No hardcoded source selection."""
    await _caller_or_demo(_bearer(authorization))
    if "lat" not in body or "lon" not in body:
        raise HTTPException(422, "lat and lon are required")
    lat, lon = float(body["lat"]), float(body["lon"])
    h = get_client(_bearer(authorization))
    try:
        plan = await _resolve_forecast_plan(h, lat, lon, body.get("model_layer"))
        result = await run_in_threadpool(
            ntgam.build_scenario_from_plan, lat, lon,
            layer=plan["selection"]["model_layer"], layer_source=plan["selection"]["layer_source"],
            aquifers=plan["aquifer"].get("aquifers") or [], nearest_well=plan["nearest_well"],
            branches=plan["branches"], overrides=body.get("overrides") or {})
        result["plan"] = {"complete": plan["complete"], "branches": plan["branches"],
                          "plan_json": plan["plan_json"]}
        return result
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"scenario assembly failed: {exc}")


@app.post("/forecast/run", tags=["NTGAM forecast"])
async def ntgam_run(body: dict[str, Any], authorization: str | None = Header(None)):
    """Run the SUBSIDE screening model on an assembled scenario (returns risk score,
    risk factors, and the annual subsidence projection). Needs a signed-in user: it
    runs the model on this service's own compute."""
    await _caller_or_demo(_bearer(authorization))
    scenario = body.get("scenario") or body
    if not isinstance(scenario, dict) or not scenario:
        raise HTTPException(422, "a scenario object is required")
    try:
        return await run_in_threadpool(ntgam.run_forecast, scenario)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"forecast run failed: {exc}")


@app.post("/forecast/run-tapis", tags=["NTGAM forecast"])
async def ntgam_run_tapis(body: dict[str, Any], authorization: str | None = Header(None)):
    """Run the forecast as a Tapis Workflows pipeline (emulates SUBSIDE): generate a
    one-task pipeline whose function runs ``run_forecast`` on the scenario, then
    register + run it. ``dry_run`` returns the exact pipeline definition + run args
    without submitting. Live submission forwards the caller's Tapis bearer token and
    requires the tenant ``workflows`` service grant (the documented SUBSIDE blocker)."""
    await _caller_or_demo(_bearer(authorization))
    scenario = body.get("scenario")
    if not isinstance(scenario, dict) or not scenario:
        raise HTTPException(422, "a scenario object is required")
    raw_id = str(scenario.get("scenario_id") or "ntgam-forecast")
    pipeline_id = "".join(c if (c.isalnum() or c in "-_") else "-" for c in raw_id).lower()[:60]
    plan_steps = body.get("plan_steps") or []
    pipeline = tapis.build_forecast_pipeline(
        pipeline_id, scenario=scenario, plan_steps=plan_steps or None)
    args: dict[str, Any] = {}  # scenario is embedded in the function code

    if body.get("dry_run"):
        return {"status": "generated", "pipeline_id": pipeline_id,
                "tapis_workflow_definition": pipeline, "args": args}

    token = _bearer(authorization) or body.get("tapis_token")
    try:
        result = await run_in_threadpool(
            tapis.submit_tapis_workflow, pipeline, args,
            token=token, run_name=body.get("run_name") or f"ntgam-{pipeline_id}",
            # default True: Workflows can't PATCH task code, so re-register (delete+create)
            # to guarantee the latest function code runs.
            recreate=bool(body.get("recreate", True)),
        )
    except Exception as exc:  # noqa: BLE001 - surface the Tapis error to the UI
        raise HTTPException(502, f"Tapis Workflows submission failed: {exc}")
    return {"status": "submitted", "pipeline_id": pipeline_id, **result}


_FORECAST_RUN_SPEC = "subside-forecast"
_FORECAST_SERVICE_SVOS = ("land_surface__elevation", "groundwater__temperature",
                          "total_dissolved_solids", "aquitard__clay_thickness")


async def _resolve_forecast_plan(h, lat: float, lon: float,
                                 model_layer: int | None = None) -> dict[str, Any]:
    """Registry-driven resolution: detect the aquifer/layer (CKAN polygons), filter the
    registered data objects to that layer + services, and ask the planner to resolve every
    forecast input -> per-input branches (source + ETL) + the converging DAG."""
    registry = await _registry(h)
    run_spec = next((t for t in registry if t.get("name") == _FORECAST_RUN_SPEC), None)
    if run_spec is None:
        raise HTTPException(404, f"run-spec '{_FORECAST_RUN_SPEC}' not registered — "
                                 "run ntgam/register_forecast_planner.py")
    detected = await run_in_threadpool(ntgam.detect_aquifer, lat, lon)
    nearest_well = await run_in_threadpool(stac.nearest_well, lat, lon)
    rows = await _discoverable_objects(h)

    def _layer(r):
        for v in (r.get("variables") or []):
            if (v.get("local_name") or "").startswith("layer_"):
                return v["local_name"]
        return None

    def _svo(r):
        vs = r.get("variables") or []
        return (vs[0].get("standard_variable_uri") if vs else "") or ""

    present = sorted({int(_layer(r).split("_")[1]) for r in rows if _layer(r)})
    layer = model_layer or detected.get("suggested_layer") or (present[0] if present else 1)
    layer_source = "override" if model_layer else (
        "auto:aquifer-polygon" if detected.get("suggested_layer") else "default")
    want = f"layer_{layer}"
    keep = [r for r in rows if _layer(r) == want
            or (_layer(r) is None and any(k in _svo(r) for k in _FORECAST_SERVICE_SVOS))]
    sources = [_data_object_to_contract(r) for r in keep]

    edge_map = await _load_edge_map(registry)
    plan = plan_model_run(run_spec, sources, registry, edge_map=edge_map)
    branches = [{
        "standard_variable": (b.get("standard_variable_uri") or "").rsplit("/", 1)[-1],
        "temporal": next((c.get("temporal_resolution") for c in run_spec.get("contracts", [])
                          if c.get("id") == b.get("input_id")), None),
        "satisfied": b["source"] is not None,
        "source": getattr(b["source"], "resource_uri", None) if b["source"] else None,
        "etl": [s["name"] for s in (b["path"] or [])],
    } for b in plan["branches"]]
    return {"run_spec": _FORECAST_RUN_SPEC, "complete": plan["complete"],
            "selection": {"model_layer": layer, "layer_source": layer_source,
                          "available_layers": present, "lat": lat, "lon": lon},
            "aquifer": detected, "nearest_well": nearest_well, "branches": branches,
            "plan_json": _plan_with_parameters(build_model_run_plan_json(plan))}


@app.post("/forecast/plan", tags=["NTGAM forecast"])
async def ntgam_forecast_plan(body: dict[str, Any], authorization: str | None = Header(None)):
    """Query by the forecast -> the files + ETLs (DAG) needed to run it, from the registry."""
    await _caller_or_demo(_bearer(authorization))
    if "lat" not in body or "lon" not in body:
        raise HTTPException(422, "lat and lon are required")
    h = get_client(_bearer(authorization))
    return await _resolve_forecast_plan(h, float(body["lat"]), float(body["lon"]),
                                        body.get("model_layer"))


@app.get("/forecast/run-tapis/{run_uuid}", tags=["NTGAM forecast"])
async def ntgam_run_tapis_detail(run_uuid: str, pipeline_id: str,
                                 authorization: str | None = Header(None)):
    """Fetch a Tapis Workflows run's status + task logs (stdout/stderr/last_message) so
    the UI can show whether it worked and why a task failed. Needs the caller's token."""
    token = _bearer(authorization)
    if not token:
        raise HTTPException(401, "log in (Tapis token) to view a run")
    try:
        return await run_in_threadpool(tapis.get_run_detail, pipeline_id, run_uuid, token=token)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"could not fetch run: {exc}")


# --- service root ------------------------------------------------------------
@app.get("/", include_in_schema=False)
async def root() -> dict[str, Any]:
    return {
        "service": "svo-adapter-service",
        "docs": "See /docs for the API reference.",
        "health": "/health",
    }
