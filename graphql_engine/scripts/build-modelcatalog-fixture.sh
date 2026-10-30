#!/usr/bin/env bash
set -euo pipefail

# build-modelcatalog-fixture.sh
#
# Build the demo model catalog fixture from a production dump.
#
# The fixture is the catalog data that `docker compose up` loads on a laptop. It
# keeps the whole controlled vocabulary and a subset of the catalog. See
# https://github.com/mintproject/mint/issues/189 for the selection rule and
# https://github.com/mintproject/mint/issues/190 for the file format.
#
# The script starts a throwaway Postgres container, restores the dump, deletes
# the rows the fixture does not want, writes the fixture and removes the
# container. It never opens a session on production. Get the dump with
# ./scripts/backup-hasura.sh; TACC sign-in needs MFA, so a person must fetch it.
#
# Usage:
#   graphql_engine/scripts/build-modelcatalog-fixture.sh --dump <path> [options]
#
# Options:
#   --dump PATH    The production dump. Plain SQL, `.sql` or `.sql.gz`. Required.
#   --out PATH     Output file (default: graphql_engine/fixtures/modelcatalog.sql).
#   --image IMAGE  Postgres image (default: postgis/postgis:10-3.1). It must
#                  match the major version of the dump.
#   --keep         Leave the container running. For debugging.
#
# Exit codes: 0 ok, 1 error, 2 bad args.

IMAGE="postgis/postgis:10-3.1"
CONTAINER="mint-fixture-build"
DB="fixture"
DUMP=""
OUT=""
KEEP=0

repo_root() { git rev-parse --show-toplevel; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dump)  DUMP="$2"; shift 2 ;;
    --out)   OUT="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --keep)  KEEP=1; shift ;;
    -h|--help) sed -n '3,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$DUMP" ]] || { echo "--dump is required" >&2; exit 2; }
[[ -f "$DUMP" ]] || { echo "no such dump: $DUMP" >&2; exit 2; }
[[ -n "$OUT" ]] || OUT="$(repo_root)/graphql_engine/fixtures/modelcatalog.sql"

say() { echo "==> $*" >&2; }

# sha256sum on Linux, shasum on macOS.
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

psqlc() {
  docker exec -i -e PGPASSWORD=postgres "$CONTAINER" \
    psql -h 127.0.0.1 -U postgres -d "$DB" -At -q "$@"
}

cleanup() {
  if [[ "$KEEP" -eq 1 ]]; then
    say "container $CONTAINER left running (--keep)"
  else
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ---- 1. the throwaway container ---------------------------------------------
# postgis/postgis publishes amd64 only, so pin the platform. Docker does not
# fall back, and the pull fails on arm64 without it.
say "starting $CONTAINER on $IMAGE"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" --platform linux/amd64 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB="$DB" "$IMAGE" >/dev/null

# pg_isready with no host uses the unix socket. It reports ready while initdb
# still refuses TCP. Ask over TCP, the way the restore connects.
ready=0
for _ in $(seq 1 120); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres -d "$DB" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
[[ "$ready" -eq 1 ]] || { echo "postgres did not become ready" >&2; exit 1; }

# ---- 2. restore --------------------------------------------------------------
# ON_ERROR_STOP stays off. The dump recreates the postgis schemas, which the
# image already has, and those errors are harmless.
say "restoring $(basename "$DUMP")"
if [[ "$DUMP" == *.gz ]]; then cat_dump() { gunzip -c "$DUMP"; }; else cat_dump() { cat "$DUMP"; }; fi
cat_dump | docker exec -i -e PGPASSWORD=postgres "$CONTAINER" \
  psql -h 127.0.0.1 -U postgres -d "$DB" -q -v ON_ERROR_STOP=0 >/dev/null

tables_found="$(psqlc -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'modelcatalog\\_%';")"
[[ "$tables_found" -ge 40 ]] || {
  echo "the dump holds $tables_found modelcatalog_ tables; it predates DYNAMO v2.0" >&2
  exit 1
}
say "restored $tables_found modelcatalog_ tables"

# ---- 3. prune ----------------------------------------------------------------
# The execution and thread tables hold ON DELETE SET NULL foreign keys into the
# catalog, and execution_data_binding.model_io_id is NOT NULL, so the cascade
# aborts. The fixture carries no execution history, so drop those constraints.
# The modelcatalog-to-modelcatalog cascades stay, and they do the closure.
say "dropping foreign keys held from outside the catalog"
psqlc -c "DO \$\$ DECLARE s text; BEGIN
  FOR s IN SELECT format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.relname, c.conname)
             FROM pg_constraint c
             JOIN pg_class r ON r.oid = c.conrelid
             JOIN pg_class f ON f.oid = c.confrelid
            WHERE c.contype = 'f'
              AND f.relname LIKE 'modelcatalog\\_%'
              AND r.relname NOT LIKE 'modelcatalog\\_%'
  LOOP EXECUTE s; END LOOP; END \$\$;" >/dev/null

