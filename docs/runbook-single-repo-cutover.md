# Runbook: superproject to single-repo cutover

Status: **Phases 0 to 10 are done.** Phase 11 (`dynamo`) remains, and it is the
point of no return.

| Phase | State | Evidence |
|---|---|---|
| 0 Preparation | done | |
| 1 Remove dead submodules | done | |
| 2 Registry and chart groundwork | done, then corrected | chart `9.0.0-beta.7`, fixed in `beta.8` |
| 3 to 5 The three imports | done | monorepo#162 last |
| 6 Documentation cleanup | done | monorepo#163 |
| 7 Merge to `main` and publish | done | monorepo#166, `main` at `3bbaa28` |
| 8 The first release | done | `v0.1.0`, release commit `971622cc` |
| 9 Dev-cluster proof | **passed** | helm revision 70, chart `9.0.0-beta.8` |
| 10 Archive the source repositories | done | 12 issues moved to monorepo#171 to #182; 4 repos archived |
| 11 `dynamo` | not started | the point of no return |

Corrections found while executing are marked **Correction** in place. Trust
those over the surrounding prose: the prose was written before the work ran.

This runbook converts the **superproject** into the **single-repo**. It brings
`model-catalog-api`, `mint-ensemble-manager` and `graphql_engine` in as plain
directories, and it archives their source repositories.

