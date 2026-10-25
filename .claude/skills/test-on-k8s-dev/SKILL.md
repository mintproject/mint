---
name: test-on-k8s-dev
description: Deploy and test a `mintproject/monorepo` branch build on the shared MicroK8s development cluster (release `mint`, namespace `mint`) before pinning a tag. Use when asked to test a change on Kubernetes, verify a fix on the dev instance, check whether a deployed image actually contains a change, or reach Hasura / the model catalog API running in-cluster.
---

# test-on-k8s-dev

How to exercise a change on the shared MicroK8s dev cluster. This is the gap between "CI is green" and "pin the tag": CI proves the image builds, this proves it works against real data.

For local-only work use the `run-e2e-hasura` skill in `model-catalog-api/` instead. That runs against a local Hasura and needs no cluster.

## The cluster

Verified 2026-08-30:

| | |
|---|---|
| kubectl context | `microk8s` (cluster `microk8s-cluster`, node `pop-os`, k8s v1.31.14) |
| Namespace | `mint` (already the context default) |
| Helm release | `mint`. Chart `MINT-9.0.0-beta.8` deployed on 2026-08-30. `9.0.0-beta.10` is the current release, and is what the scripts install. |

The cluster is remote, not on the laptop. `kubectl get nodes` is the fastest liveness check.

**Two stale names to ignore.** The MINT chart's own README ([`charts/mint/README.md`](../../../charts/mint/README.md)) documents installing the release as `testing-mint`, and `model-catalog-api/src/hasura/client.ts` defaults `HASURA_GRAPHQL_URL` to `http://testing-mint-hasura.mint.svc.cluster.local/v1/graphql`. Neither matches this cluster, where the release is `mint` and the in-cluster URL is `http://mint-hasura/v1/graphql`. Resource names are `mint-*`, not `testing-mint-*`.

## Component map

The four services that ship from `mintproject/monorepo`:

| Directory | Deployment | Container | Ingress host | Image |
|---|---|---|---|---|
| `model-catalog-api` | `mint-model-catalog` | `model-catalog` | `api.models.mint.local` | `ghcr.io/mintproject/model-catalog-api` |
| `graphql_engine` | `mint-hasura` | `hasura` | `graphql.mint.local` | `ghcr.io/mintproject/graphql-engine` |
| `mint-ensemble-manager` | `mint-ensemble-manager` | `head` | `ensemble-manager.mint.local` | `ghcr.io/mintproject/ensemble-manager` |
| `ui-react` | `mint-ui-react` | `ui-react` | `mint.local` | `ghcr.io/mintproject/mint-ui-react` |

`ui` (mint-ui-lit) is an external repository, with no directory here: deployment `mint-ui`, host `legacy.mint.local`.

The `*.mint.local` hosts only resolve if the node IP is in your `/etc/hosts`. Port-forwarding avoids that entirely and is the better default for a quick check.

## Reaching a service without touching the cluster

```bash
kubectl port-forward -n mint svc/mint-model-catalog 18080:80 &
PF=$!
curl -s http://127.0.0.1:18080/health          # {"status":"ok","hasura":"connected"}
kill $PF
```

Read-only, safe on a shared cluster, and enough to characterise current behaviour before you change anything.

## Deploying a branch build

CI in `mintproject/monorepo` builds **all four services on every branch push**, with no path filter, so one commit gives you a whole consistent system. A branch image exists as soon as its `publish` job is green — you do not need to merge to test:

- `ghcr.io/mintproject/<image>:<full-commit-sha>`
- `ghcr.io/mintproject/<image>:<branch-name-with-slashes-as-dashes>`
- `:latest` is only republished on the default branch.

Confirm the image is really in the registry before deploying it:

```bash
IMAGE=model-catalog-api
SHA=<full-sha>
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:mintproject/${IMAGE}:pull&service=ghcr.io" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  "https://ghcr.io/v2/mintproject/${IMAGE}/manifests/${SHA}"
```

`200` means present. Brace the variable as `${IMAGE}`. In zsh, `"$IMAGE:latest"` applies the `:l` lowercase modifier instead of appending a tag, and the probe silently reports the wrong thing.

Then point the deployment at it. **This mutates a shared cluster — ask the user first.**

```bash
# note the current image so you can get back to it
kubectl get deploy -n mint mint-model-catalog \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'

kubectl set image -n mint deploy/mint-model-catalog \
  model-catalog=ghcr.io/mintproject/model-catalog-api:<sha>
kubectl rollout status -n mint deploy/mint-model-catalog --timeout=120s
```

Revert when done:

```bash
kubectl rollout undo -n mint deploy/mint-model-catalog
```

Helm will also overwrite this on its next `helm upgrade`, so a forgotten `set image` is not permanent — but do not leave the shared instance on a branch build.

**A helm upgrade does not run Hasura migrations.** The migration job is a post-install hook only, so a `graphql_engine` schema change needs a hand-run step ([#117](https://github.com/mintproject/monorepo/issues/117)).

## Verifying the change is actually live

**A 200 with plausible data does not mean your change deployed.** `model-catalog-api` is a Fastify + `fastify-openapi-glue` service: AJV validates the querystring against the OpenAPI spec and **silently strips any query param the spec does not declare**. An unrecognised filter is dropped, the endpoint returns an unfiltered page, and the response looks fine.

Observed on the dev cluster against an image predating the change:

```
?label_contains=land_surface&per_page=3  -> evaporation_volume_flux_index,
                                            downstream_volume_flow_rate,
                                            land_region_water__..._index
?per_page=3                              -> evaporation_volume_flux_index,
                                            downstream_volume_flow_rate,
                                            land_region_water__..._index
```

Identical. The filter did nothing.

So always test a new param **differentially** — compare it against the same request without it, and confirm the results differ in the way you expect:

```bash
kubectl port-forward -n mint svc/mint-model-catalog 18080:80 &
PF=$!
BASE=http://127.0.0.1:18080/v2.0.0/standardvariables
lbl() { curl -s "$1" | python3 -c "import sys,json;print([x['label'][0] for x in json.load(sys.stdin)])"; }
lbl "$BASE?per_page=3"
lbl "$BASE?label_contains=land_surface&per_page=3"   # must differ, and all match
kill $PF
```

Two corollaries when adding a query param to this API:

1. Implementing it in `service.ts` is not enough. It must also be declared under the operation's `parameters:` in `openapi.yaml`, or it never reaches the handler.
2. A service-level unit test bypasses Fastify and will pass either way. Cover it with a route-level test (`app.inject`) too — see `src/__tests__/standardvariables-ckan-route.test.ts`.

## Where this fits

1. Push the branch, wait for CI (`gh pr checks <n>`).
2. Confirm the image is in GHCR.
3. Deploy it here and verify differentially (this skill).
4. Only then pin the tag and open the PR — the `bump-image-tag` skill.
