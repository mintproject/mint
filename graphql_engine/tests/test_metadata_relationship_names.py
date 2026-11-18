"""Hasura refuses the whole metadata file when a table declares a relationship
name twice, which stops every later metadata change from deploying."""
from collections import Counter
from pathlib import Path

import yaml

TABLES = Path(__file__).resolve().parents[1] / "metadata" / "tables.yaml"


def test_no_table_declares_a_relationship_name_twice():
    duplicates = {}
    for entry in yaml.safe_load(TABLES.read_text()):
        names = [r["name"] for kind in ("object_relationships", "array_relationships")
                 for r in entry.get(kind) or []]
        repeated = sorted(n for n, count in Counter(names).items() if count > 1)
        if repeated:
            duplicates[f'{entry["table"]["schema"]}.{entry["table"]["name"]}'] = repeated
    assert duplicates == {}
