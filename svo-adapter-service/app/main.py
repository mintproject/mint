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
  GET  /plans/{id}                fetch a stored plan
  POST /workflows/generate        emit a Tapis Workflows pipeline for a plan
  POST /workflows/submit          register + run the pipeline (emulates SUBSIDE)
  GET  /runs/{id}                 fetch execution state of a run
  POST /runs/{id}/register-output register a transformed output as a new data object

A bundled standalone UI (static/index.html) is served at / and drives this flow;
demo mode (SVO_ADAPTER_DEMO_MODE=1) backs it with an in-memory store (see store.py).
"""
from __future__ import annotations

import asyncio
import hmac
import hashlib
import json
import logging
import re
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from pathlib import Path

from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

log = logging.getLogger(__name__)

from . import ntgam, qaqc, run_tokens, stac, tapis
from .config import settings
from .hasura import (
    DATA_OBJECT_CONTRACT_QUERY,
    LIST_DATA_OBJECTS_QUERY,
    MODEL_INPUT_REQUIREMENT_QUERY,
    TRANSFORM_REGISTRY_QUERY,
    get_client,
)
from .models import (
    BindDeferredPlanIn,
    DataObjectContract,
    DataObjectIn,
    DeferredPlanIn,
    GenerateWorkflowIn,
    ModelRunIn,
    PlanIn,
    ReadinessCheckIn,
    ReadinessResult,
    ReadinessStatus,
    RegisterOutputIn,
    SubmitWorkflowIn,
    TransformSpecIn,
)
from .planner import (
    build_model_run_plan_json,
    build_plan_json,
    compatibility,
    find_path,
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
    plan_json["parameters"] = parameter_definitions(
        plan_json.get("steps") or [], tapis.STANDARD_PARAMS
    )
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

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start the background Tapis status poller on startup; cancel it on shutdown.

    The poller only runs when:
    - demo_mode is off (no real Tapis in demo)
    - tapis_token is configured (service-level token for unattended polling)
    - poll_interval_seconds > 0 (explicit disable path)
    """
    task: asyncio.Task | None = None
    if (not settings.demo_mode
            and settings.tapis_token
            and settings.poll_interval_seconds > 0):
        from . import poller
        task = asyncio.create_task(poller.run_poller(), name="svo-adapter-poller")
    else:
        log.info(
            "poller disabled (demo_mode=%s, token=%s, interval=%d)",
            settings.demo_mode,
            "set" if settings.tapis_token else "unset",
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

from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _bearer(authorization: str | None) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:]
    return None


def _internal_service_authorized(secret: str | None) -> bool:
    expected = settings.internal_service_secret or settings.hasura_admin_secret
    return bool(expected and secret and hmac.compare_digest(secret, expected))


