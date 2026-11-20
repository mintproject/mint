"""Focused contract tests for the semantic-search service.

These tests use only an in-memory fake connection. The service dependencies are
provided by the container image; when running on a host without those
dependencies, the suite is skipped rather than contacting a live database.
"""

import unittest
from unittest.mock import patch

try:
    import main
except ModuleNotFoundError as error:  # pragma: no cover - host-only fallback
    raise unittest.SkipTest(f"semantic-search dependencies unavailable: {error}")


class FakeResult:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0] if self.rows else None


class FakeConnection:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.queries = []

    def execute(self, query, params=None):
        self.queries.append((query, params))
        return FakeResult(self.responses.pop(0))


class SemanticSearchContractTests(unittest.TestCase):
    def test_search_filters_are_returned_as_structured_hard_filters(self):
        filters = main.SearchFilters(
            region_ids=["region-1"],
            category_ids=["category-1"],
            variable_ids=["variable-1"],
            output_variable_ids=["output-1"],
            role="output",
        )

        self.assertEqual(
            filters.as_response(),
            {
                "region_ids": ["region-1"],
                "category_ids": ["category-1"],
                "variable_ids": ["variable-1"],
                "output_variable_ids": ["output-1"],
                "role": "output",
            },
        )
        self.assertEqual(len(main.configuration_filter_parameters(filters)), 11)

    def test_role_only_filter_is_a_relationship_constraint(self):
        connection = FakeConnection([])

        with patch.object(main, "vector_literal", return_value="[0,0]"):
            results = main.search_svos(
                connection,
                "wildfire",
                10,
                main.SearchFilters(role="output"),
            )

        self.assertEqual(results, [])
        self.assertIn("role_links", connection.queries[0][0])
        self.assertIn("CAST(%s AS text) IS NULL", connection.queries[0][0])
        self.assertEqual(connection.queries[0][1][9:11], ("output", "output"))

    def test_region_filter_accepts_legacy_and_catalog_identifiers(self):
        connection = FakeConnection(
            [("south_sudan", "https://w3id.org/okn/i/mint/South_Sudan")]
        )

        resolved = main.resolve_region_ids(connection, ["south_sudan"])

        self.assertEqual(
            resolved,
            ["https://w3id.org/okn/i/mint/South_Sudan", "south_sudan"],
        )

    def test_default_svo_search_keeps_unlinked_embedded_rows(self):
        connection = FakeConnection(
            [("svo-1", "burn severity", "Description", 0.83)],
            [],
        )

        with patch.object(main, "vector_literal", return_value="[0,0]"):
            results = main.search_svos(connection, "wildfire", 10, main.SearchFilters())

        self.assertEqual(results[0]["id"], "svo-1")
        self.assertNotIn("role_links", connection.queries[0][0])

    def test_saved_problem_statement_loads_task_variables_and_selected_models(self):
        connection = FakeConnection(
            [("ps-1", "Wildfire study", "2026-01-01", "2026-12-31", "south_sudan", "South Sudan")],
            [("Fire impact", "response-1", "burn severity", "driving-1", "fire occurrence")],
            [("config-1",)],
        )

        request = main.saved_problem_statement_request(connection, "ps-1")

        self.assertEqual(request.title, "Wildfire study")
        self.assertEqual(request.region_name, "South Sudan")
        self.assertEqual(request.selected_variable_ids, ["response-1", "driving-1"])
        self.assertEqual(request.selected_model_configuration_ids, ["config-1"])

    def test_model_configuration_search_returns_inverse_context(self):
        connection = FakeConnection(
            [
                [("config-1", "Wildfire model", "A fire model", None, "version-1", "v1", None, None, 0.91)],
            ],
            [("config-1", "svo-1", "burn severity", "output", "category-1", "Fire", "region-1", "California")],
            [("config-1", "category-1", "Fire")],
            [("config-1", "region-1", "California")],
        )

        with patch.object(main, "vector_literal", return_value="[0,0]"):
            results = main.search_configurations(
                connection,
                "wildfire",
                10,
                main.SearchFilters(),
            )

        self.assertEqual(results[0]["id"], "config-1")
        self.assertEqual(results[0]["standard_variables"][0]["role"], "output")
        self.assertEqual(results[0]["categories"][0]["label"], "Fire")
        self.assertEqual(results[0]["regions"][0]["label"], "California")
        self.assertEqual(
            {item["source"] for item in results[0]["evidence"]},
            {"standard_variable", "category", "region"},
        )
        self.assertIn("modelcatalog_configuration c", connection.queries[0][0])

    def test_problem_statement_recommendations_abstain_without_context(self):
        request = main.ProblemStatementRequest()
        connection = FakeConnection()

        response = main.recommendation_response(connection, request)

        self.assertEqual(response["capability"], "problem_statement_recommendations")
        self.assertEqual(response["status"], "abstained")
        self.assertEqual(response["results"], {"svo": [], "model_configuration": []})
        self.assertFalse(connection.queries)

    def test_problem_statement_preserves_optional_spatial_conditions_map(self):
        request = main.ProblemStatementRequest(
            title="Groundwater availability",
            spatial_conditions={
                "spatial_scope_type": "custom",
                "spatial_scope_id": "texas",
                "spatial_resolution": "region",
            },
        )
        connection = FakeConnection()
        with patch.object(main, "search_target", return_value=[]):
            response = main.recommendation_response(connection, request)

        self.assertEqual(
            response["spatial_conditions"],
            {
                "spatial_scope_type": "custom",
                "spatial_scope_id": "texas",
                "spatial_resolution": "region",
            },
        )

    def test_etl_piece_embedding_text_includes_contract(self):
        text = main.etl_piece_embedding_text("Clip", None, "Inputs: DEM Outputs: Slope")
        self.assertEqual(text, "Clip. . Data contract: Inputs: DEM Outputs: Slope")

    def test_etl_piece_search_only_reads_public_and_shared(self):
        connection = FakeConnection(
            [("p1", "Clip", "Clips", "public", "alice", 0.9)],
            [
                ("p1", "input", 0, "sv:dem", "DEM", "geotiff"),
                ("p1", "output", 0, "sv:slope", "Slope", "geotiff"),
            ],
        )
        with patch.object(main, "vector_literal", return_value="[0,0]"):
            results = main.search_etl_pieces(connection, "slope", 5)

        sql = connection.queries[0][0]
        self.assertIn("p.visibility IN ('public', 'shared')", sql)
        self.assertNotIn("private'", sql.replace("('public', 'shared')", ""))
        self.assertEqual(results[0]["inputs"][0]["standard_variable_uri"], "sv:dem")
        self.assertEqual(results[0]["outputs"][0]["label"], "Slope")
        self.assertEqual(results[0]["visibility"], "public")

    def test_etl_piece_search_falls_back_to_keywords_without_model(self):
        connection = FakeConnection([])
        with patch.object(main, "vector_literal", side_effect=RuntimeError("no model")):
            results = main.search_etl_pieces(connection, "slope", 5)

        self.assertEqual(results, [])
        self.assertNotIn("embedding", connection.queries[0][0])
        self.assertIn("p.visibility IN ('public', 'shared')", connection.queries[0][0])

    def test_similar_unknown_variable_is_404(self):
        with self.assertRaises(main.HTTPException) as caught:
            main.similar_variables(FakeConnection([]), "sv:none", 5)
        self.assertEqual(caught.exception.status_code, 404)

    def test_similar_unindexed_variable_returns_status(self):
        response = main.similar_variables(FakeConnection([(False,)]), "sv:a", 5)
        self.assertEqual(response["results"], [])
        self.assertEqual(response["status"], "not_indexed")

    def test_similar_excludes_itself_and_shapes_results(self):
        connection = FakeConnection([(True,)], [("sv:b", "B", "desc", 0.8)])
        response = main.similar_variables(connection, "sv:a", 5)
        self.assertEqual(connection.queries[1][1], ("sv:a", "sv:a", 5))
        self.assertEqual(
            response["results"], [{"id": "sv:b", "label": "B", "description": "desc", "score": 0.8}]
        )

    def test_pending_rows_skips_current_and_flags_stale(self):
        rows = [("a", "A", "d", "c", "A. d. Models and workflows: c", True),
                ("b", "B", "d", "c", "old", True),
                ("c", "C", "d", "c", None, False)]
        pending = main.pending_rows(rows, main.embedding_text, force=False)
        self.assertEqual([row[0] for row, _ in pending], ["b", "c"])


if __name__ == "__main__":
    unittest.main()
