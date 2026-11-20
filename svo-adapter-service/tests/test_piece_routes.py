"""Registering a piece from a repository commit, and approving it from the page.

The catalog is replaced by a fake that records which token each call carried, so
the tests can say who the catalog was asked as. The GitHub fetch is replaced too
(it has its own tests in ``test_piece_fetch.py``).
"""
from __future__ import annotations

import os

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config

import re  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main as main_module  # noqa: E402
from app import piece_authoring, tapis  # noqa: E402
from app.config import settings  # noqa: E402
from app.hasura import HasuraClient, HasuraError  # noqa: E402
from app.main import _is_operator_route, app  # noqa: E402
from app.store import STORE  # noqa: E402
from app.stored_source import approval_sha256, decision, is_approved, source_sha256  # noqa: E402

client = TestClient(app)
V = "https://example.org/"
SHA = "0123456789abcdef0123456789abcdef01234567"
CODE = "def run(inputs):\n    return 'tapis://sys/out'\n"
USERS = {"tok-alice": "alice", "tok-bob": "bob", "tok-root": "root"}


def bearer(name):
    return {"Authorization": f"Bearer tok-{name}"}


class Catalog:
    """The model catalog as the callers see it. ``calls`` records (token, operation)."""

    def __init__(self):
        self.admins = {"root"}
        self.variables = {V + "in", V + "out"}
        self.processes: dict[str, dict] = {}
        self.calls: list[tuple[str | None, str]] = []
        self.unavailable = False
        self.insert_error: str | None = None
        self.sent: list[dict] = []
        self.preowned = 0

    def client(self, token):
        catalog = self

        class Fake:
            _bearer = token

            async def execute(self, query, variables=None):
                op = re.search(r"(?:query|mutation)\s+(\w+)", query).group(1)
                catalog.calls.append((token, op))
                if catalog.unavailable:
                    raise HasuraError("connection refused")
                user = USERS.get(token)
                if op == "CatalogAdmin":
                    # A user reads only their own row of the table.
                    return {"modelcatalog_admin": [
                        {"username": user} for _ in [0] if user in catalog.admins
                        and variables["username"] == user]}
                if op == "PieceStandardVariables":
                    return {"modelcatalog_standard_variable": [
                        {"id": i} for i in variables["ids"] if i in catalog.variables]}
                if op == "CreatePieceFromRepository":
                    if catalog.insert_error:
                        raise HasuraError(catalog.insert_error)
                    obj = variables["object"]
                    catalog.sent.append(obj)
                    if obj["id"] in catalog.processes:
                        raise HasuraError("Uniqueness violation. duplicate key value")
                    # Hasura sets the owner from the token, never from the request.
                    row = {**obj, "owner_username": user}
                    catalog.processes[obj["id"]] = row
                    return {"insert_modelcatalog_etl_process_one": {
                        "id": obj["id"], "label": obj["label"], "owner_username": user,
                        "visibility": obj["visibility"]}}
                if op == "CountOwnPieces":
                    own = [i for i, r in catalog.processes.items() if r["owner_username"] == user]
                    own += [f"preowned-{n}" for n in range(catalog.preowned)]
                    return {"modelcatalog_etl_process": [{"id": i} for i in own][:variables["limit"]]}
                if op == "GetEtlProcess":
                    row = catalog.processes.get(variables["id"])
                    return {"modelcatalog_etl_process_by_pk": row and {
                        **row, "contracts": row["contracts"]["data"]}}
                raise AssertionError(f"unexpected catalog operation {op}")

        return Fake()


@pytest.fixture
def catalog(monkeypatch):
    fake = Catalog()
    monkeypatch.setattr(main_module, "_caller_catalog", fake.client)
    monkeypatch.setattr(tapis, "userinfo_username", lambda token: USERS.get(token))
    main_module._CALLER_CACHE.clear()
    client.post("/admin/reset")
    STORE.provenance.clear()
    monkeypatch.setattr(piece_authoring, "registration_limiter", piece_authoring.RateLimiter(30, 3600.0))
    return fake


