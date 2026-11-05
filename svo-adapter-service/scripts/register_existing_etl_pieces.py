"""Import existing SVO Adapter transform manifests into the MINT ETL catalog.

Dry-run by default. Use --apply against the local Hasura instance to upsert the
pieces; the catalog IDs are stable, so this is safe to rerun.
"""
import argparse
import json
from pathlib import Path
from typing import Iterable
import urllib.request

MUTATION = """mutation UpsertETL($object: modelcatalog_etl_process_insert_input!) {
  insert_modelcatalog_etl_process_one(object: $object, on_conflict: {
    constraint: modelcatalog_etl_process_pkey,
    update_columns: [label, description, version, visibility, runtime_kind, runtime_json]
  }) { id }
}"""


def manifests(root: Path):
    for path in sorted(root.glob("*_transforms.json")):
        payload = json.loads(path.read_text())
        for spec in payload.get("transform_specs", []):
            if spec.get("name"):
                yield path.name, spec
    payload = json.loads((root / "transform_spec_registration.json").read_text())
    if payload.get("transform_spec"):
        yield "transform_spec_registration.json", payload["transform_spec"]


def _schema_requirement(contract):
    """Schema JSON for a contract, carrying its catalog marker if it has one.

    MINT's contract table has no catalog column, so the marker rides in
    `schema_requirement_json` under the `_svo` namespace, merged into (never
    replacing) any existing schema. app.mint_sync lifts it back out on sync.
    """
    schema = contract.get("schema_requirement_json")
    catalog = contract.get("catalog")
    if not catalog:
        return schema
    return {**(schema or {}), "_svo": {"catalog": catalog}}


def to_object(spec):
    process_id = spec.get("id") or f"https://w3id.org/okn/i/mint/etl/{spec['name']}"
    method = spec.get("method", "tapis_function")
    return {
        "id": process_id,
        "label": spec.get("name", process_id),
        "description": spec.get("description", ""),
        "version": spec.get("version", "1.0.0"),
        "visibility": "public",
        "runtime_kind": "tapis_app" if method == "tapis_job" else "tapis_function",
        "runtime_json": {
            "language": "python",
            "entrypoint": "transform",
            "tapis_app_id": spec.get("tapis_app_id"),
            "tapis_app_version": spec.get("app_version"),
            "adapter_method": method,
            "container_image": spec.get("container_image"),
            "source_code_url": spec.get("source_code_url"),
            "parameters_schema_json": spec.get("parameters_schema_json"),
            # Round-tripped by app.mint_sync so the adapter row stays runnable.
            "adapter_transform_type": spec.get("transform_type"),
            "stage": spec.get("stage"),
            "env_from_args": spec.get("env_from_args"),
            "file_inputs": spec.get("file_inputs"),
        },
        "contracts": {"data": [
            {"role": c.get("role"), "position": sum(1 for prior in spec.get("contracts", [])[:i] if prior.get("role") == c.get("role")), "standard_variable_uri": c.get("standard_variable_uri"),
             "unit": c.get("unit"), "format": c.get("format"), "dimensionality": c.get("dimensionality"),
             "spatial_type": c.get("spatial_type"), "crs_requirement": c.get("crs_requirement"),
             "temporal_resolution": c.get("temporal_resolution"),
             "schema_requirement_json": _schema_requirement(c)}
            for i, c in enumerate(spec.get("contracts", []))
        ], "on_conflict": {"constraint": "modelcatalog_etl_process_contract_pkey", "update_columns": [
            "standard_variable_uri", "unit", "format", "dimensionality", "spatial_type",
            "crs_requirement", "temporal_resolution", "schema_requirement_json"
        ]}},
    }


def unique_rows(entries: Iterable[tuple[str, dict]]) -> list[dict]:
    """Return one row per stable ID and reject conflicting definitions."""
    by_id: dict[str, dict] = {}
    sources: dict[str, str] = {}
    for source, spec in entries:
        row = to_object(spec)
        process_id = row["id"]
        previous = by_id.get(process_id)
        if previous is None:
            by_id[process_id] = row
            sources[process_id] = source
            continue
        if row != previous:
            raise ValueError(
                f"conflicting ETL definition for {process_id}: "
                f"{sources[process_id]} vs {source}"
            )
    return list(by_id.values())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--endpoint", default="http://localhost:8082/v1/graphql")
    parser.add_argument("--admin-secret", default="mint")
    args = parser.parse_args()
    rows = unique_rows(manifests(Path(__file__).parents[1] / "examples"))
    print(f"Found {len(rows)} unique adapter ETL pieces")
    if not args.apply:
        for row in rows:
            print(f"DRY RUN {row['id']} — {row['label']}")
        return
    for row in rows:
        body = json.dumps({"query": MUTATION, "variables": {"object": row}}).encode()
        request = urllib.request.Request(args.endpoint, body, {"Content-Type": "application/json", "x-hasura-admin-secret": args.admin_secret})
        with urllib.request.urlopen(request) as response:
            result = json.load(response)
        if result.get("errors"):
            raise RuntimeError(result["errors"])
        print(f"REGISTERED {row['id']}")


if __name__ == "__main__":
    main()