def humanize_svo(uri: str | None) -> str:
    """SVO machine name -> readable label using the object__quantity grammar:
    'groundwater__hydraulic_head' -> 'Groundwater — hydraulic head'."""
    name = (uri or "").rsplit("/", 1)[-1]
    obj, sep, qty = name.partition("__")
    obj = obj.replace("_", " ").strip()
    qty = qty.replace("_", " ").strip()
    if sep and obj and qty:
        return f"{obj[:1].upper()}{obj[1:]} — {qty}"
    return (qty or obj or name).replace("_", " ").capitalize()


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
  }
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
    owner_execution_id owner_model_child_id owner_tenant
  }
}
"""

LIST_RUNS = """
query ListRuns($limit: Int!, $offset: Int!) {
  adapter_workflow_run(
    limit: $limit
    offset: $offset
    order_by: [{started_at: desc}, {created_at: desc}]
  ) {
    id status tapis_workflow_id tapis_run_id started_at completed_at
    output_data_object_id logs_uri error_message workflow_plan_id execution_id
  }
  adapter_workflow_run_aggregate { aggregate { count } }
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
    if (
        body.owner_execution_id or body.owner_model_child_id or body.owner_tenant
    ) and not _internal_service_authorized(internal_secret):
        raise HTTPException(
            403,
            detail={
                "code": "INTERNAL_SERVICE_AUTH_REQUIRED",
                "message": "owned model-output data objects require Ensemble Manager authentication",
            },
        )
    h = get_client(_bearer(authorization))
    obj = body.model_dump(exclude_none=True)
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
    obj = (await h.execute(GET_DATA_OBJECT, {"id": object_id}))["adapter_data_object_by_pk"]
    if not obj:
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
    "env_from_args", "file_inputs",
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
    h = get_client(_bearer(authorization))
    return (await h.execute(TRANSFORM_REGISTRY_QUERY))["adapter_transform_spec"]


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
    h = get_client(token)
    specs = (await h.execute(TRANSFORM_REGISTRY_QUERY))["adapter_transform_spec"]
    spec = next((s for s in specs if s.get("id") == spec_id), None)
    if not spec:
        raise HTTPException(404, "transform spec not found")
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


async def _load_edge_map(
    registry: list[dict[str, Any]],
) -> "dict[str, list[dict[str, Any]]] | None":
    """Fetch precomputed edges from Hasura and build the BFS index. Returns None
    in demo mode or when the edge table is empty (first run before recompute)."""
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

    objects = (await h.execute(LIST_DATA_OBJECTS_QUERY)).get("adapter_data_object", [])
    if not objects:
        raise HTTPException(422, "no data objects registered — sync CKAN resources first")

    target_svo = target_contract.get("standard_variable_uri", "")
    target_fields = DataObjectContract.model_fields
    target = DataObjectContract(**{
        key: value for key, value in target_contract.items() if key in target_fields
    })
    registry = (await h.execute(TRANSFORM_REGISTRY_QUERY))["adapter_transform_spec"]
    edge_map = await _load_edge_map(registry)

    candidates = []
    for obj in objects:
        if target_svo and not any(
            variable.get("standard_variable_uri") == target_svo
            for variable in obj.get("variables", [])
        ):
            continue
        rows = (await h.execute(DATA_OBJECT_CONTRACT_QUERY, {"id": obj["id"]}))["adapter_data_object"]
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
    src_rows = (await h.execute(DATA_OBJECT_CONTRACT_QUERY, {"id": data_object_id}))["adapter_data_object"]
    if not src_rows:
        raise HTTPException(404, "data object not found")
    source = _data_object_to_contract(src_rows[0])
    target = DataObjectContract(**{
        key: value for key, value in target_contract_raw.items()
        if key in DataObjectContract.model_fields
    })
    registry = (await h.execute(TRANSFORM_REGISTRY_QUERY))["adapter_transform_spec"]
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
    registry = (await h.execute(TRANSFORM_REGISTRY_QUERY))["adapter_transform_spec"]
    edge_map = await _load_edge_map(registry)
    # A deferred source is a model output that does not exist as a registered
    # data object yet.  Treat it as reachable while planning; the later bind
    # step verifies the materialized output's ownership and contract.
    planning_source = body.source_contract
    if not planning_source.resource_uri:
        planning_source = planning_source.model_copy(
            update={"resource_uri": "deferred-model-output"}
        )
    path = find_path(planning_source, target, registry, edge_map=edge_map)
    if path is None:
        raise HTTPException(422, detail={
            "code": "NO_DEFERRED_TRANSFORM_PATH",
            "message": "no transform path found from model output to target contract",
        })

    plan_json = _plan_with_parameters(build_plan_json(path))
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


@app.post("/plans/deferred/{plan_id}/bind", tags=["Core: Planning"])
async def bind_deferred_plan(
    plan_id: str,
    body: BindDeferredPlanIn,
    authorization: str | None = Header(None),
    internal_secret: str | None = Header(None, alias="X-Ensemble-Manager-Secret"),
):
    """Bind one server-owned model output to a deferred adapter plan."""
    if not _internal_service_authorized(internal_secret):
        raise HTTPException(403, detail={
            "code": "INTERNAL_SERVICE_AUTH_REQUIRED",
            "message": "deferred-plan binding is an internal Ensemble Manager operation",
        })
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

    object_rows = (await h.execute(
        DATA_OBJECT_CONTRACT_QUERY, {"id": body.data_object_id}
    )).get("adapter_data_object") or []
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


@app.post("/readiness/check", response_model=ReadinessResult, tags=["Core: Planning"])
async def readiness_check(body: ReadinessCheckIn, authorization: str | None = Header(None)):
    h = get_client(_bearer(authorization))
    src_rows = (await h.execute(DATA_OBJECT_CONTRACT_QUERY, {"id": body.data_object_id}))[
        "adapter_data_object"
    ]
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


@app.post("/plans", tags=["Core: Planning"])
async def create_plan(body: PlanIn, authorization: str | None = Header(None)):
    h = get_client(_bearer(authorization))
    src_rows = (await h.execute(DATA_OBJECT_CONTRACT_QUERY, {"id": body.data_object_id}))[
        "adapter_data_object"
    ]
    if not src_rows:
        raise HTTPException(404, "data object not found")
    src = _data_object_to_contract(src_rows[0])
    tgt = await _resolve_target(h, body.target_dataset_specification_id, body.target_contract)

    if compatibility(src, tgt).status == ReadinessStatus.ready:
        return {"status": "ready", "plan": None, "message": "data object is already model-ready"}

    registry = (await h.execute(TRANSFORM_REGISTRY_QUERY))["adapter_transform_spec"]

    edge_map = await _load_edge_map(registry)
    path = find_path(src, tgt, registry, edge_map=edge_map)
    if path is None:
        raise HTTPException(422, "no transform path found from source contract to target contract")

    plan_json = _plan_with_parameters(build_plan_json(path))
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
    registry = (await h.execute(TRANSFORM_REGISTRY_QUERY))["adapter_transform_spec"]
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
    registry = (await h.execute(TRANSFORM_REGISTRY_QUERY))["adapter_transform_spec"]

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
    """Registered data objects (the 'we have this SVO input' sources) — id, label,
    and each variable's standard_variable_uri + unit/format."""
    h = get_client(_bearer(authorization))
    return (await h.execute(LIST_DATA_OBJECTS_QUERY))["adapter_data_object"]


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
    specs = (await h.execute(TRANSFORM_REGISTRY_QUERY))["adapter_transform_spec"]
    objs = (await h.execute(LIST_DATA_OBJECTS_QUERY))["adapter_data_object"]
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
        registry = (await h.execute(TRANSFORM_REGISTRY_QUERY))["adapter_transform_spec"]
    except Exception as exc:  # noqa: BLE001 - report dependency failure
        registry_error = f"{type(exc).__name__}: {exc}"
    try:
        data_objects = (await h.execute(LIST_DATA_OBJECTS_QUERY))["adapter_data_object"]
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
    registry = (await h.execute(TRANSFORM_REGISTRY_QUERY))["adapter_transform_spec"]
    data_objects = (await h.execute(LIST_DATA_OBJECTS_QUERY))["adapter_data_object"]
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
    rows = (await h.execute(DATA_OBJECT_CONTRACT_QUERY, {"id": data_object_id}))["adapter_data_object"]
    if not rows:
        raise HTTPException(404, "data object not found")
    src = _data_object_to_contract(rows[0])
    registry = (await h.execute(TRANSFORM_REGISTRY_QUERY))["adapter_transform_spec"]
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
    registry = (await h.execute(TRANSFORM_REGISTRY_QUERY))["adapter_transform_spec"]
    run_spec = next((t for t in registry if t.get("id") == body.run_spec_id), None)
    if run_spec is None:
        raise HTTPException(404, f"run spec '{body.run_spec_id}' not found")

    rows = (await h.execute(LIST_DATA_OBJECTS_QUERY))["adapter_data_object"]
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
    return {key: value for key, value in args.items() if key != "tapis_token"}


def _composite_task_contains_secret(value: Any) -> bool:
    """Reject credentials in coordinator-owned composite task descriptors."""
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).lower() in {"tapis_token", "authorization", "x-tapis-token"}:
                if item not in (None, "", {}, []):
                    return True
            if _composite_task_contains_secret(item):
                return True
        return False
    if isinstance(value, list):
        return any(_composite_task_contains_secret(item) for item in value)
    return isinstance(value, str) and bool(re.search(r"\bbearer\s+", value, flags=re.IGNORECASE))


