# ADR-0004: No submodule stubs for external repositories

- **Status:** Accepted
- **Deciders:** MetaLearn engineering
- **Related:** refines [ADR-0003](0003-single-repo-over-submodule-superproject.md) § 3;
  [ADR-0002](0002-react-frontend-replaces-litelement-ui.md); issue
  [#81](https://github.com/mintproject/mint/issues/81)

---

## Context

[ADR-0003](0003-single-repo-over-submodule-superproject.md) imported three services and
left two gitlinks in place: the MINT chart (`mintproject/mint-chart-archive`, at `helm-charts/`) and
`ui` (`mint-ui-lit`, at `ui/`). It gave a reason for each. Both reasons said why the
content must not be **imported**. Neither said why a **gitlink** must stay.

Measured on 2026-08-30 at `ec5ff61`:

| Fact | Value |
|---|---|
| Workflows that read either gitlink | 0 of 6 |
| Files that read the chart directory | 1 — `scripts/test-migration-local.sh:54` |
| Files that read the `ui` directory | 0 |
| Commits that moved the chart gitlink | 11 |
| Commits that moved the chart gitlink and changed nothing else | 5 |
| Both directories, checked out in a working tree | no — empty stubs, and all work succeeded |

Three facts decided it.

**The gitlink has no reader.** No workflow initialises a submodule. `dynamo` pins a
published chart version and never resolves the gitlink. So the recorded SHA constrains
nothing. A pointer that constrains nothing is not a dependency.

**The gitlink misreports itself.** A `chore(helm-charts): bump the chart pin` commit
reads like a dependency update in `git log`. It is a note to a human saying which chart
version is deployed. That note was true, and it was in the wrong place.

**The chart is already distributed properly.** `mintproject/mint-chart-archive` publishes an
`index.yaml` and packaged releases to `https://mintproject.github.io/mint`. ADR-0003
cited that publication as the reason not to import the chart. It is equally the reason
not to vendor a pointer to it: a Helm repository is the supported way to consume a chart,
and `helm repo add` needs no gitlink.

## Decision

**Remove the `helm-charts` and `ui` gitlinks, delete `.gitmodules`, and consume both
repositories the way any outside consumer does.**

ADR-0003 § 3 is refined, not reversed. Neither repository is imported. Both stay
external, for the reasons ADR-0003 gave. What changes is that "external" now means
external, with no stub in the tree.

Three consequences of that are worth recording.

### 1. The chart is consumed from its Helm repository

`scripts/test-migration-local.sh` was the only reader. It now runs `helm repo add
mintproject https://mintproject.github.io/mint` and installs `mintproject/MINT` at
`$CHART_VERSION`.

It previously passed the chart's own `values.yaml` back to `helm upgrade` with `-f`.
That was equivalent to passing nothing, because `helm upgrade` applies chart defaults
already. Dropping it changes no behaviour.

### 2. The deployed chart version needs a home, and the gitlink was not it

`CHART_VERSION` in that script is the local-test default, and it is `9.0.0-beta.10`.
`dynamo` remains the record of what production deploys. Neither is derived from this
repository, and neither ever was.

Removing the gitlink exposed three versions that disagreed. The `test-on-k8s-dev` skill
recorded `MINT-9.0.0-beta.6`, commit `5c90da6` pinned `9.0.0-beta.8`, and the published
release was `9.0.0-beta.10`. `helm list` then showed the dev cluster on `9.0.0-beta.8`, so
the skill was stale by two releases. The disagreement was invisible while a gitlink looked
authoritative. Finding it is the point.

### 3. `superproject` becomes a past-tense word

`.gitmodules` is gone, so the layout in this repository is the single-repo, in full.
`CONTEXT.md` moves `superproject` to the past and adds **external repository** for what
the two removed stubs now are.

This does **not** end the cutover. `CONTEXT.md` defines the cutover as ending when the
four source repositories are archived. That condition is unchanged, and so is
[the point of no return](0003-single-repo-over-submodule-superproject.md).

## Consequences

**A clone is complete and `--recurse-submodules` is now a no-op.** No contributor has to
remember it, and no CI job has to configure it.

**The chart's history leaves this repository's reach.** `git log helm-charts` returned 11
pointer moves, never a chart change, so no reader loses anything real. To read the chart's
history, read `mintproject/mint-chart-archive`.

**Nothing in this repository states the deployed chart version any more.** That is
correct — `dynamo` states it — but a reader who expected to find it here will not. This
ADR and `CONTEXT.md` are where that reader is sent.

**`ui` loses its countdown marker.** The stub was a visible reminder that
[#81](https://github.com/mintproject/mint/issues/81) is open. #81 tracks it now, and
`CONTEXT.md` still defines the term.

## Traps for anyone working here

- **Do not re-add a gitlink to record a version.** That is what this ADR removes. A
  version belongs in `dynamo`, in a script variable, or in prose.
- **`.git/modules/` keeps stale caches.** Removing a gitlink does not delete them, and
  that directory is shared across git worktrees. Leave it alone unless reclaiming disk.
- **The chart name is `MINT`, not `mint`.** `helm install mint mintproject/MINT` — the
  release is lowercase and the chart is uppercase.

## References

- [ADR-0003](0003-single-repo-over-submodule-superproject.md) § 3, "`helm-charts` and `ui` stay out"
- [`CONTEXT.md`](../../CONTEXT.md) — **the MINT chart**, **external repository**, **submodule**
- [`docs/runbook-single-repo-cutover.md`](../runbook-single-repo-cutover.md)
