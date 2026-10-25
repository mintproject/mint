# Helm hooks vs. `--wait`, `--timeout` and `--atomic`

Research for [mintproject/monorepo#343](https://github.com/mintproject/monorepo/issues/343)
(part of #342). Date: 2026-10-25.

Sources are primary only. Code links are pinned to Helm **v3.22.1** (latest v3) and
**v4.3.1** (latest v4; the laptop runs v4.2.3). The upgrade flow is the same in both.
Docs: [Chart Hooks](https://helm.sh/docs/topics/charts_hooks/)
([source at helm-www@243c2d6](https://github.com/helm/helm-www/blob/243c2d6ac95078256a4b2b56013aae454e67202a/docs/topics/charts_hooks.md)).

Context: `charts/mint/templates/post-install-hasura.yaml` declares the Hasura migration Job
with `helm.sh/hook: post-install`, `hook-weight: "-5"` and
`hook-delete-policy: hook-succeeded`. The plan is to add `post-upgrade`.

## Answers

### 1. If `--wait` fails, do `post-upgrade` hooks run? **No.**

`releasingUpgrade` runs strictly in order: pre-upgrade hooks, `KubeClient.Update`, wait,
post-upgrade hooks. A wait error calls `recordRelease(originalRelease)`, reports the error
and `return`s before the post-upgrade block.

- v3: [upgrade.go#L446-L471](https://github.com/helm/helm/blob/v3.22.1/pkg/action/upgrade.go#L446-L471)
  (wait returns at L451-L461; post-upgrade hooks at L465-L471)
- v4: [upgrade.go#L492-L512](https://github.com/helm/helm/blob/v4.3.1/pkg/action/upgrade.go#L492-L512)
- Docs, install lifecycle step 9: "if the `--wait` flag is set, the library will wait until
  all resources are in a ready state and will not run the `post-install` hook until they are
  ready." ([charts_hooks.md#L67-L69](https://github.com/helm/helm-www/blob/243c2d6ac95078256a4b2b56013aae454e67202a/docs/topics/charts_hooks.md#L67-L69))

Consequence for the dev cluster: the orphan Pending PVC fails the wait, so with `--wait`
the migration hook never runs there. Without `--wait` (v3 `Wait=false`; v4 default
`--wait=hookOnly`) the resource wait is skipped and the hook runs.

### 2. How does `--timeout` apply to hook Jobs?

Helm blocks until each hook Job **completes** (or fails), and `--timeout` (default 300s)
is applied **separately** to each step, not as one shared budget.

- The flag help says it: "time to wait for any individual Kubernetes operation (like Jobs
  for hooks)" ([cmd/helm/upgrade.go#L268](https://github.com/helm/helm/blob/v3.22.1/cmd/helm/upgrade.go#L268)).
- `execHook(..., u.Timeout)` is called with the full timeout for pre-upgrade and for
  post-upgrade, and the resource wait gets its own `u.Timeout`
  ([v3 upgrade.go#L421](https://github.com/helm/helm/blob/v3.22.1/pkg/action/upgrade.go#L421),
  [#L451-L457](https://github.com/helm/helm/blob/v3.22.1/pkg/action/upgrade.go#L451-L457),
  [#L467](https://github.com/helm/helm/blob/v3.22.1/pkg/action/upgrade.go#L467)).
- Inside `execHook`, every hook resource gets `WatchUntilReady(resources, timeout)`
  ([v3 hooks.go#L90](https://github.com/helm/helm/blob/v3.22.1/pkg/action/hooks.go#L90);
  [v4 hooks.go#L120](https://github.com/helm/helm/blob/v4.3.1/pkg/action/hooks.go#L120)).
  So N hooks in one phase can take up to N x timeout. The `before-hook-creation` delete also
  waits up to `timeout` ([v3 hooks.go#L164-L169](https://github.com/helm/helm/blob/v3.22.1/pkg/action/hooks.go#L164-L169)).
- For a Job, "ready" means the `Complete` condition is `True`; a `Failed` condition is an
  error ([v3 kube/client.go#L818-L833](https://github.com/helm/helm/blob/v3.22.1/pkg/kube/client.go#L818-L833),
  watch with timeout at [#L781-L782](https://github.com/helm/helm/blob/v3.22.1/pkg/kube/client.go#L782-L783)).
  A Job only gets `Failed` after its `backoffLimit` (Kubernetes default 6) is used up, so a
  crash-looping migration can consume the whole timeout.
- Docs: "If the resource is a `Job` or `Pod` kind, Helm will wait until it successfully runs
  to completion. And if the hook fails, the release will fail. This is a _blocking
  operation_" ([charts_hooks.md#L75-L79](https://github.com/helm/helm-www/blob/243c2d6ac95078256a4b2b56013aae454e67202a/docs/topics/charts_hooks.md#L75-L79)).
- The hook wait does not depend on `--wait`. `--wait` controls only the wait on the
  release's normal resources.

A hook timeout or failure marks the release `failed` with "post-upgrade hooks failed"
([v3 upgrade.go#L467-L469](https://github.com/helm/helm/blob/v3.22.1/pkg/action/upgrade.go#L467-L469),
then `failRelease` [#L485-L491](https://github.com/helm/helm/blob/v3.22.1/pkg/action/upgrade.go#L485-L491)).
The main resources stay applied.

### 3. `before-hook-creation`, `hook-succeeded` and a failed Job from an earlier run

**With only `hook-succeeded` (the current chart), a failed Job blocks every later run.**

- The default `before-hook-creation` applies **only when no delete policy is set**:
  `if len(h.DeletePolicies) == 0 { h.DeletePolicies = [before-hook-creation] }`
  ([v3 hooks.go#L52-L59](https://github.com/helm/helm/blob/v3.22.1/pkg/action/hooks.go#L52-L59);
  [v4 hooks.go#L237-L246](https://github.com/helm/helm/blob/v4.3.1/pkg/action/hooks.go#L237-L246)).
  The docs say the same ([charts_hooks.md#L204-L205](https://github.com/helm/helm-www/blob/243c2d6ac95078256a4b2b56013aae454e67202a/docs/topics/charts_hooks.md#L204-L205)).
  Setting `hook-succeeded` alone therefore turns the default off.
- `hook-succeeded` deletes only after success
  ([v3 hooks.go#L121-L130](https://github.com/helm/helm/blob/v3.22.1/pkg/action/hooks.go#L121-L130)).
  On failure only `hook-failed` triggers a delete
  ([#L101-L106](https://github.com/helm/helm/blob/v3.22.1/pkg/action/hooks.go#L101-L106)).
  So a failed Job stays in the cluster.
- On the next run, `deleteHookByPolicy(h, before-hook-creation)` does nothing, and
  `KubeClient.Create` fails because a Job with the same name exists
  ([v3 hooks.go#L61-L87](https://github.com/helm/helm/blob/v3.22.1/pkg/action/hooks.go#L61-L87)).
  The upgrade fails with `warning: Hook post-upgrade ... failed: ... already exists`.
  A manual `kubectl delete job` is then needed.

**Fix:** use `"helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded`
(the exact example in the docs,
[charts_hooks.md#L193](https://github.com/helm/helm-www/blob/243c2d6ac95078256a4b2b56013aae454e67202a/docs/topics/charts_hooks.md#L193)).
Helm then deletes any leftover Job, waits for the delete, and creates a fresh one. A failed
Job stays for debugging until the next run. Do not add `hook-failed` if you want to read
the failed pod's logs.

### 4. `--atomic` (v4: `--rollback-on-failure`) on hook failure

- `--atomic` forces `--wait` on
  ([v3 upgrade.go#L156-L158](https://github.com/helm/helm/blob/v3.22.1/pkg/action/upgrade.go#L156-L158);
  v4 switches `hookOnly` to `watcher` at
  [upgrade.go#L185-L189](https://github.com/helm/helm/blob/v4.3.1/pkg/action/upgrade.go#L185-L189)).
  On the dev cluster the PVC wait then fails first and the hook never runs.
- Any failure, hook failure included, goes to `failRelease`. It marks the new revision
  `failed`, and with `--atomic` rolls back to the newest `deployed`/`superseded` revision
  with `Wait=true` and the same timeout
  ([v3 upgrade.go#L504-L538](https://github.com/helm/helm/blob/v3.22.1/pkg/action/upgrade.go#L504-L538);
  [v4 upgrade.go#L553-L590](https://github.com/helm/helm/blob/v4.3.1/pkg/action/upgrade.go#L553-L590)).
- The rollback runs only `pre-rollback`/`post-rollback` hooks, not the migration Job. Any
  schema change the Job already applied is **not** undone. The failed Job stays (see 3).
- The rollback itself also waits on resources, so on the dev cluster it would also fail
  on the Pending PVC ("an error occurred while rolling back the release").

## Implications for the chart change

1. Change the annotation to `post-install,post-upgrade` and the delete policy to
   `before-hook-creation,hook-succeeded`.
2. On the dev cluster, run `helm upgrade` without `--wait`/`--atomic` until the orphan PVC
   is gone, or the migration hook never runs.
3. Set `--timeout` large enough for one migration Job run (it is per hook, not total).
4. Hasura migrations are forward-only here; `--atomic` will not revert them.
