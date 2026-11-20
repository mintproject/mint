"""Proposing what fits in a flow, exactly, from the pieces' declared contracts."""
from __future__ import annotations

import os

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import flow_propose  # noqa: E402
from app import main as main_module  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)
V = "https://example.org/"
AUTH = {"Authorization": "Bearer tok"}


@pytest.fixture(autouse=True)
def fresh():
    client.post("/admin/reset")
    main_module._CALLER_CACHE.clear()


def register(name, inputs, outputs):
    """``inputs`` and ``outputs`` are (variable, format) pairs."""
    response = client.post("/transform-specs", json={
        "name": name, "method": "tapis_function", "transform_type": "unit_convert",
        "contracts": [
            *({"role": "input", "standard_variable_uri": V + var, "format": fmt} for var, fmt in inputs),
            *({"role": "output", "standard_variable_uri": V + var, "format": fmt} for var, fmt in outputs)],
        "env_from_args": {"TAPIS_TOKEN": "tapis_token"}})
    assert response.status_code == 200, response.text
    return response.json()["id"]


@pytest.fixture
def pieces():
    return {
        "ingest": register("ingest", [("corpus", "csv")], [("clean", "csv")]),
        "to_parquet": register("to_parquet", [("clean", "csv")], [("clean", "parquet")]),
        "to_arrow": register("to_arrow", [("clean", "parquet")], [("clean", "arrow")]),
        "score": register("score", [("clean", "parquet")], [("counts", "parquet")]),
        "deep": register("deep", [("clean", "arrow")], [("deep", "csv")]),
        "report": register("report", [("counts", "parquet"), ("clean", "csv")], [("report", "html")]),
    }


def flow_input():
    return {"id": "in:corpus", "contract": {"standard_variable_uri": V + "corpus", "format": "csv"}}


def step(position, piece, wires=()):
    return {"position": position, "etl_process_id": piece, "wires": list(wires)}


def to_input(source, to):
    return {"to": {"input": to}, "from": source}


def propose(steps, purpose, **extra):
    return client.post("/flows/propose", headers=AUTH, json={
        "inputs": [flow_input()], "steps": steps, "purpose": purpose, **extra})


def ingested(pieces):
    return [step(1, pieces["ingest"], [to_input({"flow_input": "in:corpus"}, 1)])]


# --- for an input ---------------------------------------------------------------

def test_an_input_is_offered_every_flow_input_and_earlier_output_that_fits(pieces):
    # step 2 (report) input 2 takes clean/csv: the output of step 1 fits, the flow input does not.
    steps = ingested(pieces) + [step(2, pieces["report"])]
    body = propose(steps, {"step": 2, "input": 2}).json()
    assert body["direct"] == [{
        "source": {"kind": "step_output", "step": 1, "output": 1}, "fits": True,
        "wire": {"to": {"input": 2}, "from": {"step": 1, "output": 1}}}]
    assert body["chains"] == [] and body["cut"] is False


def test_a_proposed_source_passes_the_flow_check(pieces):
    steps = ingested(pieces) + [step(2, pieces["report"])]
    wire = propose(steps, {"step": 2, "input": 2}).json()["direct"][0]["wire"]
    checked = client.post("/flows/check", headers=AUTH, json={
        "inputs": [flow_input()], "steps": ingested(pieces) + [step(2, pieces["report"], [wire])]}).json()
    assert [p for p in checked["problems"] if p.get("wire") == 0 and p["step"] == 2] == []


def test_where_nothing_fits_the_shortest_converter_chain_is_offered(pieces):
    steps = ingested(pieces) + [step(2, pieces["score"])]
    body = propose(steps, {"step": 2, "input": 1}).json()
    assert body["direct"] == []
    assert len(body["chains"]) == 1
    chain = body["chains"][0]
    assert chain["from"] == {"kind": "step_output", "step": 1, "output": 1}
    assert [(p["piece"], p["position"], p["output"]) for p in chain["pieces"]] == [(pieces["to_parquet"], 1, 1)]
    assert chain["length"] == 1 and chain["lossy"] is False


