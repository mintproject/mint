"""The catalog sync registers model configurations as pieces the planner may use.
A flow is a configuration too, but it is a graph of pieces, not a piece."""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.mint_sync import sync_mint_to_adapter  # noqa: E402

V = "https://example.org/"


def _configuration(config_id):
    io = lambda variable: [{"input" if variable == "a" else "output": {  # noqa: E731
        "id": f"{config_id}:{variable}", "has_format": "csv",
        "presentations": [{"presentation": {"standard_variable": {"id": V + variable}}}]}}]
    return {"id": config_id, "label": config_id, "inputs": io("a"), "outputs": io("b"), "parameters": []}


class _Catalog:
    def __init__(self, configurations, flows, flows_table=True):
        self.configurations, self.flows, self.flows_table = configurations, flows, flows_table
        self.upserted: list[str] = []

    async def execute(self, query, variables=None):
        variables = variables or {}
        if "ListFlowConfigurationIds" in query:
            if not self.flows_table:
                raise RuntimeError("field 'modelcatalog_configuration_flow' not found in type: 'query_root'")
            return {"modelcatalog_configuration_flow": [{"configuration_id": i} for i in self.flows]}
        if "modelcatalog_configuration(" in query:
            return {"modelcatalog_configuration": [] if variables.get("offset") else self.configurations}
        if "modelcatalog_etl_process(" in query:
            return {"modelcatalog_etl_process": []}
        if "GetMintSpecIds" in query:
            return {"adapter_transform_spec": []}
        if "obj" in variables and variables["obj"].get("mint_model_config_id"):
            self.upserted.append(variables["obj"]["mint_model_config_id"])
        return {"insert_adapter_transform_spec_one": {"id": "x"},
                "delete_adapter_transform_spec": {"affected_rows": 0},
                "delete_adapter_transform_contract": {"affected_rows": 0}}


def _rows(result_of_dry_run):
    return result_of_dry_run.created, result_of_dry_run.skipped


def test_a_flow_configuration_is_not_registered_as_a_piece():
    catalog = _Catalog([_configuration("model"), _configuration("flow")], flows=["flow"])
    assert _rows(asyncio.run(sync_mint_to_adapter(catalog, dry_run=True))) == (1, 1)
    both = _Catalog([_configuration("model"), _configuration("flow")], flows=[])
    assert _rows(asyncio.run(sync_mint_to_adapter(both, dry_run=True))) == (2, 0)


def test_a_catalog_from_before_flows_existed_still_syncs():
    catalog = _Catalog([_configuration("model")], flows=[], flows_table=False)
    assert _rows(asyncio.run(sync_mint_to_adapter(catalog, dry_run=True))) == (1, 0)
