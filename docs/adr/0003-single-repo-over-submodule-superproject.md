# ADR-0003: Three services move from git submodules into a single repository

- **Status:** Accepted — not yet executed. The steps are in [`docs/runbook-single-repo-cutover.md`](../runbook-single-repo-cutover.md).
- **Deciders:** MetaLearn engineering
- **Related:** wayfinder map [#138](https://github.com/mintproject/mint/issues/138) and its eight tickets; [ADR-0002](0002-react-frontend-replaces-litelement-ui.md)

---

## Context

`mintproject/mint` is a **superproject**: it holds each MINT service as a git
submodule. `.gitmodules` declares nine. Three of them hold services that ship in
the MINT chart and change every week — `model-catalog-api`,
`mint-ensemble-manager` and `graphql_engine`.

A fourth service, `ui-react`, is already a plain directory in this repository.
[ADR-0002](0002-react-frontend-replaces-litelement-ui.md) put it there. It has
worked, and it is the shape this decision generalises.

Measured on 2026-08-29 at `08cdae9`:

| Fact | Value |
|---|---|
| Superproject commits, last 12 months | 209, all by one author |
| Of those, commits that only move a submodule pointer | 50 of the last 191 |
| Submodules with a commit in the last 12 months | 6 of 9 |
| `.git/modules` on disk | ~120 MB |
| Human pull requests open across all submodule repos | 2 |

Two failures show the cost is not theoretical.

**A pointer bump is not a change.** A quarter of recent superproject commits
carry no content. They exist to tell the superproject that a submodule moved.

**The deploy automation already has a hole shaped like this.**
[#70](https://github.com/mintproject/mint/issues/70) recorded that
`ui_react`'s image tag in the chart is a superproject SHA. The bump automation
resolves tags with `git ls-remote` against a per-service repository, finds no row
for `ui_react`, and **silently skips it**. That tag is set by hand today.
`ui_react` is not a special case. It is the first service to live where every
service is going.

The third cost is the one that decided it. An agent reads `git log` and
`git blame` for context before it edits. Across a submodule boundary that history
is in another repository, which the agent does not clone. It guesses instead.

## Decision

**Import `model-catalog-api`, `mint-ensemble-manager` and `graphql_engine` into
`mintproject/mint` as plain directories, each with its full mainline history,
and archive their source repositories.**

Four choices inside that decision are worth recording, because a future reader
will wonder.

### 1. Full history, imported with `git filter-repo`

Not `git subtree add`, and not a flat copy. `filter-repo
--to-subdirectory-filter` rewrites the path inside every historical commit, so
`git blame` and `git log --follow` cross the import boundary with no flags.
`subtree` leaves historical paths unprefixed and blame stops at the boundary.

The justification is the agent reader, not the human one. Only 3% of
`mint-ensemble-manager`'s surviving lines predate 2024, and `model-catalog-api`
has none — a human rarely blames that far back. But an agent that meets a line it
cannot explain does not clone an archived repository. The cost of preventing that
is about 20 MB and one command per service.

Branches and tags do not cross. 60 of `mint-ensemble-manager`'s 78 refs hold
unmerged commits; the archived repository is their only copy. That is why the
sources are archived and never deleted.

### 2. The image tag becomes total

Every single-repo commit builds an image for **every** service, so one SHA names
the whole system state and the chart pins one `global.imageTag`.

The alternative — build only what changed — was rejected on measurement, not
taste. The repository is public, the Actions timing API reports 0 billable ms,
GHCR storage for public packages is free, and traffic is about 6 commits a week.
So a path filter buys a few minutes of wall clock. Partial tags are what broke
`ui_react` in [#70](https://github.com/mintproject/mint/issues/70): a tag that
is a partial function has holes, and the automation falls through them quietly.

A path filter also turns out to cost the publish gate. GitHub path filters are
workflow-level, so a filtered `test` job and an unfiltered `publish` job cannot
share a file, and `publish` cannot then `needs: [test]`. Losing that gate to save
a few minutes is a bad trade.

### 3. `helm-charts` and `ui` stay out

`helm-charts` (the repository `mintproject/mint-chart-archive`) is a published Helm chart
repository with a committed `index.yaml`, packaged `releases/*.tgz`, and external
consumers. It has 2 forks; every service repository has 0. External consumers
keep it external.

`ui` is deprecated and is being removed from TACC by
[#81](https://github.com/mintproject/mint/issues/81). Importing history that
is about to be deleted is waste. Its submodule stub stays until then. Its image
still moves to GHCR, because dropping Docker Hub is about the registry, not about
which repository builds.

### 4. Releases return, cut by the single-repo

No service cuts its own release. The single-repo cuts one release for all of
them, starting at `0.1.0`, with `release-please`.

`ui-react` sets that floor: it is `0.1.0` today and it ships in the chart. A
higher number would claim maturity it does not have.

`release-please` rather than a hand process, because the evidence for decay is in
the repository: `mint-ensemble-manager` carries a `.release-it.json` last touched
in 2019 configuring a tool that is not in its `devDependencies`, a `VERSION` file
reading `4.0.0`, a `package.json` reading `4.1.0`, and a newest tag of
`8.1.0-beta.1`. Three version numbers that disagree. A CI release cannot stop
quietly; it opens a pull request you merge or ignore.

## Consequences

**Release coordination gets harder, and that is the price.** Every service now
shares one tag namespace, one release cadence and one default branch. A service
can no longer ship on its own schedule. This is the real cost of the decision,
and it was accepted knowingly: the drivers are daily friction and agent
navigability, not release management.

**One SHA is now deployable, or not, as a whole.** A red commit publishes no
image, because `publish` needs `test`. The chart pins one value.

**Two skills become one, and a third is rewritten.** The
`component_key|owner/repo|branch` table that both bump scripts carry disappears.
It is wrong in both today: it names branch `master` for two repositories that
default to `main`, and has no row for `ui_react`.

**`git clone` stops needing `--recurse-submodules`** for everything except `ui`
and the chart.

**Nothing enforces the new CI.** Neither `main` nor `develop` is protected and
there are no required status checks, so the publish gate is real but a merge gate
does not exist. Adding one is repo governance, and it would fail merges
immediately on `mint-ensemble-manager`'s 475 eslint errors. This ADR does not
close that gap; it records it.

**The point of no return is the first `dynamo` pin to a single-repo tag**, not
the archive. Archiving is one click to undo. Once production pins a single-repo
SHA, redoing the import means a new history, which invalidates every tag the
chart could roll back to.

## Traps for anyone working here

- **Never squash-merge an import branch.** It flattens the imported history into
  one commit and destroys the entire justification above.
- **A path cannot be a gitlink and a tree at once.** Remove the gitlink in a
  commit before merging content at that path.
- **Reverting a merge poisons the re-merge.** Git treats the branch as already
  merged. Revert the revert first.
- **A GHCR package is created private.** It does not inherit the repository's
  visibility. Prove each package pulls anonymously before the chart pins it.
- **A Helm upgrade does not run the Hasura migrations.** The migration job is a
  post-install hook. See
  [#117](https://github.com/mintproject/mint/issues/117).

## References

- Wayfinder map [#138](https://github.com/mintproject/mint/issues/138)
- Tickets [#140](https://github.com/mintproject/mint/issues/140),
  [#141](https://github.com/mintproject/mint/issues/141),
  [#142](https://github.com/mintproject/mint/issues/142),
  [#143](https://github.com/mintproject/mint/issues/143),
  [#144](https://github.com/mintproject/mint/issues/144),
  [#145](https://github.com/mintproject/mint/issues/145),
  [#146](https://github.com/mintproject/mint/issues/146),
  [#147](https://github.com/mintproject/mint/issues/147),
  [#149](https://github.com/mintproject/mint/issues/149)
- [`docs/runbook-single-repo-cutover.md`](../runbook-single-repo-cutover.md)