def test_a_chain_is_found_up_to_the_length_asked_and_no_further(pieces):
    steps = ingested(pieces) + [step(2, pieces["deep"])]
    purpose = {"step": 2, "input": 1}
    assert propose(steps, purpose, max_chain=1).json()["chains"] == []
    two = propose(steps, purpose, max_chain=2).json()["chains"]
    assert [[p["piece"] for p in c["pieces"]] for c in two] == [[pieces["to_parquet"], pieces["to_arrow"]]]
    # Asked for more than the limit, it is held to the limit and still finds it.
    assert len(propose(steps, purpose, max_chain=99).json()["chains"]) == 1


def test_the_search_stops_at_its_budget_and_says_so(pieces):
    flow = {"inputs": [flow_input()], "steps": [
        {"position": 1, "piece": main_module._piece_view(_spec(pieces["ingest"])),
         "wires": [to_input({"flow_input": "in:corpus"}, 1)]},
        {"position": 2, "piece": main_module._piece_view(_spec(pieces["deep"])), "wires": []}]}
    views = {pid: {**main_module._piece_view(_spec(pid)), "id": pid} for pid in pieces.values()}
    cut = flow_propose.propose(flow, views, {"step": 2, "input": 1}, max_chain=3, max_expansions=2)
    assert cut["cut"] is True and cut["chains"] == []
    whole = flow_propose.propose(flow, views, {"step": 2, "input": 1}, max_chain=3)
    assert whole["cut"] is False and len(whole["chains"]) == 1


def _spec(piece_id):
    import asyncio
    rows = asyncio.run(main_module._registry(main_module.get_client(None), plannable=False))
    return next(row for row in rows if row["id"] == piece_id)


def test_results_are_cut_at_the_limit_and_the_answer_says_so(pieces):
    for n in range(5):
        register(f"another{n}", [("clean", "csv")], [("clean", "parquet")])
    steps = ingested(pieces) + [step(2, pieces["score"])]
    body = propose(steps, {"step": 2, "input": 1}, max_results=2).json()
    assert len(body["chains"]) == 2 and body["cut"] is True


# --- for an output --------------------------------------------------------------

def test_an_output_is_offered_the_pieces_that_can_take_it_next(pieces):
    body = propose(ingested(pieces), {"step": 1, "output": 1}).json()
    assert [(n["piece"], n["input"]) for n in body["next"]] == sorted(
        [(pieces["to_parquet"], 1), (pieces["report"], 2)])
    assert body["next"][0]["label"] in ("to_parquet", "report")


def test_an_output_nothing_takes_gets_an_empty_list_not_an_error(pieces):
    body = propose(ingested(pieces) + [step(2, pieces["report"])], {"step": 2, "output": 1})
    assert body.status_code == 200 and body.json()["next"] == []


# --- for a wanted result --------------------------------------------------------

def test_a_wanted_result_lists_its_makers_and_what_each_still_needs(pieces):
    wanted = {"standard_variable_uri": V + "counts", "format": "parquet"}
    body = propose(ingested(pieces), {"contract": wanted}).json()
    assert [(p["piece"], p["output"], p["complete"]) for p in body["produces"]] == [(pieces["score"], 1, True)]
    need = body["produces"][0]["inputs"][0]
    assert need["input"] == 1 and need["direct"] == [] and need["met"] is True
    assert [p["piece"] for p in need["chains"][0]["pieces"]] == [pieces["to_parquet"]]


def test_a_maker_with_an_input_nothing_can_feed_is_incomplete(pieces):
    register("needy", [("clean", "csv"), ("unobtainable", "csv")], [("wanted", "csv")])
    wanted = {"standard_variable_uri": V + "wanted", "format": "csv"}
    body = propose(ingested(pieces), {"contract": wanted}).json()
    needy = body["produces"][0]
    assert needy["label"] == "needy" and needy["complete"] is False
    assert [(n["input"], n["met"]) for n in needy["inputs"]] == [(1, True), (2, False)]


def test_a_wanted_result_nothing_makes_is_an_empty_list(pieces):
    body = propose([], {"contract": {"standard_variable_uri": V + "nothing"}})
    assert body.status_code == 200 and body.json()["produces"] == []


# --- who may see a piece, and what a proposal says about it ---------------------