def fetched(code=CODE, **over):
    return {"repository": "org/repo", "commit": SHA, "path": "pieces/clean.py",
            "url": f"https://raw.githubusercontent.com/org/repo/{SHA}/pieces/clean.py",
            "code": code, "sha256": source_sha256(code), "bytes": len(code),
            "fetched_at": "2026-11-20T10:00:00Z", "verified_on_branch": "main", **over}


@pytest.fixture
def github(monkeypatch):
    seen = []

    def fake_fetch(repository, commit, path):
        repository, commit, path = piece_authoring.source_address(repository, commit, path)  # as the real one does
        seen.append((repository, commit, path))
        return fetched(repository=repository, commit=commit, path=path)

    monkeypatch.setattr(piece_authoring, "fetch_verified_source", fake_fetch)
    return seen


def body(**over):
    base = {
        "label": "Clean the corpus", "description": "Removes noise", "version": "1.0.0",
        "repository": "org/repo", "commit": SHA, "path": "pieces/clean.py", "entrypoint": "run",
        "inputs": [{"standard_variable_uri": V + "in", "format": "directory"}],
        "outputs": [{"standard_variable_uri": V + "out", "format": "directory", "unit": "none"}],
        "arguments": [{"name": "top_n", "type": "integer", "default": 25, "description": "how many"}],
        "dry_run": True}
    base.update(over)
    return base


def post(payload, who="alice"):
    return client.post("/pieces/from-repository", json=payload, headers=bearer(who))


# --- D1: the route -------------------------------------------------------------
def test_a_dry_run_previews_what_would_be_stored_and_writes_nothing(catalog, github):
    response = post(body())
    assert response.status_code == 200, response.text
    out = response.json()
    assert out["dry_run"] is True and out["valid"] is True
    assert out["source"] == CODE and out["source_sha256"] == source_sha256(CODE)
    assert out["origin"]["commit"] == SHA and out["origin"]["repository"] == "org/repo"
    assert out["entrypoint"] == "run"
    assert out["arguments"] == {"top_n": {"type": "integer", "description": "how many", "default": 25}}
    assert out["env_from_args"] == {"TOP_N": "top_n"}
    assert [c["role"] for c in out["contracts"]] == ["input", "output"]
    assert out["visibility"] == "private"
    assert re.fullmatch(r"[0-9a-f]{64}", out["approval_sha256"])
    assert catalog.processes == {} and STORE.transform_spec == {}
    assert [op for _, op in catalog.calls if op.startswith("Create")] == []
    assert github == [("org/repo", SHA, "pieces/clean.py")]


def test_it_is_a_dry_run_unless_the_caller_says_otherwise(catalog, github):
    payload = body()
    del payload["dry_run"]
    assert post(payload).json()["dry_run"] is True
    assert catalog.processes == {}


def test_a_signed_out_caller_is_refused(catalog, github):
    assert client.post("/pieces/from-repository", json=body()).status_code == 401
    assert client.post("/pieces/from-repository", json=body(),
                       headers={"Authorization": "Bearer nobody"}).status_code == 401
    assert github == []


def test_a_live_registration_writes_the_catalog_row_with_the_callers_token(catalog, github):
    response = post(body(dry_run=False), who="alice")
    assert response.status_code == 200, response.text
    pid = response.json()["process_id"]
    assert response.json()["status"] == "created"
    assert response.json()["owner_username"] == "alice"
    writes = [(token, op) for token, op in catalog.calls if op == "CreatePieceFromRepository"]
    assert writes == [("tok-alice", "CreatePieceFromRepository")]
    # Never the adapter's admin identity, and the owner is not something the request sets.
    assert all(token == "tok-alice" for token, _ in catalog.calls)
    row = catalog.processes[pid]
    assert "owner_username" not in catalog.sent[0] and row["owner_username"] == "alice"
    assert row["visibility"] == "private" and row["runtime_kind"] == "tapis_function"
    runtime = row["runtime_json"]
    assert runtime["source"] == {"language": "python", "code": CODE}
    assert runtime["entrypoint"] == "run"
    assert runtime["origin"]["sha256"] == source_sha256(CODE)
    assert runtime["parameters_schema_json"]["properties"]["top_n"]["default"] == 25
    assert [c["position"] for c in row["contracts"]["data"]] == [0, 0]


