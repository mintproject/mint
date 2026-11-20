#!/usr/bin/env bash
# Launch the SVO Adapter with the NTGAM forecast tab wired up:
#   - demo mode (the pipeline tab's in-memory store)
#   - CKAN token (read at runtime from the local token file; NOT stored in the repo)
#   - the SUBSIDE conda env python (has numpy/pandas + the screening model;
#     subside/.venv intentionally does NOT carry these).
# The NTGAM forecast is served at /forecast/ntgam/* (see /docs).
set -euo pipefail
cd "$(dirname "$0")"

export SVO_ADAPTER_DEMO_MODE=1
export SVO_ADAPTER_CKAN_TOKEN="$(cat "${CKAN_TOKEN_FILE:-$HOME/.claude/tmp/ckan_token.txt}")"
export SVO_ADAPTER_SUBSIDE_PYTHON="${SVO_ADAPTER_SUBSIDE_PYTHON:-$HOME/opt/miniconda3/envs/subside-h2i-opera/bin/python}"
# Optional overrides (defaults match local dev): SVO_ADAPTER_CKAN_URL, SVO_ADAPTER_MINT_HASURA_URL,
# SVO_ADAPTER_MINT_ADMIN_SECRET, SVO_ADAPTER_FORECAST_CONFIG_ID.
_export_dotenv_if_unset() {
  local key="$1"
  local value=""
  if [ -z "${!key:-}" ] && [ -f .env ]; then
    value="$(sed -n "s/^${key}=//p" .env | tail -n 1)"
    [ -n "${value}" ] && export "${key}=${value}"
  fi
}
_export_dotenv_if_unset SVO_ADAPTER_CKAN_URL
_export_dotenv_if_unset SVO_ADAPTER_NTGAM_WATERLEVELS_DATASET

# Start the server in the background, then seed the registry-driven forecast: the demo
# store is in-memory, so each launch re-registers the data objects + ETL transforms +
# run-spec (so /plans/model-run can resolve the forecast). Then wait on the server.
.venv/bin/uvicorn app.main:app --port 8090 "$@" &
SERVER=$!
for _ in $(seq 1 30); do curl -sf http://localhost:8090/health >/dev/null 2>&1 && break; sleep 1; done
CKAN_TOKEN="$SVO_ADAPTER_CKAN_TOKEN" ADAPTER_URL="http://localhost:8090" \
  CKAN_URL="${SVO_ADAPTER_CKAN_URL:-http://localhost:5001}" \
  NTGAM_HEAD_DATASET="${SVO_ADAPTER_NTGAM_WATERLEVELS_DATASET:-ntgam-water-levels}" \
  .venv/bin/python ../../ntgam/register_forecast_planner.py || echo "(forecast registry seed failed; continuing)"
wait "$SERVER"
