---
name: bump-image-tag
description: Pin a MINT deployment to one commit of `mintproject/mint` by writing `global.imageTag` in a helm values file. Use when asked to deploy a monorepo branch or release, bump helm image tags, or refresh a values file to the latest images.
---

# bump-image-tag

One single-repo commit builds all four services, so **one tag names the whole system state**. This skill writes that one tag.

```bash
.claude/skills/bump-image-tag/bump.sh --values <path> [--branch NAME | --tag TAG] [--pr] [--dry-run]
```

`--help` lists every flag. Start with `--dry-run`.

## What it writes

| | |
|---|---|
| `.global.imageTag` | the resolved tag |
| `.components.<key>.image.tag` | emptied, for the four services below |

The chart resolves `.image.tag | default .Values.global.imageTag | default .Chart.AppVersion`, so **a per-service tag wins over the global**. The chart's own defaults pin all four, which is why the script clears them. Leaving one set is the silent failure this skill exists to remove: the deploy reports success and runs the old image.

The four services that come from `mintproject/mint`:

| Component key | Image |
|---|---|
| `hasura` | `ghcr.io/mintproject/graphql-engine` |
| `model_catalog_api` | `ghcr.io/mintproject/model-catalog-api` |
| `ui_react` | `ghcr.io/mintproject/mint-ui-react` |
| `ensemble_manager` | `ghcr.io/mintproject/ensemble-manager` |

`ui` (mint-ui-lit) is still its own repository. The script never touches it, nor `cromo`, `mic_*`, `data_catalog*`, `model_catalog_endpoint`, `hasura_db` or the auth webhook.

## Where globals live

Helm reads globals only from the **root** `global` key, even when MINT is a subchart. Components move with the subchart; globals do not. So a values file that wraps the chart holds `MINT.components.*` beside a root-level `global.imageTag`. The script detects which root applies and prints it.

## Two aborts, both deliberate

- **A repository that is not the GHCR one.** A tag from `mintproject/mint` does not exist on Docker Hub. Fix the chart before pinning.
- **An image missing at that tag.** Every one of the four must be in GHCR before the pin is real. Wait for CI. `--skip-image-check` overrides, for a tag you know is still building.

Chart `9.0.0-beta.8` or newer. Earlier charts have no `global.imageTag` at all, or
— in `9.0.0-beta.7` — have the key but pin every service per service in the chart
defaults, which wins over it. In both cases the write is inert.

## Where this fits

1. Push the branch, wait for CI (`gh pr checks <n>`).
2. Verify the change is live on the dev cluster — the `test-on-k8s-dev` skill.
3. Pin the tag and open the PR (this skill).
