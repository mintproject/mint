#!/usr/bin/env bash
# Pin one MINT release to a values file by writing global.imageTag.
# See SKILL.md.
set -euo pipefail

SOURCE_REPO="mintproject/mint"

# chart component key|GHCR repository
SERVICES=(
  "hasura|ghcr.io/mintproject/graphql-engine"
  "model_catalog_api|ghcr.io/mintproject/model-catalog-api"
  "ui_react|ghcr.io/mintproject/mint-ui-react"
  "ensemble_manager|ghcr.io/mintproject/ensemble-manager"
)

usage() {
  cat <<EOF
Usage: $(basename "$0") --values PATH [options]

Required:
  --values PATH        Values file to edit.

Tag selection (pick one; default is the current branch of this working tree):
  --branch NAME        Resolve the head SHA of NAME in ${SOURCE_REPO}.
  --tag TAG            Use TAG verbatim. For a release version, e.g. v9.1.0.

Options:
  --base NAME          Pull request base. Default: main
  --pr                 Commit, push and open a pull request.
  --skip-image-check   Write the tag before the images exist.
  --dry-run            Print the plan and exit.
  -h, --help
EOF
}

VALUES=""
BRANCH=""
TAG=""
BASE="main"
OPEN_PR=0
SKIP_IMAGE_CHECK=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --values)            VALUES="$2"; shift 2 ;;
    --branch)            BRANCH="$2"; shift 2 ;;
    --tag)               TAG="$2"; shift 2 ;;
    --base)              BASE="$2"; shift 2 ;;
    --pr)                OPEN_PR=1; shift ;;
    --skip-image-check)  SKIP_IMAGE_CHECK=1; shift ;;
    --dry-run)           DRY_RUN=1; shift ;;
    -h|--help)           usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$VALUES" ]] || { echo "ERROR: --values is required" >&2; usage >&2; exit 2; }
[[ -f "$VALUES" ]] || { echo "ERROR: no such file: $VALUES" >&2; exit 1; }
[[ -n "$BRANCH" && -n "$TAG" ]] && { echo "ERROR: --branch and --tag are exclusive" >&2; exit 2; }

command -v yq   >/dev/null || { echo "yq not found (mikefarah v4)" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl not found" >&2; exit 1; }

# ---------------------------------------------------------------- resolve tag
if [[ -z "$TAG" ]]; then
  [[ -n "$BRANCH" ]] || BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  TAG="$(git ls-remote "https://github.com/${SOURCE_REPO}.git" "refs/heads/${BRANCH}" | cut -f1)"
  [[ -n "$TAG" ]] || { echo "ERROR: ${SOURCE_REPO} has no branch ${BRANCH}" >&2; exit 1; }
  echo "resolved ${SOURCE_REPO}@${BRANCH} -> ${TAG}"
else
  echo "using tag ${TAG} verbatim"
fi

# --------------------------------------------------- locate the components root
# Helm reads globals only from the root `global` key, even when the chart is a
# subchart. Components move with the subchart; globals do not.
if [[ "$(yq '.MINT.components // "null"' "$VALUES")" != "null" ]]; then
  COMPONENTS=".MINT.components"
elif [[ "$(yq '.components // "null"' "$VALUES")" != "null" ]]; then
  COMPONENTS=".components"
else
  echo "ERROR: ${VALUES} has neither .components nor .MINT.components" >&2
  exit 1
fi
echo "components root: ${COMPONENTS}"

# ------------------------------------------------------- check the repositories
FAIL=0
for entry in "${SERVICES[@]}"; do
  key="${entry%%|*}"
  want="${entry##*|}"
  have="$(yq "${COMPONENTS}.${key}.image.repository // \"\"" "$VALUES")"
  [[ -z "$have" ]] && continue
  if [[ "$have" != "$want" ]]; then
    echo "ERROR: ${COMPONENTS}.${key}.image.repository is ${have}, not ${want}" >&2
    echo "       A tag from ${SOURCE_REPO} does not exist there." >&2
    FAIL=1
  fi
done
[[ $FAIL -eq 0 ]] || { echo "Fix the repositories in the chart first." >&2; exit 1; }

# ------------------------------------------------------------- check the images
if [[ $SKIP_IMAGE_CHECK -eq 0 ]]; then
  for entry in "${SERVICES[@]}"; do
    repo="${entry##*|}"
    path="${repo#ghcr.io/}"
    # A package that does not exist yet refuses the token. Report that as a
    # missing image, rather than aborting on curl's exit status.
    token="$(curl -sS "https://ghcr.io/token?scope=repository:${path}:pull&service=ghcr.io" \
      | yq -p json '.token // ""' 2>/dev/null || true)"
    if [[ -z "$token" ]]; then
      echo "MISSING ${repo}:${TAG} (no anonymous pull token; the package is private or absent)" >&2
      FAIL=1
      continue
    fi
    code="$(curl -s -o /dev/null -w '%{http_code}' \
      -H "Authorization: Bearer ${token}" \
      -H 'Accept: application/vnd.oci.image.index.v1+json' \
      -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
      "https://ghcr.io/v2/${path}/manifests/${TAG}")"
    if [[ "$code" == "200" ]]; then
      echo "ok      ${repo}:${TAG}"
    else
      echo "MISSING ${repo}:${TAG} (HTTP ${code})" >&2
      FAIL=1
    fi
  done
  [[ $FAIL -eq 0 ]] || {
    echo "Wait for CI, or pass --skip-image-check." >&2
    exit 1
  }
