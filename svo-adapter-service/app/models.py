"""Pydantic request/response models and the core DataObjectContract."""
from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Contract — the normalized, comparable description of a variable. Both a data
# object's variable and a model input's requirement are projected onto this
# shape so the planner compares like-for-like.
# ---------------------------------------------------------------------------
class DataObjectContract(BaseModel):
    standard_variable_uri: str | None = None  # SVO / StandardVariable
    local_name: str | None = None
    unit: str | None = None
    format: str | None = None
    extension: str | None = None
    mime_type: str | None = None
    dimensionality: str | None = None
    spatial_type: str | None = None
    crs: str | None = None
    grid_id: str | None = None
    grid_description: str | None = None
    temporal_resolution: str | None = None
    schema_json: dict[str, Any] | None = None
    metadata_json: dict[str, Any] | None = None
    resource_uri: str | None = None
    # Catalog/discoverability state: which catalogs the product is registered in
    # (e.g. "ckan", "stac", "ckan+stac"). None/empty = not registered. A target
    # that requires registration is satisfied only once a catalog_register
    # transform (stac-publish) has run.
    catalog: str | None = None


class CompatibilityDimension(str, Enum):
    semantic = "semantic"      # SVO / standard variable
    unit = "unit"
    spatial = "spatial"        # grid / CRS
    temporal = "temporal"      # time resolution
    format = "format"          # file format / schema
    accessibility = "accessibility"  # is the file actually reachable
    catalog = "catalog"        # registered / discoverable in CKAN / STAC


class ReadinessStatus(str, Enum):
    ready = "ready"
    transform_required = "transform_required"
    incompatible = "incompatible"


# ---- Requests --------------------------------------------------------------
class DataObjectVariableIn(BaseModel):
    standard_variable_uri: str | None = None
    local_name: str | None = None
    unit: str | None = None
    dimensionality: str | None = None
    spatial_type: str | None = None
    crs: str | None = None
    grid_id: str | None = None
    grid_description: str | None = None
    temporal_resolution: str | None = None
    schema_json: dict[str, Any] | None = None
    metadata_json: dict[str, Any] | None = None


class DataObjectIn(BaseModel):
    id: str | None = None
    label: str
    description: str | None = None
    resource_uri: str
    filename: str | None = None
    format: str | None = None
    extension: str | None = None
    mime_type: str | None = None
    checksum: str | None = None
    source_catalog: str | None = None
    # Set only by the server-owned model-output handoff. Catalog objects leave
    # these fields empty and remain globally discoverable.
    owner_execution_id: str | None = None
    owner_model_child_id: str | None = None
    owner_tenant: str | None = None
    variables: list[DataObjectVariableIn] = Field(default_factory=list)


class ReadinessCheckIn(BaseModel):
    data_object_id: str
    model_configuration_id: str | None = None
    # Either point at a model-catalog DatasetSpecification (read from Hasura) OR
    # supply the target requirement inline (handy for demos / catalog-less checks).
    dataset_specification_id: str | None = None
    target_contract: DataObjectContract | None = None


class PlanIn(BaseModel):
    data_object_id: str
    target_model_configuration_id: str | None = None
    target_dataset_specification_id: str | None = None
    target_contract: DataObjectContract | None = None


class DeferredPlanIn(BaseModel):
    """Plan an adapter chain before its model-output source exists."""

    source_contract: DataObjectContract
    target_dataset_specification_id: str | None = None
    target_contract: DataObjectContract | None = None
    model_output_key: str
    # Values the caller intends for the plan's publish step (stac_collection,
    # ckan_org), checked against the deployment allow-lists at plan time.
    parameter_values: dict[str, Any] | None = None


class PlanModelInputsIn(BaseModel):
    """Plan the input-side ETL steps for a model's unfilled, bound file inputs."""

    configuration_id: str
    # Source objects are validated by app.input_plan so errors carry a code.
    sources: list[dict[str, Any]] = Field(min_length=1, max_length=4)
    filled_app_inputs: list[str] = Field(default_factory=list)


class BindDeferredPlanIn(BaseModel):
    data_object_id: str
    plan_hash: str
    parent_execution_id: str
    model_child_id: str
    parameter_values_hash: str


class TransformContractIn(BaseModel):
    id: str | None = None
    role: str  # "input" | "output"
    standard_variable_uri: str | None = None
    # Some registration helpers describe bundle contracts as a list of SVO names.
    # The adapter stores those in metadata_json unless a single SVO can be carried
    # directly by standard_variable_uri.
    standard_variables: list[str] | None = None
    data_type: str | None = None
    unit: str | None = None
    format: str | None = None
    dimensionality: str | None = None
    spatial_type: str | None = None
    crs_requirement: str | None = None
    temporal_resolution: str | None = None
    schema_requirement_json: dict[str, Any] | None = None
    catalog: str | None = None  # catalog(s) this contract requires / produces


class TransformSpecIn(BaseModel):
    id: str | None = None
    name: str
    version: str | None = None
    description: str | None = None
    transform_type: str | None = None
    is_lossy: bool = False
    method: str | None = None
    tapis_function_id: str | None = None
    tapis_app_id: str | None = None
    tapis_app_version: str | None = None
    app_version: str | None = None
    stage: str | None = None
    container_image: str | None = None
    parameters_schema_json: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None
    env_from_args: dict[str, str] | None = None
    file_inputs: list[dict[str, Any]] | None = None
    contracts: list[TransformContractIn] = Field(default_factory=list)


class ModelRunIn(BaseModel):
    # Plan an ETL DAG that resolves EVERY input of a multi-input model (run_spec)
    # from the registered data objects, then runs it. source_ids optionally
    # restricts which data objects may be used as sources (default: all).
    run_spec_id: str
    source_ids: list[str] | None = None


class GenerateWorkflowIn(BaseModel):
    plan_id: str


class SubmitWorkflowIn(BaseModel):
    plan_id: str
    # Run args keyed by pipeline param name, SUBSIDE-style: {"start_date": {"value": ...}}.
    # Plain {"start_date": "..."} is also accepted and wrapped.
    args: dict[str, Any] = Field(default_factory=dict)
    run_name: str | None = None
    recreate: bool = False  # delete + recreate the pipeline so task changes re-sync
    dry_run: bool = False   # register/generate only; do not trigger a run
    # Server-generated model task for a composite MINT run. This is deliberately
    # an opaque provider job definition: the Ensemble Manager builds it from the
    # catalog and strips credentials before handing it to the adapter.
    model_task: dict[str, Any] | None = None
    # When set, the poller will auto-bind the run's output to this EM execution
    # on completion (upserts resource + execution_data_binding rows).
    execution_id: str | None = None
    idempotency_key: str | None = None


class RegisterOutputIn(BaseModel):
    output_data_object: DataObjectIn
    # When set, the adapter upserts a `resource` row and inserts an
    # `execution_data_binding` row so the output is immediately visible as a
    # bound input on the target Ensemble Manager execution.
    execution_id: str | None = None


# ---- Responses -------------------------------------------------------------
class DimensionResult(BaseModel):
    dimension: CompatibilityDimension
    compatible: bool
    detail: str
    source: str | None = None
    target: str | None = None


class ReadinessResult(BaseModel):
    status: ReadinessStatus
    dimensions: list[DimensionResult]
    missing_requirements: list[str]
    suggested_plan_id: str | None = None
