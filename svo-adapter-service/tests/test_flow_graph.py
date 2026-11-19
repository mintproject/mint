"""The flow graph check: pure, no catalog and no HTTP."""
from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import flow_graph  # noqa: E402

TEXT = {"standard_variable_uri": "svo:document_collection__text", "format": "folder"}
COUNTS = {"standard_variable_uri": "svo:document_lexicon_group__term_count", "format": "csv"}
LEXICON = {"standard_variable_uri": "svo:lexicon__term_set", "format": "csv"}
REPORT = {"standard_variable_uri": "svo:document_collection__sensemaking_report", "format": "md"}
AOI = {"standard_variable_uri": "svo:land_region__boundary", "format": "geojson"}
ARCHIVE = {"standard_variable_uri": "svo:land_surface__displacement_rate", "format": "folder"}


def piece(inputs=(), outputs=(), arguments=(), values=()):
    contracts = [{"role": "input", "position": i + 1, **c} for i, c in enumerate(inputs)]
    contracts += [{"role": "output", "position": i + 1, **c} for i, c in enumerate(outputs)]
    return {"contracts": contracts,
            "parameters_schema_json": {"properties": {name: {"type": "string"} for name in arguments}},
            "value_outputs": [{"name": name, "type": "string"} for name in values]}


INGEST = piece([TEXT], [TEXT])
SCORE = piece([TEXT, LEXICON], [COUNTS], arguments=["top_n"])
REPORTER = piece([COUNTS], [REPORT])


def flow(steps, inputs=("corpus",), **more):
    contracts = {"corpus": TEXT, "lexicon": LEXICON, "aoi": AOI}
    return {"inputs": [{"id": name, "contract": contracts[name]} for name in inputs],
            "steps": steps, **more}


def step(position, a_piece, wires, **more):
    return {"position": position, "piece": a_piece, "wires": wires, **more}


def from_input(name, to):
    return {"to": {"input": to}, "from": {"flow_input": name}}


def from_step(source, output, to):
    return {"to": {"input": to}, "from": {"step": source, "output": output}}


def codes(checked):
    return [p.code for p in checked.problems]


def test_a_chain_checks_out_and_orders_its_steps():
    checked = flow_graph.check(flow([
        step(1, INGEST, [from_input("corpus", 1)]),
        step(2, piece([TEXT], [COUNTS]), [from_step(1, 1, 1)]),
        step(3, REPORTER, [from_step(2, 1, 1)]),
    ]))
    assert checked.ok, checked.problems
    assert checked.depends_on == {1: [], 2: [1], 3: [2]}


def test_a_piece_takes_two_inputs_from_two_places():
    checked = flow_graph.check(flow([
        step(1, INGEST, [from_input("corpus", 1)]),
        step(2, SCORE, [from_step(1, 1, 1), from_input("lexicon", 2)]),
    ], inputs=("corpus", "lexicon")))
    assert checked.ok, checked.problems
    assert checked.depends_on[2] == [1]


def test_a_step_reads_from_a_step_that_is_not_the_one_before_it():
    two_outputs = piece([TEXT], [TEXT, LEXICON])
    checked = flow_graph.check(flow([
        step(1, two_outputs, [from_input("corpus", 1)]),
        step(2, INGEST, [from_step(1, 1, 1)]),
        step(3, SCORE, [from_step(2, 1, 1), from_step(1, 2, 2)]),
    ]))
    assert checked.ok, checked.problems
    assert checked.depends_on[3] == [1, 2]


def test_two_steps_with_no_link_between_them_do_not_depend_on_each_other():
    checked = flow_graph.check(flow([
        step(1, INGEST, [from_input("corpus", 1)]),
        step(2, INGEST, [from_input("corpus", 1)]),
    ]))
    assert checked.ok and checked.depends_on == {1: [], 2: []}


def test_a_flow_with_no_dataset_input_is_valid():
    run = piece([], [ARCHIVE], arguments=["start_date", "end_date"], values=["job_uuid"])
    checked = flow_graph.check(flow([step(1, run, [], settings={"start_date": "2024-01-01"})], inputs=()))
    assert checked.ok, checked.problems