def test_what_is_previewed_is_what_is_stored(catalog, github):
    preview = post(body()).json()
    pid = post(body(dry_run=False)).json()["process_id"]
    runtime = catalog.processes[pid]["runtime_json"]
    assert preview["source"] == runtime["source"]["code"]
    assert preview["arguments"] == runtime["parameters_schema_json"]["properties"]
    assert preview["env_from_args"] == runtime["env_from_args"]


def test_the_piece_is_in_the_registry_at_once_and_a_provenance_event_names_the_author(catalog, github):
    out = post(body(dry_run=False)).json()
    pid = out["process_id"]
    assert out["in_registry"] is True and out["provenance_recorded"] is True
    spec = STORE.transform_spec[pid]
    assert spec["owner_username"] == "alice" and spec["visibility"] == "private"
    assert spec.get("approved_source_sha256") is None
    events = [e for e in STORE.provenance if e["event_type"] == "piece_registered_from_repository"]
    assert events[0]["payload_json"] == {
        "process_id": pid, "registered_by": "alice", "repository": "org/repo",
        "commit": SHA, "path": "pieces/clean.py", "verified_on_branch": "main", "source_sha256": source_sha256(CODE),
        "visibility": "private"}
    # The hash the preview promised is the hash the registry copy has.
    assert approval_sha256(spec) == out["approval_sha256"]


def test_an_existing_id_is_reported_and_nothing_else_is_written(catalog, github, monkeypatch):
    monkeypatch.setattr(piece_authoring, "new_process_id", lambda label: V + "etl/dup")
    post(body(dry_run=False))
    again = post(body(dry_run=False))
    assert again.status_code == 409 and again.json()["detail"]["code"] == "PIECE_EXISTS"


def test_a_catalog_that_refuses_the_write_is_reported_as_refused(catalog, github):
    catalog.insert_error = "field 'insert_modelcatalog_etl_process_one' not found: not allowed"
    response = post(body(dry_run=False))
    assert response.status_code == 403 and response.json()["detail"]["code"] == "CATALOG_WRITE_REFUSED"
    assert STORE.transform_spec == {}


def test_a_variable_the_catalog_does_not_have_is_refused(catalog, github):
    response = post(body(inputs=[{"standard_variable_uri": V + "nope"}]))
    assert response.status_code == 422
    assert response.json()["detail"] == {
        "code": "PIECE_VARIABLE_UNKNOWN", "variables": [V + "nope"],
        "message": "these standard variables are not in the catalog"}


@pytest.mark.parametrize("override,code", [
    ({"commit": "main"}, "PIECE_COMMIT_INVALID"),
    ({"entrypoint": "missing"}, "PIECE_ENTRYPOINT_INVALID"),
    ({"inputs": []}, "PIECE_CONTRACT_INVALID"),
    ({"outputs": []}, "PIECE_CONTRACT_INVALID"),
    ({"label": " "}, "PIECE_LABEL_INVALID"),
    ({"visibility": "everyone"}, "PIECE_VISIBILITY_INVALID"),
    ({"arguments": [{"name": "tapis_token"}]}, "PIECE_ARGUMENT_INVALID"),
    ({"arguments": [{"name": "source_uri"}]}, "PIECE_ARGUMENT_INVALID"),
    ({"arguments": [{"name": "ckan_token"}]}, "PIECE_ARGUMENT_INVALID"),
    ({"arguments": [{"name": "svo_run_id"}]}, "PIECE_ARGUMENT_INVALID"),
    ({"arguments": [{"name": "Bad-Name"}]}, "PIECE_ARGUMENT_INVALID"),
    ({"arguments": [{"name": "n", "type": "integer", "default": "x"}]}, "PIECE_ARGUMENT_INVALID"),
    ({"arguments": [{"name": "n"}, {"name": "n"}]}, "PIECE_ARGUMENT_INVALID"),
    ({"env_from_args": {"X": "undeclared"}}, "PIECE_ARGUMENT_INVALID"),
    ({"env_from_args": {"X": "signal_token"}}, "PIECE_ARGUMENT_INVALID"),
    ({"env_from_args": {"SVO_X": "top_n"}}, "PIECE_ARGUMENT_INVALID"),
    ({"secrets": [{"name": "Bad Name", "env": {"K": "key"}}]}, "SECRET_DECLARATION_INVALID"),
    ({"sends_data_to": [{"service": "x"}]}, "SECRET_DECLARATION_INVALID"),
])
def test_a_request_that_cannot_be_a_piece_is_refused(catalog, github, override, code):
    response = post(body(**override))
    assert response.status_code in (422, 400), response.text
    assert response.json()["detail"]["code"] == code
    assert catalog.processes == {}


