# ADR-0005: The chart lives here, and this repository is named mint

- **Status:** Accepted
- **Deciders:** MetaLearn engineering
- **Related:** reverses [ADR-0003](0003-single-repo-over-submodule-superproject.md) § 3
  for the chart, and [ADR-0004](0004-no-submodule-stubs-for-external-repositories.md) § 1;
  map [#281](https://github.com/mintproject/mint/issues/281); research
  [#285](https://github.com/mintproject/mint/issues/285)

---

## Context

ADR-0003 and ADR-0004 kept the MINT chart in its own repository, `mintproject/mint`. The
reason was distribution. The chart is a published Helm repository at
`https://mintproject.github.io/mint`, and it has outside consumers.

That reason forbids a change of **URL**. It does not forbid a change of **repository**. This
repository can publish the same Helm repository at the same URL, if it holds the name
`mint`.

Measured on 2026-10-25:

| Fact | Value |
|---|---|
| Chart version on `mintproject/mint` `main` | `9.0.0-beta.17` (index ends at `9.0.0-beta.16`) |
| Entries in `index.yaml` | 142, back to `MINT-0.1.0` |
| Pages source of `mintproject/mint` | `main` at `/` |
| Release process | `Makefile:2`, run by hand, then committed to `main` |
| Forks / stars / open issues | 2 / 1 / 5 |
| Image path | `ghcr.io/mintproject/<service>`; no repository name in it |
| TACC chart source | a vendored `charts/*.tgz` in `~/tacc-values/shared` |
| `mintproject/helm-charts`, `mintproject/mint-chart-archive` | both free |

Every chart change already follows a service change. A new `ui-react` value needs a new
chart template, and a chart release pins a monorepo commit in `global.imageTag`. Today that is
two pull requests in two repositories for one change.

## Decision

**Move the chart into `charts/mint/`. Rename this repository to `mintproject/mint`.**

### 1. The two acts are one act

The name `mint` is held by the chart repository. GitHub Pages serves a project site at
`<owner>.github.io/<repository name>`. So the Helm repository URL belongs to whichever
repository holds the name `mint`.

GitHub redirects a renamed repository, but it does **not** redirect Pages
([#285](https://github.com/mintproject/mint/issues/285), finding 1). The URL survives only
if the repository that takes the name `mint` also publishes the chart. So the chart must move
here before this repository takes the name. A rename alone kills the URL. A move alone leaves
the URL on a repository that no longer holds the chart.

### 2. The order is forced

1. Import the chart, and publish it from here to a `gh-pages` branch.
2. Rehearse that Helm repository at `https://mintproject.github.io/monorepo`.
3. Rename `mintproject/mint` out of the way, then archive it.
4. Rename `mintproject/monorepo` to `mintproject/mint`, and turn on Pages.

Step 3 renames before it archives, because GitHub cannot rename an archived repository. The URL
is dead between step 3 and step 4. That gap is minutes, in one sitting.

### 3. The old repository is renamed `mint-chart-archive`

Two names were evaluated for the old chart repository.

| Name | For | Against |
|---|---|---|
| `mint-chart-archive` | States what it is: frozen history. Nobody opens a pull request there. | A new name nobody uses yet. |
| `helm-charts` | Matches the local clone directory. Reads as the usual chart repository name. | Reads as **live**. It is archived. `CONTEXT.md` lists `helm-charts` under _Avoid_. It takes the conventional org chart name for a dead repository. |

The rename of the old repository changes no URL that a consumer uses. Either name works. The
archive name wins because the repository is an archive, and a name must not say otherwise.

### 4. The rename keeps the domain

This repository becomes `mintproject/mint`, the name of the product and of
`mint.tacc.utexas.edu`. The GitHub redirect from `mintproject/monorepo` keeps every `git
remote`, issue link and pull request link working.

## Consequences

**A chart change and a service change land in one pull request.** The chart can pin the image
of the same commit.

**Two release lines.** `release-please` gets two packages, `.` and `charts/mint`. The chart
keeps its `9.x` line, because a published chart version must never go back. `main` cuts stable;
`develop` cuts `beta`. `chart-releaser` replaces the `Makefile`.

**Every historical tarball moves.** `gh-pages` carries every `releases/*.tgz` and the old
`index.yaml` unchanged, so an outside pin on an old version still resolves.

**Old chart links change target.** After step 4, a link to `github.com/mintproject/mint/pull/110`
resolves to pull request #110 of **this** repository, not of the archive. Taking a
redirect-claimed name destroys that redirect, and it is permanent
([#285](https://github.com/mintproject/mint/issues/285), finding 4). Rewrite every such
link to `mintproject/mint-chart-archive` before the cutover.

**Images built before the rename carry the old source label.**
`org.opencontainers.image.source` is set in each `Dockerfile`, so old images name
`mintproject/monorepo`. The redirect resolves it. Update the label in the document sweep
([#294](https://github.com/mintproject/mint/issues/294)).

**A GHCR package link may break.** GitHub does not document what a rename does to the
package-to-repository link that grants Actions push access. Test it before the cutover
([#286](https://github.com/mintproject/mint/issues/286)).

**TACC changes nothing.** It deploys a vendored chart, and `dynamo` resolves the unchanged URL.

## Traps for anyone working here

- **Do not rename the old repository after you archive it.** GitHub refuses. Unarchive first,
  and the archive date resets.
- **Transfer the open chart issues before the archive.** An archived repository is read-only,
  and an issue cannot leave it.
- **Do not reuse `monorepo` as a name.** A new repository named `monorepo` destroys the
  redirect from the old name.
- **The chart name is still `MINT`.** `helm install mint mintproject/MINT`.

## Outcome

The cutover ran on 2026-10-25 at 16:41 UTC. The Helm URL was dead for about 11 seconds.

- `mintproject/mint` became `mintproject/mint-chart-archive`, and it is archived.
- `mintproject/monorepo` became `mintproject/mint`. The old name redirects.
- Pages serves `gh-pages` from this repository at `https://mintproject.github.io/mint`.
- `dynamo` resolves `MINT 9.0.0-beta.16` with no edit.

In the Context and Decision sections above, `mintproject/mint` means the old chart
repository, which is now the archive. The rehearsal of the rename on two throwaway
repositories is in [#286](https://github.com/mintproject/mint/issues/286).

## References

- [ADR-0003](0003-single-repo-over-submodule-superproject.md) § 3
- [ADR-0004](0004-no-submodule-stubs-for-external-repositories.md)
- [Renaming a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository) — GitHub Docs
- [#281](https://github.com/mintproject/mint/issues/281) — the map; #293 holds the cutover steps
