#!/usr/bin/env python3
"""Store or replace a model-owner secret through PUT /admin/secrets.

Field values come from environment variables (``SECRET_FIELD_<NAME>``) or an
interactive prompt, never argv, so they stay out of shell history and ``ps``.
The adapter pins the secret to the configuration's Tapis app and returns
metadata only.

    SECRET_FIELD_USERNAME=... SECRET_FIELD_PASSWORD=... \\
    SVO_ADAPTER_INTERNAL_SERVICE_SECRET=... \\
    python scripts/seed_model_owner_secret.py --adapter-url https://svo.example \\
        --configuration-id <id> --owner <tapis user> --name earthdata \\
        --field username --field password --acknowledge
"""
from __future__ import annotations

import argparse
import getpass
import os
import sys

import httpx


def _collect_fields(names: list[str]) -> dict[str, str]:
    fields: dict[str, str] = {}
    for name in names:
        value = os.environ.get(f"SECRET_FIELD_{name.upper()}")
        if value is None:
            value = getpass.getpass(f"{name}: ")
        fields[name] = value
    return fields


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--adapter-url", default=os.environ.get("SVO_ADAPTER_URL", "http://localhost:8000"))
    parser.add_argument("--configuration-id", required=True)
    parser.add_argument("--owner", required=True, help="the configuration's owner_username")
    parser.add_argument("--name", required=True, help="secret name declared on the configuration")
    parser.add_argument("--field", action="append", required=True, dest="fields",
                        help="field name to store (repeatable); value from SECRET_FIELD_<NAME> or a prompt")
    parser.add_argument("--acknowledge", action="store_true",
                        help="the owner accepts that every runner's Tapis job record shows these values")
    args = parser.parse_args(argv)

    secret = os.environ.get("SVO_ADAPTER_INTERNAL_SERVICE_SECRET")
    if not secret:
        print("SVO_ADAPTER_INTERNAL_SERVICE_SECRET is required", file=sys.stderr)
        return 2
    resp = httpx.put(
        f"{args.adapter_url.rstrip('/')}/admin/secrets",
        headers={"X-Ensemble-Manager-Secret": secret},
        json={"scope": "model_owner", "owner_username": args.owner,
              "configuration_id": args.configuration_id, "name": args.name,
              "fields": _collect_fields(args.fields), "acknowledged": args.acknowledge},
        timeout=30,
    )
    print(resp.status_code, resp.text)
    return 0 if resp.status_code == 200 else 1


if __name__ == "__main__":
    raise SystemExit(main())