def test_secrets_and_data_sent_outside_are_declared_and_previewed_and_stored(catalog, github):
    secrets = [{"name": "openai", "label": "OpenAI key", "env": {"OPENAI_API_KEY": "api_key"}}]
    sends = [{"service": "api.openai.com", "what": "the text of the corpus"}]
    preview = post(body(secrets=secrets, sends_data_to=sends)).json()
    assert preview["secrets"] == secrets and preview["sends_data_to"] == sends
    pid = post(body(secrets=secrets, sends_data_to=sends, dry_run=False)).json()["process_id"]
    runtime = catalog.processes[pid]["runtime_json"]
    assert runtime["secrets"] == secrets and runtime["sends_data_to"] == sends
    # The registry copy carries them, so approval covers them.
    assert STORE.transform_spec[pid]["parameters_schema_json"]["metadata"]["runtime"]["secrets"] == secrets


def test_a_secret_may_not_fill_an_input_the_piece_also_binds_to_an_argument(catalog, github):
    secrets = [{"name": "k", "label": "k", "env": {"TOP_N": "api_key"}}]
    response = post(body(secrets=secrets))
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "FLOW_SECRET_INPUT_TAKEN"


def test_fetch_failures_reach_the_caller_with_their_code(catalog, monkeypatch):
    def refuse(*_):
        raise piece_authoring.PieceError(404, "PIECE_SOURCE_NOT_FOUND", "no such file")
    monkeypatch.setattr(piece_authoring, "fetch_verified_source", refuse)
    response = post(body())
    assert response.status_code == 404 and response.json()["detail"]["code"] == "PIECE_SOURCE_NOT_FOUND"


def test_the_route_does_not_accept_code_from_the_browser(catalog, github):
    assert post({**body(), "python_source": "print(1)"}).status_code == 422
    assert post({**body(), "source": "print(1)"}).status_code == 422


def test_the_catalog_client_carries_the_callers_token_and_never_the_admin_secret(monkeypatch):
    monkeypatch.setattr(settings, "hasura_admin_secret", "hunter2")
    headers = main_module._caller_catalog("tok-alice")._headers()
    assert headers["Authorization"] == "Bearer tok-alice"
    assert "x-hasura-admin-secret" not in headers


# --- D2: approval -------------------------------------------------------------
def register(who="alice", visibility="public", suffix="a", **over):
    out = post(body(dry_run=False, visibility=visibility, **over), who=who)
    assert out.status_code == 200, out.text
    return out.json()["process_id"], out.json()


def approve(spec_id, sha, who="root", approved=True):
    payload = {"approved": approved}
    if sha is not None:
        payload["reviewed_sha256"] = sha
    return client.put(f"/transform-specs/{spec_id}/approval", json=payload, headers=bearer(who))


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(settings, "stored_source_enabled", True)


def test_the_new_routes_are_not_operator_routes():
    assert not _is_operator_route("PUT", "/transform-specs/https://x/etl/p/approval")
    assert not _is_operator_route("POST", "/pieces/from-repository")
    assert _is_operator_route("PUT", "/admin/transform-spec-approval")


def test_a_non_admin_cannot_approve(catalog, github):
    spec_id, out = register()
    for who in ("alice", "bob"):  # the owner included
        response = approve(spec_id, out["approval_sha256"], who=who)
        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "ADMIN_REQUIRED"
    assert STORE.transform_spec[spec_id].get("approved_source_sha256") is None
    assert not [e for e in STORE.provenance if e["event_type"] == "transform_spec_approval_set"]


