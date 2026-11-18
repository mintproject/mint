"""The registry is read as the calling user when registry_user_scoped is on,
and Hasura's select permissions cover everything that read asks for."""
from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config

import pytest  # noqa: E402
import yaml  # noqa: E402

from app import main as main_module  # noqa: E402
from app.config import settings  # noqa: E402
from app.edges import build_edge_map  # noqa: E402
from app.hasura import TRANSFORM_REGISTRY_QUERY, HasuraClient  # noqa: E402
from app.store import InMemoryHasura  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
TABLES = ROOT / "graphql_engine" / "metadata" / "tables.yaml"
PUBLIC = {"visibility": {"_eq": "public"}}
VISIBLE_TO_USER = {"_or": [PUBLIC, {"visibility": {"_eq": "shared"}},
                           {"owner_username": {"_eq": "X-Hasura-User-Id"}}]}


@pytest.fixture
def admin_secret(monkeypatch):
    monkeypatch.setattr(settings, "hasura_admin_secret", "admin-secret")


# --- the client ------------------------------------------------------------

def test_off_by_default_and_as_user_is_then_the_same_client(admin_secret):
    assert settings.registry_user_scoped is False
    client = HasuraClient("user-token")
    assert client.as_user() is client
    assert client._headers()["x-hasura-admin-secret"] == "admin-secret"


def test_as_user_sends_the_bearer_token_and_never_the_admin_secret(admin_secret, monkeypatch):
    monkeypatch.setattr(settings, "registry_user_scoped", True)
    headers = HasuraClient("user-token").as_user()._headers()
    assert headers["Authorization"] == "Bearer user-token"
    assert "x-hasura-admin-secret" not in headers


def test_as_user_without_a_token_is_anonymous(admin_secret, monkeypatch):
    monkeypatch.setattr(settings, "registry_user_scoped", True)
    headers = HasuraClient(None).as_user()._headers()
    assert "Authorization" not in headers
    assert "x-hasura-admin-secret" not in headers


def test_the_ordinary_client_is_unchanged_when_scoping_is_on(admin_secret, monkeypatch):
    monkeypatch.setattr(settings, "registry_user_scoped", True)
    assert HasuraClient("user-token")._headers()["x-hasura-admin-secret"] == "admin-secret"


def test_demo_store_has_nothing_to_scope():
    store = InMemoryHasura("t")
    assert store.as_user() is store


# --- every registry read goes through the helper ---------------------------

def test_registry_helper_reads_through_as_user():
    class Fake:
        def __init__(self, scoped=False):
            self.scoped = scoped
            self.used = []

        def as_user(self):
            self.child = Fake(scoped=True)
            return self.child

        async def execute(self, query, variables=None):
            self.used.append(query)
            return {"adapter_transform_spec": [{"id": "scoped" if self.scoped else "admin"}]}

    fake = Fake()
    assert asyncio.run(main_module._registry(fake)) == [{"id": "scoped"}]
    assert fake.used == [] and fake.child.used == [TRANSFORM_REGISTRY_QUERY]


def test_no_route_reads_the_registry_around_the_helper():
    source = Path(main_module.__file__).read_text()
    uses = [m.start() for m in re.finditer(r"TRANSFORM_REGISTRY_QUERY", source)]
    # The import, and the one execute inside _registry.
    assert len(uses) == 2
    assert source.count("execute(TRANSFORM_REGISTRY_QUERY)") == 1
    assert "client.execute(TRANSFORM_REGISTRY_QUERY)" in source


# --- edges follow the scoped registry --------------------------------------

def test_edges_into_a_piece_missing_from_the_registry_are_dropped():
    visible = {"id": "mine", "contracts": [{"id": "in-mine", "role": "input"}]}
    edges = [
        {"source_contract_id": "out-x", "target_contract_id": "in-mine"},
        {"source_contract_id": "out-x", "target_contract_id": "in-someone-elses-private"},
    ]
    assert build_edge_map([visible], edges) == {"out-x": [visible]}


# --- Hasura permissions cover the read -------------------------------------

def _select(table, role):
    for entry in yaml.safe_load(TABLES.read_text()):
        if entry["table"] == {"name": table, "schema": "adapter"}:
            for perm in entry.get("select_permissions") or []:
                if perm["role"] == role:
                    return perm["permission"]
    raise AssertionError(f"adapter.{table} has no {role} select permission")


def _queried_fields():
    body = TRANSFORM_REGISTRY_QUERY.split("adapter_transform_spec {", 1)[1]
    spec_part, contract_part = body.split("contracts {", 1)
    return set(spec_part.split()), set(contract_part.split("}", 1)[0].split())


@pytest.mark.parametrize("role", ["anonymous", "user"])
def test_permissions_expose_every_field_the_registry_query_selects(role):
    spec_fields, contract_fields = _queried_fields()
    assert {"owner_username", "visibility", "approved_source_sha256"} <= spec_fields
    assert spec_fields <= set(_select("transform_spec", role)["columns"])
    assert contract_fields <= set(_select("transform_contract", role)["columns"])


def test_anonymous_sees_only_public_pieces_and_their_contracts():
    assert _select("transform_spec", "anonymous")["filter"] == PUBLIC
    assert _select("transform_contract", "anonymous")["filter"] == {"transform_spec": PUBLIC}


def test_a_user_sees_public_shared_and_own_pieces_and_their_contracts():
    assert _select("transform_spec", "user")["filter"] == VISIBLE_TO_USER
    assert _select("transform_contract", "user")["filter"] == {"transform_spec": VISIBLE_TO_USER}