fi

# ---------------------------------------------------------------------- the plan
OLD="$(yq '.global.imageTag // ""' "$VALUES")"
echo
echo "plan for ${VALUES}:"
echo "  .global.imageTag: '${OLD}' -> '${TAG}'"
PINNED=()
for entry in "${SERVICES[@]}"; do
  key="${entry%%|*}"
  have="$(yq "${COMPONENTS}.${key}.image.tag // \"\"" "$VALUES")"
  if [[ -n "$have" ]]; then
    PINNED+=("$key")
    echo "  ${COMPONENTS}.${key}.image.tag: '${have}' -> '' (a per-service tag wins over the global)"
  fi
done

[[ $DRY_RUN -eq 1 ]] && { echo; echo "dry run: nothing written"; exit 0; }

# ---------------------------------------------------------------------- write
yq -i ".global.imageTag = \"${TAG}\"" "$VALUES"
for key in "${PINNED[@]:-}"; do
  [[ -n "$key" ]] || continue
  yq -i "${COMPONENTS}.${key}.image.tag = \"\"" "$VALUES"
done
echo
echo "wrote ${VALUES}"

[[ $OPEN_PR -eq 1 ]] || { echo "Review with: git -C \"\$(dirname ${VALUES})\" diff"; exit 0; }

# ------------------------------------------------------------- commit, push, PR
command -v gh >/dev/null || { echo "gh not found; the file is written, open the PR by hand" >&2; exit 1; }
TOP="$(git -C "$(dirname "$VALUES")" rev-parse --show-toplevel)"
SHORT="${TAG:0:12}"
PR_BRANCH="bump/imagetag-${SHORT}"
SUBJECT="chore: pin global.imageTag to ${SHORT}"
BODY="Pins every image the chart takes from \`${SOURCE_REPO}\` to \`${TAG}\`.

One single-repo commit builds all four services, so one tag names the whole
system state. Per-service tags are cleared, because they win over the global."

# Branch off the base the pull request targets, or the diff carries whatever
# else the current branch holds.
ON="$(git -C "$TOP" rev-parse --abbrev-ref HEAD)"
if [[ "$ON" != "$BASE" ]]; then
  echo "ERROR: $(basename "$TOP") is on '${ON}', not '${BASE}'." >&2
  echo "       The file is written. Check it out on ${BASE} and rerun, or commit by hand." >&2
  exit 1
fi

ABS="$(cd "$(dirname "$VALUES")" && pwd)/$(basename "$VALUES")"
git -C "$TOP" checkout -B "$PR_BRANCH" >/dev/null
git -C "$TOP" add "$ABS"
git -C "$TOP" commit -m "$SUBJECT" -m "$BODY"
git -C "$TOP" push -u origin "$PR_BRANCH"
( cd "$TOP" && gh pr create --base "$BASE" --head "$PR_BRANCH" --title "$SUBJECT" --body "$BODY" )