def test_a_signed_out_caller_cannot_approve(catalog, github):
    spec_id, out = register()
    response = client.put(f"/transform-specs/{spec_id}/approval",
                          json={"approved": True, "reviewed_sha256": out["approval_sha256"]})
    assert response.status_code == 401


def test_the_admin_check_asks_the_catalog_as_the_caller_not_the_adapter(catalog, github):
    spec_id, out = register()
    catalog.calls.clear()
    approve(spec_id, out["approval_sha256"], who="bob")
    assert catalog.calls == [("tok-bob", "CatalogAdmin")]


def test_a_catalog_that_cannot_be_asked_fails_closed(catalog, github):
    spec_id, out = register()
    catalog.unavailable = True
    response = approve(spec_id, out["approval_sha256"], who="root")
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "ADMIN_CHECK_UNAVAILABLE"
    assert STORE.transform_spec[spec_id].get("approved_source_sha256") is None


def test_an_admin_approval_is_recorded_with_who_and_when(catalog, github, enabled):
    spec_id, out = register()
    response = approve(spec_id, out["approval_sha256"])
    assert response.status_code == 200, response.text
    sha = out["approval_sha256"]
    assert response.json()["approved_by"] == "root"
    assert STORE.transform_spec[spec_id]["approved_source_sha256"] == sha
    assert is_approved(STORE.transform_spec[spec_id])
    (event,) = [e for e in STORE.provenance if e["event_type"] == "transform_spec_approval_set"]
    payload = event["payload_json"]
    assert payload["approved_by"] == "root" and payload["approved_source_sha256"] == sha
    assert payload["transform_spec_id"] == spec_id and payload["action"] == "approved"
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", payload["approved_at"])
    # Another user may now run it.
    assert decision(STORE.transform_spec[spec_id], "bob") == "approved"


def test_the_page_shows_exactly_what_is_approved(catalog, github):
    secrets = [{"name": "openai", "label": "OpenAI key", "env": {"OPENAI_API_KEY": "api_key"}}]
    sends = [{"service": "api.openai.com", "what": "the corpus text"}]
    spec_id, out = register(secrets=secrets, sends_data_to=sends)
    detail = client.get(f"/transform-specs/{spec_id}/approval", headers=bearer("root")).json()
    assert detail["is_admin"] is True
    assert detail["source"] == CODE and detail["source_sha256"] == source_sha256(CODE)
    assert detail["approval_sha256"] == out["approval_sha256"]
    assert detail["entrypoint"] == "run"
    assert detail["env_from_args"] == {"TOP_N": "top_n"}
    assert detail["arguments"]["properties"]["top_n"]["default"] == 25
    assert detail["secrets"] == secrets and detail["sends_data_to"] == sends
    assert detail["origin"]["commit"] == SHA and detail["owner_username"] == "alice"
    assert detail["approved"] is False and detail["history"] == []
    assert {c["role"] for c in detail["contracts"]} == {"input", "output"}


def test_the_page_names_who_approved_and_when_and_keeps_the_history(catalog, github, enabled):
    spec_id, out = register()
    approve(spec_id, out["approval_sha256"])
    approve(spec_id, None, approved=False)
    approve(spec_id, out["approval_sha256"])
    detail = client.get(f"/transform-specs/{spec_id}/approval", headers=bearer("bob")).json()
    assert detail["is_admin"] is False
    assert detail["approved"] is True and detail["approved_by"] == "root"
    assert detail["approved_at"]
    assert [(h["approved"], h["by"]) for h in detail["history"]] == [
        (True, "root"), (False, "root"), (True, "root")]


def test_approval_needs_the_hash_the_page_showed(catalog, github):
    spec_id, out = register()
    missing = approve(spec_id, None)
    assert missing.status_code == 409 and missing.json()["detail"]["code"] == "REVIEWED_HASH_REQUIRED"
    stale = approve(spec_id, "0" * 64)
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "APPROVAL_STALE"
    assert STORE.transform_spec[spec_id].get("approved_source_sha256") is None


