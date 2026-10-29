#!/usr/bin/env python3
"""Classify monorepo paths for selective MINT development deployment."""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterable


SERVICE_IMAGES = {
    "graphql": "graphql-engine",
    "postgres": "postgres-pgvector",
    "api": "model-catalog-api",
    "ensemble": "ensemble-manager",
    "ui": "ui",
    "svo": "svo-adapter",
    "semantic_search": "semantic-search",
}
SERVICE_ORDER = ("postgres", "graphql", "api", "ensemble", "svo", "semantic_search", "ui")
# PostgreSQL is persistent state, not part of a normal full application deploy.
# It is selected only when its own image/context changes.
DEPLOY_ALL_SERVICES = tuple(service for service in SERVICE_ORDER if service != "postgres")

SERVICE_PREFIXES = (
    ("graphql", "graphql_engine/"),
    ("postgres", "docker/postgres-pgvector/"),
    ("api", "model-catalog-api/"),
    ("ensemble", "mint-ensemble-manager/"),
    ("svo", "svo-adapter-service/"),
    ("semantic_search", "semantic-search-service/"),
    ("ui", "ui-react/"),
)

SCHEMA_PREFIXES = ("graphql_engine/migrations/", "graphql_engine/metadata/")
# CI changes affect how a future rollout runs and must not themselves trigger a
# service rollout. Pod-spec changes are handled separately because they must be
# applied to the running service definition.
CONTROL_ONLY_PREFIXES = (".github/", "deploy/")
DEPLOYMENT_CONFIG_SERVICES = {
    "deploy/tapis/register_mint_stack.py": ("ensemble",),
}
SHARED_FILES = {
    "compose.yaml",
    "docker-compose.yml",
    "Makefile",
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "pyproject.toml",
    "requirements.txt",
    "uv.lock",
}
IGNORED_PREFIXES = (".wolf/", "docs/", ".git/")
IGNORED_FILES = {"LICENSE", "README.md", ".gitignore", ".gitattributes"}


def develop_image_map(services: Iterable[str]) -> dict[str, dict[str, str]]:
    """Build the mutable runtime image map used by the MINT dev stack."""
    return {
        service: {
            "image": f"ghcr.io/mintproject/{SERVICE_IMAGES[service]}",
            "tag": "develop",
            "image_ref": f"ghcr.io/mintproject/{SERVICE_IMAGES[service]}:develop",
        }
        for service in services
    }


def _clean_path(path: str) -> str:
    return path.strip().removeprefix("./")


def _is_ignored(path: str) -> bool:
    return (
        not path
        or path in IGNORED_FILES
        or path.startswith(IGNORED_PREFIXES)
        or path.endswith(".md")
    )


def _service_for(path: str) -> str | None:
    for service, prefix in SERVICE_PREFIXES:
        if path.startswith(prefix):
            return service
    return None


def make_plan(paths: Iterable[str], source_sha: str | None = None) -> dict[str, object]:
    build: set[str] = set()
    schema_changed = False
    deploy_all = False

    for raw_path in paths:
        path = _clean_path(raw_path)
        # Published guide Markdown is part of the UI image, not internal docs.
        if path.startswith("ui-react/docs/docs/"):
            build.add("ui")
            continue
        if _is_ignored(path):
            continue
        config_services = DEPLOYMENT_CONFIG_SERVICES.get(path)
        if config_services:
            build.update(config_services)
            continue
        if path.startswith(CONTROL_ONLY_PREFIXES) or path == "deploy/mint_change_plan.py":
            continue
        if path in SHARED_FILES:
            deploy_all = True
            continue
        if path.startswith(SCHEMA_PREFIXES) or path == "graphql_engine/config.yaml":
            schema_changed = True
            build.add("graphql")
            continue
        service = _service_for(path)
        if service:
            build.add(service)
        else:
            deploy_all = True

    if deploy_all:
        build = set(DEPLOY_ALL_SERVICES)
        restart = set(DEPLOY_ALL_SERVICES)
    else:
        restart = set(build)
        if "postgres" in build:
            restart.update(("graphql", "api", "ensemble", "svo", "semantic_search"))
        if schema_changed:
            restart.update(("graphql", "semantic_search"))

    short_sha = source_sha[:7] if source_sha else ""
    images = {
        service: {
            "image": f"ghcr.io/mintproject/{SERVICE_IMAGES[service]}",
            "tag": f"sha-{short_sha}" if short_sha else "",
            "image_ref": f"ghcr.io/mintproject/{SERVICE_IMAGES[service]}:sha-{short_sha}" if short_sha else "",
        }
        for service in sorted(build, key=SERVICE_ORDER.index)
    }
    return {
        "schema_version": 1,
        "source_sha": source_sha or "",
        "short_sha": short_sha,
        "build_services": sorted(build, key=SERVICE_ORDER.index),
        "restart_services": sorted(restart, key=SERVICE_ORDER.index),
        "schema_changed": schema_changed,
        "deploy_all": deploy_all,
        "images": images,
        "has_changes": bool(build or restart),
        "matrix": {
            "include": [
                {
                    "service": service,
                    "image": SERVICE_IMAGES[service],
                    "context": {
                        "graphql": "graphql_engine",
                        "postgres": "docker/postgres-pgvector",
                        "api": "model-catalog-api",
                        "ensemble": "mint-ensemble-manager",
                        "svo": "svo-adapter-service",
                        "semantic_search": "semantic-search-service",
                        "ui": "ui-react",
                    }[service],
                    "dockerfile": {
                        "graphql": "graphql_engine/Dockerfile",
                        "postgres": "docker/postgres-pgvector/Dockerfile",
                        "api": "model-catalog-api/Dockerfile",
                        "ensemble": "mint-ensemble-manager/Dockerfile",
                        "svo": "svo-adapter-service/Dockerfile",
                        "semantic_search": "semantic-search-service/Dockerfile",
                        "ui": "ui-react/Dockerfile",
                    }[service],
                }
                for service in sorted(build, key=SERVICE_ORDER.index)
            ]
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-sha", default="")
    args = parser.parse_args()
    print(json.dumps(make_plan(sys.stdin, args.source_sha), separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
