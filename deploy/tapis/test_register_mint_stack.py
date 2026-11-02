"""Offline regression checks for database data-loss boundaries."""

import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import register_mint_stack as deploy


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.spec = deploy.build_specs("mintproject", "sha-test", "https://portals.tapis.io")["postgres"]

    def test_database_uses_postgis_and_pgdata_within_persistent_mount(self):
        self.assertEqual(self.spec["image"], "ghcr.io/mintproject/postgres-pgvector:sha-test")
        self.assertEqual(self.spec["template"], "postgres:16postgis3.5")
        self.assertEqual(
            self.spec["networking"],
            {"default": {"protocol": "postgres", "port": 5432}},
        )
        data = self.spec["environment_variables"]["PGDATA"]
        mount, source = next(iter(self.spec["volume_mounts"].items()))
        self.assertTrue(data.startswith(mount + "/"))
        self.assertEqual(source["type"], "tapisvolume")
        self.assertEqual(source["source_id"], "mintdevpostgresdata")

    def test_graphql_points_event_triggers_at_semantic_search_service(self):
        specs = deploy.build_specs("mintproject", "develop", "https://portals.tapis.io")
        graphql = specs["graphql"]
        semantic = specs["semantic_search"]
        ui = specs["ui"]
        self.assertEqual(
            graphql["environment_variables"]["SVO_SEMANTIC_SEARCH_WEBHOOK_URL"],
            "https://mintdevsemanticsearch.pods.portals.tapis.io/events/catalog",
        )
        self.assertEqual(semantic["pod_id"], "mintdevsemanticsearch")
        self.assertEqual(semantic["image"], "ghcr.io/mintproject/semantic-search:develop")
        self.assertEqual(semantic["networking"]["default"]["port"], 8091)
        self.assertEqual(
            semantic["environment_variables"]["SVO_CORS_ORIGINS"],
            "https://mintdevui.pods.portals.tapis.io",
        )
        self.assertEqual(
            ui["environment_variables"]["SEMANTIC_SEARCH_API"],
            "https://mintdevsemanticsearch.pods.portals.tapis.io",
        )
        self.assertEqual(
            ui["environment_variables"]["ENSEMBLE_MANAGER_API"],
            "https://mintdevensemble.pods.portals.tapis.io/v1",
        )
        self.assertEqual(
            ui["environment_variables"]["MODEL_CATALOG_API"],
            "https://mintdevapi.pods.portals.tapis.io/v2.0.0",
        )

    def test_ensemble_uses_public_svo_pod_route_by_default(self):
        specs = deploy.build_specs("mintproject", "develop", "https://portals.tapis.io")
        config = json.loads(specs["ensemble"]["environment_variables"]["ENSEMBLE_MANAGER_CONFIG_JSON"])

        self.assertEqual(
            config["svo_adapter_api"],
            "https://mintdevsvo.pods.portals.tapis.io",
        )

    def test_ensemble_config_carries_the_dedicated_signing_secret(self):
        with patch.dict(os.environ, {"UNIFIED_PLAN_SECRET": "test-signing-secret"}, clear=True):
            specs = deploy.build_specs("mintproject", "develop", "https://portals.tapis.io")
        config = json.loads(specs["ensemble"]["environment_variables"]["ENSEMBLE_MANAGER_CONFIG_JSON"])
        self.assertEqual(config["unified_plan_secret"], "test-signing-secret")

    def test_svo_uses_configured_geo_actor_id(self):
        with patch.dict(
            os.environ,
            {"SVO_ADAPTER_GEO_ACTOR_ID": "zXBG65KNWDylm"},
            clear=True,
        ):
            svo = deploy.build_specs("mintproject", "develop", "https://portals.tapis.io")["svo"]

        self.assertEqual(
            svo["environment_variables"]["SVO_ADAPTER_GEO_ACTOR_ID"],
            "zXBG65KNWDylm",
        )

    def test_graphql_tapis_route_does_not_submit_cors_settings(self):
        graphql = deploy.build_specs("mintproject", "develop", "https://portals.tapis.io")["graphql"]
        self.assertEqual(
            graphql["networking"],
            {"default": {"protocol": "http", "port": 8080}},
        )
        self.assertNotIn("cors_allow_origins", graphql["networking"]["default"])

    def test_graphql_live_deploy_requires_auth_configuration(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(SystemExit) as ctx:
                deploy.validate_live_requirements(["graphql"])
        self.assertEqual(ctx.exception.code, 2)

    def test_graphql_live_deploy_accepts_auth_hook_configuration(self):
        with patch.dict(
            os.environ,
            {
                "MINTDEV_HASURA_AUTH_HOOK": "http://mintdevauthwebhook:3000/auth-webhook",
                "HASURA_GRAPHQL_ADMIN_SECRET": "admin-secret",
                "MINTDEV_POSTGRES_PASSWORD": "postgres-password",
            },
            clear=True,
        ):
            deploy.validate_live_requirements(["graphql"])

    def test_graphql_auth_hook_does_not_set_unauthorized_role(self):
        with patch.dict(
            os.environ,
            {
                "MINTDEV_HASURA_AUTH_HOOK": "https://mintdevauthwebhook.pods.portals.tapis.io/auth-webhook",
                "HASURA_GRAPHQL_ADMIN_SECRET": "admin-secret",
                "MINTDEV_POSTGRES_PASSWORD": "postgres-password",
            },
            clear=True,
        ):
            graphql = deploy.build_specs("mintproject", "develop", "https://portals.tapis.io")["graphql"]

        self.assertNotIn("HASURA_GRAPHQL_UNAUTHORIZED_ROLE", graphql["environment_variables"])
        self.assertEqual(
            graphql["environment_variables"]["HASURA_GRAPHQL_AUTH_HOOK"],
            "https://mintdevauthwebhook.pods.portals.tapis.io/auth-webhook",
        )

    def test_graphql_and_semantic_search_share_default_postgres_route(self):
        with patch.dict(
            os.environ,
            {
                "MINTDEV_POSTGRES_USER": "mint",
                "MINTDEV_POSTGRES_PASSWORD": "test-password",
                "MINTDEV_POSTGRES_DB": "mintdb",
            },
            clear=True,
        ):
            specs = deploy.build_specs("mintproject", "develop", "https://portals.tapis.io")

        expected = (
            "postgres://mint:test-password@"
            "mintdevpostgres.pods.portals.tapis.io:443/mintdb?sslmode=require"
        )
        self.assertEqual(specs["graphql"]["environment_variables"]["HASURA_GRAPHQL_DATABASE_URL"], expected)
        self.assertEqual(specs["semantic_search"]["environment_variables"]["DATABASE_URL"], expected)

    def test_manifest_image_map_overrides_each_service_exactly(self):
        image_map = json.dumps(
            {
                "graphql": {"image_ref": "ghcr.io/mintproject/graphql-engine:sha-abc1234"},
                "ui": {"image_ref": "ghcr.io/mintproject/ui:sha-def5678"},
            }
        )
        overrides = deploy.parse_image_map(image_map, "mintproject")
        specs = deploy.build_specs(
            "mintproject",
            "develop",
            "https://portals.tapis.io",
            overrides,
        )
        self.assertEqual(specs["graphql"]["image"], "ghcr.io/mintproject/graphql-engine:sha-abc1234")
        self.assertEqual(specs["ui"]["image"], "ghcr.io/mintproject/ui:sha-def5678")
        self.assertEqual(specs["api"]["image"], "ghcr.io/mintproject/model-catalog-api:develop")

    def test_manifest_image_map_rejects_wrong_repository(self):
        with self.assertRaises(SystemExit):
            deploy.parse_image_map(
                json.dumps({"ui": {"image_ref": "ghcr.io/other/ui:sha-new"}}),
                "mintproject",
            )

    def test_explicit_database_url_override_remains_shared(self):
        override = "postgres://override:secret@db.example.test:5432/mintdb?sslmode=disable"
        with patch.dict(os.environ, {"MINTDEV_HASURA_DATABASE_URL": override}, clear=True):
            specs = deploy.build_specs("mintproject", "develop", "https://portals.tapis.io")

        self.assertEqual(specs["graphql"]["environment_variables"]["HASURA_GRAPHQL_DATABASE_URL"], override)
        self.assertEqual(specs["semantic_search"]["environment_variables"]["DATABASE_URL"], override)

    def test_existing_storage_can_be_reused(self):
        deploy.check_postgres_storage(self.spec, recreate=False)

    def test_known_plain_postgis_storage_can_transition_to_pgvector(self):
        legacy = {**self.spec, "image": "postgis/postgis:16-3.5"}
        deploy.check_postgres_storage(legacy, recreate=False)

    def test_sdk_objects_are_supported(self):
        def obj(value):
            return SimpleNamespace(**{k: obj(v) for k, v in value.items()}) if isinstance(value, dict) else value
        deploy.check_postgres_storage(obj(self.spec), recreate=False)

    def test_ephemeral_or_different_storage_fails_before_update_or_delete(self):
        for change in [
            {"volume_mounts": {}},
            {"volume_mounts": None},
            {"environment_variables": {}},
            {"image": "postgres:16"},
            {"volume_mounts": {deploy.POSTGRES_MOUNT: {"type": "tapisvolume", "source_id": "other", "sub_path": ""}}},
        ]:
            with self.subTest(change=change):
                t = Mock()
                t.pods.get_pod.return_value = {**self.spec, **change}
                with self.assertRaises(RuntimeError):
                    deploy.upsert_pod(t, self.spec, recreate=False, start=True, restart=True)
                t.pods.update_pod.assert_not_called()
                t.pods.delete_pod.assert_not_called()

    def test_recreate_cannot_bypass_postgres_guard(self):
        t = Mock()
        t.pods.get_pod.return_value = self.spec
        with self.assertRaises(RuntimeError):
            deploy.upsert_pod(t, self.spec, recreate=True, start=True, restart=True)
        t.pods.delete_pod.assert_not_called()

    def test_nested_mount_cannot_hide_persistent_pgdata(self):
        self.spec["volume_mounts"][deploy.POSTGRES_DATA] = {"type": "ephemeral"}
        with self.assertRaises(RuntimeError):
            deploy.check_postgres_storage(self.spec, recreate=False)

    def test_readonly_database_volume_is_rejected(self):
        self.spec["volume_mounts"][deploy.POSTGRES_MOUNT]["read_only"] = True
        with self.assertRaises(RuntimeError):
            deploy.check_postgres_storage(self.spec, recreate=False)

    def test_only_404_is_missing(self):
        for code in (400, 401, 403, 500, None):
            error = Exception("do not expose credentials")
            error.response = SimpleNamespace(status_code=code)
            with self.subTest(code=code), self.assertRaises(RuntimeError) as ctx:
                deploy._get_or_missing(Mock(side_effect=error))
            self.assertNotIn("credentials", str(ctx.exception))
        error.response.status_code = 404
        self.assertIsNone(deploy._get_or_missing(Mock(side_effect=error)))

    def test_volume_is_reused_without_create_or_delete(self):
        t = Mock()
        t.pods.get_volume.return_value = {"status": "AVAILABLE"}
        deploy.ensure_postgres_volume(t)
        t.pods.create_volume.assert_not_called()
        t.pods.delete_volume.assert_not_called()

    def test_volume_created_only_when_missing(self):
        t = Mock()
        error = Exception()
        error.response = SimpleNamespace(status_code=404)
        t.pods.get_volume.side_effect = [error, {"status": "AVAILABLE"}]
        deploy.ensure_postgres_volume(t, allow_create=True)
        self.assertEqual(t.pods.create_volume.call_args.kwargs["volume_id"], deploy.POSTGRES_VOLUME)

    def test_missing_volume_for_existing_database_is_not_replaced(self):
        t = Mock()
        error = Exception()
        error.response = SimpleNamespace(status_code=404)
        t.pods.get_volume.side_effect = error
        with self.assertRaises(RuntimeError):
            deploy.ensure_postgres_volume(t)
        t.pods.create_volume.assert_not_called()

    def test_volume_error_does_not_create(self):
        t = Mock()
        t.pods.get_volume.side_effect = TimeoutError()
        with self.assertRaises(RuntimeError):
            deploy.ensure_postgres_volume(t)
        t.pods.create_volume.assert_not_called()

    def test_readiness_requires_new_container_and_successful_sql(self):
        t = Mock()
        t.pods.get_pod.side_effect = [
            {"status": "AVAILABLE", "status_container": {"start_time": "old"}},
            {"status": "AVAILABLE", "status_container": {"start_time": "new"}},
        ]
        t.pods.exec_pod_commands.return_value = {"execution_results": [{"exit_code": 0, "stdout": "1\n"}]}
        with patch.object(deploy.time, "sleep"):
            deploy.wait_for_postgres(t, "old", restarted=True)
        self.assertEqual(t.pods.get_pod.call_count, 2)
        t.pods.exec_pod_commands.assert_called_once()

    def test_restart_requires_old_timestamp(self):
        t = Mock()
        with self.assertRaises(RuntimeError):
            deploy.wait_for_postgres(t, restarted=True)
        t.pods.exec_pod_commands.assert_not_called()

    def test_missing_new_timestamp_does_not_confirm_restart(self):
        t = Mock()
        t.pods.get_pod.return_value = {"status": "AVAILABLE", "status_container": {}}
        with patch.object(deploy.time, "monotonic", side_effect=[0, 0, 601]), patch.object(deploy.time, "sleep"):
            with self.assertRaises(RuntimeError):
                deploy.wait_for_postgres(t, "old", restarted=True)
        t.pods.exec_pod_commands.assert_not_called()

    def test_hasura_migration_runs_in_exact_graphql_image_and_verifies_catalog(self):
        t = Mock()
        t.pods.get_pod.side_effect = [{
            "status": "AVAILABLE",
            "image": "ghcr.io/mintproject/graphql-engine:sha-abc1234",
            "status_container": {"start_time": "old"},
        }, {
            "status": "AVAILABLE",
            "image": "ghcr.io/mintproject/graphql-engine:sha-abc1234",
            "status_container": {"start_time": "new"},
        }]
        t.pods.exec_pod_commands.side_effect = [{
            "execution_results": [{"exit_code": 0}],
        }, {
            "execution_results": [{
                "exit_code": 0,
                "stdout": "Hasura migration and catalog verification succeeded.\n",
            }],
        }]

        deploy.run_hasura_migrations(
            t,
            expected_image="ghcr.io/mintproject/graphql-engine:sha-abc1234",
        )

        command = t.pods.exec_pod_commands.call_args.kwargs["commands"][0][2]
        self.assertIn("hasura migrate apply --skip-update-check", command)
        self.assertIn("hasura metadata apply --skip-update-check", command)
        self.assertIn("status=\"$(hasura migrate status --skip-update-check --no-color 2>&1)\"", command)
        self.assertIn("Not Present", command)
        self.assertIn("metadata inconsistency list --skip-update-check --no-color", command)
        self.assertIn("metadata is consistent", command)
        self.assertIn("groundwater_model_modflow6_simulation_archive", command)
        self.assertEqual(
            t.pods.exec_pod_commands.call_args.kwargs["pod_id"],
            deploy.PODS["graphql"],
        )
        t.pods.restart_pod.assert_called_once_with(pod_id=deploy.PODS["graphql"])

    def test_hasura_migration_failure_is_fatal(self):
        t = Mock()
        t.pods.get_pod.side_effect = [{
            "status": "AVAILABLE",
            "image": "ghcr.io/mintproject/graphql-engine:sha-abc1234",
            "status_container": {"start_time": "old"},
        }, {
            "status": "AVAILABLE",
            "image": "ghcr.io/mintproject/graphql-engine:sha-abc1234",
            "status_container": {"start_time": "new"},
        }]
        t.pods.exec_pod_commands.side_effect = [{
            "execution_results": [{"exit_code": 0}],
        }, {
            "execution_results": [{"exit_code": 1, "stderr": "migration failed"}],
        }]

        with self.assertRaisesRegex(RuntimeError, "Hasura migration/verification failed"):
            deploy.run_hasura_migrations(
                t,
                expected_image="ghcr.io/mintproject/graphql-engine:sha-abc1234",
            )

    def test_hasura_migration_requires_restart_timestamp(self):
        t = Mock()
        t.pods.get_pod.return_value = {
            "status": "AVAILABLE",
            "image": "ghcr.io/mintproject/graphql-engine:sha-abc1234",
            "status_container": {},
        }

        with self.assertRaisesRegex(RuntimeError, "previous container start time"):
            deploy.run_hasura_migrations(
                t,
                expected_image="ghcr.io/mintproject/graphql-engine:sha-abc1234",
            )
        t.pods.restart_pod.assert_not_called()

    def test_migrate_hasura_requires_graphql_only(self):
        with self.assertRaises(SystemExit), patch("sys.stderr"):
            deploy.main(["--migrate-hasura", "--pods", "ui"])

    def test_conflicting_start_flags_rejected_before_any_connection(self):
        with self.assertRaises(SystemExit), patch("sys.stderr"):
            deploy.main(["--no-start", "--restart"])

    def test_no_start_allows_image_mismatch_recovery(self):
        self.assertEqual(
            deploy.main(
                [
                    "--no-start",
                    "--recreate-on-image-mismatch",
                    "--dry-run",
                    "--pods",
                    "ui",
                ]
            ),
            0,
        )

    def test_recreate_modes_cannot_be_combined(self):
        with self.assertRaises(SystemExit), patch("sys.stderr"):
            deploy.main(["--recreate", "--recreate-on-image-mismatch"])

    def test_automated_restart_allowlist_excludes_postgres(self):
        selected = deploy.parse_pods("all")
        self.assertEqual(
            deploy.resolve_restart_pods(
                selected,
                restart=False,
                restart_pods="graphql,api,ensemble,svo,ui",
            ),
            ["graphql", "api", "ensemble", "svo", "ui"],
        )

    def test_postgres_is_not_restarted_when_omitted_from_allowlist(self):
        t = Mock()
        t.pods.get_pod.return_value = self.spec
        deploy.upsert_pod(t, self.spec, recreate=False, start=True, restart=False)
        t.pods.restart_pod.assert_not_called()
        t.pods.update_pod.assert_called_once()

    def test_postgres_transition_updates_image_without_recreating_volume(self):
        t = Mock()
        legacy = {**self.spec, "image": "postgis/postgis:16-3.5"}
        t.pods.get_pod.return_value = legacy
        with self.assertRaises(RuntimeError):
            deploy.upsert_pod(t, self.spec, recreate=False, start=True, restart=False)
        t.pods.update_pod.assert_not_called()
        t.pods.delete_pod.assert_not_called()

    def test_postgres_tag_change_replaces_pod_only_with_migration_flag(self):
        t = Mock()
        existing = {**self.spec, "image": "ghcr.io/mintproject/postgres-pgvector:sha-old", "status": "AVAILABLE"}
        t.pods.get_pod.return_value = existing
        with patch.object(deploy, "wait_for_pod_absent"), patch.object(
            deploy, "wait_for_pod_image"
        ):
            deploy.upsert_pod(
                t,
                self.spec,
                migrate_postgres_image=True,
                recreate=False,
                start=False,
                restart=True,
            )
        t.pods.delete_pod.assert_called_once_with(pod_id=deploy.PODS["postgres"])
        t.pods.create_pod.assert_called_once_with(**self.spec)
        t.pods.update_pod.assert_not_called()

    def test_postgres_transition_replaces_only_the_pod_and_retains_volume(self):
        t = Mock()
        legacy = {**self.spec, "image": "postgis/postgis:16-3.5", "status": "AVAILABLE"}
        t.pods.get_pod.return_value = legacy
        with patch.object(deploy, "wait_for_pod_absent"), patch.object(
            deploy, "wait_for_pod_image"
        ):
            deploy.upsert_pod(
                t,
                self.spec,
                migrate_postgres_image=True,
                recreate=False,
                start=False,
                restart=True,
            )
        t.pods.delete_pod.assert_called_once_with(pod_id=deploy.PODS["postgres"])
        t.pods.create_pod.assert_called_once_with(**self.spec)
        t.pods.update_pod.assert_not_called()
        t.pods.delete_volume.assert_not_called()

    def test_restart_allowlist_is_limited_to_updated_pods(self):
        self.assertEqual(
            deploy.resolve_restart_pods(
                deploy.parse_pods("postgres,ui"),
                restart=False,
                restart_pods="redis,postgres,ui",
            ),
            ["postgres", "ui"],
        )

    def test_restart_modes_cannot_be_combined(self):
        with self.assertRaises(SystemExit):
            deploy.resolve_restart_pods(["ui"], restart=True, restart_pods="ui")

    def test_waits_are_bounded(self):
        with self.assertRaises(RuntimeError):
            deploy.wait_for_postgres(Mock(), timeout=0)
        t = Mock()
        t.pods.get_volume.return_value = {"status": "CREATING"}
        with self.assertRaises(RuntimeError):
            deploy.ensure_postgres_volume(t, timeout=0)

    def test_selector_keeps_dependency_order(self):
        self.assertEqual(deploy.parse_pods("graphql,postgres,postgres"), ["postgres", "graphql"])


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.spec = deploy.build_specs("mintproject", "sha-new", "https://portals.tapis.io")["ui"]

    def test_image_verification_waits_for_eventual_consistency(self):
        old = {"image": "ghcr.io/mintproject/ui:sha-old"}
        new = {"image": self.spec["image"]}
        t = Mock()
        t.pods.get_pod.side_effect = [old, old, new]
        clock = [0]
        with patch.object(deploy.time, "monotonic", side_effect=lambda: clock[0]), patch.object(
            deploy.time, "sleep", side_effect=lambda _: clock.__setitem__(0, clock[0] + 1)
        ):
            result = deploy.wait_for_pod_image(t, self.spec["pod_id"], self.spec["image"], timeout=10)
        self.assertEqual(result, new)
        self.assertEqual(t.pods.get_pod.call_count, 3)

    def test_image_verification_timeout_is_fail_closed(self):
        t = Mock()
        with self.assertRaises(deploy.PodImageMismatchError) as ctx:
            deploy.wait_for_pod_image(t, self.spec["pod_id"], self.spec["image"], timeout=0)
        self.assertIn("did not converge", str(ctx.exception))

    def test_verification_lookup_errors_do_not_trigger_recovery(self):
        t = Mock()
        t.pods.get_pod.side_effect = RuntimeError("credentials must not leak")
        with self.assertRaises(RuntimeError) as ctx:
            deploy.wait_for_pod_image(t, self.spec["pod_id"], self.spec["image"])
        self.assertNotIn("credentials", str(ctx.exception))

    def test_transient_verification_lookup_is_retried(self):
        missing_connection = ConnectionError("connection closed")
        t = Mock()
        t.pods.get_pod.side_effect = [missing_connection, {"image": self.spec["image"]}]
        with patch.object(deploy.time, "sleep"):
            result = deploy.wait_for_pod_image(t, self.spec["pod_id"], self.spec["image"], timeout=10)
        self.assertEqual(result["image"], self.spec["image"])
        self.assertEqual(t.pods.get_pod.call_count, 2)

    def test_tapipy_transport_wrapper_is_retried(self):
        t = Mock()
        t.pods.get_pod.side_effect = [
            Exception("Unable to make request to Tapis server. Exception: connection reset"),
            {"image": self.spec["image"]},
        ]
        with patch.object(deploy.time, "sleep"):
            result = deploy.wait_for_pod_image(t, self.spec["pod_id"], self.spec["image"], timeout=10)
        self.assertEqual(result["image"], self.spec["image"])

    def test_http_verification_error_is_not_retried(self):
        error = Exception("unauthorized credentials")
        error.response = SimpleNamespace(status_code=401)
        t = Mock()
        t.pods.get_pod.side_effect = error
        with patch.object(deploy.time, "sleep"):
            with self.assertRaises(RuntimeError) as ctx:
                deploy.wait_for_pod_image(t, self.spec["pod_id"], self.spec["image"], timeout=10)
        self.assertIn("HTTP 401", str(ctx.exception))
        self.assertNotIn("credentials", str(ctx.exception))
        t.pods.get_pod.assert_called_once()

    def test_restart_happens_after_image_verification(self):
        existing = {"image": "old", "status_container": {"start_time": "old-start"}}
        updated = {"image": self.spec["image"]}
        ready = {"image": self.spec["image"], "status": "AVAILABLE", "status_container": {"start_time": "new-start"}}
        t = Mock()
        t.pods.get_pod.side_effect = [existing, updated, ready]
        events = []
        t.pods.update_pod.side_effect = lambda **_: events.append("update")
        t.pods.restart_pod.side_effect = lambda **_: events.append("restart")
        with patch.object(deploy.time, "sleep"), patch.object(
            deploy, "wait_for_pod_image", side_effect=lambda *_args, **_kwargs: events.append("verify")
        ), patch.object(deploy, "wait_for_pod_restart", side_effect=lambda *_args, **_kwargs: events.append("ready")):
            deploy.upsert_pod(t, self.spec, recreate=False, start=False, restart=True)
        self.assertEqual(events, ["update", "verify", "restart", "ready"])

    def test_existing_graphql_update_preserves_live_networking(self):
        desired = deploy.build_specs(
            "mintproject", "sha-new", "https://portals.tapis.io"
        )["graphql"]
        live_networking = {
            "default": {
                "protocol": "http",
                "port": 8080,
                "cors_allow_origins": ["https://live-ui.example"],
                "cors_allow_methods": ["GET"],
                "cors_allow_headers": ["Authorization"],
                "cors_allow_credentials": False,
                "cors_max_age": 42,
            }
        }
        existing = {
            **desired,
            "image": "ghcr.io/mintproject/graphql-engine:sha-old",
            "networking": live_networking,
        }
        t = Mock()
        t.pods.get_pod.return_value = existing

        with patch.object(deploy, "wait_for_pod_image"):
            deploy.upsert_pod(
                t, desired, recreate=False, start=False, restart=False
            )

        sent = t.pods.update_pod.call_args.kwargs
        self.assertNotIn("networking", sent)
        self.assertEqual(sent["image"], desired["image"])
        self.assertEqual(existing["networking"], live_networking)

    def test_existing_graphql_update_preserves_live_auth_env(self):
        desired = deploy.build_specs(
            "mintproject", "sha-new", "https://portals.tapis.io"
        )["graphql"]
        existing = {
            **desired,
            "image": "ghcr.io/mintproject/graphql-engine:sha-old",
            "environment_variables": {
                **desired["environment_variables"],
                "HASURA_GRAPHQL_AUTH_HOOK": "http://mintdevauthwebhook:3000/auth-webhook",
                "HASURA_GRAPHQL_AUTH_HOOK_MODE": "POST",
            },
        }
        t = Mock()
        t.pods.get_pod.return_value = existing

        with patch.object(deploy, "wait_for_pod_image"):
            deploy.upsert_pod(
                t, desired, recreate=False, start=False, restart=False
            )

        sent = t.pods.update_pod.call_args.kwargs
        self.assertEqual(
            sent["environment_variables"]["HASURA_GRAPHQL_AUTH_HOOK"],
            "http://mintdevauthwebhook:3000/auth-webhook",
        )
        self.assertEqual(sent["environment_variables"]["HASURA_GRAPHQL_AUTH_HOOK_MODE"], "POST")

    def test_restart_existing_pods_only_restarts_selected_apps(self):
        t = Mock()
        deploy.restart_existing_pods(t, ["api", "ui"])
        self.assertEqual(
            t.pods.restart_pod.call_args_list,
            [
                unittest.mock.call(pod_id=deploy.PODS["api"]),
                unittest.mock.call(pod_id=deploy.PODS["ui"]),
            ],
        )
        t.pods.get_pod.assert_not_called()
        t.pods.update_pod.assert_not_called()
        t.pods.create_pod.assert_not_called()
        t.pods.delete_pod.assert_not_called()
        t.pods.set_pod_permission.assert_not_called()

    def test_update_pod_images_changes_only_image_field(self):
        t = Mock()
        images = {"api": "ghcr.io/mintproject/model-catalog-api:sha-new"}
        with patch.object(deploy, "wait_for_pod_image") as wait_for_image:
            deploy.update_pod_images(t, ["api"], images)
        t.pods.update_pod.assert_called_once_with(
            pod_id=deploy.PODS["api"], image=images["api"]
        )
        wait_for_image.assert_called_once_with(t, deploy.PODS["api"], images["api"])
        t.pods.restart_pod.assert_not_called()
        t.pods.create_pod.assert_not_called()

    def test_update_pod_images_retries_transient_server_errors(self):
        t = Mock()
        error = Exception("temporary Tapis failure")
        error.response = SimpleNamespace(status_code=500)
        t.pods.update_pod.side_effect = [error, None]
        images = {"api": "ghcr.io/mintproject/model-catalog-api:sha-new"}

        with patch.object(deploy.time, "sleep") as sleep, patch.object(
            deploy, "wait_for_pod_image"
        ) as wait_for_image:
            deploy.update_pod_images(t, ["api"], images)

        self.assertEqual(t.pods.update_pod.call_count, 2)
        sleep.assert_called_once_with(deploy.POD_UPDATE_BACKOFF)
        wait_for_image.assert_called_once_with(t, deploy.PODS["api"], images["api"])

    def test_update_pod_images_reports_pod_and_image_on_nontransient_error(self):
        t = Mock()
        error = Exception("forbidden")
        error.response = SimpleNamespace(status_code=403)
        t.pods.update_pod.side_effect = error
        image = "ghcr.io/mintproject/model-catalog-api:sha-new"

        with self.assertRaisesRegex(RuntimeError, r"\[mintdevapi\].*" + image + r".*HTTP 403"):
            deploy.update_pod_images(t, ["api"], {"api": image})

        t.pods.update_pod.assert_called_once_with(pod_id=deploy.PODS["api"], image=image)

    def test_update_pod_images_requires_exact_image_for_each_pod(self):
        t = Mock()
        with self.assertRaises(RuntimeError):
            deploy.update_pod_images(t, ["api", "ui"], {"api": "ghcr.io/mintproject/model-catalog-api:sha-new"})
        t.pods.update_pod.assert_not_called()

    def test_update_pod_images_fails_before_restart_when_image_does_not_converge(self):
        t = Mock()
        image = "ghcr.io/mintproject/graphql-engine:sha-new"
        with patch.object(
            deploy,
            "wait_for_pod_image",
            side_effect=deploy.PodImageMismatchError("stale image"),
        ):
            with self.assertRaisesRegex(deploy.PodImageMismatchError, "stale image"):
                deploy.update_pod_images(t, ["graphql"], {"graphql": image})
        t.pods.update_pod.assert_called_once_with(pod_id=deploy.PODS["graphql"], image=image)
        t.pods.restart_pod.assert_not_called()

    def test_wait_for_pod_restart_reports_last_observed_state(self):
        t = Mock()
        t.pods.get_pod.return_value = {
            "status": "STARTING",
            "image": "ghcr.io/mintproject/graphql-engine:sha-old",
            "status_container": {"start_time": "old-start"},
        }
        with patch.object(deploy.time, "monotonic", side_effect=[0, 0, 0, 11]), patch.object(
            deploy.time, "sleep"
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                r"last status='STARTING'.*image='ghcr.io/mintproject/graphql-engine:sha-old'.*"
                r"start_time='old-start'.*previous_start='old-start'",
            ):
                deploy.wait_for_pod_restart(
                    t,
                    deploy.PODS["graphql"],
                    "ghcr.io/mintproject/graphql-engine:sha-new",
                    previous_start="old-start",
                    timeout=10,
                )

    def test_restart_dispatches_all_requests_without_polling(self):
        t = Mock()
        events = []
        t.pods.restart_pod.side_effect = lambda **kwargs: events.append(("restart", kwargs["pod_id"]))
        deploy.restart_existing_pods(t, ["api", "ensemble", "ui"])
        self.assertEqual(
            events,
            [
                ("restart", deploy.PODS["api"]),
                ("restart", deploy.PODS["ensemble"]),
                ("restart", deploy.PODS["ui"]),
            ],
        )
        t.pods.get_pod.assert_not_called()

    def test_image_and_restart_modes_reject_static_infrastructure_pods(self):
        t = Mock()
        with self.assertRaises(RuntimeError):
            deploy.update_pod_images(t, ["postgres"], {"postgres": "ghcr.io/mintproject/postgres-pgvector:sha-new"})
        with self.assertRaises(RuntimeError):
            deploy.restart_existing_pods(t, ["redis"])

    def test_mismatch_without_opt_in_does_not_delete_or_restart(self):
        t = Mock()
        t.pods.get_pod.return_value = self.spec
        with patch.object(deploy, "wait_for_pod_image", side_effect=deploy.PodImageMismatchError("stale")):
            with self.assertRaises(deploy.PodImageMismatchError):
                deploy.upsert_pod(t, self.spec, recreate=False, start=False, restart=True)
        t.pods.delete_pod.assert_not_called()
        t.pods.restart_pod.assert_not_called()

    def test_opt_in_recovery_recreates_ui_after_confirmed_delete(self):
        missing = Exception()
        missing.response = SimpleNamespace(status_code=404)
        live_networking = SimpleNamespace(
            default=SimpleNamespace(
                protocol="http",
                port=8080,
                cors_allow_origins=["https://mintdevui.example"],
            )
        )
        existing = dict(self.spec, networking=live_networking)
        t = Mock()
        t.pods.get_pod.side_effect = [existing, missing]
        with patch.object(
            deploy,
            "wait_for_pod_image",
            side_effect=[deploy.PodImageMismatchError("stale"), self.spec],
        ):
            deploy.upsert_pod(
                t,
                self.spec,
                recreate=False,
                recreate_on_image_mismatch=True,
                start=False,
                restart=True,
            )
        t.pods.delete_pod.assert_called_once_with(pod_id=deploy.PODS["ui"])
        recreated = t.pods.create_pod.call_args.kwargs
        self.assertEqual(
            recreated["networking"],
            {
                "default": {
                    "protocol": "http",
                    "port": 8080,
                    "cors_allow_origins": ["https://mintdevui.example"],
                }
            },
        )
        json.dumps(recreated)
        t.pods.restart_pod.assert_not_called()

    def test_opt_in_recovery_cannot_recreate_postgres(self):
        postgres = deploy.build_specs("mintproject", "sha-new", "https://portals.tapis.io")["postgres"]
        t = Mock()
        t.pods.get_pod.return_value = postgres
        with patch.object(deploy, "wait_for_pod_image", side_effect=deploy.PodImageMismatchError("stale")):
            with self.assertRaises(RuntimeError) as ctx:
                deploy.upsert_pod(
                    t,
                    postgres,
                    recreate=False,
                    recreate_on_image_mismatch=True,
                    start=False,
                    restart=False,
                )
        self.assertIn("protected pod", str(ctx.exception))
        t.pods.delete_pod.assert_not_called()
        t.pods.create_pod.assert_not_called()

    def test_recovery_validates_networking_before_delete(self):
        existing = dict(self.spec, networking=object())
        t = Mock()
        t.pods.get_pod.return_value = existing
        with patch.object(deploy, "wait_for_pod_image", side_effect=deploy.PodImageMismatchError("stale")):
            with self.assertRaisesRegex(RuntimeError, "non-JSON networking data"):
                deploy.upsert_pod(
                    t,
                    self.spec,
                    recreate=False,
                    recreate_on_image_mismatch=True,
                    start=False,
                    restart=False,
                )
        t.pods.delete_pod.assert_not_called()
        t.pods.create_pod.assert_not_called()

    def test_opt_in_recovery_cannot_recreate_redis(self):
        redis = deploy.build_specs("mintproject", "sha-new", "https://portals.tapis.io")["redis"]
        t = Mock()
        t.pods.get_pod.return_value = redis
        with patch.object(deploy, "wait_for_pod_image", side_effect=deploy.PodImageMismatchError("stale")):
            with self.assertRaises(RuntimeError) as ctx:
                deploy.upsert_pod(
                    t,
                    redis,
                    recreate=False,
                    recreate_on_image_mismatch=True,
                    start=False,
                    restart=False,
                )
        self.assertIn("protected pod", str(ctx.exception))
        t.pods.delete_pod.assert_not_called()
        t.pods.create_pod.assert_not_called()

    def test_delete_wait_requires_confirmed_404(self):
        t = Mock()
        error = Exception()
        error.response = SimpleNamespace(status_code=403)
        t.pods.get_pod.side_effect = error
        with self.assertRaises(RuntimeError):
            deploy.wait_for_pod_absent(t, deploy.PODS["ui"], timeout=1)


class OwnerGrantTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_grant_touches_every_pod_and_never_mutates_definitions(self):
        t = Mock()
        t.pods.get_pod.return_value = {"image": "any"}
        rc = deploy.grant_pod_owners(t, list(deploy.ORDER), ["wmobley", "mosorio"])
        self.assertEqual(rc, 0)
        granted = {
            (call.kwargs["pod_id"], call.kwargs["user"])
            for call in t.pods.set_pod_permission.call_args_list
        }
        self.assertEqual(
            granted,
            {(deploy.PODS[key], user) for key in deploy.ORDER for user in ("wmobley", "mosorio")},
        )
        t.pods.update_pod.assert_not_called()
        t.pods.create_pod.assert_not_called()
        t.pods.restart_pod.assert_not_called()
        t.pods.delete_pod.assert_not_called()

    def test_absent_pod_is_skipped_not_created(self):
        missing = Exception()
        missing.response = SimpleNamespace(status_code=404)
        t = Mock()
        t.pods.get_pod.side_effect = [missing, {"image": "any"}]
        rc = deploy.grant_pod_owners(t, ["semantic_search", "ui"], ["mosorio"])
        self.assertEqual(rc, 0)
        t.pods.set_pod_permission.assert_called_once_with(
            pod_id=deploy.PODS["ui"], user="mosorio", level="APPROVEDADMIN"
        )
        t.pods.create_pod.assert_not_called()

    def test_require_all_owner_grants_fails_for_absent_pod(self):
        missing = Exception()
        missing.response = SimpleNamespace(status_code=404)
        t = Mock()
        t.pods.get_pod.side_effect = [missing, {"image": "any"}]
        rc = deploy.grant_pod_owners(
            t, ["semantic_search", "ui"], ["wmobley"], require_all=True
        )
        self.assertEqual(rc, 1)
        t.pods.set_pod_permission.assert_called_once_with(
            pod_id=deploy.PODS["ui"], user="wmobley", level="APPROVEDADMIN"
        )

    def test_one_rejected_grant_does_not_hide_the_others(self):
        t = Mock()
        t.pods.get_pod.return_value = {"image": "any"}
        t.pods.set_pod_permission.side_effect = [Exception("CORS approval required"), None]
        rc = deploy.grant_pod_owners(t, ["graphql"], ["wmobley", "mosorio"])
        self.assertEqual(rc, 0)
        self.assertEqual(t.pods.set_pod_permission.call_count, 2)

    def test_total_failure_is_fatal(self):
        t = Mock()
        t.pods.get_pod.return_value = {"image": "any"}
        t.pods.set_pod_permission.side_effect = Exception("unauthorized")
        rc = deploy.grant_pod_owners(t, ["graphql"], ["mosorio"])
        self.assertEqual(rc, 1)

    def test_owners_only_rejects_lifecycle_options(self):
        for extra in (["--restart"], ["--recreate"], ["--dry-run"], ["--restart-existing-pods", "ui"]):
            with self.subTest(extra=extra):
                with self.assertRaises(SystemExit):
                    deploy.main(["--set-owners-only", *extra])

    def test_owners_only_does_not_require_deploy_secrets(self):
        with patch.object(deploy, "validate_live_requirements") as gate, patch.object(
            deploy, "grant_pod_owners", return_value=0
        ) as grant, patch.dict(
            os.environ, {"TAPIS_USERNAME": "mosorio", "TAPIS_PASSWORD": "x"}, clear=True
        ), patch.dict(
            "sys.modules", {"tapipy": Mock(), "tapipy.tapis": Mock()}
        ):
            rc = deploy.main(["--set-owners-only"])
        self.assertEqual(rc, 0)
        gate.assert_not_called()
        self.assertEqual(grant.call_args.args[1], list(deploy.ORDER))


class UiAuthSyncTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.spec = deploy.build_specs("mintproject", "sha-new", "https://portals.tapis.io")["ui"]
        self.allowed = self.spec["networking"]["default"]["tapis_auth_allowed_users"]

    def _converged(self):
        return {"networking": {"default": {"tapis_auth_allowed_users": list(self.allowed)}}}

    def test_sync_keeps_the_running_image(self):
        running = {
            "image": "ghcr.io/mintproject/ui:sha-old",
            "status_container": {"start_time": "old-start"},
        }
        ready = {
            "image": "ghcr.io/mintproject/ui:sha-old",
            "status": "AVAILABLE",
            "status_container": {"start_time": "new-start"},
        }
        t = Mock()
        t.pods.get_pod.side_effect = [running, self._converged(), ready]
        rc = deploy.sync_ui_auth(t, self.spec)
        self.assertEqual(rc, 0)
        sent = t.pods.update_pod.call_args.kwargs
        self.assertEqual(sent["image"], "ghcr.io/mintproject/ui:sha-old")
        self.assertEqual(
            sent["networking"]["default"]["tapis_auth_allowed_users"], self.allowed
        )

    def test_sync_requests_restart_after_allowlist_update(self):
        running = {
            "image": "ghcr.io/mintproject/ui:sha-old",
            "status_container": {"start_time": "old-start"},
        }
        ready = {
            "image": "ghcr.io/mintproject/ui:sha-old",
            "status": "AVAILABLE",
            "status_container": {"start_time": "new-start"},
        }
        t = Mock()
        t.pods.get_pod.side_effect = [running, self._converged(), ready]
        with patch.object(deploy.time, "sleep"):
            deploy.sync_ui_auth(t, self.spec)
        t.pods.restart_pod.assert_called_once_with(pod_id=deploy.PODS["ui"])
        t.pods.start_pod.assert_not_called()
        t.pods.create_pod.assert_not_called()
        t.pods.delete_pod.assert_not_called()

    def test_sync_can_defer_restart_for_application_batch(self):
        running = {
            "image": "ghcr.io/mintproject/ui:sha-old",
            "status_container": {"start_time": "old-start"},
        }
        t = Mock()
        t.pods.get_pod.side_effect = [running, self._converged()]
        rc = deploy.sync_ui_auth(t, self.spec, restart=False)
        self.assertEqual(rc, 0)
        t.pods.update_pod.assert_called_once()
        t.pods.restart_pod.assert_not_called()
        t.pods.start_pod.assert_not_called()

    def test_sync_refuses_a_missing_pod(self):
        missing = Exception()
        missing.response = SimpleNamespace(status_code=404)
        t = Mock()
        t.pods.get_pod.side_effect = missing
        with self.assertRaises(RuntimeError) as ctx:
            deploy.sync_ui_auth(t, self.spec)
        self.assertIn("will not create it", str(ctx.exception))
        t.pods.update_pod.assert_not_called()

    def test_sync_refuses_a_pod_without_an_image(self):
        t = Mock()
        t.pods.get_pod.return_value = {"image": ""}
        with self.assertRaises(RuntimeError) as ctx:
            deploy.sync_ui_auth(t, self.spec)
        self.assertIn("refusing to rewrite", str(ctx.exception))
        t.pods.update_pod.assert_not_called()

    def test_sync_is_fail_closed_when_the_allowlist_does_not_converge(self):
        stale = {"networking": {"default": {"tapis_auth_allowed_users": ["wmobley"]}}}
        t = Mock()
        t.pods.get_pod.side_effect = [
            {"image": "ghcr.io/mintproject/ui:sha-old", "status_container": {"start_time": "old-start"}},
            stale,
        ]
        with self.assertRaises(RuntimeError) as ctx:
            deploy.sync_ui_auth(t, self.spec)
        self.assertIn("did not converge", str(ctx.exception))

    def test_sync_rejects_lifecycle_options(self):
        for extra in (["--restart"], ["--recreate"], ["--dry-run"], ["--set-owners-only"]):
            with self.subTest(extra=extra):
                with self.assertRaises(SystemExit):
                    deploy.main(["--sync-ui-auth", *extra])

    def test_sync_does_not_require_deploy_secrets(self):
        with patch.object(deploy, "validate_live_requirements") as gate, patch.object(
            deploy, "sync_ui_auth", return_value=0
        ) as sync, patch.dict(
            os.environ, {"TAPIS_USERNAME": "mosorio", "TAPIS_PASSWORD": "x"}, clear=True
        ), patch.dict(
            "sys.modules", {"tapipy": Mock(), "tapipy.tapis": Mock()}
        ):
            rc = deploy.main(["--sync-ui-auth"])
        self.assertEqual(rc, 0)
        gate.assert_not_called()
        self.assertEqual(sync.call_args.args[1]["pod_id"], deploy.PODS["ui"])


class SvoRuntimeSyncTests(unittest.TestCase):
    def setUp(self):
        self.spec = {
            "pod_id": deploy.PODS["svo"],
            "environment_variables": {"SVO_ADAPTER_GEO_ACTOR_ID": "z8LGLpm7lVqrK"},
        }

    def test_sync_preserves_existing_environment_and_updates_actor(self):
        running = {
            "image": "ghcr.io/mintproject/svo-adapter:develop",
            "status_container": {"start_time": "old-start"},
            "environment_variables": {"KEEP_ME": "yes", "SVO_ADAPTER_GEO_ACTOR_ID": "old"},
        }
        applied = {
            "environment_variables": {"KEEP_ME": "yes", "SVO_ADAPTER_GEO_ACTOR_ID": "z8LGLpm7lVqrK"},
        }
        ready = {
            "image": running["image"],
            "status": "AVAILABLE",
            "status_container": {"start_time": "new-start"},
        }
        t = Mock()
        t.pods.get_pod.side_effect = [running, applied, ready]
        with patch.object(deploy.time, "sleep"):
            rc = deploy.sync_svo_runtime(t, self.spec)
        self.assertEqual(rc, 0)
        t.pods.update_pod.assert_called_once_with(
            pod_id=deploy.PODS["svo"],
            image=running["image"],
            environment_variables={"KEEP_ME": "yes", "SVO_ADAPTER_GEO_ACTOR_ID": "z8LGLpm7lVqrK"},
        )
        t.pods.restart_pod.assert_called_once_with(pod_id=deploy.PODS["svo"])

    def test_sync_can_defer_restart(self):
        running = {
            "image": "ghcr.io/mintproject/svo-adapter:develop",
            "status_container": {"start_time": "old-start"},
            "environment_variables": {},
        }
        applied = {"environment_variables": {"SVO_ADAPTER_GEO_ACTOR_ID": "z8LGLpm7lVqrK"}}
        t = Mock()
        t.pods.get_pod.side_effect = [running, applied]
        rc = deploy.sync_svo_runtime(t, self.spec, restart=False)
        self.assertEqual(rc, 0)
        t.pods.restart_pod.assert_not_called()

    def test_sync_refuses_to_clear_actor(self):
        t = Mock()
        spec = {"pod_id": deploy.PODS["svo"], "environment_variables": {"SVO_ADAPTER_GEO_ACTOR_ID": ""}}
        with self.assertRaises(RuntimeError):
            deploy.sync_svo_runtime(t, spec)
        t.pods.update_pod.assert_not_called()

    def test_sync_manages_run_signal_wiring_when_the_spec_declares_it(self):
        # An empty secret is applied too: that is how the feature is switched off
        # on the live pod without a full re-registration.
        spec = {
            "pod_id": deploy.PODS["svo"],
            "environment_variables": {
                "SVO_ADAPTER_GEO_ACTOR_ID": "z8LGLpm7lVqrK",
                "SVO_ADAPTER_PUBLIC_URL": "https://mintdevsvo.pods.portals.tapis.io",
                "SVO_ADAPTER_RUN_SIGNAL_SECRETS": "",
            },
        }
        running = {
            "image": "ghcr.io/mintproject/svo-adapter:develop",
            "status_container": {"start_time": "old-start"},
            "environment_variables": {"SVO_ADAPTER_GEO_ACTOR_ID": "old",
                                      "SVO_ADAPTER_RUN_SIGNAL_SECRETS": "rotated-out"},
        }
        applied = {"environment_variables": {
            "SVO_ADAPTER_GEO_ACTOR_ID": "z8LGLpm7lVqrK",
            "SVO_ADAPTER_PUBLIC_URL": "https://mintdevsvo.pods.portals.tapis.io",
            "SVO_ADAPTER_RUN_SIGNAL_SECRETS": "",
        }}
        t = Mock()
        t.pods.get_pod.side_effect = [running, applied]
        rc = deploy.sync_svo_runtime(t, spec, restart=False)
        self.assertEqual(rc, 0)
        self.assertEqual(
            t.pods.update_pod.call_args.kwargs["environment_variables"],
            applied["environment_variables"],
        )

    def test_sync_fails_when_signal_wiring_does_not_converge(self):
        spec = {
            "pod_id": deploy.PODS["svo"],
            "environment_variables": {"SVO_ADAPTER_GEO_ACTOR_ID": "z8LGLpm7lVqrK",
                                      "SVO_ADAPTER_RUN_SIGNAL_SECRETS": "new"},
        }
        running = {
            "image": "ghcr.io/mintproject/svo-adapter:develop",
            "status_container": {"start_time": "old-start"},
            "environment_variables": {},
        }
        applied = {"environment_variables": {"SVO_ADAPTER_GEO_ACTOR_ID": "z8LGLpm7lVqrK",
                                             "SVO_ADAPTER_RUN_SIGNAL_SECRETS": "old"}}
        t = Mock()
        t.pods.get_pod.side_effect = [running, applied]
        with self.assertRaises(RuntimeError) as ctx:
            deploy.sync_svo_runtime(t, spec, restart=False)
        self.assertIn("SVO_ADAPTER_RUN_SIGNAL_SECRETS", str(ctx.exception))
        self.assertNotIn("new", str(ctx.exception).replace("SVO_ADAPTER_RUN_SIGNAL_SECRETS", ""))


class EnsembleConfigSyncTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"UNIFIED_PLAN_SECRET": "test-signing-secret"}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.spec = deploy.build_specs("mintproject", "sha-new", "https://portals.tapis.io")["ensemble"]

    def _applied(self):
        return {
            "environment_variables": {
                "ENSEMBLE_MANAGER_CONFIG_JSON": self.spec["environment_variables"]["ENSEMBLE_MANAGER_CONFIG_JSON"],
                "KEEP_ME": "yes",
            }
        }

    def test_sync_preserves_existing_environment_and_image(self):
        running = {
            "image": "ghcr.io/mintproject/ensemble-manager:sha-old",
            "status_container": {"start_time": "old-start"},
            "environment_variables": {"KEEP_ME": "yes"},
        }
        ready = {
            "image": running["image"],
            "status": "AVAILABLE",
            "status_container": {"start_time": "new-start"},
        }
        t = Mock()
        t.pods.get_pod.side_effect = [running, self._applied(), ready]
        with patch.object(deploy.time, "sleep"):
            rc = deploy.sync_ensemble_config(t, self.spec)
        self.assertEqual(rc, 0)
        sent = t.pods.update_pod.call_args.kwargs
        self.assertEqual(sent["image"], running["image"])
        self.assertEqual(sent["environment_variables"]["KEEP_ME"], "yes")
        self.assertEqual(
            json.loads(sent["environment_variables"]["ENSEMBLE_MANAGER_CONFIG_JSON"])["unified_plan_secret"],
            "test-signing-secret",
        )
        t.pods.restart_pod.assert_called_once_with(pod_id=deploy.PODS["ensemble"])

    def test_sync_can_defer_restart(self):
        running = {
            "image": "ghcr.io/mintproject/ensemble-manager:sha-old",
            "status_container": {"start_time": "old-start"},
            "environment_variables": {},
        }
        t = Mock()
        t.pods.get_pod.side_effect = [running, self._applied()]
        rc = deploy.sync_ensemble_config(t, self.spec, restart=False)
        self.assertEqual(rc, 0)
        t.pods.restart_pod.assert_not_called()

    def test_sync_refuses_an_empty_signing_secret(self):
        spec = dict(self.spec)
        spec["environment_variables"] = dict(self.spec["environment_variables"])
        config = json.loads(spec["environment_variables"]["ENSEMBLE_MANAGER_CONFIG_JSON"])
        config["unified_plan_secret"] = ""
        spec["environment_variables"]["ENSEMBLE_MANAGER_CONFIG_JSON"] = json.dumps(config)
        t = Mock()
        with self.assertRaisesRegex(RuntimeError, "UNIFIED_PLAN_SECRET"):
            deploy.sync_ensemble_config(t, spec)
        t.pods.get_pod.assert_not_called()


if __name__ == "__main__":
    unittest.main()