def test_withdrawal_clears_the_approval_and_records_who(catalog, github, enabled):
    spec_id, out = register()
    approve(spec_id, out["approval_sha256"])
    assert decision(STORE.transform_spec[spec_id], "bob") == "approved"
    response = approve(spec_id, None, approved=False)
    assert response.status_code == 200 and response.json()["approved"] is False
    assert STORE.transform_spec[spec_id].get("approved_source_sha256") is None
    assert decision(STORE.transform_spec[spec_id], "bob") == "denied"
    events = [e["payload_json"] for e in STORE.provenance if e["event_type"] == "transform_spec_approval_set"]
    assert events[-1]["approved_source_sha256"] is None
    assert events[-1]["approved_by"] == "root" and events[-1]["action"] == "withdrawn"


def test_a_non_admin_cannot_withdraw(catalog, github, enabled):
    spec_id, out = register()
    approve(spec_id, out["approval_sha256"])
    assert approve(spec_id, None, approved=False, who="alice").status_code == 403
    assert is_approved(STORE.transform_spec[spec_id])


@pytest.mark.parametrize("change", ["source", "entrypoint", "env_from_args", "arguments", "secrets", "sends_data_to"])
def test_an_approval_lapses_when_anything_it_covers_changes(catalog, github, enabled, change):
    spec_id, out = register()
    approve(spec_id, out["approval_sha256"])
    spec = STORE.transform_spec[spec_id]
    assert is_approved(spec)
    metadata = spec["parameters_schema_json"]["metadata"]
    if change == "source":
        metadata["runtime"]["source"] = {"language": "python", "code": CODE + "# changed\n"}
    elif change == "entrypoint":
        metadata["runtime"]["entrypoint"] = "other"
    elif change == "env_from_args":
        spec["env_from_args"] = {**spec["env_from_args"], "EXTRA": "top_n"}
    elif change == "arguments":
        spec["parameters_schema_json"]["properties"]["top_n"]["default"] = 26
    elif change == "secrets":
        metadata["runtime"]["secrets"] = [{"name": "k", "label": "k", "env": {"K": "key"}}]
    else:
        metadata["runtime"]["sends_data_to"] = [{"service": "x.example", "what": "everything"}]
    assert not is_approved(spec)
    assert decision(spec, "bob") == "denied"
    detail = client.get(f"/transform-specs/{spec_id}/approval", headers=bearer("root")).json()
    assert detail["approved"] is False and detail["lapsed"] is True
    assert detail["approved_by"] is None


def test_a_piece_registered_a_moment_ago_can_be_approved_before_the_sync(catalog, github, enabled):
    spec_id, out = register()
    del STORE.transform_spec[spec_id]  # the registry copy is gone: only the catalog row remains
    response = approve(spec_id, out["approval_sha256"])
    assert response.status_code == 200, response.text
    assert is_approved(STORE.transform_spec[spec_id])
    # The catalog was read as the approver.
    assert ("tok-root", "GetEtlProcess") in catalog.calls


def test_an_unknown_piece_is_not_found(catalog):
    response = approve(V + "etl/none", "0" * 64)
    assert response.status_code == 404


def test_the_operator_route_still_works_and_shows_as_the_operator(catalog, github, enabled):
    spec_id, out = register()
    response = client.put("/admin/transform-spec-approval", json={"spec_id": spec_id, "approved": True})
    assert response.status_code == 200
    assert response.json()["approved_source_sha256"] == out["approval_sha256"]
    detail = client.get(f"/transform-specs/{spec_id}/approval", headers=bearer("bob")).json()
    assert detail["approved"] is True and detail["approved_by"] == "operator"


def test_a_private_piece_is_not_shown_to_other_users_but_is_to_an_admin(catalog, github):
    spec_id, _ = register(visibility="private")
    assert client.get(f"/transform-specs/{spec_id}/approval", headers=bearer("bob")).status_code == 404
    assert client.get(f"/transform-specs/{spec_id}/approval", headers=bearer("alice")).status_code == 200
    assert client.get(f"/transform-specs/{spec_id}/approval", headers=bearer("root")).status_code == 200