def test_a_link_can_only_set_order():
    run = piece([AOI], [ARCHIVE])
    manifest = piece([ARCHIVE], [])
    publish = piece([ARCHIVE], [])
    checked = flow_graph.check(flow([
        step(1, run, [from_input("aoi", 1)]),
        step(2, manifest, [from_step(1, 1, 1)]),
        step(3, publish, [from_step(1, 1, 1), {"to": {}, "from": {"step": 2}}]),
    ], inputs=("aoi",)))
    assert checked.ok, checked.problems
    assert checked.depends_on[3] == [1, 2]


def test_a_value_from_one_step_feeds_a_setting_of_a_later_one():
    resolve = piece([], [ARCHIVE], values=["manifest_name"])
    publish = piece([ARCHIVE], [], arguments=["manifest_name"])
    wires = [from_step(1, 1, 1), {"to": {"setting": "manifest_name"}, "from": {"step": 1, "value": "manifest_name"}}]
    assert flow_graph.check(flow([step(1, resolve, []), step(2, publish, wires)], inputs=())).ok
    unknown = [from_step(1, 1, 1), {"to": {"setting": "manifest_name"}, "from": {"step": 1, "value": "nope"}}]
    assert codes(flow_graph.check(flow([step(1, resolve, []), step(2, publish, unknown)], inputs=()))) == ["FLOW_WIRE_SOURCE"]


def test_a_flow_parameter_feeds_settings_of_several_steps():
    a = piece([], [], arguments=["model"])
    wire = {"to": {"setting": "model"}, "from": {"flow_parameter": "p:model"}}
    checked = flow_graph.check({"parameters": [{"id": "p:model"}], "steps": [step(1, a, [wire]), step(2, a, [wire])]})
    assert checked.ok, checked.problems


def test_a_link_that_does_not_fit_names_the_step_and_the_link():
    checked = flow_graph.check(flow([
        step(1, INGEST, [from_input("corpus", 1)]),
        step(2, REPORTER, [from_step(1, 1, 1)]),
    ]))
    (problem,) = checked.problems
    assert (problem.code, problem.step, problem.wire) == ("FLOW_WIRE_DOES_NOT_FIT", 2, 0)
    assert problem.as_dict()["message"].startswith("what this link carries does not fit the input")


def test_a_step_cannot_read_from_itself_or_a_later_step():
    later = flow_graph.check(flow([
        step(1, INGEST, [from_step(2, 1, 1)]),
        step(2, INGEST, [from_input("corpus", 1)]),
    ]))
    assert "FLOW_WIRE_FORWARD" in codes(later)
    itself = flow_graph.check(flow([step(1, INGEST, [from_step(1, 1, 1)])]))
    assert "FLOW_WIRE_FORWARD" in codes(itself)


def test_every_input_of_a_piece_must_be_linked_once():
    unlinked = flow_graph.check(flow([step(1, SCORE, [from_input("corpus", 1)])]))
    assert codes(unlinked) == ["FLOW_INPUT_UNWIRED"] and unlinked.problems[0].step == 1
    twice = flow_graph.check(flow([step(1, INGEST, [from_input("corpus", 1), from_input("corpus", 1)])]))
    assert codes(twice) == ["FLOW_WIRE_TARGET"]


def test_an_input_takes_data_not_a_value():
    resolve = piece([], [], values=["name"])
    wires = [{"to": {"input": 1}, "from": {"step": 1, "value": "name"}}]
    checked = flow_graph.check(flow([step(1, resolve, []), step(2, INGEST, wires)], inputs=()))
    assert codes(checked) == ["FLOW_WIRE_DOES_NOT_FIT"]


def test_a_deleted_piece_is_reported_on_its_own_step_only():
    checked = flow_graph.check(flow([
        step(1, None, [from_input("corpus", 1)]),
        step(2, INGEST, [from_step(1, 1, 1)]),
    ]))
    assert [(p.code, p.step) for p in checked.problems][0] == ("FLOW_STEP_EMPTY", 1)


