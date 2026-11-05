"""MINT model catalog → adapter.transform_spec sync.

Pulls ModelConfiguration entries from the MINT REST API, maps each one to a
transform spec row, and reconciles adapter.transform_spec via Hasura upsert.
MINT is the sole source of truth (D1): rows whose mint_model_config_id no
longer appears in MINT are deleted; hand-created rows (null
mint_model_config_id) are left untouched.

Constraints from the design (D2–D8):
  - env_from_args is built from MINT parameter labels following the standard
    convention table. Parameters that don't match are warned and skipped.
  - tapis_app_id is read from ModelConfiguration.tapis_app_id (new MINT field).
    If null, the sync creates the spec row; generate_tapis_workflow emits a
    function task using task_code.get_code().
  - Contracts: one per (DatasetSpecification, VariablePresentation) pair (D6).
  - Configs with no typed I/O presentations are skipped (not a transform).
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

from .config import settings
from .etl_contract import mint_label_mapping

log = logging.getLogger(__name__)

# Standard parameter label → (env var name, pipeline arg name).
# MINT parameters whose label matches a key here are wired automatically.
# Match is case-insensitive on the stripped label; the key must match the
# exact label string after .strip().lower() (including units in parens).
_PARAM_CONVENTION: dict[str, tuple[str, str]] = {
    # ── ETL routing ──────────────────────────────────────────────────────────
    "source_uri":      ("SOURCE_URI",      "source_uri"),
    "output_uri":      ("OUTPUT_URI",      "output_uri"),
    "lat":             ("LAT",             "lat"),
    "lon":             ("LON",             "lon"),
    "source_unit":     ("SOURCE_UNIT",     "source_unit"),
    "target_unit":     ("TARGET_UNIT",     "target_unit"),
    "variable_name":   ("VARIABLE_NAME",   "variable_name"),
    # ── MODFLOW run control ──────────────────────────────────────────────────
    "baseline data directory": ("BASELINE_DATA_DIR", "baseline_data_dir"),
    # ── Subside-forecast physical parameters (subside-forecast-cfg) ──────────
    # Labels include units in parens to match the MINT catalog entries exactly.
    "water level trend (ft/yr)":             ("WATER_LEVEL_TREND_FT_YR",      "water_level_trend_ft_yr"),
    "aquifer thickness (ft)":                ("AQUIFER_THICKNESS_FT",          "aquifer_thickness_ft"),
    "clay thickness (ft)":                   ("CLAY_THICKNESS_FT",             "clay_thickness_ft"),
    "aquifer porosity (%)":                  ("AQUIFER_POROSITY_PCT",          "aquifer_porosity_pct"),
    "clay porosity (%)":                     ("CLAY_POROSITY_PCT",             "clay_porosity_pct"),
    "aquifer compressibility min (1/psi)":   ("AQUIFER_COMPRESSIBILITY_MIN",   "aquifer_compressibility_min"),
    "aquifer compressibility max (1/psi)":   ("AQUIFER_COMPRESSIBILITY_MAX",   "aquifer_compressibility_max"),
    "clay compressibility min (1/psi)":      ("CLAY_COMPRESSIBILITY_MIN",      "clay_compressibility_min"),
    "clay compressibility max (1/psi)":      ("CLAY_COMPRESSIBILITY_MAX",      "clay_compressibility_max"),
    "aquifer lithology":                     ("AQUIFER_LITHOLOGY",             "aquifer_lithology"),
    "water level method":                    ("WATER_LEVEL_METHOD",            "water_level_method"),
}


@dataclass
class SyncResult:
    created: int = 0
    updated: int = 0
    deleted: int = 0
    skipped: int = 0
    unresolved_tapis_apps: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class MintCatalogClient:
    """Reads ModelConfigurations directly from Hasura (same instance the adapter
    already uses). This avoids any dependency on the model-catalog-api REST layer
    being up and its exact URL / pagination format.

    The `hasura_client` parameter accepts any object with an async
    `execute(query, variables)` method — the real HasuraClient or InMemoryHasura.
    In demo mode the in-memory store has no modelcatalog_* data, so sync returns
    zero configs (expected — demo uses fixture seeds).
    """

    def __init__(self, hasura_client: Any) -> None:
        self._hasura = hasura_client

    async def list_all_configurations(self) -> list[dict[str, Any]]:
        """Paginate through all ModelConfiguration rows via Hasura."""
        from .hasura import LIST_MINT_CONFIGURATIONS_QUERY

        results: list[dict[str, Any]] = []
        limit = 100
        offset = 0
        while True:
            data = await self._hasura.execute(
                LIST_MINT_CONFIGURATIONS_QUERY,
                {"limit": limit, "offset": offset},
            )
            page = data.get("modelcatalog_configuration") or []
            results.extend(page)
            if len(page) < limit:
                break
            offset += limit
        return results

    async def list_all_etl_processes(self) -> list[dict[str, Any]]:
        """Paginate through first-class ETL processes in the MINT catalog."""
        from .hasura import LIST_MINT_ETL_PROCESSES_QUERY

        results: list[dict[str, Any]] = []
        limit = 100
        offset = 0
        while True:
            data = await self._hasura.execute(
                LIST_MINT_ETL_PROCESSES_QUERY,
                {"limit": limit, "offset": offset},
            )
            page = data.get("modelcatalog_etl_process") or []
            results.extend(page)
            if len(page) < limit:
                break
            offset += limit
        return results


def _normalise_uri(uri: str | None) -> str | None:
    if not uri:
        return None
    return uri.strip().lower().replace("http://", "https://")


def _build_env_from_args(
    parameters: list[dict[str, Any]], config_id: str, warnings: list[str]
) -> dict[str, str]:
    """Map MINT parameter labels to env_from_args via the convention table."""
    result: dict[str, str] = {}
    labels = {
        str((wrapper.get("parameter") or wrapper).get("label") or "").strip().lower()
        for wrapper in parameters
    }
    has_primary_geometry_uri = bool(
        labels & {
            "gma boundary uri", "gma_boundary_uri", "geometry source uri",
            "geometry_source_uri", "location file uri", "location_file_uri",
        }
    )
    for param_wrapper in parameters:
        p = param_wrapper.get("parameter") or param_wrapper
        label = (p.get("label") or "").strip().lower()
        if not label:
            continue
        if p.get("has_fixed_value"):
            continue
        if p.get("parameter_type") == "secret":
            continue  # delivered by the secrets store, never an env_from_args mapping
        convention = mint_label_mapping(label) or _PARAM_CONVENTION.get(label)
        if convention is None:
            warnings.append(
                f"{config_id}: parameter {label!r} has no convention mapping — "
                "skipped from env_from_args. Update the MINT entry to follow the "
                "standard label convention."
            )
            continue
        env_var, arg_name = convention
        # A DFC ETL may declare two spatial URIs (primary GMA + area overlay).
        # Keep the second one distinct instead of overwriting the canonical
        # primary source mapping.
        if (
            arg_name == "geometry_source_uri"
            and has_primary_geometry_uri
            and label in {"dfc area boundary uri", "dfc_area_boundary_uri"}
        ):
            env_var, arg_name = "DFC_AREA_BOUNDARY_URI", "dfc_area_boundary_uri"
        result[env_var] = arg_name
    return result


def _build_contracts(
    io_specs: list[dict[str, Any]],
    role: str,
    config_id: str,
    warnings: list[str],
) -> list[dict[str, Any]]:
    """One contract per (DatasetSpecification, VariablePresentation) pair (D6).

    Input contracts carry the junction's binding in ``metadata_json`` so the
    bridge can plan which Tapis file input each dataset specification feeds.
    Every presentation of one specification gets the same binding.
    """
    contracts: list[dict[str, Any]] = []
    bound_by: dict[str, str] = {}
    for spec_wrapper in io_specs:
        spec = spec_wrapper.get("input") or spec_wrapper.get("output") or spec_wrapper
        spec_id = spec.get("id", "")
        has_format = spec.get("has_format") or spec.get("format")
        presentations = spec.get("presentations") or []
        if not presentations:
            warnings.append(
                f"{config_id}: spec {spec_id!r} has no presentations — skipped."
            )
            continue
        metadata: dict[str, Any] | None = None
        if role == "input":
            app_input_name = spec_wrapper.get("app_input_name") or None
            metadata = {
                "app_input_name": app_input_name,
                "is_optional": bool(spec_wrapper.get("is_optional")),
                "dataset_specification_id": spec_id,
            }
            if app_input_name:
                other = bound_by.setdefault(app_input_name, spec_id)
                if other != spec_id:
                    warnings.append(
                        f"{config_id}: dataset specifications {other!r} and {spec_id!r} "
                        f"both bind app input {app_input_name!r}."
                    )
        for pres_wrapper in presentations:
            pres = pres_wrapper.get("presentation") or pres_wrapper
            sv = pres.get("standard_variable") or {}
            sv_uri = _normalise_uri(sv.get("id") or pres.get("has_standard_variable"))
            unit_obj = pres.get("unit") or {}
            unit = unit_obj.get("id") or pres.get("uses_unit")
            contract: dict[str, Any] = {
                "role": role,
                "standard_variable_uri": sv_uri,
                "format": has_format,
                "unit": unit,
            }
            if metadata is not None:
                contract["metadata_json"] = dict(metadata)
            contracts.append(contract)
    return contracts


def mint_config_to_spec_row(
    config: dict[str, Any],
    warnings: list[str],
) -> dict[str, Any] | None:
    """Map a MINT ModelConfiguration to an adapter.transform_spec insert dict.

    Returns None when the config has no typed I/O presentations — those are
    standalone models, not transform edges in the BFS graph.
    """
    config_id = config.get("id", "")
    label = config.get("label") or config_id

    inputs_raw = config.get("inputs") or config.get("hasInput") or []
    outputs_raw = config.get("outputs") or config.get("hasOutput") or []
    parameters_raw = config.get("parameters") or config.get("hasParameter") or []

    input_contracts = _build_contracts(inputs_raw, "input", config_id, warnings)
    output_contracts = _build_contracts(outputs_raw, "output", config_id, warnings)

    if not input_contracts and not output_contracts:
        return None

    env_from_args = _build_env_from_args(parameters_raw, config_id, warnings)

    tapis_app_id: str | None = config.get("tapis_app_id")
    tapis_app_version: str | None = config.get("tapis_app_version")

    if config.get("has_software_image") and not tapis_app_id:
        warnings.append(
            f"{config_id}: has_software_image is set but tapis_app_id is null — "
            "unresolved Tapis app. Admin must register the app and set tapis_app_id."
        )

    transform_type = _infer_transform_type(config)

    return {
        "mint_model_config_id": config_id,
        "name": label[0] if isinstance(label, list) else str(label),
        "description": config.get("description") or "",
        "transform_type": transform_type,
        "method": "tapis_job" if tapis_app_id else "tapis_function",
        "tapis_app_id": tapis_app_id,
        "app_version": tapis_app_version,
        "env_from_args": env_from_args or None,
        "contracts": {"data": input_contracts + output_contracts},
    }


def etl_process_to_spec_row(
    process: dict[str, Any], warnings: list[str]
) -> dict[str, Any] | None:
    """Map a catalog ETL process to the adapter's reusable transform registry.

    The catalog owns the source and runtime metadata; the adapter retains the
    normalized SVO contracts used by inference and planning.
    """
    process_id = str(process.get("id") or "")
    if not process_id:
        warnings.append("ETL process has no id — skipped.")
        return None
    contracts = process.get("contracts") or []
    if not any(c.get("role") == "input" for c in contracts) or not any(
        c.get("role") == "output" for c in contracts
    ):
        warnings.append(f"{process_id}: ETL process requires input and output contracts — skipped.")
        return None
    runtime = process.get("runtime_json") or {}
    app_id = runtime.get("tapis_app_id")
    app_version = runtime.get("tapis_app_version")
    metadata = {
        "mint_etl_process_id": process_id,
        "visibility": process.get("visibility"),
        "runtime_kind": process.get("runtime_kind"),
        "runtime": runtime,
    }
    # MINT's ETL contract includes catalog ordering (`position`), while the
    # adapter contract table stores only execution-relevant fields. Normalize
    # at this boundary so a live sync never forwards an unknown GraphQL input
    # field. Preserve the ordering as metadata for diagnostics.
    contract_fields = (
        "role",
        "standard_variable_uri",
        "unit",
        "format",
        "dimensionality",
        "spatial_type",
        "crs_requirement",
        "temporal_resolution",
        "schema_requirement_json",
    )
    normalized_contracts = []
    for contract in contracts:
        normalized = {
            key: contract[key]
            for key in contract_fields
            if key in contract
        }
        metadata_json = {}
        if contract.get("position") is not None:
            metadata_json["mint_position"] = contract["position"]
        # The ETL contract table has no catalog column; the marker rides in
        # schema_requirement_json["_svo"] (see register_existing_etl_pieces).
        # Lift it into metadata_json and keep it out of the forwarded schema.
        schema = normalized.get("schema_requirement_json")
        if isinstance(schema, dict) and "_svo" in schema:
            schema = dict(schema)
            svo_marker = schema.pop("_svo") or {}
            if isinstance(svo_marker, dict) and svo_marker.get("catalog"):
                metadata_json["catalog"] = svo_marker["catalog"]
            normalized["schema_requirement_json"] = schema or None
        if metadata_json:
            normalized["metadata_json"] = metadata_json
        normalized_contracts.append(normalized)
    # A hosted adapter piece (registered by scripts/register_existing_etl_pieces)
    # records its adapter transform_type and job-shaping hints in runtime_json,
    # so the round trip through the catalog keeps it runnable. Catalog-authored
    # processes carry none of these and stay generic "etl_process" rows.
    schema = runtime.get("parameters_schema_json")
    row = {
        "id": process_id,
        "name": process.get("label") or process_id,
        "version": process.get("version"),
        "description": process.get("description") or "",
        "transform_type": runtime.get("adapter_transform_type") or "etl_process",
        "method": "tapis_job" if app_id else "tapis_function",
        "tapis_app_id": app_id,
        "app_version": app_version,
        "parameters_schema_json": {**(schema if isinstance(schema, dict) else {}), "metadata": metadata},
        "contracts": {"data": normalized_contracts},
    }
    for key in ("stage", "env_from_args", "file_inputs"):
        if runtime.get(key) is not None:
            row[key] = runtime[key]
    return row


def _infer_transform_type(config: dict[str, Any]) -> str:
    """Infer the transform_type from MINT label/description when not explicit."""
    label = str(config.get("label") or "").lower()
    desc = str(config.get("description") or "").lower()
    combined = label + " " + desc
    if "point" in combined and ("extract" in combined or "sample" in combined):
        return "point_extract"
    if "unit" in combined and "convert" in combined:
        return "unit_convert"
    if "reproject" in combined or "gdal" in combined:
        return "gdal_reproject"
    if "rolling" in combined or "average" in combined:
        return "rolling_average"
    if "passthrough" in combined:
        return "passthrough"
    return "transform"


async def sync_mint_to_adapter(
    hasura_client: Any,
    mint_client: MintCatalogClient | None = None,
    *,
    dry_run: bool = False,
) -> SyncResult:
    """Pull all MINT ModelConfigurations and reconcile adapter.transform_spec.

    Steps:
    1. Fetch all configs from MINT (via the same Hasura the adapter already uses)
    2. Map each to a spec row
    3. Upsert rows that have a valid I/O presentation pair
    4. Delete adapter rows whose mint_model_config_id is no longer in MINT
    5. Return a SyncResult with counts + warnings
    """
    from .hasura import (
        UPSERT_TRANSFORM_SPEC_MUTATION,
        UPSERT_ETL_TRANSFORM_SPEC_MUTATION,
        DELETE_OBSOLETE_MINT_SPECS_MUTATION,
        GET_MINT_SPEC_IDS_QUERY,
        DELETE_SPEC_CONTRACTS_MUTATION,
    )

    if mint_client is None:
        mint_client = MintCatalogClient(hasura_client)

    result = SyncResult()
    warnings: list[str] = []

    log.info("mint_sync: fetching all ModelConfigurations via Hasura")
    configs = await mint_client.list_all_configurations()
    etl_processes = await mint_client.list_all_etl_processes()
    log.info("mint_sync: received %d configurations", len(configs))

    rows_to_upsert: list[dict[str, Any]] = []
    live_mint_ids: list[str] = []

    for cfg in configs:
        row = mint_config_to_spec_row(cfg, warnings)
        if row is None:
            result.skipped += 1
            continue
        if cfg.get("has_software_image") and not cfg.get("tapis_app_id"):
            result.unresolved_tapis_apps.append(cfg.get("id", ""))
        live_mint_ids.append(row["mint_model_config_id"])
        rows_to_upsert.append(row)

    for process in etl_processes:
        row = etl_process_to_spec_row(process, warnings)
        if row is None:
            result.skipped += 1
            continue
        rows_to_upsert.append(row)

    result.warnings = warnings
    log.info(
        "mint_sync: %d rows to upsert, %d skipped, %d unresolved tapis apps",
        len(rows_to_upsert), result.skipped, len(result.unresolved_tapis_apps),
    )

    if dry_run:
        result.created = len(rows_to_upsert)
        return result

    # Get existing mint-synced spec IDs to distinguish create vs update
    existing_data = await hasura_client.execute(GET_MINT_SPEC_IDS_QUERY)
    spec_id_by_config = {
        r["mint_model_config_id"]: r.get("id")
        for r in (existing_data.get("adapter_transform_spec") or [])
        if r.get("mint_model_config_id")
    }
    existing_ids = set(spec_id_by_config)

    # Replace, don't append: clear the contracts of every spec this sync is
    # about to re-insert them for.
    replace_ids = sorted({
        str(row["id"]) if "mint_model_config_id" not in row
        else str(spec_id_by_config.get(row["mint_model_config_id"]) or "")
        for row in rows_to_upsert if row.get("contracts")
    } - {""})
    if replace_ids:
        await hasura_client.execute(DELETE_SPEC_CONTRACTS_MUTATION, {"ids": replace_ids})

    for row in rows_to_upsert:
        contracts = row.pop("contracts", None)
        is_etl = "mint_model_config_id" not in row
        is_update = row.get("mint_model_config_id") in existing_ids if not is_etl else False
        # Upsert on mint_model_config_id: if the row exists, update all fields;
        # contracts are deleted and re-inserted via the nested mutation.
        row["mint_synced_at"] = "now()"
        if contracts:
            row["contracts"] = contracts
        mutation = UPSERT_ETL_TRANSFORM_SPEC_MUTATION if is_etl else UPSERT_TRANSFORM_SPEC_MUTATION
        await hasura_client.execute(mutation, {"obj": row})
        if is_update:
            result.updated += 1
        else:
            result.created += 1

    # Delete spec rows for configs that no longer exist in MINT.
    # Rows with null mint_model_config_id (hand-created) are never deleted.
    if live_mint_ids:
        del_data = await hasura_client.execute(
            DELETE_OBSOLETE_MINT_SPECS_MUTATION,
            {"live_ids": live_mint_ids},
        )
        result.deleted = (
            del_data.get("delete_adapter_transform_spec", {}).get("affected_rows", 0)
        )

    log.info(
        "mint_sync: done — created=%d updated=%d deleted=%d skipped=%d warnings=%d",
        result.created, result.updated, result.deleted, result.skipped,
        len(result.warnings),
    )
    return result


def sync_mint_to_adapter_sync(
    hasura_client: Any,
    mint_client: MintCatalogClient | None = None,
    *,
    dry_run: bool = False,
) -> SyncResult:
    """Synchronous wrapper for use outside an async context (e.g. startup hook)."""
    return asyncio.get_event_loop().run_until_complete(
        sync_mint_to_adapter(hasura_client, mint_client, dry_run=dry_run)
    )
