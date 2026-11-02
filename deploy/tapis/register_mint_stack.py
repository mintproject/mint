#!/usr/bin/env python3
"""Register or update the MINT dev stack on Tapis Pods.

This script is intentionally safe for local inspection: use ``--dry-run`` to
print redacted pod specs without calling Tapis. Live create/update/start/restart
operations are intended to run from the GitHub Actions dev deployment workflow.
"""

from __future__ import annotations

import argparse
from http.client import RemoteDisconnected
import json
import os
import sys
import time
from getpass import getpass
from functools import partial
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
POSTGRES_IMAGE = "ghcr.io/mintproject/postgres-pgvector:develop"
POSTGRES_TEMPLATE = "postgres:16postgis3.5"
LEGACY_POSTGRES_IMAGES = frozenset({"postgis/postgis:16-3.5"})
POSTGRES_VOLUME = "mintdevpostgresdata"
POSTGRES_MOUNT = "/var/lib/postgresql/data"
POSTGRES_DATA = f"{POSTGRES_MOUNT}/pgdata"

PODS = {
    "postgres": "mintdevpostgres",
    "redis": "mintdevredis",
    "graphql": "mintdevgraphql",
    "api": "mintdevapi",
    "ensemble": "mintdevensemble",
    "svo": "mintdevsvo",
    "semantic_search": "mintdevsemanticsearch",
    "ui": "mintdevui",
}

ORDER = ["postgres", "redis", "graphql", "api", "ensemble", "svo", "semantic_search", "ui"]
RESTART_ONLY_PODS = ("graphql", "api", "ensemble", "svo", "semantic_search", "ui")
IMAGE_NAMES = {
    "postgres": "postgres-pgvector",
    "graphql": "graphql-engine",
    "api": "model-catalog-api",
    "ensemble": "ensemble-manager",
    "svo": "svo-adapter",
    "semantic_search": "semantic-search",
    "ui": "ui",
}

# Recreating a pod is destructive. Only stateless application services may use
# this fallback; Redis queue state and PostgreSQL data are protected.
RECREATE_ON_IMAGE_MISMATCH_PODS = frozenset({"graphql", "api", "ensemble", "svo", "semantic_search", "ui"})
POD_IMAGE_VERIFY_TIMEOUT = 120
POD_RESTART_TIMEOUT = 600
HASURA_MIGRATION_TIMEOUT = 600
POD_UPDATE_RETRIES = 3
POD_UPDATE_BACKOFF = 5

SECRET_KEYS = {
    "HASURA_GRAPHQL_ADMIN_SECRET",
    "HASURA_ADMIN_SECRET",
    "HASURA_GRAPHQL_DATABASE_URL",
    "MINTDEV_POSTGRES_PASSWORD",
    "PGPASSWORD",
    "DATABASE_URL",
    "DATA_CATALOG_KEY",
    "ENSEMBLE_MANAGER_CONFIG_JSON",
    "TAPIS_PASSWORD",
    "TAPIS_CLIENT_KEY",
    "MINTDEV_HASURA_JWT_SECRET",
}

HASURA_AUTH_ENV_KEYS = frozenset(
    {
        "HASURA_GRAPHQL_AUTH_HOOK",
        "HASURA_GRAPHQL_AUTH_HOOK_MODE",
        "HASURA_GRAPHQL_JWT_SECRET",
    }
)


def _load_dotenv() -> None:
    try:
        from dotenv import load_dotenv

        load_dotenv(REPO_ROOT / ".env")
    except ImportError:
        pass


def _pods_domain(base_url: str) -> str:
    return base_url.rstrip("/").split("://", 1)[-1]


def pod_urls(base_url: str) -> dict[str, str]:
    domain = _pods_domain(base_url)
    return {name: f"https://{pid}.pods.{domain}" for name, pid in PODS.items()}


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def _postgres_user() -> str:
    return _env("MINTDEV_POSTGRES_USER", "postgres")


def _postgres_db() -> str:
    return _env("MINTDEV_POSTGRES_DB", "postgres")


def _postgres_password() -> str:
    return _env("MINTDEV_POSTGRES_PASSWORD") or _env("PGPASSWORD")


def _admin_secret() -> str:
    return _env("HASURA_GRAPHQL_ADMIN_SECRET") or _env("HASURA_ADMIN_SECRET")


def _hasura_auth_env() -> dict[str, str]:
    """Optional Hasura auth settings for authenticated writes.

    The dev stack can boot with only an anonymous role and admin-secret reads,
    but Model Catalog writes require Hasura to validate user JWTs. Operators can
    provide either a full Hasura JWT secret JSON string or an auth hook URL.
    """
    if _env("MINTDEV_HASURA_AUTH_HOOK"):
        return {
            "HASURA_GRAPHQL_AUTH_HOOK": _env("MINTDEV_HASURA_AUTH_HOOK"),
            "HASURA_GRAPHQL_AUTH_HOOK_MODE": _env("MINTDEV_HASURA_AUTH_HOOK_MODE", "POST"),
        }
    if _env("MINTDEV_HASURA_JWT_SECRET"):
        return {"HASURA_GRAPHQL_JWT_SECRET": _env("MINTDEV_HASURA_JWT_SECRET")}
    return {}


def _preserve_hasura_auth_env(existing: Any, desired: dict[str, Any]) -> dict[str, Any]:
    """Keep live Hasura auth settings when a desired spec omits them."""
    live = _field(existing, "environment_variables", {}) or {}
    if not isinstance(live, dict):
        return desired
    merged = dict(desired)
    for key in HASURA_AUTH_ENV_KEYS:
        if key not in merged and live.get(key):
            merged[key] = live[key]
    return merged


def _database_url(base_url: str) -> str:
    explicit = _env("MINTDEV_HASURA_DATABASE_URL") or _env("HASURA_GRAPHQL_DATABASE_URL")
    if explicit:
        return explicit
    # Tapis's working PostgreSQL route uses the default entry name and is
    # exposed through the Pods TLS/SNI tunnel on :443.
    host = f"{PODS['postgres']}.pods.{_pods_domain(base_url)}"
    return (
        f"postgres://{_postgres_user()}:{_postgres_password()}@"
        f"{host}:443/{_postgres_db()}?sslmode=require"
    )


def _redacted(value: str) -> str:
    if not value:
        return value
    return "***"


def redact_spec(spec: dict[str, Any]) -> dict[str, Any]:
    clone = json.loads(json.dumps(spec))
    env = clone.get("environment_variables")
    if isinstance(env, dict):
        for key in list(env):
            upper = key.upper()
            if upper in SECRET_KEYS or any(part in upper for part in ("SECRET", "PASSWORD", "TOKEN", "KEY")):
                env[key] = _redacted(str(env[key]))
    return clone


def _ensemble_config(urls: dict[str, str]) -> str:
    explicit = _env("ENSEMBLE_MANAGER_CONFIG_JSON") or _env("MINTDEV_ENSEMBLE_MANAGER_CONFIG_JSON")
    if explicit:
        return explicit
    config = {
        "data_catalog_api": _env("DATA_CATALOG_API", "https://ckan.tacc.utexas.edu"),
        "data_catalog_type": _env("DATA_CATALOG_TYPE", "CKAN"),
        "ensemble_manager_api": f"{urls['ensemble']}/v1",
        # Tapis Pods do not provide shared DNS between pod IDs. Use the public
        # pod route so Ensemble Manager can reach the adapter over HTTPS; the
        # browser still only calls Ensemble Manager's unified /plans boundary.
        "svo_adapter_api": _env("SVO_ADAPTER_API_URL", urls["svo"]),
        # Required to sign opaque legacy unified-plan IDs. Never reuse the
        # Hasura admin secret for this purpose.
        "unified_plan_secret": _env("UNIFIED_PLAN_SECRET", ""),
        "tapis_webhook_base_url": urls["ensemble"],
        "graphql": {
            "endpoint": f"{urls['graphql']}/v1/graphql",
            "enable_ssl": True,
            "use_secret": True,
        },
        "execution_engine": "tapis",
        "tapis": {
            "parallelism": int(_env("MINTDEV_TAPIS_PARALLELISM", "2")),
            "basePath": _env("TAPIS_BASE_URL", "https://portals.tapis.io"),
        },
        "auth_server": _env("AUTH_SERVER", "https://portals.tapis.io"),
        "auth_client_id": _env("MINTDEV_AUTH_CLIENT_ID", "mint_dev"),
        "visualization_url": "",
        "ingestion_api": "",
        "auth": {
            "client_id": _env("MINTDEV_AUTH_CLIENT_ID", "mint_dev"),
            "authorization_url": _env(
                "MINTDEV_AUTHORIZATION_URL",
                "https://portals.tapis.io/v3/oauth2/authorize",
            ),
            "public_key": _env("MINTDEV_TAPIS_PUBLIC_KEY", ""),
            "algorithms": ["RS256"],
        },
        "openapi": {
            "servers": [
                {"url": f"{urls['ensemble']}/v1", "description": "MINT dev Tapis Pods"}
            ]
        },
    }
    if _env("DATA_CATALOG_KEY"):
        config["data_catalog_key"] = _env("DATA_CATALOG_KEY")
    return json.dumps(config, separators=(",", ":"))


