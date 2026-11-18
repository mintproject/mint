"""Owner and visibility travel from the catalog into the registry, removed
processes are deleted, and approval is tied to the stored source's hash."""
from __future__ import annotations

import asyncio
import os

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.hasura import UPSERT_ETL_TRANSFORM_SPEC_MUTATION  # noqa: E402
from app.main import _is_operator_route, app  # noqa: E402
from app.mint_sync import etl_process_to_spec_row, sync_mint_to_adapter  # noqa: E402
from app.store import STORE  # noqa: E402
from app.stored_source import is_approved, source_sha256, stored_source  # noqa: E402

client = TestClient(app)
CODE = "from owe_python_sdk.runtime import execution_context as ctx\nctx.set_output('result', '1')\n"


def _process(pid="https://w3id.org/okn/i/mint/etl/mine", **over):
    row = {
        "id": pid, "label": "Mine", "version": "1.0.0",
        "owner_username": "alice", "visibility": "private",
        "runtime_kind": "tapis_function",
        "runtime_json": {"language": "python", "source": {"language": "python", "code": CODE}},
        "contracts": [
            {"role": "input", "position": 0, "standard_variable_uri": "https://example.org/a"},
            {"role": "output", "position": 0, "standard_variable_uri": "https://example.org/b"},
        ],
    }
    row.update(over)
    return row


class _FakeHasura:
    def __init__(self, etl_processes):
        self.etl_processes = etl_processes
        self.calls: list[tuple[str, dict]] = []

    async def execute(self, query, variables=None):
        variables = variables or {}
        self.calls.append((query, variables))
        if "modelcatalog_configuration(" in query:
            return {"modelcatalog_configuration": []}
        if "modelcatalog_etl_process(" in query:
            return {"modelcatalog_etl_process": [] if variables.get("offset") else self.etl_processes}
        if "GetMintSpecIds" in query:
            return {"adapter_transform_spec": []}
        if "DeleteObsoleteEtlSpecs" in query:
            return {"delete_adapter_transform_spec": {"affected_rows": 3}}
        if "DeleteSpecContracts" in query:
            return {"delete_adapter_transform_contract": {"affected_rows": 0}}
        return {"insert_adapter_transform_spec_one": {"id": "x"}}

    def variables_of(self, op):
        return [v for q, v in self.calls if op in q]


# --- sync ------------------------------------------------------------------

def test_spec_row_carries_owner_visibility_and_process_id():
    row = etl_process_to_spec_row(_process(), [])
    assert row["owner_username"] == "alice"
    assert row["visibility"] == "private"
    assert row["mint_etl_process_id"] == row["id"]
    assert "approved_source_sha256" not in row


@pytest.mark.parametrize("visibility", [None, "", "everyone"])
def test_missing_or_unknown_visibility_is_private(visibility):
    assert etl_process_to_spec_row(_process(visibility=visibility), [])["visibility"] == "private"


def test_built_in_process_stays_public_and_ownerless():
    row = etl_process_to_spec_row(
        _process(owner_username=None, visibility="public", runtime_json={"adapter_transform_type": "unit_convert"}), [])
    assert (row["owner_username"], row["visibility"]) == (None, "public")
    assert stored_source(row) is None


def test_sync_upserts_ownership_and_never_writes_approval():
    fake = _FakeHasura([_process()])
    asyncio.run(sync_mint_to_adapter(fake))
    (upsert,) = fake.variables_of("UpsertMintETLSpec")
    assert upsert["obj"]["owner_username"] == "alice"
    assert upsert["obj"]["visibility"] == "private"
    assert "approved_source_sha256" not in upsert["obj"]
    assert "approved_source_sha256" not in UPSERT_ETL_TRANSFORM_SPEC_MUTATION
    for column in ("owner_username", "visibility", "mint_etl_process_id"):
        assert column in UPSERT_ETL_TRANSFORM_SPEC_MUTATION


def test_sync_deletes_rows_for_processes_gone_from_the_catalog():
    fake = _FakeHasura([_process("etl-a"), _process("etl-b")])
    result = asyncio.run(sync_mint_to_adapter(fake))
    assert fake.variables_of("DeleteObsoleteEtlSpecs") == [{"live_ids": ["etl-a", "etl-b"]}]
    assert result.deleted == 3


def test_an_empty_catalog_listing_deletes_nothing():
    fake = _FakeHasura([])
    asyncio.run(sync_mint_to_adapter(fake))
    assert fake.variables_of("DeleteObsoleteEtlSpecs") == []


# --- stored source and approval -------------------------------------------

@pytest.mark.parametrize("metadata", [
    {"source": {"language": "python", "code": CODE}},
    {"source": CODE},
    {"runtime": {"source": {"code": CODE}}},
    {"runtime": {"source": CODE}},
])
def test_stored_source_reads_every_shape(metadata):
    assert stored_source({"parameters_schema_json": {"metadata": metadata}}) == CODE


@pytest.mark.parametrize("spec", [
    {}, {"parameters_schema_json": None},
    {"parameters_schema_json": {"metadata": {"source": {"code": "   "}}}},
    {"parameters_schema_json": {"metadata": {"runtime": "not-a-dict"}}},
])
def test_no_stored_source(spec):
    assert stored_source(spec) is None


def test_approval_lapses_when_the_source_changes():
    spec = {"parameters_schema_json": {"metadata": {"source": {"code": CODE}}},
            "approved_source_sha256": source_sha256(CODE)}
    assert is_approved(spec)
    spec["parameters_schema_json"]["metadata"]["source"]["code"] = CODE + "# changed\n"
    assert not is_approved(spec)
    assert not is_approved({"parameters_schema_json": {"metadata": {"source": {"code": CODE}}}})
    assert not is_approved({"approved_source_sha256": source_sha256(CODE)})


# --- approval route --------------------------------------------------------

@pytest.fixture
def pieces():
    client.post("/admin/reset")
    contracts = [{"role": "input", "standard_variable_uri": "https://example.org/a"},
                 {"role": "output", "standard_variable_uri": "https://example.org/b"}]
    stored = client.post("/transform-specs", json={
        "name": "stored", "method": "tapis_function", "contracts": contracts,
        "metadata": {"source": {"language": "python", "code": CODE}}}).json()["id"]
    builtin = client.post("/transform-specs", json={
        "name": "builtin", "method": "tapis_function", "transform_type": "unit_convert",
        "contracts": contracts}).json()["id"]
    return stored, builtin


def test_approval_route_is_an_operator_route():
    assert _is_operator_route("PUT", "/admin/transform-spec-approval")


def test_approve_records_the_source_hash_and_withdraw_clears_it(pieces):
    stored, _ = pieces
    resp = client.put("/admin/transform-spec-approval", json={"spec_id": stored, "approved": True})
    assert resp.status_code == 200
    assert resp.json()["approved_source_sha256"] == source_sha256(CODE)
    assert is_approved(STORE.transform_spec[stored])
    assert any(e.get("event_type") == "transform_spec_approval_set" for e in STORE.provenance)

    resp = client.put("/admin/transform-spec-approval", json={"spec_id": stored, "approved": False})
    assert resp.json()["approved_source_sha256"] is None
    assert not is_approved(STORE.transform_spec[stored])


def test_a_piece_without_stored_source_cannot_be_approved(pieces):
    _, builtin = pieces
    resp = client.put("/admin/transform-spec-approval", json={"spec_id": builtin, "approved": True})
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "NO_STORED_SOURCE"


def test_unknown_piece_is_a_404(pieces):
    resp = client.put("/admin/transform-spec-approval", json={"spec_id": "nope", "approved": True})
    assert resp.status_code == 404
