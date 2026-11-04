"""In-memory backend for DEMO MODE only.

Mirrors the subset of Hasura GraphQL operations the service issues, so the whole
flow runs with no Postgres/Hasura. It is selected by settings.demo_mode and is a
drop-in for hasura.HasuraClient (same async ``execute(query, variables)``).

This intentionally does NOT parse GraphQL — it routes on the operation name
(the identifier after ``query``/``mutation``), which is unique per statement in
this codebase. Not for production: no auth, no persistence, single process.
"""
from __future__ import annotations

import re
import uuid
from typing import Any

_OP_RE = re.compile(r"\b(?:query|mutation)\s+(\w+)")


def _new_id() -> str:
    return uuid.uuid4().hex


class _Tables:
    """Process-wide demo state. One instance shared by all demo clients."""

    def __init__(self) -> None:
        self.data_object: dict[str, dict] = {}
        self.transform_spec: dict[str, dict] = {}
        self.readiness: dict[str, dict] = {}
        self.plan: dict[str, dict] = {}
        self.run: dict[str, dict] = {}
        self.provenance: list[dict] = []
        self.dataset_specification: dict[str, dict] = {}  # model-catalog target rows
        self.catalog_configuration: dict[str, dict] = {}  # model-catalog configurations (secret declarations)
        self.secret: dict[str, dict] = {}
        self.secret_event: list[dict] = []


STORE = _Tables()


def reset_store() -> None:
    """Clear all in-memory demo state (used by POST /admin/reset)."""
    STORE.__init__()


def _insert(table: dict[str, dict], obj: dict, nested_key: str | None = None) -> dict:
    """Insert a row, expanding a Hasura-style nested {"data": [...]} child list."""
    row = dict(obj)
    row.setdefault("id", _new_id())
    children = []
    if nested_key and isinstance(row.get(nested_key), dict):
        children = row[nested_key].get("data", [])
    if nested_key:
        row[nested_key] = [
            {**dict(c), "id": c.get("id") or _new_id()} for c in children
        ]
    table[row["id"]] = row
    return row