def parse_image_map(value: str, owner: str) -> dict[str, str]:
    if not value:
        return {}
    try:
        raw = json.loads(value)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"invalid image map: {exc}") from exc
    if not isinstance(raw, dict):
        raise SystemExit("image map must be an object")
    result: dict[str, str] = {}
    for service, entry in raw.items():
        if service not in PODS:
            raise SystemExit(f"image map contains an invalid service: {service}")
        image = entry.get("image_ref") if isinstance(entry, dict) else entry
        expected_prefix = f"ghcr.io/{owner}/{IMAGE_NAMES[service]}:"
        if not isinstance(image, str) or not image.startswith(expected_prefix):
            raise SystemExit(f"image map has an invalid image for {service}")
        result[service] = image
    return result


def build_specs(
    owner: str,
    tag: str,
    base_url: str,
    image_overrides: dict[str, str] | None = None,
) -> dict[str, dict[str, Any]]:
    image_overrides = image_overrides or {}

    def image(service: str) -> str:
        return image_overrides.get(
            service,
            f"ghcr.io/{owner}/{IMAGE_NAMES[service]}:{tag}",
        )

    urls = pod_urls(base_url)
    graphql_endpoint = f"{urls['graphql']}/v1/graphql"
    admin_secret = _admin_secret()
    specs: dict[str, dict[str, Any]] = {
        "postgres": {
            "pod_id": PODS["postgres"],
            "image": image("postgres"),
            "template": POSTGRES_TEMPLATE,
            "description": "MINT dev PostgreSQL database",
            "networking": {"default": {"protocol": "postgres", "port": 5432}},
            "environment_variables": {
                "POSTGRES_USER": _postgres_user(),
                "POSTGRES_PASSWORD": _postgres_password(),
                "POSTGRES_DB": _postgres_db(),
                "PGDATA": POSTGRES_DATA,
            },
            "volume_mounts": {
                POSTGRES_MOUNT: {
                    "type": "tapisvolume",
                    "source_id": POSTGRES_VOLUME,
                    "sub_path": "",
                },
            },
            "time_to_stop_default": -1,
        },
        "redis": {
            "pod_id": PODS["redis"],
            "image": "docker.io/redis:7-alpine",
            "description": "MINT dev Redis queue backend",
            "networking": {"default": {"protocol": "tcp", "port": 6379}},
            "time_to_stop_default": -1,
        },
        "graphql": {
            "pod_id": PODS["graphql"],
            "image": image("graphql"),
            "description": "MINT dev Hasura GraphQL Engine",
            # Keep the Tapis route only. CORS is already configured on the
            # live pod and requires APPROVEDADMIN when submitted to Tapis.
            "networking": {"default": {"protocol": "http", "port": 8080}},
            "resources": {"cpu_request": 250, "cpu_limit": 1000, "mem_request": 512, "mem_limit": 2048},
            "environment_variables": {
                "HASURA_GRAPHQL_DATABASE_URL": _database_url(base_url),
                "HASURA_GRAPHQL_ADMIN_SECRET": admin_secret,
                "HASURA_GRAPHQL_ENABLE_CONSOLE": _env("HASURA_GRAPHQL_ENABLE_CONSOLE", "true"),
                "HASURA_GRAPHQL_DEV_MODE": _env("HASURA_GRAPHQL_DEV_MODE", "false"),
                "HASURA_GRAPHQL_CORS_ORIGINS": _env(
                    "HASURA_GRAPHQL_CORS_ORIGINS",
                    "https://mintdevui.pods.portals.tapis.io",
                ),
                "SVO_SEMANTIC_SEARCH_WEBHOOK_URL": f"{urls['semantic_search']}/events/catalog",
                **_hasura_auth_env(),
            },
            "time_to_stop_default": -1,
        },
        "api": {
            "pod_id": PODS["api"],
            "image": image("api"),
            "description": "MINT dev Model Catalog API",
            "networking": {"default": {"protocol": "http", "port": 3000}},
            "resources": {"cpu_request": 250, "cpu_limit": 1000, "mem_request": 512, "mem_limit": 2048},
            "environment_variables": {
                "PORT": "3000",
                "HASURA_GRAPHQL_URL": graphql_endpoint,
                "HASURA_ADMIN_SECRET": admin_secret,
                "TAPIS_JWKS_URI": _env("TAPIS_JWKS_URI", "https://portals.tapis.io/v3/tenants/portals"),
                "TAPIS_TOKEN_ISSUER": _env("TAPIS_TOKEN_ISSUER", "https://portals.tapis.io/v3/tokens"),
                "REGION_IMPORT_BODY_LIMIT": _env("REGION_IMPORT_BODY_LIMIT", "10485760"),
                "REGION_IMPORT_MAX_REGIONS": _env("REGION_IMPORT_MAX_REGIONS", "500"),
                "REGION_IMPORT_MAX_GEOMETRIES": _env("REGION_IMPORT_MAX_GEOMETRIES", "10"),
                "REGION_IMPORT_MAX_REGION_BYTES": _env("REGION_IMPORT_MAX_REGION_BYTES", "2097152"),
                "LOG_LEVEL": _env("LOG_LEVEL", "info"),
            },
            "time_to_stop_default": -1,
        },
        "ensemble": {
            "pod_id": PODS["ensemble"],
            "image": image("ensemble"),
            "description": "MINT dev Ensemble Manager",
            "networking": {"default": {"protocol": "http", "port": 3000}},
            "resources": {"cpu_request": 500, "cpu_limit": 2000, "mem_request": 1024, "mem_limit": 4096},
            "environment_variables": {
                "REDIS_URL": _env("MINTDEV_REDIS_URL", f"redis://{PODS['redis']}:6379"),
                "HASURA_GRAPHQL_ADMIN_SECRET": admin_secret,
                # The image entrypoint materializes this JSON into the config
                # file the application already knows how to read.
                "ENSEMBLE_MANAGER_CONFIG_JSON": _ensemble_config(urls),
            },
            "time_to_stop_default": -1,
        },
        "svo": {
            "pod_id": PODS["svo"],
            "image": image("svo"),
            "description": "MINT dev SVO Adapter service",
            "networking": {"default": {"protocol": "http", "port": 8090}},
            "resources": {"cpu_request": 250, "cpu_limit": 1000, "mem_request": 512, "mem_limit": 2048},
            "environment_variables": {
                "SVO_ADAPTER_HASURA_GRAPHQL_URL": graphql_endpoint,
                "SVO_ADAPTER_HASURA_ADMIN_SECRET": admin_secret,
                "SVO_ADAPTER_MINT_CATALOG_BASE_URL": urls["api"],
                "SVO_ADAPTER_TAPIS_BASE_URL": _env("TAPIS_BASE_URL", "https://portals.tapis.io"),
                "SVO_ADAPTER_DEMO_MODE": _env("SVO_ADAPTER_DEMO_MODE", "false"),
                "SVO_ADAPTER_MINT_SYNC_ON_STARTUP": _env("SVO_ADAPTER_MINT_SYNC_ON_STARTUP", "false"),
                "SVO_ADAPTER_CKAN_SYNC_ON_STARTUP": _env("SVO_ADAPTER_CKAN_SYNC_ON_STARTUP", "false"),
                "SVO_ADAPTER_CKAN_URL": _env("SVO_ADAPTER_CKAN_URL", "https://ckan.tacc.utexas.edu"),
                "SVO_ADAPTER_STAC_API_URL": _env("SVO_ADAPTER_STAC_API_URL", "https://stacapi.pods.portals.tapis.io/api/v1"),
                "SVO_ADAPTER_GEO_ACTOR_ID": _env("SVO_ADAPTER_GEO_ACTOR_ID", ""),
                # Run signals: the model task posts liveness back to this URL with
                # a per-run HMAC token (svo-adapter-service/app/run_state.py).
                # Empty secrets leave signalling and the staleness sweep off.
                "SVO_ADAPTER_PUBLIC_URL": _env("SVO_ADAPTER_PUBLIC_URL", urls["svo"]),
                "SVO_ADAPTER_RUN_SIGNAL_SECRETS": _env("SVO_ADAPTER_RUN_SIGNAL_SECRETS", ""),
            },
            "time_to_stop_default": -1,
        },
        "semantic_search": {
            "pod_id": PODS["semantic_search"],
            "image": image("semantic_search"),
            "description": "MINT dev semantic search service",
            "networking": {"default": {"protocol": "http", "port": 8091}},
            "resources": {"cpu_request": 500, "cpu_limit": 2000, "mem_request": 1024, "mem_limit": 4096},
            "environment_variables": {
                "DATABASE_URL": _database_url(base_url),
                "SVO_EMBEDDING_REFRESH_SECONDS": _env("SVO_EMBEDDING_REFRESH_SECONDS", "60"),
                "SVO_CORS_ORIGINS": urls["ui"],
            },
            "time_to_stop_default": -1,
        },
        "ui": {
            "pod_id": PODS["ui"],
            "image": image("ui"),
            "description": "MINT dev React UI",
            "networking": {
                "default": {
                    "protocol": "http",
                    "port": 80,
                    "tapis_auth": True,
                    "tapis_auth_return_path": "/",
                    "tapis_auth_allowed_users": [
                        user.strip()
                        for user in _env("MINTDEV_UI_AUTH_ALLOWED_USERS", "wmobley,mosorio").split(",")
                        if user.strip()
                    ],
                }
            },
            "resources": {"cpu_request": 250, "cpu_limit": 1000, "mem_request": 256, "mem_limit": 512},
            "environment_variables": {
                "HASURA_ENDPOINT": graphql_endpoint,
                "AUTH_PROVIDER": _env("AUTH_PROVIDER", "tapis"),
                "AUTH_SERVER": _env("AUTH_SERVER", "https://portals.tapis.io"),
                "AUTH_CLIENT_ID": _env("MINTDEV_AUTH_CLIENT_ID", "mint_dev"),
                "AUTH_CALLBACK_ORIGIN": urls["ui"],
                # Ensemble Manager mounts its API under /v1. Keep the route
                # prefix in the UI base URL so requests reach the API router.
                "ENSEMBLE_MANAGER_API": f"{urls['ensemble']}/v1",
                # The Tapis app picker calls the model-catalog API from the
                # user's browser, so it needs the public pod URL and API
                # version prefix rather than the in-cluster default.
                "MODEL_CATALOG_API": f"{urls['api']}/v2.0.0",
                "SEMANTIC_SEARCH_API": urls["semantic_search"],
                "DATA_CATALOG_API": _env("DATA_CATALOG_API", "https://ckan.tacc.utexas.edu"),
                "DATA_CATALOG_BROWSE_URL": _env("DATA_CATALOG_BROWSE_URL", "https://ckan.tacc.utexas.edu"),
                "EXECUTION_ENGINE": _env("EXECUTION_ENGINE", "tapis"),
                "WELCOME_MESSAGE": _env("WELCOME_MESSAGE", "MINT dev"),
            },
            "time_to_stop_default": -1,
        },
    }
    specs["_urls"] = urls
    return specs