def test_another_users_private_piece_is_never_proposed_or_named(pieces, monkeypatch):
    real = main_module._registry

    async def registry(h, **kwargs):
        rows = await real(h, **kwargs)
        return [{**row, "visibility": "private", "owner_username": "someone-else"}
                if row.get("name") == "to_parquet" else row for row in rows]
    monkeypatch.setattr(main_module, "_registry", registry)
    steps = ingested(pieces) + [step(2, pieces["score"])]
    response = propose(steps, {"step": 2, "input": 1})
    assert response.json()["chains"] == []
    assert propose(ingested(pieces), {"step": 1, "output": 1}).json()["next"] == [
        {"piece": pieces["report"], "label": "report", "approval": "builtin", "input": 2}]
    assert pieces["to_parquet"] not in response.text and "someone-else" not in response.text


def test_a_step_whose_piece_the_caller_cannot_see_is_refused_without_naming_it(pieces, monkeypatch):
    real = main_module._registry

    async def registry(h, **kwargs):
        rows = await real(h, **kwargs)
        return [{**row, "visibility": "private", "owner_username": "someone-else"}
                if row.get("name") == "score" else row for row in rows]
    monkeypatch.setattr(main_module, "_registry", registry)
    response = propose([step(1, pieces["score"])], {"step": 1, "input": 1})
    assert response.status_code == 422 and response.json()["detail"]["code"] == "FLOW_PROPOSE_STEP"
    assert "someone-else" not in response.text


def test_each_piece_carries_the_callers_approval_state(pieces):
    body = propose(ingested(pieces), {"step": 1, "output": 1}).json()
    assert {n["approval"] for n in body["next"]} == {"builtin"}


def test_a_blank_contract_is_warned_about(pieces):
    open_piece = client.post("/transform-specs", json={
        "name": "anything", "method": "tapis_function", "transform_type": "unit_convert",
        "contracts": [{"role": "input"}, {"role": "output", "standard_variable_uri": V + "x"}]}).json()["id"]
    body = propose(ingested(pieces), {"step": 1, "output": 1}).json()
    assert open_piece in [n["piece"] for n in body["next"]]
    assert {"code": "BLANK_CONTRACT", "piece": open_piece, "input": 1,
            "fields": ["standard_variable_uri", "format"]} in body["warnings"]


# --- malformed requests ---------------------------------------------------------

@pytest.mark.parametrize("purpose", [
    "input", 7, [], {}, {"step": 1}, {"step": 1, "input": 1, "output": 1},
    {"step": "1", "input": 1}, {"step": True, "input": 1}, {"step": 9, "input": 1},
    {"step": 1, "input": "x"}, {"step": 1, "input": 99}, {"step": 1, "output": 99},
    {"step": 1, "output": None}, {"contract": "x"}, {"contract": None}, {"nothing": 1},
])
def test_a_malformed_purpose_is_a_422_never_a_500(pieces, purpose):
    response = propose(ingested(pieces), purpose)
    assert response.status_code == 422, response.text
    assert response.json()["detail"]


def test_a_contract_that_cannot_be_read_is_a_422_never_a_500(pieces):
    response = propose(ingested(pieces), {"contract": {"unit": ["not", "a", "string"]}})
    assert response.status_code == 422
    broken = client.post("/flows/propose", headers=AUTH, json={
        "inputs": [{"id": "in:corpus", "contract": {"format": {"x": 1}}}, {"id": 5}, "nope"],
        "steps": [{"position": 1, "etl_process_id": pieces["ingest"], "wires": ["junk", {"to": 1}]}],
        "purpose": {"step": 1, "input": 1}})
    assert broken.status_code in (200, 422)


def test_no_purpose_is_an_empty_answer(pieces):
    body = propose(ingested(pieces), None)
    assert body.status_code == 200
    assert (body.json()["direct"], body.json()["chains"], body.json()["next"], body.json()["produces"]) == ([], [], [], [])


def test_a_wrongly_typed_body_is_a_422(pieces):
    assert client.post("/flows/propose", headers=AUTH, json={"steps": "x"}).status_code == 422
    assert client.post("/flows/propose", headers=AUTH, json={"max_chain": "x"}).status_code == 422