def test_the_list_marks_admins_and_what_awaits_approval(catalog, github, enabled):
    awaiting, _ = register(suffix="w")
    done, out = register(suffix="d")
    private, _ = register(suffix="v", visibility="private")
    approve(done, out["approval_sha256"])
    as_bob = client.get("/pieces/approvals", headers=bearer("bob")).json()
    assert as_bob["is_admin"] is False
    by_id = {p["spec_id"]: p for p in as_bob["pieces"]}
    assert set(by_id) == {awaiting, done}  # someone else's private piece is not listed
    assert by_id[awaiting]["approved"] is False and by_id[done]["approved"] is True
    assert by_id[done]["approved_by"] == "root"
    as_root = client.get("/pieces/approvals", headers=bearer("root")).json()
    assert as_root["is_admin"] is True and {p["spec_id"] for p in as_root["pieces"]} == {awaiting, done, private}
    assert client.get("/pieces/approvals").status_code == 401


def test_membership_of_the_admin_table_is_what_makes_an_approver(catalog, github):
    spec_id, out = register()
    catalog.admins.add("bob")
    assert approve(spec_id, out["approval_sha256"], who="bob").status_code == 200


# --- the security review's findings --------------------------------------------
def test_a_caller_cannot_choose_the_id(catalog, github):
    response = post({**body(), "process_id": "https://example.org/mine"})
    assert response.status_code == 422  # not a field of the request
    out = post(body(dry_run=False)).json()
    assert out["process_id"].startswith(piece_authoring.ETL_ID_PREFIX)
    assert "process_id" not in post(body()).json()  # a preview names no id


def test_a_registration_never_replaces_another_registry_spec(catalog, github, monkeypatch):
    # A spec that is not a catalog piece: a hand-registered one, or a MINT configuration's.
    STORE.transform_spec[V + "etl/taken"] = {
        "id": V + "etl/taken", "name": "someone else's", "owner_username": "carol", "visibility": "public",
        "mint_etl_process_id": None, "contracts": []}
    monkeypatch.setattr(piece_authoring, "new_process_id", lambda label: V + "etl/taken")
    response = post(body(dry_run=False))
    assert response.status_code == 200, response.text  # the catalog row exists ...
    out = response.json()
    assert out["in_registry"] is False  # ... but the registry row was left alone
    assert any("not in the adapter's registry" in w for w in out["warnings"])
    assert STORE.transform_spec[V + "etl/taken"]["name"] == "someone else's"
    assert STORE.transform_spec[V + "etl/taken"]["owner_username"] == "carol"


def test_a_registry_spec_of_another_piece_is_not_replaced_by_the_sync(catalog):
    import asyncio
    from app.mint_sync import SpecIdCollision, sync_one_etl_process
    from app.store import InMemoryHasura
    STORE.transform_spec[V + "etl/x"] = {"id": V + "etl/x", "mint_etl_process_id": V + "etl/other"}
    process = {"id": V + "etl/x", "label": "x", "owner_username": "alice", "visibility": "public",
               "runtime_json": {"source": {"code": CODE}, "entrypoint": "run"},
               "contracts": [{"role": "input", "standard_variable_uri": "u"},
                             {"role": "output", "standard_variable_uri": "v"}]}
    with pytest.raises(SpecIdCollision):
        asyncio.run(sync_one_etl_process(InMemoryHasura(), process))
    assert STORE.transform_spec[V + "etl/x"]["mint_etl_process_id"] == V + "etl/other"


def test_syncing_a_piece_again_still_works(catalog):
    import asyncio
    from app.mint_sync import sync_one_etl_process
    from app.store import InMemoryHasura
    process = {"id": V + "etl/y", "label": "y", "owner_username": "alice", "visibility": "public",
               "runtime_json": {"source": {"code": CODE}, "entrypoint": "run"},
               "contracts": [{"role": "input", "standard_variable_uri": "u"},
                             {"role": "output", "standard_variable_uri": "v"}]}
    for _ in range(2):
        assert asyncio.run(sync_one_etl_process(InMemoryHasura(), process))
    assert STORE.transform_spec[V + "etl/y"]["mint_etl_process_id"] == V + "etl/y"


