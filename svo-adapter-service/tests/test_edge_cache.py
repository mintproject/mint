"""The edge cache: computing it gives the same edges with far fewer comparisons,
recomputing it does not block the event loop, and the planner does not trust a
cache that knows nothing about a piece."""
from __future__ import annotations

import asyncio
import os
import threading

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config

from app import edges as edges_mod  # noqa: E402
from app.edges import build_edge_map, compute_edges  # noqa: E402
from app.models import DataObjectContract, ReadinessStatus  # noqa: E402
from app.planner import _contract_from_registry, compatibility, find_path  # noqa: E402

A, B, C = "https://example.org/a", "https://example.org/b", "https://example.org/c"


def spec(sid, inputs, outputs):
    contracts = [{"id": f"{sid}-in{i}", "role": "input", "standard_variable_uri": sv, "format": fmt}
                 for i, (sv, fmt) in enumerate(inputs)]
    contracts += [{"id": f"{sid}-out{i}", "role": "output", "standard_variable_uri": sv, "format": fmt}
                  for i, (sv, fmt) in enumerate(outputs)]
    return {"id": sid, "name": sid, "contracts": contracts}


REGISTRY = [
    spec("one", [(A, "csv")], [(B, "csv")]),
    spec("two", [(B, "csv")], [(C, "csv")]),
    spec("upper", [(B.upper(), "csv")], [(C, "json")]),      # same variable, different case
    spec("any", [(None, "csv")], [(A, "csv")]),              # accepts any variable
    spec("other-format", [(B, "json")], [(C, "csv")]),
    spec("opaque", [(A, "csv")], [(None, "csv")]),           # output names no variable
]


def all_pairs(registry):
    """Every output compared with every input: the definition the index must match."""
    found = []
    for out_spec in registry:
        for out_c in (c for c in out_spec["contracts"] if c["role"] == "output"):
            src = _contract_from_registry(out_c).model_copy(update={"resource_uri": "precompute"})
            for in_spec in registry:
                for in_c in (c for c in in_spec["contracts"] if c["role"] == "input"):
                    if compatibility(src, _contract_from_registry(in_c)).status == ReadinessStatus.ready:
                        found.append((out_c["id"], in_c["id"]))
    return found


def pairs(edges):
    return [(e["source_contract_id"], e["target_contract_id"]) for e in edges]


def test_indexed_edges_equal_the_all_pairs_definition_in_the_same_order():
    assert pairs(compute_edges(REGISTRY)) == all_pairs(REGISTRY)


def test_expected_edges_are_present_and_mismatches_absent():
    found = set(pairs(compute_edges(REGISTRY)))
    assert ("one-out0", "two-in0") in found              # same variable and format
    assert ("one-out0", "upper-in0") in found            # case-insensitive variable
    assert ("one-out0", "any-in0") in found              # target with no variable accepts it
    assert ("one-out0", "other-format-in0") not in found  # format differs
    assert ("two-out0", "one-in0") not in found          # variable differs
    assert ("opaque-out0", "any-in0") in found           # opaque output only reaches a no-variable input
    assert ("opaque-out0", "one-in0") not in found


def test_recompute_runs_the_computation_off_the_event_loop(monkeypatch):
    seen = {}

    def fake_compute(registry):
        seen["thread"] = threading.current_thread()
        return [{"source_contract_id": "a", "target_contract_id": "b"}]

    class FakeHasura:
        async def execute(self, query, variables=None):
            if "TransformRegistry" in query:
                return {"adapter_transform_spec": REGISTRY}
            if "delete_adapter_transform_edge" in query:
                return {"delete_adapter_transform_edge": {"affected_rows": 7}}
            return {"insert_adapter_transform_edge": {"affected_rows": len(variables["objects"])}}

    monkeypatch.setattr(edges_mod, "compute_edges", fake_compute)

    async def run():
        seen["loop_thread"] = threading.current_thread()
        return await edges_mod.recompute(FakeHasura())

    result = asyncio.run(run())
    assert seen["thread"] is not seen["loop_thread"]
    assert result == {"deleted": 7, "inserted": 1, "registry_size": len(REGISTRY), "edge_count": 1}


SOURCE = DataObjectContract(standard_variable_uri=A, format="csv", resource_uri="https://example.org/data.csv")
TARGET = DataObjectContract(standard_variable_uri=C, format="csv")
CHAIN = REGISTRY[:2]


def test_a_cache_with_no_entry_for_a_piece_does_not_hide_the_path():
    assert [s["id"] for s in find_path(SOURCE, TARGET, CHAIN, edge_map={})] == ["one", "two"]
    # A cache written before these pieces were synced refers to other contract ids.
    stale = build_edge_map(CHAIN, [{"source_contract_id": "old-out", "target_contract_id": "old-in"}])
    assert [s["id"] for s in find_path(SOURCE, TARGET, CHAIN, edge_map=stale)] == ["one", "two"]


def test_a_current_cache_gives_the_same_path():
    fresh = build_edge_map(CHAIN, compute_edges(CHAIN))
    assert [s["id"] for s in find_path(SOURCE, TARGET, CHAIN, edge_map=fresh)] == ["one", "two"]
    assert [s["id"] for s in find_path(SOURCE, TARGET, CHAIN)] == ["one", "two"]


def test_no_path_is_still_no_path():
    unreachable = DataObjectContract(standard_variable_uri="https://example.org/zzz", format="csv")
    assert find_path(SOURCE, unreachable, CHAIN, edge_map={}) is None
