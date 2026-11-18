"""transform_edge precomputation.

Walks every (output_contract, input_contract) pair in the registry and checks
compatibility. Compatible pairs are stored in `adapter.transform_edge` so the
planner can do a single indexed lookup instead of running all compatibility
checks on every BFS step.

Public API
----------
compute_edges(registry)        -> list of edge dicts (pure, no I/O)
build_edge_map(registry, edges) -> {output_contract_id: [spec_dict, ...]}
recompute(h)                   -> coroutine; deletes + re-inserts all edges
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from .planner import DataObjectContract, _contract_from_registry, compatibility, ReadinessStatus

log = logging.getLogger(__name__)


def _variable_key(uri: str | None) -> str | None:
    """A standard variable as the semantic check compares it."""
    return uri.strip().lower() if uri is not None else None


# ---------------------------------------------------------------------------
# GraphQL (self-contained — no imports from main.py)
# ---------------------------------------------------------------------------

GET_EDGES = """
query GetEdges {
  adapter_transform_edge {
    id source_contract_id target_contract_id is_lossy
  }
}
"""

DELETE_ALL_EDGES = """
mutation DeleteAllEdges {
  delete_adapter_transform_edge(where: {}) { affected_rows }
}
"""

INSERT_EDGES = """
mutation InsertEdges($objects: [adapter_transform_edge_insert_input!]!) {
  insert_adapter_transform_edge(objects: $objects) { affected_rows }
}
"""


# ---------------------------------------------------------------------------
# Pure computation — no I/O, easily testable
# ---------------------------------------------------------------------------

def compute_edges(registry: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return one dict per compatible (output → input) contract pair.

    An edge means: data that satisfies OUTPUT contract O (produced by transform A)
    can be fed directly to INPUT contract I of transform B. The BFS uses this to
    avoid re-running all compatibility checks on every step.

    Edges are directional — A's output compatible with B's input — but A may equal
    B (self-chaining transforms are allowed). Only OUTPUT→INPUT edges are emitted;
    OUTPUT→OUTPUT and INPUT→INPUT pairs are not meaningful for planning.
    """
    # Index contracts by role
    outputs: list[tuple[dict[str, Any], dict[str, Any]]] = []  # (contract, owning_spec)
    inputs:  list[tuple[dict[str, Any], dict[str, Any]]] = []

    for spec in registry:
        for c in spec.get("contracts", []):
            if not c.get("id"):
                continue
            if c.get("role") == "output":
                outputs.append((c, spec))
            elif c.get("role") == "input":
                inputs.append((c, spec))

    # The semantic check passes only when the target names no standard variable
    # or names the same one as the source (planner._check_semantic). Index the
    # inputs that way so each output is compared with the inputs that can match
    # it, not with every input in the registry. Positions keep the original
    # order, which the planner's tie-breaking depends on.
    parsed_inputs = [(in_c, in_spec, _contract_from_registry(in_c)) for in_c, in_spec in inputs]
    by_variable: dict[str | None, list[int]] = {}
    for position, (_, _, tgt) in enumerate(parsed_inputs):
        by_variable.setdefault(_variable_key(tgt.standard_variable_uri), []).append(position)

    edges: list[dict[str, Any]] = []
    for out_c, out_spec in outputs:
        src = _contract_from_registry(out_c)
        positions = list(by_variable.get(None, []))
        key = _variable_key(src.standard_variable_uri)
        if key is not None:
            positions = sorted(positions + by_variable.get(key, []))
        # Output contracts have no resource_uri (they're specs, not materialized files).
        # Treat the output as accessible — the upstream transform produces a file
        # when it runs, so accessibility is guaranteed by definition.
        if not src.resource_uri:
            src = src.model_copy(update={"resource_uri": "precompute"})

        # Handle pass-through transforms: if output format is null (wildcard),
        # try to infer format from the transform's input contract.
        inferred_format = src.format
        if src.format is None:
            for c in out_spec.get("contracts", []):
                if c.get("role") == "input" and c.get("format"):
                    inferred_format = c["format"]
                    break

        # For pass-through transforms (both input and output format are null),
        # create edges based on SVO + unit compatibility, ignoring format.
        is_passthrough = (src.format is None)
        for c in out_spec.get("contracts", []):
            if c.get("role") == "input" and c.get("format") is None:
                is_passthrough = True
                break

        for position in positions:
            in_c, in_spec, tgt = parsed_inputs[position]
            # Use inferred format for compatibility check
            src_for_check = src
            if src.format is None and inferred_format is not None:
                src_for_check = src.model_copy(update={"format": inferred_format})
            elif is_passthrough and src.format is None:
                # Pass-through transform: try compatibility with inferred format from target
                # The pass-through preserves whatever format it receives, so if the
                # target accepts a specific format, we assume the pass-through can provide it
                # (since it preserves whatever upstream format it receives).
                # We check compatibility by temporarily using the target's format.
                src_for_check = src.model_copy(update={"format": tgt.format})
            result = compatibility(src_for_check, tgt)
            if result.status == ReadinessStatus.ready:
                edges.append({
                    "source_contract_id": out_c["id"],
                    "target_contract_id": in_c["id"],
                    "is_lossy": bool(out_spec.get("is_lossy")),
                    "compatibility_json": {
                        d.dimension.value: d.compatible
                        for d in result.dimensions
                    },
                })
    return edges


def build_edge_map(
    registry: list[dict[str, Any]],
    edges: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    """Build {output_contract_id: [spec_dict, ...]} for fast BFS lookup.

    Given the output contract id of the transform that was just applied, the map
    tells the planner which other transforms can immediately accept its output.
    """
    spec_by_input_id: dict[str, dict[str, Any]] = {}
    for spec in registry:
        for c in spec.get("contracts", []):
            if c.get("role") == "input" and c.get("id"):
                spec_by_input_id[c["id"]] = spec

    result: dict[str, list[dict[str, Any]]] = {}
    for edge in edges:
        out_id = edge.get("source_contract_id")
        in_id = edge.get("target_contract_id")
        spec = spec_by_input_id.get(in_id)
        if out_id and spec:
            lst = result.setdefault(out_id, [])
            # Avoid duplicating the same spec twice under one output contract.
            if spec not in lst:
                lst.append(spec)
    return result


# ---------------------------------------------------------------------------
# I/O — recompute in Hasura
# ---------------------------------------------------------------------------

async def recompute(h) -> dict[str, Any]:
    """Delete all existing edges, compute the new set, insert them.

    Uses the admin-secret client `h` (passed in so this module stays testable
    without a real Hasura). Returns a summary dict.
    """
    from .hasura import TRANSFORM_REGISTRY_QUERY

    registry = (await h.execute(TRANSFORM_REGISTRY_QUERY))["adapter_transform_spec"]
    # CPU-bound: run it off the event loop so the service keeps answering.
    started = time.monotonic()
    edges = await asyncio.to_thread(compute_edges, registry)
    log.info("edges: computed %d edges for %d specs in %.1fs",
                len(edges), len(registry), time.monotonic() - started)

    deleted = (await h.execute(DELETE_ALL_EDGES))["delete_adapter_transform_edge"]["affected_rows"]

    inserted = 0
    if edges:
        # Hasura has a max variables limit; batch in chunks of 500 to be safe.
        for i in range(0, len(edges), 500):
            chunk = edges[i:i + 500]
            result = await h.execute(INSERT_EDGES, {"objects": chunk})
            inserted += result["insert_adapter_transform_edge"]["affected_rows"]

    return {
        "deleted": deleted,
        "inserted": inserted,
        "registry_size": len(registry),
        "edge_count": len(edges),
    }