def parse_pods(value: str) -> list[str]:
    if value == "all":
        return ORDER
    selected = [part.strip() for part in value.split(",") if part.strip()]
    invalid = [part for part in selected if part not in PODS]
    if invalid:
        raise SystemExit(f"Unknown pod selector(s): {', '.join(invalid)}")
    return [name for name in ORDER if name in selected]


def resolve_restart_pods(selected: list[str], *, restart: bool, restart_pods: str | None) -> list[str]:
    """Resolve the pods to restart independently from the pods to update."""
    if restart and restart_pods is not None:
        raise SystemExit("--restart and --restart-pods cannot be combined")
    if restart_pods is None:
        return selected if restart else []
    requested = parse_pods(restart_pods)
    return [name for name in requested if name in selected]


def _field(value: Any, key: str, default: Any = None) -> Any:
    return value.get(key, default) if isinstance(value, dict) else getattr(value, key, default)


def _plain_data(value: Any) -> Any:
    """Convert SDK response objects into values accepted by JSON request bodies."""
    try:
        return json.loads(json.dumps(value, default=vars))
    except (TypeError, ValueError) as exc:
        raise RuntimeError("Tapis returned non-JSON networking data; refusing to recreate pod") from exc


def _get_or_missing(operation: Any, **kwargs: Any) -> Any:
    """Only a confirmed HTTP 404 permits creation; other errors must abort."""
    try:
        return operation(**kwargs)
    except Exception as exc:
        if getattr(getattr(exc, "response", None), "status_code", None) == 404:
            return None
        raise RuntimeError("Tapis lookup failed; refusing to assume the resource is absent") from None


class PodImageMismatchError(RuntimeError):
    """The Tapis pod definition did not converge to the requested image."""


class TransientPodLookupError(RuntimeError):
    """A pod lookup failed because the transport may be retried safely."""


def _is_transient_lookup_error(exc: Exception) -> bool:
    if isinstance(exc, (ConnectionError, TimeoutError, RemoteDisconnected, OSError)):
        return True
    if exc.__class__.__name__ in {
        "ConnectTimeout",
        "ReadTimeout",
        "ConnectionError",
    }:
        return True
    # Tapipy wraps transport exceptions in BaseTapyException without an HTTP
    # response. Keep this narrow so auth and service HTTP errors still fail fast.
    return getattr(exc, "response", None) is None and "unable to make request" in str(exc).lower()


def _is_transient_update_error(exc: Exception) -> bool:
    """Return whether an idempotent pod update may be retried safely."""
    status_code = getattr(getattr(exc, "response", None), "status_code", None)
    if status_code in {500, 502, 503, 504}:
        return True
    return _is_transient_lookup_error(exc)


def _pod_lookup_for_verification(t: Any, pod_id: str) -> Any:
    """Read a pod for verification without treating errors as absence."""
    try:
        return t.pods.get_pod(pod_id=pod_id)
    except Exception as exc:
        if _is_transient_lookup_error(exc):
            raise TransientPodLookupError from None
        status_code = getattr(getattr(exc, "response", None), "status_code", None)
        if status_code is not None:
            raise RuntimeError(f"Tapis pod verification failed for {pod_id} (HTTP {status_code}); deployment stopped") from None
        raise RuntimeError(f"Tapis pod verification failed for {pod_id}; deployment stopped") from None


def wait_for_pod_image(t: Any, pod_id: str, expected_image: str, *, timeout: float = POD_IMAGE_VERIFY_TIMEOUT) -> Any:
    """Wait until Tapis reports the exact requested image in the pod definition."""
    deadline = time.monotonic() + timeout
    observed = None
    while time.monotonic() < deadline:
        try:
            pod = _pod_lookup_for_verification(t, pod_id)
        except TransientPodLookupError:
            time.sleep(min(5, max(0, deadline - time.monotonic())))
            continue
        observed = _field(pod, "image")
        if observed == expected_image:
            return pod
        time.sleep(min(5, max(0, deadline - time.monotonic())))
    raise PodImageMismatchError(
        f"[{pod_id}] image did not converge; expected {expected_image!r}, observed {observed!r}"
    )


