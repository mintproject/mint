#!/usr/bin/env python3
"""Re-encrypt every adapter.secret row under the first key of the ring.

Dry-run by default: decrypts and verifies every row, changes nothing. Put the
new key FIRST in SVO_ADAPTER_SECRETS_ENCRYPTION_KEYS (keep the old one after
it), run with --apply, then drop the old key once the counts show no failures.
Needs SVO_ADAPTER_HASURA_GRAPHQL_URL and SVO_ADAPTER_HASURA_ADMIN_SECRET.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import secrets as secrets_store  # noqa: E402
from app.hasura import get_client  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--apply", action="store_true", help="write the re-encrypted rows")
    args = parser.parse_args(argv)
    if not secrets_store.secrets_configured():
        print("SVO_ADAPTER_SECRETS_ENCRYPTION_KEYS is empty", file=sys.stderr)
        return 2
    counts = asyncio.run(secrets_store.rotate_all(get_client(None), apply=args.apply))
    mode = "applied" if args.apply else "dry-run"
    print(f"{mode}: rows={counts['rows']} rotated={counts['rotated']} failed={counts['failed']}")
    return 1 if counts["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