It is the output of wayfinder map
[#138](https://github.com/mintproject/mint/issues/138). Every decision below
has a ticket. Read the ticket for the evidence. Do not re-open a decision here.

See [ADR-0003](./adr/0003-single-repo-over-submodule-superproject.md) for why.
See [`CONTEXT.md`](../CONTEXT.md) for **superproject**, **single-repo**,
**cutover** and **the point of no return**.

## Before you start: seven facts that will bite you

1. **Squash merge destroys the import.** `mintproject/mint` allows squash and
   rebase. A squash of an import branch flattens 138 to 726 commits into one. Use
   a merge commit. Phase 0 disables the other two buttons.
2. **A GHCR package is created private.** The chart then fails to pull. Phase 7
   proves visibility with an anonymous probe.
   **Correction:** when Phase 7 actually ran, all four packages were already
   public and no flip was needed. Probe anyway. Do not skip the probe because
   this note says the flip is unnecessary.
3. **Most failures here are silent.** `scripts/deploy-hasura.sh` keeps running and
   reports the wrong branch. The old bump skills keep running and return a stale
   SHA. Each phase has assertions, not a checklist.
   ([#141](https://github.com/mintproject/mint/issues/141))
   Three more turned up during execution, all of the same shape: `global.imageTag`
   was ignored by the chart while appearing to be set (Phase 2), the release
   re-tag workflow never ran while the release looked correct (Phase 8), and a
   registry move invalidated an image pin while the old pod kept serving
   (Phase 9). Assume the next one is also silent.
4. **The point of no return is not the archive.** Archiving is one click to undo.
   The one-way steps are the issue transfers (Phase 10.1) and the first `dynamo`
   pin (Phase 11).
5. **A Helm upgrade does not run Hasura migrations.**
   ([#117](https://github.com/mintproject/mint/issues/117)) Phase 0.5 exists
   because of this. It did not bite in Phase 9 — the deployed image and
   `origin/main` held the same 26 migrations and the same 36 metadata and seed
   files, byte for byte. Re-check rather than assume; the next release may differ.
6. **The release re-tag workflow does not fire.** release-please creates the
   release with the default `GITHUB_TOKEN`, and GitHub does not start workflows
   from `GITHUB_TOKEN` events. Phase 8 must be finished by hand.
7. **`helm upgrade --wait` always fails on the dev cluster.** An orphan
   `mint-hasura-db` PVC has been `Pending` for over 160 days, and `--wait` waits
   on every resource in the release. The manifests still apply. See Phase 9.

## The end state

| Directory | Today | After |
|---|---|---|
| `model-catalog-api` | submodule | plain directory, full history |
| `mint-ensemble-manager` | submodule | plain directory, full history |
| `graphql_engine` | submodule | plain directory, full history |
| `ui-react` | plain directory | unchanged |
| `ui` | submodule | gone. External repository. See [ADR-0004](adr/0004-no-submodule-stubs-for-external-repositories.md) |
| `helm-charts` | submodule | gone. External repository, published Helm repo. See [ADR-0004](adr/0004-no-submodule-stubs-for-external-repositories.md) |
| `model-catalog-ontology` | submodule | gone. Repository stays maintained. |
| `MINT_USERGUIDE` | submodule | gone. Repository stays maintained. |
| `dynamo-experiment-may` | submodule | gone. Another organisation owns it. |
| `model-catalog-fetch-api-client` | submodule | gone. Repository archived. |

`.gitmodules` ended with two stanzas, `ui` and `helm-charts`.
[ADR-0004](adr/0004-no-submodule-stubs-for-external-repositories.md) removed both and
deleted the file. Neither repository is imported; both are consumed where they live.

Every image publishes to GHCR. Docker Hub is dropped. Every single-repo commit
builds an image for every service, so one tag names the whole system state.

---

## Phase 0 — Preparation

All of Phase 0 is reversible. Nothing is published.

**0.1 Install `git-filter-repo`.** It is not on the machine.

```bash
brew install git-filter-repo
git filter-repo --version
```

**0.2 Disable squash and rebase merge** on `mintproject/mint`, for the
duration of the cutover.

```bash
gh api -X PATCH repos/mintproject/mint \
  -F allow_squash_merge=false -F allow_rebase_merge=false -F allow_merge_commit=true
```

**0.3 Merge `develop` into `main`.** `main` is 84 commits behind and has not
moved since 2026-05-20.
([#142](https://github.com/mintproject/mint/issues/142) decision 4 makes
`main` the release branch. `latest` and `release-please` both key off it.)

Do this before any import. Then the first `latest` and the first release come
from a `main` that carries no unrelated history.

Assert:

```bash
test "$(git rev-list --count origin/main..origin/develop)" -eq 0
```

Side effect: `ui-react` publishes `latest` for the first time. This closes
[#151](https://github.com/mintproject/mint/issues/151).

**0.4 Land the `mint-ensemble-manager` preconditions in the source repository**,
before the `filter-repo` run, so the import carries them.
([#145](https://github.com/mintproject/mint/issues/145))

- Commit `package-lock.json`. Remove line 30 from `.gitignore`.
- Add `"skipLibCheck": true` to `tsconfig.json`.

The 71 typecheck errors are all in `node_modules`, and none are in `src`. The
missing lockfile let `@apollo/client` float from `^3.7.1` to `3.14.1`. These two
commits turn the typecheck green.

Assert, in a fresh clone:

```bash
npm ci && npx tsc --noEmit && npm test
```

Husky, `lint-staged`, `.release-it.json` and `VERSION` are **not** touched here.
They are deleted in the single-repo, in Phase 5.
([#149](https://github.com/mintproject/mint/issues/149) decision 11)

**0.5 Check the content advance.** The import takes each service's `main`. The
superproject pins a commit that may be behind it.

```bash
for s in model-catalog-api graphql_engine mint-ensemble-manager; do
  pinned=$(git ls-tree origin/develop "$s" | awk '{print $3}')
  echo "== $s"; git -C "$s" log --oneline "$pinned..origin/main"
done
```

Measured on 2026-08-30: **all three are equal**. The advance is zero.

If it is not zero when you run it, re-pin the superproject to `main`, deploy that
to the dev cluster, and verify. Only then import. The import must be
content-neutral, so that any regression after it belongs to the repo move alone.

If `graphql_engine` has advanced, read `graphql_engine/migrations/` for new
files. A Helm upgrade will not run them.

---

## Phase 1 — Remove the four dead submodules

One pull request into `develop`.

- `model-catalog-ontology`, `MINT_USERGUIDE`, `dynamo-experiment-may`,
  `model-catalog-fetch-api-client`.
- For each: `git rm <path>` and delete its `.gitmodules` stanza.
- Add an agent note naming `mintproject/Mint-ModelCatalog-Ontology` and
  `mintproject/MINT_USERGUIDE`. Both stay maintained and both keep outside forks.
  Without the note the content becomes invisible when the directory disappears.
  ([#146](https://github.com/mintproject/mint/issues/146))

`dynamo-experiment-may` gets no note. It belongs to `In-For-Disaster-Analytics`.

Assert: `.gitmodules` has 5 stanzas.

**Correction.** Phase 1 and Phase 3 both edit `.gitmodules`, so they conflict.
Stack the import branches on the Phase 1 branch rather than branching each off
`develop`.

---

## Phase 2 — Registry and chart groundwork

Off the critical path. It must finish before any chart pins a single-repo tag.

**2.1 Move `mint-ui-lit` to GHCR.** One workflow pull request in
`mintproject/mint-ui-lit`. That repository is not imported and not archived, but
Docker Hub is dropped for every image.

Assert, anonymously:

```bash
docker manifest inspect ghcr.io/mintproject/mint-ui-lit:latest
```

Do this **before** 2.2. Flipping the chart key first points production at an
image that does not exist.

**2.2 Add `global.imageTag` to the MINT chart.** One pull request in
`mintproject/mint-chart-archive`.

The key is consumed by **exactly four** services:

- `graphql-engine`, `model-catalog-api`, `mint-ui-react`, `ensemble-manager`.

It must **not** reach `cromo`, `mic-web`, `mic-api`, `data-catalog`,
`data-catalog-db`, `model-catalog-endpoint`, `model-catalog-explorer`, `postgres`
or `postgis`. Those images do not come from the single-repo.

`mint-ui-lit` is a fifth image but not a single-repo service. It keeps its own
`tag`. Only its `repository:` key changes, to GHCR.

A per-service `tag` still overrides `global.imageTag`. The change is additive, so
`dynamo` needs no change on cutover day, and the 2 forks of `mintproject/mint-chart-archive` do
not break.

Package it as `9.0.0-beta.7`. The chart is at `9.0.0-beta.6` today, and
`releases/MINT-9.0.0-beta.6.tgz` is published. Commit the new `.tgz` and the
updated `index.yaml`.

Assert on the dev cluster, with today's per-service SHAs:

- The chart installs.
- A per-service `tag` still wins over `global.imageTag`.

Nothing pins `9.0.0-beta.7` yet, so this phase reverts by removing one `.tgz`.

**Correction: `9.0.0-beta.7` shipped a `global.imageTag` that did nothing.**
The assertion above is why. It only checks that a per-service tag *wins* — and
the chart's own defaults set a per-service tag on all four services, so the
global value was never reachable. `--set global.imageTag=X` on a fresh install
resolved the old pinned SHAs and reported success.

The missing assertion is the positive one. Add it:

```bash
# global.imageTag must actually reach all four, with no other overrides.
helm template mint charts/mint --set global.imageTag=0.1.0 \
  | grep -E '^\s+image:' | sort -u
```

Fixed in [`mintproject/mint-chart-archive#110`](https://github.com/mintproject/mint-chart-archive/pull/110),
packaged as `9.0.0-beta.8`. That change clears the four default tags, moves
`ui_react` and `ensemble_manager` from Docker Hub to GHCR, and defaults
`global.imageTag` to `0.1.0`. An empty default falls through to
`.Chart.AppVersion` (`1.16.3`), which names no image these services publish.

`mint-ui-lit` moved to GHCR in 2.1, but **only `:latest` and `:main` were pushed
there.** Every per-commit SHA tag lives only on Docker Hub, so an existing SHA
pin against the GHCR repository fails to pull. Do not pin a SHA for the `ui`
component against GHCR.

---

## Phases 3 to 5 — The three imports

One pull request per service, merged one at a time, in this order:

1. `model-catalog-api` — 138 commits, 4 MB, one author. It proves the mechanism
   on the cleanest subject, and it already has the `test` to `publish` gate.
2. `graphql_engine` — 108 commits, 12 MB. No test suite.
3. `mint-ensemble-manager` — 726 commits, 3.8 MB, two authors, a mailmap that
   matters, and the only preconditions.

**Correction.** Those counts are all-refs totals. Mainline-only, which is what
actually crosses, is **70 / 96 / 364**. Do not use the larger numbers to judge
whether an import completed.

### The import procedure, identical for all three

([#143](https://github.com/mintproject/mint/issues/143))

A path cannot be a gitlink and a tree at the same time. Remove the gitlink first,
or the merge hits a directory/file conflict.

```bash
# 1. On a branch off develop, drop the gitlink first. One commit.
git rm --cached <service>
#    ...and delete its .gitmodules stanza, then commit.

# 2. In a scratch clone of the source repository, on main:
git filter-repo --to-subdirectory-filter <service>/ --mailmap /path/to/mailmap

# 3. Back in the single-repo:
git remote add <service> /path/to/scratch-clone
git fetch <service>
git merge --allow-unrelated-histories <service>/main
```

`git subtree add` is rejected. It leaves historical paths unprefixed, so
`git blame` stops at the import boundary.

**Mainline only.** Branches and tags do not cross. 60 of
`mint-ensemble-manager`'s 78 refs hold commits that are not on `main`, including
five touched in 2026. The dev decided they are not worth replaying. The archive
is their only copy. This is why Phase 10 archives and never deletes.

**The shared mailmap.** Five author names exist for two people.

```
Maximiliano Osorio <maxiosorio@gmail.com> Maximilinano Osorio <mosorio@isi.edu>
Maximiliano Osorio <maxiosorio@gmail.com> Maximiliano Osorio <mosorio@isi.edu>
Maximiliano Osorio <maxiosorio@gmail.com> Maximiliano <maxiosorio@gmail.com>
Varun Ratnakar <varunratnakar@gmail.com> varunratnakar <27664194+varunratnakar@users.noreply.github.com>
```

`Your Name <you@example.com>` stays unmapped. Two commits, both 2020-12-11, and
the committer field gives no signal.

Normalise in this pass. Afterwards it needs a second rewrite of the whole
single-repo, which changes every SHA — and every SHA is an image tag the chart
can pin.

**Merge the pull request with a merge commit. Never squash. Never rebase.**

### The CI workflow, added with each import

([#145](https://github.com/mintproject/mint/issues/145)) One file per
service, at `.github/workflows/<service>.yml`. **No path filter.**

GitHub path filters are workflow-level, not job-level. A filtered `test` job and
an unfiltered `publish` job cannot share a file, and a `publish` job in a second
file cannot `needs:` a `test` job in the first. So filtering costs the publish
gate. The gate is worth more: the repository is public, Actions reports 0
billable ms, and traffic is about 6 commits a week.

```yaml
on:
  push:
    branches: ['**']
  pull_request:
    branches: [develop, main]

defaults:
  run:
    working-directory: <service>

concurrency:
  group: <service>-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:      # per service, see the table
  publish:   # needs: [test], if: github.event_name == 'push'
  scan:      # needs: [publish], Trivy, exit-code 0
```

`publish` pushes `ghcr.io/mintproject/<image>:<sha>` and `:<safe-branch>`,
**amd64 only**, with `cache-from`/`cache-to: type=gha`. On the default branch it
retags `:latest` with `docker buildx imagetools create`. No second build.

| Service | Node | `test` runs |
|---|---|---|
| `model-catalog-api` | 20 | `npm ci`, `tsc --noEmit`, `npm test` |
| `graphql_engine` | — | nothing. No suite exists. `publish` runs unconditionally. |
| `mint-ensemble-manager` | 24 | `npm ci`, `tsc --noEmit`, `npm test` |

Node differs on purpose. Each service's Dockerfile pins its own. Testing on a
Node the image does not use gives a green build that fails in the cluster.

`model-catalog-api` keeps `test:e2e` out of CI. It needs a live Hasura.

`mint-ensemble-manager` gets no lint or format job. It has 475 eslint errors and
74 unformatted files. See "Known gaps" below.

### Assertions after every import merge

Silent failures outnumber loud ones here. Run all four.

```bash
# 1. History crosses the import boundary.
git log --follow --oneline -- <service>/<a-file-older-than-the-import> | tail -3

# 2. Totality: every service has an image at this SHA, not just the imported one.
for i in model-catalog-api graphql-engine mint-ui-react ensemble-manager; do
  docker manifest inspect "ghcr.io/mintproject/$i:$(git rev-parse HEAD)" >/dev/null \
    && echo "ok $i" || echo "MISSING $i"
done

# 3. The hooks path did not move.
(cd <service> && npm ci)
test "$(git config core.hooksPath)" = "ui-react/.husky/_"

# 4. deploy-hasura.sh reports the service, not the superproject.
./scripts/deploy-hasura.sh --dry-run   # inspect the branch it names
```

Assertion 2 only covers services already imported, plus `ui-react`. It reaches
all four after Phase 5.

After the **last** import, add a fifth:

```bash
# 5. No gitlinks remain. This prints nothing.
git ls-files -s | awk '$1 == 160000 {print $4}'
```

### Phase 3 — `model-catalog-api`

Import as above, plus, in the same pull request:

- **Fix `scripts/deploy-hasura.sh:84-105`.** It loops over `model-catalog-api`
  and `graphql_engine`. After this import the `-d` guard still passes, but `git`
  resolves to the root repository. The script reports the superproject's branch
  and unpushed commits, labels them `model-catalog-api`, and at `:105` offers to
  push them. It becomes a lie that looks like a pass. Fix it here, in the first
  import, not at the end.
- **Delete `.claude/skills/update-helm-image-tags/` and
  `.claude/skills/dynamo-bump-from-branch/`.** Both resolve a tag with
  `git ls-remote` against a per-service repository. From this merge on, that
  repository still answers and returns a **stale SHA with no error**. A missing
  skill is loud. A stale pin is the failure class this whole map exists to
  remove ([#70](https://github.com/mintproject/mint/issues/70),
  [#148](https://github.com/mintproject/mint/issues/148)).

There is no bump skill between Phase 3 and Phase 5. Set pins by hand in that
window. It is short.

`model-catalog-api/.claude/skills/run-e2e-hasura/SKILL.md` stays where it is. It
is directory-scoped and it needs a local Hasura.

### Phase 4 — `graphql_engine`

Import as above. Its workflow has no `test` job.

`graphql_engine` gains no `CLAUDE.md`. See "Known gaps".

### Phase 5 — `mint-ensemble-manager`

**Unscheduled step, discovered during execution.** `mint-ensemble-manager`
history carries credentials that GitHub push protection rejects. The push fails
after `filter-repo` has already run, so budget for it before you start the
import rather than mid-merge.

Import as above. Then, as **separate commits in the same pull request**, so each
reverts on its own:

**5a. The cleanup commit.**
([#149](https://github.com/mintproject/mint/issues/149))

- Delete `.husky/` and the `"prepare"` script. `core.hooksPath` holds one value
  for the whole repository, and `ui-react` holds it. Two services cannot both
  install husky; the last `npm install` wins and nothing reports it. This is
  mutual exclusion, not a scoping problem, so the `ui-react` pattern does not
  help.
- Delete `lint-staged`: the dependency, the script and the config block. Its only
  caller was the deleted hook.
- Delete `.release-it.json` and `VERSION`. `release-it` is not in
  `devDependencies`. The config was last touched 2019-12-19 and drives a tool
  that cannot run.
- Add `"private": true` to `package.json`.

`prettier:fix` and `eslint:fix` stay, for manual use.

**5b. The skills commit.**

- Add the merged bump skill. It resolves one SHA or version from
  `mintproject/mint` and writes it to `global.imageTag`. Flags select the
  values file, the branch, and whether to open a pull request. The
  `component_key|owner/repo|branch` table disappears. That table is wrong in both
  old scripts today.
- Rewrite `test-on-k8s-dev`. It is written on the submodule model throughout: its
  `description`, its component table headed `Submodule`, and its claim that "CI
  in `model-catalog-api` pushes on every branch push". Rewrite it here, not
  earlier — before this point that claim is still true for the services not yet
  imported.

Root skills end at **two**, plus one directory-scoped skill under
`model-catalog-api/`.

**5c. The CI infrastructure commit.**

- `.github/dependabot.yml`: one `github-actions` entry at `/`, plus one `npm`
  entry per service directory. **Monthly, and every entry grouped into a single
  pull request.** Ungrouped weekly updates are what produced 8 open and 0 merged
  on `mint-ui-lit`. No `dependabot.yml` exists anywhere today, so this is a first
  setup, not a consolidation. The case for it is `github-actions`:
  `mint-ensemble-manager` is pinned to `actions/checkout@v2` and
  `docker/login-action@v1`.
- The `release-please` workflow. Unused until Phase 8.
- The release re-tag workflow. It adds a `<version>` tag to the manifest of a SHA
  that already passed. It does not rebuild. Unused until Phase 8.

---

## Phase 6 — Documentation cleanup

One pull request into `develop`.
([#141](https://github.com/mintproject/mint/issues/141),
[#146](https://github.com/mintproject/mint/issues/146))

**No agent instruction file moves.** Nested `CLAUDE.md` and directory-scoped
skills are path-based, not repository-based. Paths do not change. State this in
the pull request, so a later reader does not invent the work.

Root `CLAUDE.md`:

- Delete lines 1 to 6, the OpenWolf block. It imports `@.wolf/OPENWOLF.md`. There
  is no `.wolf/` directory and there never was.
- Delete the phantom rows `model-catalog-fastapi/` and `model-catalog-endpoint/`.
  Neither directory exists.
- Add the real directories: `knowledge-base/`, `scripts/`, `docs/`, `etl/`.
- Add a column marking which directories have their own `CLAUDE.md`.
- Fix `CLAUDE.md:14`, "this monorepo uses git submodules for major components".
- Fix the Migration Context bullets: "Submodules: `model-catalog-api`,
  `mint-ensemble-manager`, `ui` each have their own CLAUDE.md", and "`ui-react/`
  is NOT a submodule".

Also delete:

- `.claude/rules/openwolf.md`. It names six `.wolf/` files across ten rules and
  is not guarded.
- The five `.wolf/hooks/*.js` entries in `.claude/settings.json`. They are
  `-f`-guarded and no-op silently.

`README.md`:

- Re-point the CI badges at `mintproject/mint`. They pin `branch=master` for
  `mint-ui-lit` and `graphql_engine`; both default to `main`.
- Fix `:109`. It says
  `git clone --recurse-submodules https://github.com/mintproject/mint-chart-archive.git` — the
  wrong repository, and the flag is now meaningless.
- Delete the same two phantom directory rows.

Nested `CLAUDE.md` files are unchanged: `ui-react/` (296 lines), `ui/` (114),
`mint-ensemble-manager/` (104), `model-catalog-api/` (3), `knowledge-base/` (96).
Hoisting them would load 661 lines into every session instead of 144.

---

## Phase 7 — Merge to `main` and publish

1. Merge `develop` into `main`.
2. Confirm the four GHCR packages exist for that SHA.
3. **Flip each package to public, then prove it anonymously.** A GHCR package is
   created private. Do not assume it inherits the repository's public setting.

```bash
for i in model-catalog-api graphql-engine mint-ui-react ensemble-manager; do
  docker logout ghcr.io
  docker manifest inspect "ghcr.io/mintproject/$i:$(git rev-parse origin/main)" >/dev/null \
    && echo "public $i" || echo "PRIVATE $i"
done
```

Measured 2026-08-29: `model-catalog-api` was public; `graphql_engine`,
`mint-ui-lit` and `mint-ui-react` were not. A `ghcr.io/mintproject/mint-ui-react`
package already exists and is private, although
[#142](https://github.com/mintproject/mint/issues/142) records `ui-react` as
publishing to Docker Hub. Check what publishes there. Do not assume the package
is new.

**Correction, measured 2026-08-30:** all four were already public. No flip was
needed. Run the probe regardless.

Two problems with the probe as written.

`docker logout ghcr.io` destroys the operator's registry credentials for the
rest of the session. An anonymous token proves the same thing and touches
nothing.

Anywhere you write a bare `$i:latest` under zsh, `:l` is the lowercase modifier
and silently mangles the name. Always brace it: `${i}:latest`.

```bash
sha=$(git rev-parse origin/main)
for i in model-catalog-api graphql-engine mint-ui-react ensemble-manager; do
  t=$(curl -s "https://ghcr.io/token?scope=repository:mintproject/${i}:pull&service=ghcr.io" \
    | python3 -c "import json,sys;print(json.load(sys.stdin).get('token',''))")
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $t" \
    -H "Accept: application/vnd.oci.image.index.v1+json" \
    "https://ghcr.io/v2/mintproject/${i}/manifests/${sha}")
  [ "$code" = "200" ] && echo "public ${i}" || echo "PRIVATE/MISSING ${i} ($code)"
done
```

4. ~~**Then** delete the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets.~~

   **Correction: do not do this.** The secrets are **org-level**, and 18 other
   repositories in the organisation still use them. `mintproject/mint` has
   no repository-level secrets and no workflow that names `DOCKERHUB`, so there
   is nothing to delete here and deleting the org secrets breaks those 18 repos.
   Verify and move on:

   ```bash
   gh secret list --repo mintproject/mint   # expect: empty
   grep -rl DOCKERHUB .github/                  # expect: no matches
   ```

**Branch protection now exists on `main`**, with required checks `Lint & Format`,
`TypeScript`, `Tests` and `Test`. That closes the first item under "Known gaps".
`develop` is still unprotected, so a pull request into `develop` can be merged
while its checks are pending.

---

## Phase 8 — The first release

([#149](https://github.com/mintproject/mint/issues/149))

`release-please` opens a release pull request. Merge it. The version is
**`0.1.0`**. `ui-react` sets that floor — it is `0.1.0` in the repository today
and it ships in the chart. A higher number would claim maturity it does not have.

`mint-ensemble-manager`'s old `8.1.0-beta.1` tag does not cross the import, so
the single-repo tag namespace is empty.

The re-tag workflow adds `0.1.0` to the four manifests that already built and
passed. It does not rebuild — a rebuild would ship an artifact no test saw.

**Correction: the re-tag workflow never runs on its own.** Two reasons, and a
token change alone fixes only the first.

1. It listens on `release: published`. release-please creates the release with
   the default `GITHUB_TOKEN`, and GitHub does not start workflows from
   `GITHUB_TOKEN` events. Confirmed for `v0.1.0`:
   `gh run list --workflow="Release Re-tag"` returned `[]`.
2. The release commit is a **new** commit. Its four images are still building
   when the release publishes, so even a firing trigger would race the builds.

The release and the git tag look correct while no image carries the version.
Finish Phase 8 by hand:

```bash
# 1. Wait for all four build workflows on the RELEASE commit, not the merge
#    commit that preceded it.
sha=$(git rev-parse v0.1.0^{commit})
gh run list --limit 10 --json name,status,conclusion,headSha \
  --jq ".[] | select(.headSha==\"$sha\") | \"\(.conclusion // .status)\t\(.name)\""

# 2. Then dispatch the re-tag.
gh workflow run "Release Re-tag" -f version=0.1.0 -f sha="$sha"
```

Until the workflow is fixed, this manual step is required for **every** release.
The fix needs both a non-`GITHUB_TOKEN` credential and a wait-for-manifest loop,
or the trigger should be dropped in favour of a documented `workflow_dispatch`.

`graphql_engine` carries no version file. It has no `package.json`, and adding
one to hold a single field is new tooling. Its version lives in the git tag and
the image tag only.

Assert: `ghcr.io/mintproject/<each>:0.1.0` resolves, and its digest equals the
digest of the SHA tag. Compare digests, not just resolution — a version tag that
resolves to the wrong image is the failure this assertion exists to catch.

Measured for `v0.1.0` at release commit `971622cc`: all four match.

Note that `release-please` rewrites the two service `package.json` versions
**downwards**, `mint-ensemble-manager` 4.1.0 and `model-catalog-api` 2.1.0 both
to 0.1.0. Neither is published to npm, and `mint-ensemble-manager` is
`"private": true`. `model-catalog-api` is not; adding the flag would close the
gap.

---

## Phase 9 — The dev-cluster proof

This gates the archive. **Passed on 2026-08-30**, helm revision 70.

Deploy chart **`9.0.0-beta.8` or newer** to the dev cluster. `9.0.0-beta.7`
cannot pass this gate: its `global.imageTag` is inert, so the deploy comes up
green on the *old* images and proves nothing.

`--set global.imageTag=0.1.0` is not enough on its own. The dev cluster's own
values file pins a per-service tag for `model_catalog_api`, `ensemble_manager`
and `ui_react`, and a per-service tag wins. Clear them:

```yaml
# phase9-overlay.yaml, layered over `helm get values mint`
global:
  imageTag: "0.1.0"
components:
  model_catalog_api: { image: { tag: "" } }
  ensemble_manager:  { image: { tag: "" } }
  ui_react:          { image: { tag: "" } }
  ui:                { enabled: false }   # see below
```

Layer it rather than rewriting the values file. Round-tripping
`helm get values` through a YAML dumper reflows the Tapis auth public key.

```bash
helm --kube-context microk8s -n mint get values mint -o yaml > cluster-current.yaml
helm --kube-context microk8s -n mint upgrade mint <chart> \
  -f cluster-current.yaml -f phase9-overlay.yaml --timeout 8m
```

**Do not pass `--wait`.** An orphan `mint-hasura-db` PVC has been `Pending` for
over 160 days — the database actually uses `data-mint-hasura-db-0`, which is
bound. `--wait` waits on every resource in the release, so it always fails, the
release is marked `failed`, and the real failure is buried in the same error
block. The manifests apply either way. Verify with `kubectl` instead.

**`ui_react` needs a `client_id`.** It is `enabled: false` by default and the
chart refuses to render without `components.ui_react.config.client_id`. The dev
cluster's value is `mint-local`, readable from the live
`mint-ui-react-config-map`.

**The legacy `ui` breaks this deploy.** Chart 2.1 moved `mint-ui-lit` to GHCR,
but only `:latest` and `:main` exist there; the per-commit SHA tags live only on
Docker Hub. The cluster pinned a SHA, so `mint-ui` goes `ImagePullBackOff` while
the old ReplicaSet keeps serving — the UI looks alive and the failure surfaces
elsewhere. Disable the component, or pin `:latest`.
[`mintproject/mint-chart-archive#111`](https://github.com/mintproject/mint-chart-archive/pull/111) makes
`ui` disabled by default, in `9.0.0-beta.9`.

Assert more than `Running`. `ensemble_manager` has **no readiness probe**, so
`1/1 Running` says nothing about whether it serves. Probe from inside the
cluster:

| Endpoint | Expected |
|---|---|
| `mint-hasura/healthz` | 200 |
| `mint-model-catalog/v2.0.0/modelconfigurations?limit=1` | 200 |
| `mint-ui-react/` | 200 |
| `mint-ensemble-manager/v1/ui/` | 200 |
| `mint-ensemble-manager/v1/problemStatements` | 401, auth enforced |

`mint-ensemble-manager/v1/` returns 404 by design. No route is mounted at the
bare base path.

A TACC deployment is **not** required. `dynamo` overrides every tag per service,
so TACC does not consume `global.imageTag` until Phase 11. A TACC deploy would
prove nothing extra about the repo move, and it costs an MFA-gated session and
carries the [#117](https://github.com/mintproject/mint/issues/117) migration
hazard.

There is no waiting period. The gate is evidence, not the calendar. Archiving is
reversible, so a soak buys nothing.

---

## Phase 10 — Archive the source repositories

([#144](https://github.com/mintproject/mint/issues/144)) An archived
repository is read-only. **Do every write first, in this order.**

Steps 1, 2, 3 and 6 ran on 2026-08-30. Steps 4 and 5 were dropped — see the
correction after step 6.

1. **Transfer the 12 open issues to `mintproject/mint`.** 11 from
   `mint-ensemble-manager`, 1 from `graphql_engine`, 0 from `model-catalog-api`.
   Two are live work: `graphql_engine#13`, a grant bug on the junction tables,
   and `mint-ensemble-manager#108`, the model catalog GraphQL migration.
   **This step is irreversible.** Transferring back does not restore the numbers
   or the inbound links.

   **A transfer silently drops a label the target repository does not have.**
   `tapis` existed only in `mint-ensemble-manager` and carried 2 of the 12
   issues. Create every missing label in `mintproject/mint` **before** the
   transfer. Afterwards you cannot tell from the moved issue that a label was
   lost.

   ```bash
   # Compare before transferring.
   gh issue list --repo mintproject/<source> --state open --limit 100 \
     --json labels --jq '[.[].labels[].name] | unique[]' | sort -u
   gh label list --repo mintproject/mint --limit 100 --json name --jq '.[].name' | sort
   ```

   Done: `mint-ensemble-manager` 110, 109, 108, 105, 102, 101, 52, 40, 22, 14, 1
   and `graphql_engine#13` became **monorepo#171 to #182**, in that order.
   `enhancement` and `tapis` both survived.
2. Close `mint-ensemble-manager#106`, "Add Claude Code GitHub Workflow",
   superseded by Phase 5c. Do not replay it.

   **Correction: #106 is a pull request, not an issue.** So it is not one of the
   12, and the arithmetic in step 1 already excludes it. `gh issue list` does not
   show it, but `gh issue view 106` does — which reads as a missing issue unless
   you check `.pull_request`. Close it with `gh pr close`.
3. Commit one README line per source repository: the code moved to
   `mintproject/mint`, and this repository is read-only history. The GitHub
   archive banner says "archived", not "moved here".

   `model-catalog-fetch-api-client` needs different wording. Its code did **not**
   move into the single-repo — it was a dead submodule dropped in Phase 1. Point
   it at `model-catalog-api/` and name the npm deprecation instead.
4. ~~Add a deprecation note to the Docker Hub repositories `ensemble-manager`,
   `mint-ui-lit` and `mint-ui-react`.~~
5. ~~`npm deprecate @mintproject/modelcatalog_client`.~~
6. Archive `model-catalog-api`, `mint-ensemble-manager`, `graphql_engine` and
   `model-catalog-fetch-api-client`.

**Correction: steps 4 and 5 are dropped.** The dev decided on 2026-08-30 not to
do them. Both are cosmetic notes on external registries, neither gates Phase 11,
and neither is on the GitHub token — `npm whoami` returns `ENEEDAUTH` and
`~/.docker/config.json` holds no auths, so each costs a separate login.

Nothing breaks. Both artifacts keep working exactly as before:

- The Docker Hub images keep their last tag and their pull history — 21,436 and
  18,076 pulls. Chart `9.0.0-beta.8` already moved every MINT service to GHCR,
  so no deployment reads them.
- `@mintproject/modelcatalog_client` stays published, which is what
  `ui/package.json:30` needs while
  [#81](https://github.com/mintproject/mint/issues/81) is open. The original
  step said "do not unpublish" for that reason; not deprecating is strictly
  safer than deprecating.

**Do not write that the npm package is deprecated.** The first
`model-catalog-fetch-api-client` README notice said so and had to be corrected.
Its README now states that the package stays published, and why.

If you ever do want these notes, an archived repository does not block either
write. Order them before step 1 next time, though: a step needing a login you do
not have should surface before the irreversible one, not after it.

**Why archive and not leave open.** Each repository holds a workflow that writes
`<sha>`, `<safe-branch>` and `latest` to the same GHCR names the single-repo now
writes. One stray push republishes `latest` from pre-import code, against
production. Archiving disables Actions. Leaving the repository open does not.

**Why archive and not delete.** The unmerged branches are not worth replaying,
but the archive is their only copy.

---

## Phase 11 — `dynamo`

Off the critical path, after the archive. `dynamo` is private and MFA-gated.

Replace the per-service tag keys with one `global.imageTag: 0.1.0`, and bump the
chart pin to **`9.0.0-beta.10`** — `beta.7` ignores `global.imageTag`, so pinning
it would leave production on whatever the per-service keys said.

Two defaults changed under that pin, so read `dynamo` before it ships.

- `components.ui.enabled` is `false` from `9.0.0-beta.9`. If `dynamo` relies on
  the old `true`, the bump silently removes the legacy UI at TACC.
  [#81](https://github.com/mintproject/mint/issues/81) is still open.
- `components.ui_react` is enabled from `9.0.0-beta.10`, at host `mint.local`
  with `client_id: mint-local`. If `dynamo` does not set its own
  `components.ui_react.ingress.hosts` and `config.client_id`, the bump points the
  React UI at the wrong host with the wrong OAuth2 client.

**This is the point of no return.** Once production pins a single-repo tag,
redoing the import means a new history, which invalidates every published SHA tag
the chart could roll back to.

Until this phase, the per-service overrides in `dynamo` are the rollback
mechanism. Do not delete them early.

---

## Rollback

| After | How to undo | Cost |
|---|---|---|
| Phase 0 to 2 | Delete the branch. Remove the `9.0.0-beta.8` `.tgz`. | Free. Nothing pins it. |
| Phase 3 to 6 | `git revert -m 1 <merge-commit>` | Cheap. See the trap below. |
| Phase 7 to 9 | Revert on `main`. Re-pin the chart to the last per-service SHA tag. | Cheap. The old tags are still in GHCR, except `mint-ui-lit` SHAs, which are Docker Hub only. |
| Phase 10 | Unarchive: one click. Un-deprecate the npm package. | Cheap, except the issue transfers. They do not come back. |
| Phase 11 | None. Roll forward. | The point of no return. |

**The revert trap.** After you revert a merge commit, re-merging that branch
brings nothing back. Git considers it already merged. You must revert the revert
first. Write this in the pull request description of every import, so whoever
rolls back does not lose an afternoon to it.

---

## Known gaps this cutover does not close

State these plainly. Do not let a reader assume otherwise.

- ~~**Nothing blocks a bad merge.**~~ **Closed for `main`**, which now requires
  `Lint & Format`, `TypeScript`, `Tests` and `Test`. **Still open for
  `develop`**, which is unprotected — monorepo#168 was merged with four checks
  still pending. The publish gate in the workflow is real, because it is a
  `needs:` inside one file.
- **`mint-ensemble-manager` has 475 eslint errors and 74 unformatted files.** CI
  runs neither check after cutover. Dropping husky and `lint-staged` does not
  make this worse: they only ever formatted files as they were touched, which is
  why the backlog exists.
- **`graphql_engine` has no `CLAUDE.md` and no version file.** Both are content,
  and content is out of scope.
- **The chart pins `mint-ui-lit` at `tag: latest`.** That is
  [#148](https://github.com/mintproject/mint/issues/148), live today and
  unrelated to this cutover. `ensemble_manager` no longer does: `9.0.0-beta.8`
  clears its tag so `global.imageTag` applies. `mint-ui-lit` keeps `latest`
  because its GHCR repository has no SHA tags to pin instead.
- **A stale `main` writes a stale pin, with no error.** The bump skill reads the
  tip of `main`. `dynamo` overrides every tag, so TACC is safe. Only fresh chart
  installs get stale code. The dev accepted this risk.
- **The release re-tag is a manual step on every release.** See Phase 8.
- **A bare chart install shipped no frontend** in `9.0.0-beta.9`. `ui` was off by
  default and `ui_react` could not be on by default, because it hard-failed to
  render without a `client_id`. `9.0.0-beta.10` closes this: `client_id` defaults
  to `mint-local` and `ui_react` is on, at host `mint.local`.
  [`mintproject/mint-chart-archive#113`](https://github.com/mintproject/mint-chart-archive/pull/113).
- **`model-catalog-api/package.json` has no `"private": true`.** release-please
  rewrites its version downwards. Nothing publishes it today.
- **`ui` stays a submodule** until
  [#81](https://github.com/mintproject/mint/issues/81) removes Lit from TACC.
- **The Docker Hub and npm deprecation notes are not posted, by decision.**
  Phase 10 steps 4 and 5, dropped on 2026-08-30. The Docker Hub images are
  unreferenced from chart `9.0.0-beta.8` on, and
  `@mintproject/modelcatalog_client` must stay published for `ui` anyway.
