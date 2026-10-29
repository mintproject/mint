"""Service configuration.

All metadata reads/writes go through Hasura GraphQL — this service does NOT
open its own PostgreSQL connection. The only DB-ish config it needs is the
Hasura endpoint + auth.
"""
from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# …/modflow-suite (app/ -> svo-adapter-service/ -> monorepo/ -> modflow-suite/)
# In container, file is at /app/app/config.py, so parents[3] would be IndexError
try:
    _REPO = Path(__file__).resolve().parents[3]
except IndexError:
    _REPO = Path("/app")  # Fallback for container environment

# Canonical monorepo root used by sibling modules (ntgam, qaqc, etc.)
REPO_ROOT = _REPO


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SVO_ADAPTER_", env_file=".env")

    # Hasura GraphQL endpoint (same Hasura that fronts the model catalog).
    hasura_graphql_url: str = "http://localhost:8080/v1/graphql"
    # Admin secret is used ONLY for reads / system writes. User-initiated writes
    # forward the caller's JWT instead (see hasura.HasuraClient).
    hasura_admin_secret: str | None = None
    # Shared server-to-server secret for Ensemble Manager-owned model-output
    # registration and deferred-plan binding. Never expose this to the UI.
    internal_service_secret: str | None = None

    # Tapis Workflows. Submission emulates SUBSIDE's manager so adapter-generated
    # pipelines are interchangeable with SUBSIDE's: same pipeline shape, registered
    # into a Workflows group, run via client.workflows.runPipeline(...).
    tapis_base_url: str = "https://portals.tapis.io"
    tapis_tenant: str | None = None
    # Bearer token used to register + run pipelines. Per-request callers should
    # forward their own token instead (see main.submit_workflow); this is the
    # service-level fallback for unattended runs.
    tapis_token: str | None = None
    # Swap the caller's token in workflow args for a bounded per-run token so a
    # long run survives UI-token expiry. Off by default; TTL is clamped to min/max.
    run_token_enabled: bool = False
    run_token_ttl_seconds: int = 43200
    run_token_ttl_min_seconds: int = 900
    run_token_ttl_max_seconds: int = 172800
    run_token_target_prefix: str = "svo-adapter-run"
    # Ceiling on the composite model task's pipeline max_exec_time. The task polls
    # until the Tapis job is terminal (renewing its token as it goes), so this only
    # needs to exceed the longest expected queue wait plus runtime.
    model_task_max_exec_seconds: int = 172800
    # How long the model task keeps retrying when Tapis is unreachable while it
    # polls a job, before it fails the stage. Auth failures end the stage at once.
    model_poll_outage_seconds: int = 1800
    # Workflows group the generated pipeline is registered into + run from.
    tapis_workflow_group: str = "adapter-ops"
    # Owner placeholder Tapis fills in at registration (matches SUBSIDE's YAML).
    tapis_workflow_owner: str = "${apiUserId}"
    # Default Tapis execution system for tapis_job tasks (override per registry).
    tapis_exec_system: str = "ls6"
    # Keep adapter workflows aligned with Ensemble Manager's Tapis job runs.
    # Deployments may override this without changing the plan contract.
    tapis_allocation: str = "PT2050-DataX"

    request_timeout_seconds: float = 30.0

    # Background polling: how often (seconds) to check Tapis run status for
    # adapter_workflow_run rows in "running"/"submitting" state.
    # Set to 0 to disable polling even when tapis_token is configured.
    poll_interval_seconds: int = 60

    # Demo mode: serve the bundled standalone UI and back every Hasura call with an
    # in-process in-memory store, so the whole flow (register pieces -> readiness ->
    # plan -> generate -> submit dry-run) runs with NO Hasura/Postgres/Tapis. Never
    # enable in production. Set SVO_ADAPTER_DEMO_MODE=1.
    demo_mode: bool = False

    # MINT catalog sync: pull ModelConfiguration entries from the MINT model-catalog
    # REST API and upsert them into adapter.transform_spec. MINT is the sole source
    # of truth — no hand-created specs coexist.
    mint_catalog_base_url: str = "http://localhost:3000"
    # Run one sync at startup (non-blocking, background). Set to True in prod once
    # common transforms are registered in MINT.
    mint_sync_on_startup: bool = False
    # CKAN → data_object sync: pull resources with mint_standard_variables from CKAN
    # and upsert them as adapter data objects. Runs once at startup when True.
    ckan_sync_on_startup: bool = False
    # Limit CKAN sync to a specific organization slug (empty = all orgs).
    ckan_sync_org: str = ""

    # Tapis Abaco actor ID for the dso-geo GDAL/MODFLOW actor (mcp-suite/servers/geo).
    # Register with mcp-suite/servers/geo/register-actor.sh; set via SVO_ADAPTER_GEO_ACTOR_ID.
    geo_actor_id: str = ""

    # Default spatial layers surfaced to the local ETL UI so users can pick from
    # known monorepo-backed references without pasting raw URLs.
    gma_boundary_layer_uri: str = (
        "https://services1.arcgis.com/7DRakJXKPEhwv0fM/arcgis/rest/services/"
        "Z_Statewide_gdb/FeatureServer/4"
    )
    gcd_boundary_layer_uri: str = (
        "https://services.twdb.texas.gov/arcgis/rest/services/Base/"
        "GroundWaterConservationDistricts/MapServer/0"
    )
    county_boundary_layer_uri: str = (
        "https://services.twdb.texas.gov/arcgis/rest/services/PWS/"
        "Texas_Counties_FIPS/FeatureServer/0"
    )

    # --- NTGAM location->forecast tab (Phase 2/3) ----------------------------
    # Local CKAN holding the registered NTGAM resources (heads sampled for water
    # levels). Token is needed to download private (mint_dataset) resources.
    ckan_url: str = "http://localhost:5001"
    ckan_token: str | None = None
    # MINT model catalog Hasura: the forecast ModelConfiguration + its parameter
    # *defaults* live here. The scenario's scalar config is read from these defaults
    # (overridable) so NO values are hardcoded in the service or the UI.
    mint_hasura_url: str = "http://localhost:8080/v1/graphql"
    mint_admin_secret: str = "localdev"
    # The registered forecast config whose parameter defaults seed the scenario.
    forecast_config_id: str = "subside-forecast-cfg"
    # CKAN dataset holding the NTGAM head rasters.
    ntgam_waterlevels_dataset: str = "ntgam-water-levels"
    # SUBSIDE STAC API: the subside-context collection catalogs the authoritative
    # context services (TWDB well-reports + aquifer FeatureServers, …) that the
    # forecast queries on-demand by location (aquifer detect, nearest well).
    stac_api_url: str = "https://stacapi.pods.portals.tapis.io/api/v1"
    # To RUN the forecast we shell out to the SUBSIDE venv (which vendors the
    # screening model + numpy/pandas); the adapter venv stays light on purpose.
    subside_python: str = str(_REPO / "subside" / ".venv" / "bin" / "python")
    subside_dir: str = str(_REPO / "subside")


settings = Settings()
