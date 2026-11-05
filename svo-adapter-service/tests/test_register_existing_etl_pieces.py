import importlib.util
from pathlib import Path
import unittest


SCRIPT = Path(__file__).parents[1] / "scripts" / "register_existing_etl_pieces.py"
spec = importlib.util.spec_from_file_location("register_existing_etl_pieces", SCRIPT)
register = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(register)


class RegistrationTests(unittest.TestCase):
    def test_fixture_set_has_one_shared_stac_piece_and_pipeline_specific_publish_ids(self):
        root = SCRIPT.parents[1] / "examples"
        rows = register.unique_rows(register.manifests(root))
        ids = {row["id"] for row in rows}

        self.assertEqual(len(rows), 56)
        self.assertIn("ts-subside-h2i-publish", ids)
        self.assertIn("ts-subside-werc-publish", ids)
        self.assertEqual(sum(row["id"] == "ts-subside-stac-publish" for row in rows), 1)

    def test_conflicting_duplicate_id_is_rejected(self):
        first = {"id": "etl-example", "name": "example", "contracts": []}
        second = {
            "id": "etl-example",
            "name": "example",
            "description": "different",
            "contracts": [],
        }

        with self.assertRaisesRegex(ValueError, "conflicting ETL definition"):
            register.unique_rows([("first.json", first), ("second.json", second)])


if __name__ == "__main__":
    unittest.main()