def test_the_origin_is_stored_with_where_the_commit_was_verified(catalog, github):
    pid = post(body(dry_run=False)).json()["process_id"]
    assert catalog.processes[pid]["runtime_json"]["origin"]["verified_on_branch"] == "main"
    assert STORE.transform_spec[pid]["parameters_schema_json"]["metadata"]["runtime"]["origin"][
        "verified_on_branch"] == "main"
    spec_id = pid
    detail = client.get(f"/transform-specs/{spec_id}/approval", headers=bearer("root")).json()
    assert detail["origin"]["verified_on_branch"] == "main"


def test_a_commit_that_is_not_in_the_repository_is_refused_and_nothing_is_written(catalog, monkeypatch):
    def refuse(*_):
        raise piece_authoring.PieceError(422, "PIECE_COMMIT_NOT_ON_BRANCH", "only in a fork")
    monkeypatch.setattr(piece_authoring, "fetch_verified_source", refuse)
    response = post(body(dry_run=False))
    assert response.status_code == 422 and response.json()["detail"]["code"] == "PIECE_COMMIT_NOT_ON_BRANCH"
    assert catalog.processes == {} and STORE.transform_spec == {}


def test_the_route_asks_github_to_verify_not_only_to_fetch(catalog, monkeypatch):
    calls = []
    monkeypatch.setattr(piece_authoring, "fetch_source", lambda r, c, p: calls.append("fetch") or fetched())
    monkeypatch.setattr(piece_authoring, "verify_commit", lambda r, c: calls.append("verify") or "trunk")
    out = post(body()).json()
    assert calls == ["fetch", "verify"] and out["origin"]["verified_on_branch"] == "trunk"


def test_thirty_registrations_an_hour_per_user_previews_included(catalog, github):
    assert all(post(body()).status_code == 200 for _ in range(30))
    refused = post(body())
    assert refused.status_code == 429 and refused.json()["detail"]["code"] == "PIECE_RATE_LIMITED"
    assert int(refused.headers["Retry-After"]) > 0
    assert post(body(dry_run=False), who="bob").status_code == 200  # another user is unaffected
    # The refusal comes before any fetch or catalog write.
    seen = len(github)
    post(body(dry_run=False))
    assert len(github) == seen


def test_a_user_may_own_at_most_two_hundred_pieces(catalog, github):
    catalog.preowned = 199
    assert post(body(dry_run=False)).status_code == 200  # the 200th
    refused = post(body(dry_run=False))
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "PIECE_LIMIT_REACHED"
    assert post(body(dry_run=False), who="bob").status_code == 200
    # The count is read with the caller's own token.
    assert ("tok-alice", "CountOwnPieces") in catalog.calls


def test_a_failed_provenance_write_is_retried_once_and_then_reported_not_raised(catalog, github, monkeypatch):
    from app.store import InMemoryHasura
    real = InMemoryHasura._op_Provenance
    attempts = []

    def flaky(self, v):
        attempts.append(1)
        if len(attempts) == 1:
            raise RuntimeError("database is down")
        return real(self, v)

    monkeypatch.setattr(InMemoryHasura, "_op_Provenance", flaky)
    out = post(body(dry_run=False))
    assert out.status_code == 200 and out.json()["provenance_recorded"] is True
    assert len(attempts) == 2
    assert [e for e in STORE.provenance if e["event_type"] == "piece_registered_from_repository"]


def test_a_provenance_write_that_keeps_failing_leaves_the_piece_and_says_so(catalog, github, monkeypatch):
    from app.store import InMemoryHasura
    attempts = []

    def broken(self, v):
        attempts.append(1)
        raise RuntimeError("database is down")

    monkeypatch.setattr(InMemoryHasura, "_op_Provenance", broken)
    response = post(body(dry_run=False))
    assert response.status_code == 200, response.text
    out = response.json()
    assert len(attempts) == 2 and out["provenance_recorded"] is False
    assert any("audit record" in w and "piece stays" in w for w in out["warnings"])
    assert out["process_id"] in catalog.processes and out["in_registry"] is True
