"""Hosted ETL pieces survive the MINT catalog round trip, and a re-sync replaces
contracts instead of appending them.

register_existing_etl_pieces writes each piece to modelcatalog_etl_process;
app.mint_sync maps it back into adapter.transform_spec. Before this fix the
sync rewrote every hosted piece as transform_type "etl_process" with no env
bindings (so it had no code to run) and re-inserted its contracts every run.
"""
from __future__ import annotations

import asyncio
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.hasura import DELETE_SPEC_CONTRACTS_MUTATION  # noqa: E402
from app.mint_sync import etl_process_to_spec_row, sync_mint_to_adapter  # noqa: E402
from app.planner import build_plan_json  # noqa: E402

_SCRIPT = ROOT / "scripts" / "register_existing_etl_pieces.py"
_spec = importlib.util.spec_from_file_location("register_existing_etl_pieces", _SCRIPT)
register = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(register)

EXAMPLES = ROOT / "examples"


def _as_catalog_row(obj: dict) -> dict:
    """What LIST_MINT_ETL_PROCESSES_QUERY returns for an upserted object."""
    return {**{k: v for k, v in obj.items() if k != "contracts"},
            "contracts": obj["contracts"]["data"]}


def _round_trip(spec: dict) -> dict:
    warnings: list[str] = []
    row = etl_process_to_spec_row(_as_catalog_row(register.to_object(spec)), warnings)
    assert row is not None, warnings
    return row


def _hosted_specs():
    return [spec for _, spec in register.manifests(EXAMPLES)
            if spec.get("transform_type") and spec.get("contracts")]


def test_every_hosted_piece_keeps_its_plan_step_through_the_catalog():
    specs = _hosted_specs()
    assert specs
    for spec in specs:
        direct = build_plan_json([spec])["steps"][0]
        synced = build_plan_json([_round_trip(spec)])["steps"][0]
        for key in ("transform_type", "stage", "env_from_args", "file_inputs"):
            assert synced.get(key) == direct.get(key), (spec.get("id"), key)
        assert (synced.get("parameters_schema_json") or {}).get("properties") == \
            (direct.get("parameters_schema_json") or {}).get("properties"), spec.get("id")


def test_aoi_piece_round_trips_as_an_allowed_input_step():
    from app.main import INPUT_STEP_TRANSFORM_TYPES

    aoi = next(s for s in _hosted_specs() if s.get("id") == "ts-aoi-from-boundary")
    row = _round_trip(aoi)
    assert row["transform_type"] in INPUT_STEP_TRANSFORM_TYPES
    assert row["env_from_args"] == aoi["env_from_args"]


def test_catalog_authored_process_stays_generic():
    row = etl_process_to_spec_row({
        "id": "etl-plain", "label": "plain", "runtime_json": {"language": "python"},
        "contracts": [{"role": "input"}, {"role": "output"}],
    }, [])
    assert row["transform_type"] == "etl_process"
    assert "env_from_args" not in row and "stage" not in row


class _FakeHasura:
    def __init__(self, etl_processes: list[dict], existing: list[dict]):
        self.etl_processes = etl_processes
        self.existing = existing
        self.calls: list[tuple[str, dict]] = []

    async def execute(self, query: str, variables: dict | None = None) -> dict:
        self.calls.append((query, variables or {}))
        if "modelcatalog_configuration(" in query:
            return {"modelcatalog_configuration": []}
        if "modelcatalog_etl_process(" in query:
            return {"modelcatalog_etl_process": self.etl_processes if not variables.get("offset") else []}
        if "GetMintSpecIds" in query:
            return {"adapter_transform_spec": self.existing}
        if "DeleteSpecContracts" in query:
            return {"delete_adapter_transform_contract": {"affected_rows": 4}}
        return {"insert_adapter_transform_spec_one": {"id": "x"}}


def test_resync_clears_contracts_before_reinserting():
    aoi = next(s for s in _hosted_specs() if s.get("id") == "ts-aoi-from-boundary")
    fake = _FakeHasura([_as_catalog_row(register.to_object(aoi))], existing=[])
    asyncio.run(sync_mint_to_adapter(fake, dry_run=False))

    kinds = [q for q, _ in fake.calls]
    delete_at = next(i for i, q in enumerate(kinds) if q == DELETE_SPEC_CONTRACTS_MUTATION)
    upsert_at = next(i for i, q in enumerate(kinds) if "UpsertMintETLSpec" in q)
    assert delete_at < upsert_at
    assert fake.calls[delete_at][1] == {"ids": ["ts-aoi-from-boundary"]}