def test_settings_must_be_declared_and_not_managed_secret_or_linked():
    a = piece([], [], arguments=["top_n", "model_api_key", "name"], values=["name"])
    first = step(1, a, [])
    second = step(2, a, [{"to": {"setting": "name"}, "from": {"step": 1, "value": "name"}}],
                  settings={"top_n": 5, "missing": 1, "model_api_key": "x", "name": "y"})
    checked = flow_graph.check({"steps": [first, second]}, refused_settings={"model_api_key"})
    assert codes(checked) == ["FLOW_SETTING_REFUSED"] * 3
    refused_wire = step(2, a, [{"to": {"setting": "model_api_key"}, "from": {"step": 1, "value": "name"}}])
    assert codes(flow_graph.check({"steps": [first, refused_wire]}, refused_settings={"model_api_key"})) == ["FLOW_SETTING_REFUSED"]


def test_unknown_link_forms_are_refused():
    for wire in ({"to": {"input": 1}}, {"to": {"input": 1, "setting": "x"}, "from": {"flow_input": "corpus"}},
                 {"to": {}, "from": {"flow_input": "corpus"}}, {"to": {"input": 1}, "from": {"step": 1}}, "nope"):
        checked = flow_graph.check(flow([step(1, INGEST, [from_input("corpus", 1)]), step(2, INGEST, [wire])]))
        assert "FLOW_WIRE_SHAPE" in codes(checked), wire


def test_positions_are_unique_whole_numbers_in_range():
    assert codes(flow_graph.check(flow([]))) == ["FLOW_EMPTY"]
    assert codes(flow_graph.check(flow([step(0, INGEST, [])]))) == ["FLOW_STEP_POSITION"]
    assert codes(flow_graph.check(flow([step(True, INGEST, [])]))) == ["FLOW_STEP_POSITION"]
    same = [step(1, INGEST, [from_input("corpus", 1)])] * 2
    assert codes(flow_graph.check(flow(same))) == ["FLOW_STEP_POSITION"]
    many = [step(i, INGEST, [from_input("corpus", 1)]) for i in range(1, 26)]
    assert codes(flow_graph.check(flow(many))) == ["FLOW_TOO_LONG"]


def test_flow_outputs_name_real_outputs_values_or_records():
    run = piece([], [ARCHIVE], values=["job_uuid"])
    good = [{"step": 1, "output": 1}, {"step": 1, "value": "job_uuid"}, {"step": 1, "record": "catalog"}]
    assert flow_graph.check({"steps": [step(1, run, [])], "outputs": good}).ok
    bad = [{"step": 1, "output": 2}, {"step": 1, "value": "x"}, {"step": 9, "output": 1}, {"step": 1}]
    assert codes(flow_graph.check({"steps": [step(1, run, [])], "outputs": bad})) == ["FLOW_OUTPUT"] * 4


def test_thread_bindings_name_a_flow_input_or_parameter():
    base = {"inputs": [{"id": "aoi", "contract": AOI}], "parameters": [{"id": "p:start"}],
            "steps": [step(1, piece([AOI], []), [from_input("aoi", 1)])]}
    good = {"region": {"input": "aoi"}, "start_date": {"parameter": "p:start"}}
    assert flow_graph.check({**base, "thread_bindings": good}).ok
    for bad in ({"region": {"input": "nope"}}, {"when": {"parameter": "p:start"}}, {"region": "aoi"}):
        assert codes(flow_graph.check({**base, "thread_bindings": bad})) == ["FLOW_THREAD_BINDING"]


def test_an_output_carries_forward_what_its_first_input_brought():
    # The piece declares only a format; the variable comes through from its input,
    # as it does in a planned chain.
    reformat = piece([TEXT], [{"format": "parquet"}])
    needs = piece([{"standard_variable_uri": TEXT["standard_variable_uri"], "format": "parquet"}], [])
    checked = flow_graph.check(flow([
        step(1, reformat, [from_input("corpus", 1)]),
        step(2, needs, [from_step(1, 1, 1)]),
    ]))
    assert checked.ok, checked.problems