class InMemoryHasura:
    """Drop-in for HasuraClient in demo mode."""

    def __init__(self, bearer_token: str | None = None) -> None:
        self._bearer = bearer_token

    async def execute(self, query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        variables = variables or {}
        m = _OP_RE.search(query)
        op = m.group(1) if m else ""
        handler = getattr(self, f"_op_{op}", None)
        if handler is None:
            raise RuntimeError(f"demo store: unhandled GraphQL op {op!r}")
        return handler(variables)

    # --- reads ---------------------------------------------------------------
    def _op_DataObjectContract(self, v):
        row = STORE.data_object.get(v["id"])
        return {"adapter_data_object": [row] if row else []}

    def _op_TransformRegistry(self, v):
        return {"adapter_transform_spec": list(STORE.transform_spec.values())}

    def _op_ListDataObjects(self, v):
        return {"adapter_data_object": list(STORE.data_object.values())}

    def _op_ExistingCkanDataObjects(self, v):
        return {
            "adapter_data_object": [
                {"id": object_id}
                for object_id in v.get("ids", [])
                if object_id in STORE.data_object
            ]
        }

    def _op_ModelInputRequirement(self, v):
        row = STORE.dataset_specification.get(v["ds_id"])
        return {"modelcatalog_dataset_specification": [row] if row else []}

    def _op_GetPlan(self, v):
        return {"adapter_workflow_plan_by_pk": STORE.plan.get(v["id"])}

    def _op_GetRun(self, v):
        return {"adapter_workflow_run_by_pk": STORE.run.get(v["id"])}

    def _op_GetRunByIdempotency(self, v):
        rows = [
            row for row in STORE.run.values()
            if row.get("idempotency_key") == v.get("key")
        ]
        return {"adapter_workflow_run": rows[:1]}

    def _op_GetDataObject(self, v):
        return {"adapter_data_object_by_pk": STORE.data_object.get(v["id"])}

    def _op_ListRuns(self, v):
        limit = v.get("limit", 50)
        offset = v.get("offset", 0)
        runs = sorted(
            STORE.run.values(),
            key=lambda r: r.get("started_at") or "",
            reverse=True
        )
        paginated = runs[offset:offset + limit]
        return {
            "adapter_workflow_run": paginated,
            "adapter_workflow_run_aggregate": {"aggregate": {"count": len(runs)}},
        }

    def _op_GetProvenance(self, v):
        run_id = v.get("run_id")
        limit = v.get("limit", 100)
        events = [
            e for e in STORE.provenance
            if e.get("workflow_run_id") == run_id
        ][:limit]
        return {"adapter_provenance_event": events}

    def _op_ListActiveRuns(self, v):
        active = [r for r in STORE.run.values()
                  if r.get("status") in ("running", "submitting")]
        return {"adapter_workflow_run": active}

    # --- token keeper (poller.GET_RUN_TOKEN_STATE / _LIST_KEEPER_RUNS / _UPDATE_RUN_TOKEN_IF)
    def _op_GetRunTokenState(self, v):
        return {"adapter_workflow_run_by_pk": STORE.run.get(v["id"])}

    def _op_ListKeeperRuns(self, v):
        rows = [r for r in STORE.run.values()
                if r.get("status") in ("running", "submitting", "cancelling") and r.get("run_token_enc")]
        rows.sort(key=lambda r: str(r.get("run_token_expires_at") or ""))
        return {"adapter_workflow_run": rows}

    def _op_UpdateRunTokenIf(self, v):
        # Compare-and-set on the renewal counter (keeper lineage guard).
        row = STORE.run.get(v["id"])
        if row and int(row.get("run_token_renewals") or 0) == int(v["renewals"]):
            row.update(v["set"])
            return {"update_adapter_workflow_run": {"affected_rows": 1}}
        return {"update_adapter_workflow_run": {"affected_rows": 0}}

    # --- writes --------------------------------------------------------------
    def _op_InsertDataObject(self, v):
        row = _insert(STORE.data_object, v["obj"], nested_key="variables")
        return {"insert_adapter_data_object_one": row}

    def _op_ReconcileCkanDataObject(self, v):
        existing = STORE.data_object.get(v["id"])
        deleted_count = len(existing.get("variables", [])) if existing else 0
        row = _insert(STORE.data_object, v["obj"], nested_key="variables")
        return {
            "delete_adapter_data_object_variable": {"affected_rows": deleted_count},
            "insert_adapter_data_object_one": row,
        }

    def _op_DeleteCkanDataObject(self, v):
        row = STORE.data_object.pop(v["id"], None)
        return {"delete_adapter_data_object_by_pk": row}

    def _op_InsertTransformSpec(self, v):
        row = _insert(STORE.transform_spec, v["obj"], nested_key="contracts")
        return {"insert_adapter_transform_spec_one": row}

    def _op_InsertReadiness(self, v):
        row = _insert(STORE.readiness, v["obj"])
        return {"insert_adapter_readiness_assessment_one": row}

    def _op_InsertPlan(self, v):
        row = _insert(STORE.plan, v["obj"])
        return {"insert_adapter_workflow_plan_one": row}

    def _op_SetWorkflowDef(self, v):
        row = STORE.plan.get(v["id"])
        if row:
            row["tapis_workflow_definition_json"] = v["def"]
            row["status"] = "ready"
        return {"update_adapter_workflow_plan_by_pk": row}

    def _op_InsertRun(self, v):
        idempotency_key = v["obj"].get("idempotency_key")
        if idempotency_key:
            for row in STORE.run.values():
                if row.get("idempotency_key") == idempotency_key:
                    return {"insert_adapter_workflow_run_one": row}
        row = _insert(STORE.run, v["obj"])
        return {"insert_adapter_workflow_run_one": row}

    def _op_UpdateRun(self, v):
        row = STORE.run.get(v["id"])
        if row:
            row.update(v["set"])
        return {"update_adapter_workflow_run_by_pk": row}

    def _op_UpdateRunIf(self, v):
        # Compare-and-set on status (run_state transitions).
        row = STORE.run.get(v["id"])
        if row and row.get("status") == v["status"]:
            row.update(v["set"])
            return {"update_adapter_workflow_run": {"affected_rows": 1}}
        return {"update_adapter_workflow_run": {"affected_rows": 0}}

    def _op_Provenance(self, v):
        row = dict(v["obj"])
        row.setdefault("id", _new_id())
        STORE.provenance.append(row)
        return {"insert_adapter_provenance_event_one": {"id": row["id"]}}

    # --- transform_edge stubs (no-op in demo: edge table is a perf cache) ----
    def _op_GetEdges(self, v):
        return {"adapter_transform_edge": []}

    def _op_DeleteAllEdges(self, v):
        return {"delete_adapter_transform_edge": {"affected_rows": 0}}

    def _op_InsertEdges(self, v):
        objects = v.get("objects") or []
        return {"insert_adapter_transform_edge": {"affected_rows": len(objects)}}

    # --- secrets store (secrets.py / hasura.py secret queries) ---------------
    def _op_GetSecretConfiguration(self, v):
        return {"modelcatalog_configuration_by_pk": STORE.catalog_configuration.get(v["id"])}

    def _op_FindSecret(self, v):
        rows = [r for r in STORE.secret.values()
                if r["scope"] == v["scope"] and r["owner_username"] == v["owner"]
                and r["name"] == v["name"] and r["configuration_id"] == v["cfg"]]
        return {"adapter_secret": [{k: x for k, x in r.items() if k != "ciphertext"} for r in rows[:1]]}

    def _op_GetSecret(self, v):
        return {"adapter_secret_by_pk": STORE.secret.get(v["id"])}

    def _op_ListSecrets(self, v):
        return {"adapter_secret": list(STORE.secret.values())}

    def _op_InsertSecret(self, v):
        row = dict(v["obj"])
        row.setdefault("last_used_at", None)
        STORE.secret[row["id"]] = row
        return {"insert_adapter_secret_one": {k: x for k, x in row.items() if k != "ciphertext"}}

    def _op_UpdateSecret(self, v):
        row = STORE.secret.get(v["id"])
        if row:
            row.update(v["set"])
        return {"update_adapter_secret_by_pk":
                {k: x for k, x in (row or {}).items() if k != "ciphertext"} or None}

    def _op_TouchSecret(self, v):
        row = STORE.secret.get(v["id"])
        if row:
            row["last_used_at"] = v["at"]
        return {"update_adapter_secret_by_pk": {"id": v["id"]}}

    def _op_DeleteSecret(self, v):
        STORE.secret.pop(v["id"], None)
        return {"delete_adapter_secret_by_pk": {"id": v["id"]}}

    def _op_InsertSecretEvent(self, v):
        row = dict(v["obj"])
        row.setdefault("id", _new_id())
        STORE.secret_event.append(row)
        return {"insert_adapter_secret_event_one": {"id": row["id"]}}

    def _op_GetRunCredentials(self, v):
        return {"adapter_workflow_run_by_pk": STORE.run.get(v["id"])}

    def _op_IssueRunCredentialsIf(self, v):
        # Compare-and-set on the issue counter (per-run cap).
        row = STORE.run.get(v["id"])
        if row and int(row.get("credentials_issued") or 0) == int(v["issued"]):
            row["credentials_issued"] = int(v["issued"]) + 1
            return {"update_adapter_workflow_run": {"affected_rows": 1}}
        return {"update_adapter_workflow_run": {"affected_rows": 0}}

    # --- MINT catalog read (demo: no modelcatalog_* data in-memory) ----------
    def _op_ListMintConfigurations(self, v):
        return {"modelcatalog_configuration": []}

    # --- MINT sync stubs (demo: upsert acts as insert; no deletion) ----------
    def _op_UpsertMintSyncSpec(self, v):
        row = _insert(STORE.transform_spec, v["obj"], nested_key="contracts")
        return {"insert_adapter_transform_spec_one": row}

    def _op_DeleteObsoleteMintSpecs(self, v):
        return {"delete_adapter_transform_spec": {"affected_rows": 0}}

    def _op_GetMintSpecIds(self, v):
        mint_rows = [
            {"mint_model_config_id": r["mint_model_config_id"]}
            for r in STORE.transform_spec.values()
            if r.get("mint_model_config_id")
        ]
        return {"adapter_transform_spec": mint_rows}

    def _op_GetSyncStatus(self, v):
        total = len(STORE.transform_spec)
        synced = sum(1 for r in STORE.transform_spec.values()
                     if r.get("mint_model_config_id"))
        return {
            "all": {"aggregate": {"count": total}},
            "synced": {"aggregate": {"count": synced}},
            "unresolved": {"aggregate": {"count": 0}},
            "last_sync": [],
        }

    # --- EM binding stubs (no-op in demo: no real execution exists) ----------
    def _op_UpsertResource(self, v):
        obj = v.get("obj", {})
        return {"insert_resource_one": {"id": obj.get("id", _new_id())}}

    def _op_InsertExecutionDataBinding(self, v):
        obj = v.get("obj", {})
        return {"insert_execution_data_binding_one": {
            "execution_id": obj.get("execution_id"),
            "model_io_id": obj.get("model_io_id"),
            "resource_id": obj.get("resource_id"),
        }}