def wait_for_pod_absent(t: Any, pod_id: str, *, timeout: float = POD_IMAGE_VERIFY_TIMEOUT) -> None:
    """Wait for a deleted pod to be confirmed absent before recreating it."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            t.pods.get_pod(pod_id=pod_id)
        except Exception as exc:
            if getattr(getattr(exc, "response", None), "status_code", None) == 404:
                return
            if _is_transient_lookup_error(exc):
                time.sleep(min(5, max(0, deadline - time.monotonic())))
                continue
            raise RuntimeError("Tapis pod deletion verification failed; deployment stopped") from None
        time.sleep(min(5, max(0, deadline - time.monotonic())))
    raise RuntimeError(f"[{pod_id}] deletion did not complete; refusing to create a duplicate pod")


def wait_for_pod_restart(
    t: Any,
    pod_id: str,
    expected_image: str,
    previous_start: Any = None,
    *,
    timeout: float = POD_RESTART_TIMEOUT,
) -> Any:
    """Confirm an application pod is available on a new container instance."""
    deadline = time.monotonic() + timeout
    observed_status = None
    observed_image = None
    observed_start = None
    while time.monotonic() < deadline:
        try:
            pod = _pod_lookup_for_verification(t, pod_id)
        except TransientPodLookupError:
            time.sleep(min(5, max(0, deadline - time.monotonic())))
            continue
        observed_status = _field(pod, "status")
        observed_image = _field(pod, "image")
        observed_start = _field(_field(pod, "status_container", {}), "start_time")
        if (
            observed_status == "AVAILABLE"
            and observed_image == expected_image
            and (not previous_start or (observed_start and observed_start != previous_start))
        ):
            return pod
        time.sleep(min(5, max(0, deadline - time.monotonic())))
    raise RuntimeError(
        f"[{pod_id}] did not become AVAILABLE on the requested image after restart "
        f"(last status={observed_status!r}, image={observed_image!r}, "
        f"start_time={observed_start!r}, previous_start={previous_start!r})"
    )


def run_hasura_migrations(t: Any, *, expected_image: str | None = None) -> None:
    """Apply bundled Hasura migrations and verify the dev catalog in-pod."""
    if expected_image:
        pod = _pod_lookup_for_verification(t, PODS["graphql"])
        previous_start = _field(_field(pod, "status_container", {}), "start_time")
        if not previous_start:
            raise RuntimeError("Cannot verify Hasura restart; previous container start time is missing")
        t.pods.restart_pod(pod_id=PODS["graphql"])
        print(f"  [{PODS['graphql']}] restart requested for migration stage")
        wait_for_pod_restart(
            t,
            PODS["graphql"],
            expected_image,
            previous_start=previous_start,
            timeout=HASURA_MIGRATION_TIMEOUT,
        )
        wait_for_hasura_ready(t, PODS["graphql"], timeout=HASURA_MIGRATION_TIMEOUT)
    else:
        wait_for_pod_available(t, PODS["graphql"], timeout=HASURA_MIGRATION_TIMEOUT)

    command = r'''set -eu
    cd /hasura
    hasura migrate apply --skip-update-check
    hasura metadata apply --skip-update-check
    hasura metadata reload --skip-update-check
    status="$(hasura migrate status --skip-update-check --no-color 2>&1)"
    printf '%s\n' "$status"
    if printf '%s\n' "$status" | grep -Eq '(^|[[:space:]])(Not Present|Pending)([[:space:]]|$)'; then
      printf '%s\n' 'Hasura migration status contains unapplied or pending migrations.' >&2
      exit 1
    fi
    inconsistencies="$(hasura metadata inconsistency list --skip-update-check --no-color 2>&1)"
    printf '%s\n' "$inconsistencies"
    case "$inconsistencies" in
      *'metadata is consistent'*) ;;
      *)
        printf '%s\n' 'Hasura metadata inconsistency check did not report a consistent catalog.' >&2
        exit 1
        ;;
    esac
    response="$(curl -fsS http://127.0.0.1:8080/v1/graphql \
      -H "X-Hasura-Admin-Secret: $HASURA_GRAPHQL_ADMIN_SECRET" \
      -H "Content-Type: application/json" \
      --data '{"query":"{ modelcatalog_standard_variable(where:{label:{_in:[\"groundwater_model_modflow6_simulation_archive\",\"groundwater_model_modflow2000_simulation_archive\",\"groundwater_model_modflow2005_simulation_archive\",\"groundwater_model_modflow96_simulation_archive\"]}}){ label }}"}')"
    case "$response" in
      *'"errors"'*) printf '%s\n' "$response" >&2; exit 1 ;;
    esac
    for label in \
      groundwater_model_modflow6_simulation_archive \
      groundwater_model_modflow2000_simulation_archive \
      groundwater_model_modflow2005_simulation_archive \
      groundwater_model_modflow96_simulation_archive; do
      printf '%s' "$response" | grep -Fq "\"label\":\"$label\"" || {
        printf 'missing expected catalog label: %s\n' "$label" >&2
        exit 1
      }
    done
    printf '%s\n' 'Hasura migration and catalog verification succeeded.'
    '''
    result = t.pods.exec_pod_commands(
        pod_id=PODS["graphql"],
        commands=[["sh", "-c", command]],
        command_timeout=HASURA_MIGRATION_TIMEOUT,
        total_timeout=HASURA_MIGRATION_TIMEOUT + 30,
    )
    results = _field(result, "execution_results", [])
    if not results:
        raise RuntimeError("Hasura migration command returned no execution result")
    execution = results[0]
    stdout = _field(execution, "stdout", "")
    stderr = _field(execution, "stderr", "")
    if stdout:
        print(stdout.rstrip())
    if _field(execution, "exit_code") != 0:
        if stderr:
            print(stderr.rstrip(), file=sys.stderr)
        raise RuntimeError(
            f"Hasura migration/verification failed with exit code {_field(execution, 'exit_code')}"
        )


def wait_for_hasura_ready(t: Any, pod_id: str, *, timeout: float = HASURA_MIGRATION_TIMEOUT) -> Any:
    """Wait for Hasura's HTTP server, not just the Tapis pod status."""
    deadline = time.monotonic() + timeout
    last_error = "connection refused"
    while time.monotonic() < deadline:
        try:
            result = t.pods.exec_pod_commands(
                pod_id=pod_id,
                commands=[["sh", "-c", "curl -fsS http://127.0.0.1:8080/v1/version >/dev/null"]],
                command_timeout=20,
                total_timeout=25,
            )
        except Exception as exc:  # noqa: BLE001
            if not _is_transient_lookup_error(exc):
                raise
            last_error = str(exc)
        else:
            results = _field(result, "execution_results", [])
            execution = results[0] if results else {}
            if _field(execution, "exit_code") == 0:
                return result
            last_error = _field(execution, "stderr", "") or "Hasura endpoint is not ready"
        time.sleep(min(5, max(0, deadline - time.monotonic())))
    raise RuntimeError(f"[{pod_id}] Hasura endpoint did not become ready: {last_error}")