# Delete what the fixture does not want and let ON DELETE CASCADE close it.
# Configurations go first: the self-foreign key takes the Setups of an orphan.
# Keep a configuration when it holds a version, or when it hangs off one that
# does. A Setup has a NULL version by design and inherits it through the parent.
say "pruning the catalog"
psqlc -c "
BEGIN;
DELETE FROM public.modelcatalog_configuration
 WHERE software_version_id IS NULL AND model_configuration_id IS NULL;

DELETE FROM public.modelcatalog_software_version
 WHERE id NOT IN (SELECT software_version_id FROM public.modelcatalog_configuration
                   WHERE software_version_id IS NOT NULL);

DELETE FROM public.modelcatalog_software
 WHERE id NOT IN (SELECT software_id FROM public.modelcatalog_software_version
                   WHERE software_id IS NOT NULL);

DELETE FROM public.modelcatalog_dataset_specification
 WHERE id NOT IN (SELECT input_id  FROM public.modelcatalog_configuration_input  WHERE input_id  IS NOT NULL
                  UNION
                  SELECT output_id FROM public.modelcatalog_configuration_output WHERE output_id IS NOT NULL);

DELETE FROM public.modelcatalog_parameter
 WHERE id NOT IN (SELECT parameter_id FROM public.modelcatalog_configuration_parameter
                   WHERE parameter_id IS NOT NULL);
COMMIT;" >/dev/null

# ---- 4. emit -----------------------------------------------------------------
# One INSERT for each row. Every column goes through ::text, which every type in
# the catalog round-trips: the tables hold text, integer, boolean and text[] only.
psqlc -c "
CREATE OR REPLACE FUNCTION public.fixture_rows(tbl text) RETURNS SETOF text AS \$\$
DECLARE cols text; vals text; ord text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position),
         string_agg('quote_nullable(t.' || quote_ident(column_name) || '::text)', ', ' ORDER BY ordinal_position)
    INTO cols, vals
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = tbl;

  -- ORDER BY id keeps a regenerated file readable. A junction table has no id,
  -- so order it by every column, which is its primary key and then some.
  SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = tbl AND column_name = 'id')
              THEN 't.id'
              ELSE (SELECT string_agg('t.' || quote_ident(column_name), ', ' ORDER BY ordinal_position)
                      FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = tbl)
         END
    INTO ord;

  RETURN QUERY EXECUTE format(
    'SELECT ''INSERT INTO public.%I ('' || %L || '') VALUES ('' || concat_ws('', '', %s) || '') ON CONFLICT DO NOTHING;'' FROM public.%I t ORDER BY %s',
    tbl, cols, vals, tbl, ord);
END \$\$ LANGUAGE plpgsql;" >/dev/null

# mapfile is bash 4. macOS ships bash 3.2, so read the list the portable way.
TABLES=""
while IFS= read -r t; do TABLES="$TABLES $t"; done < <(
  psqlc -c "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'modelcatalog\\_%' ORDER BY table_name;")

say "writing $OUT"
mkdir -p "$(dirname "$OUT")"
tmp="$(mktemp)"

{
  echo "-- MINT model catalog fixture."
  echo "--"
  echo "-- Demo catalog data for the docker compose stack. Generated. Do not edit."
  echo "-- Rebuild it with graphql_engine/scripts/build-modelcatalog-fixture.sh."
  echo "--"
  echo "-- Source dump: $(basename "$DUMP")"
  echo "-- sha256:      $(sha256 "$DUMP")"
  echo "--"
  echo "-- The whole vocabulary is here. The catalog is a subset. See issue 189."
  echo "-- The load runs on every compose start, so every INSERT is idempotent."
  echo ""
  echo "BEGIN;"
  echo ""
  echo "-- Defer the foreign key checks, so the table order below does not matter."
  echo "-- Primary key and unique constraints still apply, which ON CONFLICT needs."
  echo "SET session_replication_role = replica;"
  echo ""

  for t in $TABLES; do
    n="$(psqlc -c "SELECT count(*) FROM public.$t;")"
    echo "-- $t ($n rows)"
    if [[ "$n" -gt 0 ]]; then
      psqlc -c "SELECT public.fixture_rows('$t');"
    fi
    echo ""
  done

  echo "SET session_replication_role = DEFAULT;"
  echo ""
  echo "COMMIT;"
} > "$tmp"

mv "$tmp" "$OUT"
rows="$(grep -c '^INSERT INTO' "$OUT" || true)"
say "wrote $rows rows, $(du -h "$OUT" | cut -f1)"
