"""Pydantic request/response models and the core DataObjectContract."""
from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


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


class FlowStepIn(BaseModel):
    position: int
    etl_process_id: str | None = None
    settings: dict[str, Any] = Field(default_factory=dict)
    wires: list[Any] = Field(default_factory=list, max_length=64)
    pause_after: bool = False


class FlowCheckIn(BaseModel):
    """A flow to check before it is registered. Pieces are named by catalog id."""
    inputs: list[dict[str, Any]] = Field(default_factory=list, max_length=64)
    parameters: list[dict[str, Any]] = Field(default_factory=list, max_length=64)
    steps: list[FlowStepIn] = Field(max_length=24)
    outputs: list[Any] = Field(default_factory=list, max_length=64)
    thread_bindings: dict[str, Any] = Field(default_factory=dict)
    # What the author decided about each setting: {name: {"visibility", "fixed"}}.
    settings: dict[str, Any] = Field(default_factory=dict)
    # Settings the thread fills in (the dates), by name, when the bindings cannot name
    # flow parameters yet (a flow that is not saved).
    thread_settings: list[str] = Field(default_factory=list, max_length=64)


class FlowProposeIn(BaseModel):
    """A flow as far as it is built, and one question about it (see flow_propose)."""
    inputs: list[dict[str, Any]] = Field(default_factory=list, max_length=64)
    parameters: list[dict[str, Any]] = Field(default_factory=list, max_length=64)
    steps: list[FlowStepIn] = Field(default_factory=list, max_length=24)
    outputs: list[Any] = Field(default_factory=list, max_length=64)
    # {"step": n, "input": k} | {"step": n, "output": j} | {"contract": {...}} | None
    purpose: Any = None
    # Both are held to flow_propose's own limits, whatever is asked.
    max_chain: int = 3
    max_results: int = 20


class FlowCollectionResourceIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(max_length=255)
    url: str = Field(min_length=1, max_length=2000)


class FlowCollectionIn(BaseModel):
    """The files bound to one flow input that takes a collection: one input made of
    many files, in the order the thread holds them. The most it may hold is the
    ``flow_collection_max_resources`` setting (checked where the plan is made)."""
    model_config = ConfigDict(extra="forbid")
    label: str = Field(max_length=200)
    resources: list[FlowCollectionResourceIn] = Field(min_length=1)


class FlowPlanIn(BaseModel):
    """Plan a flow stored on a model configuration."""
    flow_id: str = Field(min_length=1, max_length=500)
    # flow input id (a dataset specification of the configuration) -> data object id
    inputs: dict[str, str] = Field(default_factory=dict)
    # flow input id -> its files, for an input the flow marks as taking a collection.
    # Such an input is not also given in ``inputs``.
    collections: dict[str, FlowCollectionIn] = Field(default_factory=dict)
    # The thread's region, for the flow input the flow marks as its region:
    # {"input": <flow input id>, "source": {"kind": "geojson", "geometry": ...} or
    # {"kind": "bbox", "bbox": [...]}}. The piece receives it as GeoJSON text.
    region: dict[str, Any] | None = None
    allow_unapproved_piece_ids: list[str] = Field(default_factory=list)


class PlanIn(BaseModel):
    data_object_id: str
    target_model_configuration_id: str | None = None
    target_dataset_specification_id: str | None = None
    target_contract: DataObjectContract | None = None
    # Shared or public pieces whose stored code has NOT been approved, that the
    # caller agrees to run with their own Tapis token. Never chosen otherwise.
    allow_unapproved_piece_ids: list[str] = Field(default_factory=list)
    # The pieces to run, in order, by catalog id. Given, the planner does not
    # search: it checks that the named chain fits and plans exactly that.
    piece_ids: list[str] | None = Field(default=None, min_length=1, max_length=12)


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
    # Secrets the piece asks the runner for, and a plain statement of where it sends
    # data (validated where a plan reads them; see app/step_secrets.py).
    secrets: list[dict[str, Any]] | None = None
    sends_data_to: list[dict[str, Any]] | None = None
    contracts: list[TransformContractIn] = Field(default_factory=list)


class SpecApprovalIn(BaseModel):
    # Spec ids are URIs, so the id travels in the body rather than the path.
    spec_id: str
    approved: bool


class PieceContractIn(BaseModel):
    """One input or output of a piece, by standard variable."""
    model_config = ConfigDict(extra="forbid")
    standard_variable_uri: str
    format: str | None = None
    unit: str | None = None
    dimensionality: str | None = None
    spatial_type: str | None = None
    crs_requirement: str | None = None
    temporal_resolution: str | None = None


class PieceArgumentIn(BaseModel):
    """A run argument the piece declares."""
    model_config = ConfigDict(extra="forbid")
    name: str
    type: str = "string"
    default: Any | None = None
    description: str | None = None
    required: bool = False


class PieceFromRepositoryIn(BaseModel):
    """Register a piece whose code is one file of a public GitHub repository at a
    pinned commit. ``dry_run`` (the default) fetches and checks, and writes nothing."""
    model_config = ConfigDict(extra="forbid")
    label: str
    description: str = ""
    version: str = "1.0.0"
    visibility: str = "private"
    repository: str
    commit: str
    path: str
    entrypoint: str
    inputs: list[PieceContractIn]
    outputs: list[PieceContractIn]
    arguments: list[PieceArgumentIn] = Field(default_factory=list)
    env_from_args: dict[str, str] | None = None
    secrets: list[dict[str, Any]] | None = None
    sends_data_to: list[dict[str, Any]] | None = None
    dry_run: bool = True


class PieceApprovalIn(BaseModel):
    """Approve, or withdraw approval of, a piece from its page. ``reviewed_sha256``
    is the approval hash the approver was shown; approval is refused if the piece
    no longer has it."""
    model_config = ConfigDict(extra="forbid")
    approved: bool
    reviewed_sha256: str | None = None


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
    # A flow's author chose defaults and links for settings of pieces that run with
    # the submitter's token. They are used only when the submitter says so here.
    accept_flow_settings: bool = False
    # A flow that pauses: run only up to this step (a position), the one the flow
    # pauses after. Omitted, a flow whose plan pauses runs up to its pause anyway
    # when pausing is enabled; the rest runs when the run is resumed.
    through_step: int | None = None


class ReplacementIn(BaseModel):
    """A file the user uploaded to the data catalog to stand in for an editable output."""
    model_config = ConfigDict(extra="forbid")
    # The catalog's download address for the file (https, on the catalog's own host).
    url: str = Field(min_length=1, max_length=2000)
    # Recorded with the replacement; checked against the address when given.
    dataset_id: str | None = Field(default=None, max_length=200)
    resource_id: str | None = Field(default=None, max_length=200)


class ResumeRunIn(BaseModel):
    """Resume a run stopped at its pause. Nothing else may be changed at a resume."""
    model_config = ConfigDict(extra="forbid")
    # Editable output key (``<step>:<output>``) -> the file that replaces it.
    replacements: dict[str, ReplacementIn]


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