def _resolve_bound_plan_id(plan_id: str) -> tuple[str, str | None]:
    """Resolve the opaque deferred binding token to its stored plan id."""
    if not plan_id.startswith("bound:"):
        return plan_id, None
    parts = plan_id.split(":")
    if len(parts) != 3 or not parts[1] or not parts[2]:
        raise HTTPException(404, "bound plan not found")
    return parts[1], plan_id


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
    if plan_json.get("model_task") or "execution_id" in normalized or "source_uri" in normalized:
        # These are coordinator-owned values for a composite model stage, not
        # user-entered adapter parameters.  Deferred post-model workflows also
        # receive execution_id in their submission args, while their bound
        # plan does not carry the composite model_task descriptor.
        allowed.update({"execution_id", "source_uri"})
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
    if bound_plan_id and not _internal_service_authorized(internal_secret):
        raise HTTPException(403, detail={
            "code": "INTERNAL_SERVICE_AUTH_REQUIRED",
            "message": "bound deferred plans require Ensemble Manager authentication",
        })
    plan = (await h.execute(GET_PLAN, {"id": stored_plan_id}))["adapter_workflow_plan_by_pk"]
    if not plan:
        raise HTTPException(404, "plan not found")
    if bound_plan_id:
        bound = (plan.get("plan_json") or {}).get("bound") or {}
        if bound.get("bound_plan_id") != bound_plan_id:
            raise HTTPException(409, detail={"code": "BOUND_PLAN_INVALID"})

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

    if body.model_task is not None:
        if not _internal_service_authorized(internal_secret):
            raise HTTPException(403, detail={
                "code": "INTERNAL_SERVICE_AUTH_REQUIRED",
                "message": "composite model descriptors require Ensemble Manager authentication",
            })
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
    else:
        workflow_plan = plan

    pipeline = tapis.generate_tapis_workflow(workflow_plan)
    args = _validate_plan_args(
        workflow_plan.get("plan_json") or {}, service_args, token, require_required=not body.dry_run
    )
    if not body.dry_run:
        args = await _with_run_token(args, token)

    # Record the run before triggering, so a failed submit still leaves a trail.
    run_obj: dict[str, Any] = {
        "workflow_plan_id": stored_plan_id,
        "tapis_workflow_id": pipeline["id"],
        "status": "submitting",
    }
    if body.execution_id:
        run_obj["execution_id"] = body.execution_id
    if idempotency_key:
        run_obj["idempotency_key"] = idempotency_key
    run = (await h.execute(INSERT_RUN, {"obj": run_obj}))["insert_adapter_workflow_run_one"]
    await h.execute(INSERT_PROVENANCE, {"obj": {
        "workflow_run_id": run["id"], "event_type": "workflow_submit_requested",
        "payload_json": {"plan_id": body.plan_id, "dry_run": body.dry_run},
    }})

    if body.dry_run:
        await h.execute(UPDATE_RUN, {"id": run["id"], "set": {"status": "generated"}})
        return {"run_id": run["id"], "status": "generated",
                "tapis_workflow_definition": pipeline, "args": _public_workflow_args(args)}

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
        await h.execute(UPDATE_RUN, {"id": run["id"], "set": {
            "status": "failed", "error_message": error_message,
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

    await h.execute(UPDATE_RUN, {"id": run["id"], "set": {
        "status": "running", "tapis_run_id": result.get("uuid"),
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
):
    """List persisted workflow runs, most recent first."""
    h = get_client(_bearer(authorization))
    data = await h.execute(LIST_RUNS, {"limit": limit, "offset": offset})
    total = data.get("adapter_workflow_run_aggregate", {}).get("aggregate", {}).get("count", 0)
    return {"runs": data.get("adapter_workflow_run", []), "total": total}


@app.get("/runs/{run_id}", tags=["Core: Runs"])
async def get_run(run_id: str, authorization: str | None = Header(None)):
    h = get_client(_bearer(authorization))
    run = (await h.execute(GET_RUN, {"id": run_id}))["adapter_workflow_run_by_pk"]
    if not run:
        raise HTTPException(404, "run not found")
    return run


@app.post("/runs/{run_id}/poll", tags=["Core: Runs"])
async def poll_run(run_id: str, authorization: str | None = Header(None)):
    """Poll one Tapis workflow run and persist any status transition."""
    caller_token = _bearer(authorization)
    h = get_client(caller_token or settings.tapis_token)
    run = (await h.execute(GET_RUN, {"id": run_id}))["adapter_workflow_run_by_pk"]
    if not run:
        raise HTTPException(404, "run not found")
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
    tapis_status = str(detail.get("status") or "").upper()
    adapter_status, update = _terminal_update_set(tapis_status, detail)
    if adapter_status is None and tapis_status and str(run.get("status") or "").lower() in {
        "submitting", "generated"
    }:
        update = {"status": "running"}

    if update:
        updated_run = (await h.execute(UPDATE_RUN, {"id": run_id, "set": update}))["update_adapter_workflow_run_by_pk"]
        # The mutation returns only a projection of the row. Preserve the
        # workflow/parent identifiers needed by output registration and
        # reconciliation instead of replacing the full GET result with it.
        run = {**run, **(updated_run or {})}
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
    response = {**run, **detail}
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
        try:
            output_uri = await run_in_threadpool(
                tapis.get_output_uri, pipeline_id, run_uuid, token=token,
            )
        except Exception:  # noqa: BLE001 — output discovery is best effort
            output_uri = None
        if output_uri:
            response["output_uri"] = output_uri
    return response


@app.get("/runs/{run_id}/provenance", tags=["Core: Runs"])
async def get_run_provenance(
    run_id: str,
    limit: int = Query(100, ge=1, le=500),
    authorization: str | None = Header(None),
):
    """Return persisted provenance events associated with a workflow run."""
    h = get_client(_bearer(authorization))
    run = (await h.execute(GET_RUN, {"id": run_id}))["adapter_workflow_run_by_pk"]
    if not run:
        raise HTTPException(404, "run not found")
    data = await h.execute(GET_PROVENANCE, {"run_id": run_id, "limit": limit})
    return {"run_id": run_id, "events": data.get("adapter_provenance_event", [])}


@app.post("/runs/{run_id}/register-output", tags=["Core: Runs"])
async def register_output(run_id: str, body: RegisterOutputIn, authorization: str | None = Header(None)):
    h = get_client(_bearer(authorization))
    obj = body.output_data_object.model_dump(exclude_none=True)
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
async def ntgam_run(body: dict[str, Any]):
    """Run the SUBSIDE screening model on an assembled scenario (returns risk score,
    risk factors, and the annual subsidence projection)."""
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
    registry = (await h.execute(TRANSFORM_REGISTRY_QUERY))["adapter_transform_spec"]
    run_spec = next((t for t in registry if t.get("name") == _FORECAST_RUN_SPEC), None)
    if run_spec is None:
        raise HTTPException(404, f"run-spec '{_FORECAST_RUN_SPEC}' not registered — "
                                 "run ntgam/register_forecast_planner.py")
    detected = await run_in_threadpool(ntgam.detect_aquifer, lat, lon)
    nearest_well = await run_in_threadpool(stac.nearest_well, lat, lon)
    rows = (await h.execute(LIST_DATA_OBJECTS_QUERY))["adapter_data_object"]

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


# --- bundled standalone UI -------------------------------------------------
# Serve the demo single-page app (static/index.html) and redirect / to it.
_STATIC_DIR = Path(__file__).resolve().parents[1] / "static"
if _STATIC_DIR.is_dir():
    app.mount("/ui", StaticFiles(directory=str(_STATIC_DIR), html=True), name="ui")

    @app.get("/")
    async def _root() -> RedirectResponse:
        return RedirectResponse("/ui/")
