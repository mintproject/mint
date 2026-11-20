"""A synced contract keeps a readable name, for the flow form."""
from app.mint_sync import _build_contracts


def _outputs():
    return [
        {"output": {"id": "o1", "label": "Cell budget", "has_format": "cbc-mf6",
                    "presentations": [{"presentation": {"id": "p1"}}]}},
        {"output": {"id": "o2", "label": "Spec label", "has_format": "csv",
                    "presentations": [{"presentation": {"id": "p2", "label": "Presentation label"}}]}},
    ]


def test_the_presentation_label_wins_then_the_specification_label():
    contracts = _build_contracts(_outputs(), "output", "cfg", [])
    assert [c["metadata_json"]["label"] for c in contracts] == ["Cell budget", "Presentation label"]


def test_an_unlabelled_output_carries_no_metadata():
    spec = [{"output": {"id": "o", "has_format": "csv", "presentations": [{"presentation": {}}]}}]
    assert "metadata_json" not in _build_contracts(spec, "output", "cfg", [])[0]


def test_an_input_keeps_its_binding_and_gains_the_label():
    spec = [{"input": {"id": "i", "label": "Budget", "has_format": "cbc-mf6",
                       "presentations": [{"presentation": {}}]}, "app_input_name": "cbc"}]
    metadata = _build_contracts(spec, "input", "cfg", [])[0]["metadata_json"]
    assert metadata["app_input_name"] == "cbc" and metadata["label"] == "Budget"