def wait_for_pod_available(t: Any, pod_id: str, *, timeout: float = POD_RESTART_TIMEOUT) -> Any:
    """Wait until a pod is available when no image transition is being checked."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            pod = _pod_lookup_for_verification(t, pod_id)
        except TransientPodLookupError:
            time.sleep(min(5, max(0, deadline - time.monotonic())))
            continue
        if _field(pod, "status") == "AVAILABLE":
            return pod
        time.sleep(min(5, max(0, deadline - time.monotonic())))
    raise RuntimeError(f"[{pod_id}] did not become AVAILABLE")


def check_postgres_storage(pod: Any, *, recreate: bool, expected_image: str | None = None) -> None:
    if pod is None:
        return
    if recreate:
        raise RuntimeError("PostgreSQL recreation is disabled; use the documented preservation/recovery procedure")
    mounts = _field(pod, "volume_mounts", {})
    if not isinstance(mounts, dict) and not hasattr(mounts, "__dict__"):
        raise RuntimeError("Cannot verify PostgreSQL volume mounts; deployment stopped")
    mount = _field(mounts, POSTGRES_MOUNT)
    mount_paths = mounts.keys() if isinstance(mounts, dict) else vars(mounts).keys()
    env = _field(pod, "environment_variables", {})
    observed_image = _field(pod, "image")
    allowed_image_prefix = (expected_image or POSTGRES_IMAGE).rsplit(":", 1)[0] + ":"
    image_is_allowed = observed_image in LEGACY_POSTGRES_IMAGES or (
        isinstance(observed_image, str) and observed_image.startswith(allowed_image_prefix)
    )
    if (
        _field(mount, "type") != "tapisvolume"
        or _field(mount, "source_id") != POSTGRES_VOLUME
        or _field(mount, "sub_path") != ""
        or _field(mount, "read_only", False) is not False
        or any(path.startswith(POSTGRES_MOUNT + "/") for path in mount_paths)
        or _field(env, "PGDATA") != POSTGRES_DATA
        or not image_is_allowed
    ):
        raise RuntimeError("PostgreSQL image/storage differs; preserve data and perform a deliberate migration before deploying")


def ensure_postgres_volume(t: Any, *, allow_create: bool = False, timeout: float = 600) -> None:
    volume = _get_or_missing(t.pods.get_volume, volume_id=POSTGRES_VOLUME)
    if volume is None:
        if not allow_create:
            raise RuntimeError("Existing PostgreSQL volume is missing; refusing to replace it with empty storage")
        t.pods.create_volume(volume_id=POSTGRES_VOLUME, description="Persistent MINT dev PostgreSQL data", size_limit=10240)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        volume = t.pods.get_volume(volume_id=POSTGRES_VOLUME)
        if _field(volume, "status") == "AVAILABLE":
            return
        time.sleep(5)
    raise RuntimeError("PostgreSQL volume did not become AVAILABLE; deployment stopped")


def wait_for_postgres(
    t: Any,
    previous_start: Any = None,
    *,
    restarted: bool = False,
    expected_image: str | None = None,
    timeout: float = 600,
) -> None:
    if restarted and not previous_start:
        raise RuntimeError("Cannot verify PostgreSQL restart without its previous container start time")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            pod = _pod_lookup_for_verification(t, PODS["postgres"])
        except TransientPodLookupError:
            time.sleep(min(5, max(0, deadline - time.monotonic())))
            continue
        started = _field(_field(pod, "status_container", {}), "start_time")
        if (
            _field(pod, "status") == "AVAILABLE"
            and (not expected_image or _field(pod, "image") == expected_image)
            and (not restarted or (started and started != previous_start))
        ):
            result = t.pods.exec_pod_commands(
                pod_id=PODS["postgres"],
                commands=[["sh", "-c", 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 -Atc "SELECT 1"']],
                command_timeout=10, total_timeout=15,
            )
            results = _field(result, "execution_results", [])
            if results and _field(results[0], "exit_code") == 0 and _field(results[0], "stdout", "").strip() == "1":
                return
        time.sleep(5)
    raise RuntimeError("PostgreSQL did not become SQL-ready; dependent deployment stopped")


def validate_live_requirements(selected: list[str]) -> None:
    missing = []
    if any(p in selected for p in ("postgres", "graphql", "semantic_search")) and not _postgres_password():
        missing.append("MINTDEV_POSTGRES_PASSWORD (or PGPASSWORD)")
    if any(p in selected for p in ("graphql", "api", "ensemble", "svo")) and not _admin_secret():
        missing.append("HASURA_GRAPHQL_ADMIN_SECRET (or HASURA_ADMIN_SECRET)")
    if "ensemble" in selected and not _env("UNIFIED_PLAN_SECRET"):
        missing.append("UNIFIED_PLAN_SECRET")
    if "graphql" in selected and not _hasura_auth_env():
        missing.append("MINTDEV_HASURA_AUTH_HOOK or MINTDEV_HASURA_JWT_SECRET")
    if missing:
        print("Missing required live-deploy secret(s): " + ", ".join(missing), file=sys.stderr)
        raise SystemExit(2)


def set_pod_owners(t: Any, pod_id: str, owners: list[str]) -> list[str]:
    """Add owners to a pod with APPROVEDADMIN permissions. Return failures."""
    failed = []
    for owner in owners:
        try:
            t.pods.set_pod_permission(pod_id=pod_id, user=owner, level="APPROVEDADMIN")
            print(f"  [{pod_id}] added owner: {owner}")
        except Exception as exc:  # noqa: BLE001
            failed.append(owner)
            print(f"  [{pod_id}] failed to add owner {owner}: {exc}", file=sys.stderr)
    return failed


def grant_pod_owners(
    t: Any,
    selected: list[str],
    owners: list[str],
    *,
    require_all: bool = False,
) -> int:
    """Grant APPROVEDADMIN on every selected pod; never touch a pod definition.

    A later deploy step can fail and skip the pods it owns, so this runs first
    and independently. One rejected grant must not hide the others, so the
    result is a summary. Strict mode additionally requires every selected pod
    to exist and accept every requested grant.
    """
    granted: list[str] = []
    failed: list[str] = []
    absent: list[str] = []
    for key in selected:
        pid = PODS[key]
        if _get_or_missing(t.pods.get_pod, pod_id=pid) is None:
            absent.append(pid)
            print(f"  [{pid}] not found; skipped")
            continue
        rejected = set_pod_owners(t, pid, owners)
        failed.extend(f"{pid}:{owner}" for owner in rejected)
        granted.extend(f"{pid}:{owner}" for owner in owners if owner not in rejected)
    print(
        f"\nOwner grants: {len(granted)} succeeded, {len(failed)} failed, "
        f"{len(absent)} pod(s) absent"
    )
    if require_all and absent:
        failed.extend(f"{pid}:absent" for pid in absent)
        print("Required pods absent: " + ", ".join(absent), file=sys.stderr)
    if failed:
        print("Failed grants: " + ", ".join(failed), file=sys.stderr)
    if not granted and failed:
        print("No grant succeeded; treating this as a deploy failure", file=sys.stderr)
        return 1
    if require_all and failed:
        return 1
    return 0


def _start_pod_if_needed(t: Any, pod_id: str) -> None:
    try:
        status = _field(t.pods.get_pod(pod_id=pod_id), "status")
    except Exception:
        raise RuntimeError(f"[{pod_id}] could not verify pod status before start") from None
    if status and status != "STOPPED":
        print(f"  [{pod_id}] already {status}; not starting")
        return
    try:
        t.pods.start_pod(pod_id=pod_id)
    except Exception:
        raise RuntimeError(f"[{pod_id}] start request failed") from None
    print(f"  [{pod_id}] start requested")


def _recreate_pod(
    t: Any,
    spec: dict[str, Any],
    *,
    start: bool,
    owners: list[str] | None = None,
    networking: Any = None,
    environment_variables: dict[str, Any] | None = None,
) -> None:
    pid = spec["pod_id"]
    pod_name = next((name for name, pod_id in PODS.items() if pod_id == pid), None)
    if pod_name not in RECREATE_ON_IMAGE_MISMATCH_PODS:
        raise RuntimeError(f"[{pid}] image mismatch; automatic recreation is disabled for this protected pod")
    if pid == PODS["postgres"]:
        raise RuntimeError("PostgreSQL recreation is disabled; image mismatch requires deliberate recovery")
    recreate_spec = dict(spec)
    # Tapis may remove the old pod while processing UpdatePod before reporting
    # an image mismatch. Recreate with the networking definition that was
    # already live, instead of resubmitting the desired CORS/auth payload.
    # The latter requires APPROVEDADMIN and is unrelated to an image update.
    if networking is None:
        recreate_spec.pop("networking", None)
    else:
        recreate_spec["networking"] = _plain_data(networking)
    if environment_variables is not None:
        recreate_spec["environment_variables"] = environment_variables
    # Validate the request before deleting the old pod so a malformed SDK
    # response cannot leave a stateless service unavailable.
    print(f"  [{pid}] deleting before image-mismatch recovery…")
    t.pods.delete_pod(pod_id=pid)
    wait_for_pod_absent(t, pid)
    print(f"  [{pid}] creating with requested image…")
    t.pods.create_pod(**recreate_spec)
    if owners:
        set_pod_owners(t, pid, owners)
    if start:
        _start_pod_if_needed(t, pid)
    wait_for_pod_image(t, pid, spec["image"])
    if start:
        wait_for_pod_restart(t, pid, spec["image"])


def _replace_postgres_pod(
    t: Any,
    existing: Any,
    spec: dict[str, Any],
    *,
    start: bool,
    owners: list[str] | None = None,
) -> None:
    """Replace the known legacy PostgreSQL pod without touching its volume."""
    pid = spec["pod_id"]
    if pid != PODS["postgres"]:
        raise RuntimeError("Protected PostgreSQL replacement called for a non-PostgreSQL pod")

    # Tapis exposes deletion as a lifecycle operation and may leave a running
    # pod in SHUTTING_DOWN longer than the verification window. The protected
    # storage checks above make the volume boundary explicit; delete the pod
    # directly, then wait for confirmed absence before recreating it.
    print(f"  [{pid}] deleting pod definition; persistent volume is retained…")
    t.pods.delete_pod(pod_id=pid)
    wait_for_pod_absent(t, pid)
    print(f"  [{pid}] creating with the pgvector image and existing volume…")
    t.pods.create_pod(**spec)
    if owners:
        set_pod_owners(t, pid, owners)
    if start:
        _start_pod_if_needed(t, pid)
    wait_for_pod_image(t, pid, spec["image"])


def upsert_pod(
    t: Any,
    spec: dict[str, Any],
    *,
    recreate: bool,
    recreate_on_image_mismatch: bool = False,
    start: bool,
    restart: bool,
    owners: list[str] | None = None,
    migrate_postgres_image: bool = False,
) -> None:
    pid = spec["pod_id"]
    existing = _get_or_missing(t.pods.get_pod, pod_id=pid)
    exists = existing is not None
    if pid == PODS["postgres"]:
        check_postgres_storage(existing, recreate=recreate, expected_image=spec["image"])
        if (
            existing is not None
            and _field(existing, "image") != spec["image"]
            and not migrate_postgres_image
        ):
            raise RuntimeError(
                "PostgreSQL image differs from the requested tag; rerun with --migrate-postgres-image "
                "for the protected volume-preserving transition"
            )

    if exists and recreate:
        print(f"  [{pid}] deleting existing pod (--recreate)…")
        t.pods.delete_pod(pod_id=pid)
        wait_for_pod_absent(t, pid)
        exists = False

    if exists:
        if pid == PODS["postgres"] and _field(existing, "image") != spec["image"]:
            _replace_postgres_pod(t, existing, spec, start=start, owners=owners)
            return
        previous_start = _field(_field(existing, "status_container", {}), "start_time")
        print(f"  [{pid}] updating…")
        update = dict(spec)
        update["environment_variables"] = _preserve_hasura_auth_env(
            existing, spec.get("environment_variables", {})
        )
        # Preserve the live networking definition on ordinary image/runtime
        # updates. Tapis networking may contain privileged CORS or auth
        # settings; those should not be resubmitted just because an image is
        # changing. Explicit networking changes use their dedicated paths,
        # such as --sync-ui-auth.
        update.pop("networking", None)
        if pid == PODS["postgres"]:
            # Tapis UpdatePod does not accept an image field. A known legacy
            # image is handled by _replace_postgres_pod above; this path is
            # only for an already-converged PostgreSQL definition.
            update.pop("image")
        t.pods.update_pod(**update)
        try:
            wait_for_pod_image(t, pid, spec["image"])
        except PodImageMismatchError:
            if not recreate_on_image_mismatch:
                raise
            _recreate_pod(
                t,
                spec,
                start=start,
                owners=owners,
                networking=_field(existing, "networking", None),
                environment_variables=update["environment_variables"],
            )
            return
        if restart:
            t.pods.restart_pod(pod_id=pid)
            print(f"  [{pid}] restart requested")
            if pid != PODS["postgres"]:
                wait_for_pod_restart(t, pid, spec["image"], previous_start)
        # Set owners on existing pods too
        if owners:
            set_pod_owners(t, pid, owners)
        return

    print(f"  [{pid}] creating…")
    t.pods.create_pod(**spec)
    # Set owners immediately after creation
    if owners:
        set_pod_owners(t, pid, owners)
    if start:
        _start_pod_if_needed(t, pid)
    wait_for_pod_image(t, pid, spec["image"])


def sync_ui_auth(t: Any, spec: dict[str, Any], *, restart: bool = True) -> int:
    """Push the UI auth allowlist and optionally restart the pod.

    tapis_auth_allowed_users lives in the pod definition, so only an update
    applies it. The UI must restart before the running proxy can use the new
    networking definition. This mode changes nothing else.
    """
    pid = spec["pod_id"]
    existing = _get_or_missing(t.pods.get_pod, pod_id=pid)
    if existing is None:
        raise RuntimeError(f"[{pid}] was not found; auth-sync mode will not create it")
    current_image = _field(existing, "image")
    if not current_image:
        raise RuntimeError(f"[{pid}] reports no image; refusing to rewrite the definition")
    previous_start = _field(_field(existing, "status_container", {}), "start_time")
    if restart and not previous_start:
        raise RuntimeError(f"[{pid}] reports no container start time; refusing to restart")

    allowed = spec["networking"]["default"]["tapis_auth_allowed_users"]
    update = dict(spec)
    update["image"] = current_image
    print(f"  [{pid}] keeping the running image {current_image}")
    print(f"  [{pid}] allowed users: {', '.join(allowed)}")
    t.pods.update_pod(**update)

    applied = _field(
        _field(_field(_get_or_missing(t.pods.get_pod, pod_id=pid), "networking", {}), "default", {}),
        "tapis_auth_allowed_users",
    )
    if applied is None:
        raise RuntimeError(f"[{pid}] reported no allowed-user list after the update")
    missing = [user for user in allowed if user not in applied]
    if missing:
        raise RuntimeError(
            f"[{pid}] allowlist did not converge; missing: " + ", ".join(missing)
        )
    print(f"  [{pid}] allowlist applied: {', '.join(applied)}")
    if not restart:
        return 0
    t.pods.restart_pod(pod_id=pid)
    print(f"  [{pid}] restart requested")
    wait_for_pod_restart(t, pid, current_image, previous_start)
    return 0


def sync_svo_runtime(t: Any, spec: dict[str, Any], *, restart: bool = True) -> int:
    """Apply the managed SVO runtime values without rewriting the pod spec."""
    pid = spec["pod_id"]
    spec_env = spec.get("environment_variables", {})
    configured_actor = _field(spec_env, "SVO_ADAPTER_GEO_ACTOR_ID", "")
    if not configured_actor:
        raise RuntimeError("SVO_ADAPTER_GEO_ACTOR_ID is not configured; refusing to clear the SVO runtime value")
    # Run-signal wiring is managed the same way, so a secret rotation — or an
    # empty value, which turns the feature off — reaches the live pod without
    # a full re-registration. Values are never printed.
    managed = {"SVO_ADAPTER_GEO_ACTOR_ID": configured_actor}
    for key in ("SVO_ADAPTER_PUBLIC_URL", "SVO_ADAPTER_RUN_SIGNAL_SECRETS"):
        if key in spec_env:
            managed[key] = _field(spec_env, key, "")

    existing = _get_or_missing(t.pods.get_pod, pod_id=pid)
    if existing is None:
        raise RuntimeError(f"[{pid}] was not found; runtime sync will not create it")
    current_image = _field(existing, "image")
    if not current_image:
        raise RuntimeError(f"[{pid}] reports no image; refusing to rewrite the runtime configuration")
    previous_start = _field(_field(existing, "status_container", {}), "start_time")
    if restart and not previous_start:
        raise RuntimeError(f"[{pid}] reports no container start time; refusing to restart")

    environment = _plain_data(_field(existing, "environment_variables", {}))
    if not isinstance(environment, dict):
        raise RuntimeError(f"[{pid}] returned invalid environment data; refusing to rewrite the runtime configuration")
    environment.update(managed)
    print(f"  [{pid}] applying SVO runtime configuration ({', '.join(sorted(managed))})")
    t.pods.update_pod(
        pod_id=pid,
        image=current_image,
        environment_variables=environment,
    )

    applied = _get_or_missing(t.pods.get_pod, pod_id=pid)
    applied_environment = _plain_data(_field(applied or {}, "environment_variables", {}))
    for key, value in managed.items():
        if _field(applied_environment, key, "") != value:
            raise RuntimeError(f"[{pid}] SVO runtime configuration did not converge for {key}")
    if not restart:
        return 0

    t.pods.restart_pod(pod_id=pid)
    print(f"  [{pid}] restart requested")
    wait_for_pod_restart(t, pid, current_image, previous_start)
    return 0


def sync_ensemble_config(t: Any, spec: dict[str, Any], *, restart: bool = True) -> int:
    """Apply the managed Ensemble configuration without changing its image."""
    pid = spec["pod_id"]
    desired_json = _field(spec.get("environment_variables", {}), "ENSEMBLE_MANAGER_CONFIG_JSON", "")
    try:
        desired_config = json.loads(desired_json)
    except (TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError("Ensemble configuration is not valid JSON") from exc
    if not isinstance(desired_config, dict) or not desired_config.get("unified_plan_secret"):
        raise RuntimeError("UNIFIED_PLAN_SECRET is required for Ensemble configuration sync")

    existing = _get_or_missing(t.pods.get_pod, pod_id=pid)
    if existing is None:
        raise RuntimeError(f"[{pid}] was not found; config-sync mode will not create it")
    current_image = _field(existing, "image")
    if not current_image:
        raise RuntimeError(f"[{pid}] reports no image; refusing to rewrite the runtime configuration")
    previous_start = _field(_field(existing, "status_container", {}), "start_time")
    if restart and not previous_start:
        raise RuntimeError(f"[{pid}] reports no container start time; refusing to restart")

    environment = _plain_data(_field(existing, "environment_variables", {}))
    if not isinstance(environment, dict):
        raise RuntimeError(f"[{pid}] returned invalid environment data; refusing to rewrite the runtime configuration")
    environment["ENSEMBLE_MANAGER_CONFIG_JSON"] = desired_json
    print(f"  [{pid}] applying Ensemble configuration (signing secret present)")
    t.pods.update_pod(
        pod_id=pid,
        image=current_image,
        environment_variables=environment,
    )

    applied = _get_or_missing(t.pods.get_pod, pod_id=pid)
    applied_environment = _plain_data(_field(applied or {}, "environment_variables", {}))
    applied_json = _field(applied_environment, "ENSEMBLE_MANAGER_CONFIG_JSON", "")
    try:
        applied_config = json.loads(applied_json)
    except (TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"[{pid}] reported invalid Ensemble configuration after update") from exc
    if not isinstance(applied_config, dict) or applied_config.get("unified_plan_secret") != desired_config.get("unified_plan_secret"):
        raise RuntimeError(f"[{pid}] Ensemble signing configuration did not converge")
    if not restart:
        return 0

    t.pods.restart_pod(pod_id=pid)
    print(f"  [{pid}] restart requested")
    wait_for_pod_restart(t, pid, current_image, previous_start)
    return 0


def update_pod_images(t: Any, selected: list[str], expected_images: dict[str, str]) -> None:
    """Update only the image field for selected application pods."""
    invalid = [key for key in selected if key not in RESTART_ONLY_PODS]
    if invalid:
        raise RuntimeError(
            "Image-only mode is limited to: " + ", ".join(RESTART_ONLY_PODS)
        )
    missing = [key for key in selected if key not in expected_images]
    if missing:
        raise RuntimeError("Image-only mode requires an exact image for: " + ", ".join(missing))
    for key in selected:
        pid = PODS[key]
        image = expected_images[key]
        for attempt in range(1, POD_UPDATE_RETRIES + 1):
            print(f"  [{pid}] updating image to {image} (attempt {attempt}/{POD_UPDATE_RETRIES})…", flush=True)
            try:
                t.pods.update_pod(pod_id=pid, image=image)
            except Exception as exc:  # noqa: BLE001
                status_code = getattr(getattr(exc, "response", None), "status_code", None)
                if not _is_transient_update_error(exc) or attempt == POD_UPDATE_RETRIES:
                    suffix = f" (HTTP {status_code})" if status_code else ""
                    raise RuntimeError(f"[{pid}] image update failed for {image}{suffix}") from None
                print(
                    f"  [{pid}] transient image update failure; retrying in {POD_UPDATE_BACKOFF}s…",
                    flush=True,
                )
                time.sleep(POD_UPDATE_BACKOFF)
                continue
            # Tapis accepts the pod-definition update before the new image is
            # visible to subsequent lifecycle operations. Confirm the
            # read-after-write state before a caller can restart the pod;
            # otherwise the restart may launch the previous image and the
            # migration stage will wait forever for an impossible state.
            wait_for_pod_image(t, pid, image)
            break


def restart_existing_pods(t: Any, selected: list[str]) -> None:
    """Dispatch restart requests for selected application pods without polling."""
    invalid = [key for key in selected if key not in RESTART_ONLY_PODS]
    if invalid:
        raise RuntimeError(
            "Restart-only mode is limited to: " + ", ".join(RESTART_ONLY_PODS)
        )
    for key in selected:
        pid = PODS[key]
        print(f"  [{pid}] restart requested")
        t.pods.restart_pod(pod_id=pid)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Register/update the MINT dev Tapis Pods stack.")
    parser.add_argument("--base-url", default=_env("TAPIS_BASE_URL", "https://portals.tapis.io"))
    parser.add_argument("--owner", default=_env("GHCR_OWNER", "mintproject"))
    parser.add_argument("--image-tag", default=_env("IMAGE_TAG", "latest"))
    parser.add_argument(
        "--image-map",
        default="",
        help="JSON object of service image references from the deploy manifest",
    )
    parser.add_argument("--pods", default="all", help="all or comma-separated: postgres,redis,graphql,api,ensemble,svo,semantic_search,ui")
    parser.add_argument("--owners", default="wmobley,mosorio", help="comma-separated list of pod owners (APPROVEDADMIN permission)")
    parser.add_argument("--recreate", action="store_true")
    parser.add_argument(
        "--recreate-on-image-mismatch",
        action="store_true",
        help="recreate only stateless application pods if the requested image does not converge",
    )
    parser.add_argument(
        "--migrate-postgres-image",
        action="store_true",
        help="replace the known legacy PostgreSQL pod while retaining its Tapis volume",
    )
    parser.add_argument("--restart", action="store_true")
    parser.add_argument(
        "--restart-pods",
        help="comma-separated pods to restart after updating; limits restarts without changing the update set",
    )
    parser.add_argument(
        "--restart-existing-pods",
        help="restart these application pods without polling or changing their definitions",
    )
    parser.add_argument(
        "--update-images-only",
        action="store_true",
        help="update only exact application image references; do not change networking or lifecycle",
    )
    parser.add_argument(
        "--set-owners-only",
        action="store_true",
        help="only grant APPROVEDADMIN on the selected existing pods; never create, update or restart a pod",
    )
    parser.add_argument(
        "--migrate-hasura",
        action="store_true",
        help="apply bundled Hasura migrations/metadata and verify the dev catalog",
    )
    parser.add_argument(
        "--require-all-owner-grants",
        action="store_true",
        help="fail if any selected pod is absent or rejects an owner grant",
    )
    parser.add_argument(
        "--sync-ui-auth",
        action="store_true",
        help="push the UI auth allowlist and restart the pod with its current image",
    )
    parser.add_argument(
        "--sync-svo-runtime",
        action="store_true",
        help="push the managed SVO runtime configuration and restart the pod with its current image",
    )
    parser.add_argument(
        "--sync-ensemble-config",
        action="store_true",
        help="push the managed Ensemble configuration and restart the pod with its current image",
    )
    parser.add_argument(
        "--defer-ui-restart",
        action="store_true",
        help="apply the UI auth allowlist without restarting; a later batch handles it",
    )
    parser.add_argument(
        "--defer-svo-restart",
        action="store_true",
        help="apply the SVO runtime configuration without restarting; a later batch handles it",
    )
    parser.add_argument(
        "--defer-ensemble-restart",
        action="store_true",
        help="apply the Ensemble configuration without restarting; a later batch handles it",
    )
    parser.add_argument("--no-start", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if args.restart_existing_pods is not None and (
        args.update_images_only
        or args.set_owners_only
        or args.restart
        or args.restart_pods is not None
        or args.recreate
        or args.recreate_on_image_mismatch
        or args.no_start
        or args.dry_run
        or args.sync_svo_runtime
        or args.sync_ensemble_config
    ):
        parser.error("--restart-existing-pods cannot be combined with image or lifecycle options")
    if args.update_images_only and (
        args.restart_existing_pods is not None
        or args.set_owners_only
        or args.sync_ui_auth
        or args.restart
        or args.restart_pods is not None
        or args.recreate
        or args.recreate_on_image_mismatch
        or args.migrate_postgres_image
        or args.no_start
        or args.dry_run
        or args.sync_svo_runtime
        or args.sync_ensemble_config
    ):
        parser.error("--update-images-only cannot be combined with lifecycle or dry-run options")
    if args.require_all_owner_grants and not args.set_owners_only:
        parser.error("--require-all-owner-grants requires --set-owners-only")
    if args.migrate_hasura and (
        args.restart_existing_pods is not None
        or args.update_images_only
        or args.set_owners_only
        or args.sync_ui_auth
        or args.restart
        or args.restart_pods is not None
        or args.recreate
        or args.recreate_on_image_mismatch
        or args.migrate_postgres_image
        or args.no_start
        or args.dry_run
        or args.sync_svo_runtime
        or args.sync_ensemble_config
    ):
        parser.error("--migrate-hasura cannot be combined with pod lifecycle options")
    if args.set_owners_only and (
        args.restart_existing_pods is not None
        or args.restart
        or args.restart_pods is not None
        or args.recreate
        or args.recreate_on_image_mismatch
        or args.migrate_postgres_image
        or args.no_start
        or args.dry_run
        or args.sync_svo_runtime
        or args.sync_ensemble_config
    ):
        parser.error("--set-owners-only cannot be combined with lifecycle or dry-run options")
    if args.sync_ui_auth and (
        args.set_owners_only
        or args.restart_existing_pods is not None
        or args.restart
        or args.restart_pods is not None
        or args.recreate
        or args.recreate_on_image_mismatch
        or args.migrate_postgres_image
        or args.no_start
        or args.dry_run
        or args.sync_svo_runtime
        or args.sync_ensemble_config
    ):
        parser.error("--sync-ui-auth cannot be combined with lifecycle or dry-run options")
    if args.defer_ui_restart and not args.sync_ui_auth:
        parser.error("--defer-ui-restart requires --sync-ui-auth")
    if args.defer_svo_restart and not args.sync_svo_runtime:
        parser.error("--defer-svo-restart requires --sync-svo-runtime")
    if args.defer_ensemble_restart and not args.sync_ensemble_config:
        parser.error("--defer-ensemble-restart requires --sync-ensemble-config")
    if sum(bool(flag) for flag in (args.sync_ui_auth, args.sync_svo_runtime, args.sync_ensemble_config)) > 1:
        parser.error("runtime sync modes cannot be combined")
    if args.sync_svo_runtime and args.pods not in {"all", "svo"} and "svo" not in args.pods.split(","):
        parser.error("--sync-svo-runtime requires --pods svo")
    if args.sync_ensemble_config and args.pods not in {"all", "ensemble"} and "ensemble" not in args.pods.split(","):
        parser.error("--sync-ensemble-config requires --pods ensemble")
    if args.no_start and (args.restart or args.restart_pods is not None):
        parser.error("--no-start cannot be combined with --restart or --restart-pods")
    if args.recreate and args.recreate_on_image_mismatch:
        parser.error("--recreate and --recreate-on-image-mismatch cannot be combined")

    _load_dotenv()
    if args.restart_existing_pods is not None:
        selected = parse_pods(args.restart_existing_pods)
        invalid = [key for key in selected if key not in RESTART_ONLY_PODS]
        if invalid or not selected:
            parser.error(
                "--restart-existing-pods accepts only: " + ", ".join(RESTART_ONLY_PODS)
            )
    else:
        selected = parse_pods(args.pods)
    if args.update_images_only and any(key not in RESTART_ONLY_PODS for key in selected):
        parser.error("--update-images-only accepts only: " + ", ".join(RESTART_ONLY_PODS))
    if args.sync_svo_runtime and selected != ["svo"]:
        parser.error("--sync-svo-runtime requires --pods svo")
    if args.sync_ensemble_config and selected != ["ensemble"]:
        parser.error("--sync-ensemble-config requires --pods ensemble")
    if args.migrate_hasura and selected != ["graphql"]:
        parser.error("--migrate-hasura requires --pods graphql")
    if args.migrate_postgres_image and "postgres" not in selected:
        parser.error("--migrate-postgres-image requires postgres in --pods")
    if args.migrate_postgres_image and args.recreate:
        parser.error("--migrate-postgres-image cannot be combined with --recreate")
    restart_selected = resolve_restart_pods(
        selected,
        restart=args.restart,
        restart_pods=args.restart_pods,
    )
    image_overrides = parse_image_map(args.image_map, args.owner)
    specs = build_specs(args.owner, args.image_tag, args.base_url, image_overrides)
    urls = specs.pop("_urls")

    if args.dry_run:
        if "postgres" in selected:
            print(f"Persistent volume: {POSTGRES_VOLUME} (create if absent; retain on pod restart)")
        for key in selected:
            print(f"--- {PODS[key]} ({key}) ---")
            print(json.dumps(redact_spec(specs[key]), indent=2, sort_keys=True))
        print("\nDev URLs:")
        for key in ORDER:
            print(f"  {key:8} {urls[key]}")
        return 0

    if (
        args.restart_existing_pods is None
        and not args.update_images_only
        and not args.set_owners_only
        and not args.sync_ui_auth
        and not args.sync_svo_runtime
        and not args.sync_ensemble_config
        and not args.migrate_hasura
    ):
        validate_live_requirements(selected)

    try:
        from tapipy.tapis import Tapis
    except ImportError:
        raise SystemExit("tapipy is not installed (pip install tapipy).")

    username = _env("TAPIS_USERNAME") or _env("TAPIS_ID") or input("Tapis username: ")
    password = _env("TAPIS_PASSWORD") or getpass("Tapis password: ")
    t = Tapis(base_url=args.base_url.rstrip("/"), username=username, password=password)
    t.requests_session.send = partial(t.requests_session.send, timeout=30)
    t.get_tokens()

    if args.update_images_only:
        update_pod_images(t, selected, image_overrides)
        print("\nMINT dev application image tags updated:")
        for key in selected:
            print(f"  {key:8} {PODS[key]}")
        return 0

    if args.migrate_hasura:
        run_hasura_migrations(t, expected_image=specs["graphql"]["image"])
        print("\nHasura migrations applied and verified.")
        return 0

    if args.restart_existing_pods is not None:
        restart_existing_pods(t, selected)
        print("\nMINT dev application pods restarted:")
        for key in selected:
            print(f"  {key:8} {PODS[key]}")
        return 0

    # Parse owners list
    owners = [o.strip() for o in args.owners.split(",") if o.strip()] if args.owners else []

    if args.set_owners_only:
        if not owners:
            parser.error("--set-owners-only requires a non-empty --owners list")
        return grant_pod_owners(
            t,
            selected,
            owners,
            require_all=args.require_all_owner_grants,
        )

    if args.sync_ui_auth:
        return sync_ui_auth(t, specs["ui"], restart=not args.defer_ui_restart)

    if args.sync_svo_runtime:
        return sync_svo_runtime(t, specs["svo"], restart=not args.defer_svo_restart)

    if args.sync_ensemble_config:
        return sync_ensemble_config(t, specs["ensemble"], restart=not args.defer_ensemble_restart)

    previous_start = None
    postgres_restarted = False
    if "postgres" in selected:
        postgres = _get_or_missing(t.pods.get_pod, pod_id=PODS["postgres"])
        check_postgres_storage(postgres, recreate=args.recreate, expected_image=specs["postgres"]["image"])
        postgres_image_migration = (
            args.migrate_postgres_image
            and postgres is not None
            and _field(postgres, "image") in LEGACY_POSTGRES_IMAGES
        )
        if postgres is not None and "postgres" in restart_selected and not postgres_image_migration:
            previous_start = _field(_field(postgres, "status_container", {}), "start_time")
            if not previous_start:
                raise RuntimeError("Cannot verify PostgreSQL restart; previous container start time is missing")
            postgres_restarted = True
        ensure_postgres_volume(t, allow_create=postgres is None)

    for key in selected:
        upsert_pod(
            t,
            specs[key],
            recreate=args.recreate,
            recreate_on_image_mismatch=args.recreate_on_image_mismatch,
            start=not args.no_start,
            restart=key in restart_selected,
            owners=owners,
            migrate_postgres_image=args.migrate_postgres_image,
        )
        if key == "postgres" and not args.no_start:
            wait_for_postgres(
                t,
                previous_start,
                restarted=postgres_restarted,
                expected_image=specs[key]["image"],
            )

    print("\nMINT dev stack updated:")
    for key in ORDER:
        print(f"  {key:8} {urls[key]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
