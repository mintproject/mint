# TACC: apply the indicator standard-variable FK migration

Apply migration `1771200018000_response_variable_standard_variable_fk` against TACC's Hasura,
**and** the metadata that moves with it, so the Variables step can save an indicator at
`mint.tacc.utexas.edu`.

**Scope**: TACC production. Four `ALTER TABLE` pairs and eight `UPDATE`s inside one
transaction, plus a metadata apply. No data is deleted, no PVC is touched, no seeds are run.

**Ticket**: [monorepo#136](https://github.com/mintproject/mint/issues/136).
Dev-cluster rehearsal and the decision behind it are on
[#106](https://github.com/mintproject/mint/issues/106).

**Runbook this copies**: `docs/runbook-116-cascade-migration.md`. Read its
"What happened on 2026-08-10" section — the lock-wait trap is the same here.

---

## Read this first: the migration breaks the deployed Lit UI

This is not in the ticket body. It was measured on 2026-08-29, both directions, live.

`thread.response_variable` and `thread.driving_variable` are `foreign_key_constraint_on`
object relationships, so they **follow the constraint**. After the migration they resolve to
`modelcatalog_standard_variable`, which has `id`, `label`, `description` — and no `name`.

The Lit UI selects `response_variable { name }`:

    ui/src/queries/fragments/thread_previews.graphql

That fragment is pulled into `problem_statement_info`, which is used by
`problem-statement/list.graphql`, `get.graphql` and both subscriptions. Hasura rejects the
document at validation, so **the problem statement list and detail pages fail entirely**,
not one field. The commit TACC deploys today, `888ec50`, carries that selection.

Proof, run anonymously against both endpoints:

| endpoint | state | `response_variable { name }` | `response_variable { label }` |
|---|---|---|---|
| `graphql.mint.tacc.utexas.edu` | not migrated | works | `validation-failed` |
| `graphql.mint.local` (dev) | migrated | `validation-failed` | works |

The two apps are a matched pair with the schema, in opposite directions. TACC cannot serve
both at once.

### What this costs Lit

One cosmetic thing. `screens/modeling/actions.ts:361` is the only consumer: it collects the
names into `problem["preview"]`, the variable chips on a problem statement card. At TACC
**1 of 165 threads** carries a response variable, so the chip is empty on every other card.

### Sequencing

Pick one before you start. The rest of this runbook is the same either way.

- **A — migrate, then flip immediately.** No Lit change. Lit's problem statement list is dead
  between the two steps, and stays dead if the flip has to be rolled back. #69 made Lit
  "deployed-but-unrouted" the *only* undo for the flip, so this degrades the undo at exactly
  the moment it is needed.
- **B — patch Lit to select `label`, deploy, then migrate.** Same coupling, mirrored: the
  patched Lit is broken *until* the migration lands. No better than A.
- **C — make Lit migration-agnostic first (recommended).** Delete the
  `response_variable { name }` selection from `thread_previews.graphql`. Lit then validates
  against both schemas, the migration can land whenever, and the flip keeps a working undo.
  Cost: one line, one Lit image build, one `ui` tag bump in `dynamo`, one `helm upgrade`.

Option C is the recommendation. It turns one timed, coupled, hard-to-undo step into two
independent safe ones. **This is a call for Max, not for this runbook** — record it on #136.

---

## Prerequisites

| Item | Value |
|---|---|
| `kubectl` context | TACC production (via `ssh tacc-shared`; the jump host needs MFA) |
| Namespace | the MINT namespace (add `-n mint` to every command if it is not your default) |
| Hasura pod image | `06492bdedd05ca3534b943739f7ffffe877851da` or later |
| Signed-in browser | needed for step 6 — TACC login needs MFA |

The image tag matters **more than it did for #116**, because this migration has a metadata
half. An image built before `graphql_engine`
[#15](https://github.com/mintproject/graphql_engine/pull/15) carries the old
`metadata/tables.yaml`; a `hasura metadata apply` from it puts the four array relationships
back on `variable`, where the constraints no longer are. That is the inconsistent state, and
it is worse than not starting. **The image must carry both halves or neither.**

[dynamo#12](https://github.com/In-For-Disaster-Analytics/dynamo/pull/12) bumps the tag.
`ghcr.io/mintproject/graphql-engine:06492bd…` is published and pullable.

Merge it, then `helm upgrade` the TACC release with `shared/values.yaml`. Confirm the release
name and namespace first — they are not recorded anywhere in `dynamo`:

```bash
helm list -A
```

Then check the running pod:

```bash
kubectl get pod -l app=mint-hasura \
  -o jsonpath='{.items[0].spec.containers[0].image}{"\n"}'
```

Step 1a is the check that really counts. If `1771200018000` reads `SOURCE STATUS: Not Present`,
the pod does not have the file, whatever the tag says — deploy first, or use the appendix.

---

## Step 0 — get a shell in the pod

```bash
kubectl exec -ti $(kubectl get pod -l app=mint-hasura \
  --field-selector=status.phase==Running \
  -o jsonpath='{.items[0].metadata.name}') -- sh
```

`--field-selector=status.phase==Running` is not optional here. Straight after a rollout,
`items[0]` is the **Terminating** pod, still carrying the pre-upgrade image. That misfire
produced a false `migrate status` reading and a failed `metadata apply` on the dev cluster —
see the third script bug below.

Every command below runs **inside that shell**. Set these once:

```sh
cd /hasura
export EP=http://localhost:8080
export HC="--endpoint $EP --database-name default --skip-update-check"
```

`HASURA_GRAPHQL_ENDPOINT` is not set in the server pod, so pass `--endpoint` every time.

---

## Step 1 — read the current state

Do this before you change anything.

### 1a. Migration state

```sh
hasura migrate status $HC
```

**Expected**: every version through `1771200017000` is `Present / Present` — #116 applied that
one on 2026-08-10 — and `1771200018000` reads `Present / Not Present`.

If anything before `1771200018000` is `Not Present`, stop and report on #136. Do not let this
apply drag in an unrelated pending migration.

### 1b. FK state

```sh
curl -s -X POST "$EP/v2/query" \
  -H "x-hasura-admin-secret: $HASURA_GRAPHQL_ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  --data-binary '{"type":"run_sql","args":{"source":"default","read_only":true,"sql":"SELECT conname, confrelid::regclass AS references FROM pg_constraint WHERE conname IN ('"'"'thread_response_variable_id_fkey'"'"','"'"'thread_driving_variable_id_fkey'"'"','"'"'task_response_variable_id_fkey'"'"','"'"'task_driving_variable_id_fkey'"'"') ORDER BY conname;"}}'
```

**Expected before**: four rows, every `references` = `variable`.

| What you see | What it means | What to do |
|---|---|---|
| four rows, all `variable` | not applied | continue |
| four rows, all `modelcatalog_standard_variable` | already applied | skip to step 3 |
| a mix | a partial apply | **stop**, report on #136 |
| fewer than four rows | a constraint is named differently | **stop**, report on #136 |

This reading must agree with 1a. If it does not, stop.

### 1c. Long-lived transactions — do not skip this

**This is what went wrong on 2026-08-10** ([#119](https://github.com/mintproject/mint/issues/119)).
`idle_in_transaction_session_timeout` is unset on that database, so an abandoned transaction
can hold a lock for months.

```sh
cat > /tmp/idle.json <<'JSON'
{"type":"run_sql","args":{"source":"default","read_only":true,"sql":"SELECT pid, state, now()-xact_start AS age, left(query,60) AS q FROM pg_stat_activity WHERE datname=current_database() AND xact_start < now()-interval '1 minute' ORDER BY xact_start;"}}
JSON
curl -s -X POST "$EP/v2/query" -H "x-hasura-admin-secret: $HASURA_GRAPHQL_ADMIN_SECRET" \
  -H 'Content-Type: application/json' --data-binary @/tmp/idle.json
```

**Expected**: no rows, or nothing older than a few seconds. Clear any `idle in transaction`
row before you apply — `SELECT pg_terminate_backend(<pid>);` is safe on a session that is
doing nothing.

This migration takes ACCESS EXCLUSIVE on `thread`, `task`, `variable` **and**
`modelcatalog_standard_variable`. That is a wider lock footprint than #116's.

### 1d. Metadata state

New for this migration. #116 changed no metadata; this one does.

```sh
hasura metadata diff --endpoint $EP --skip-update-check
```

**Expected before**: the four array relationships sit under `variable` on both sides, and any
other difference is pre-existing drift. Read it now so you can tell your change from someone
else's after step 4.

If the diff shows the four relationships already under `modelcatalog_standard_variable` on the
server, the metadata half is already applied — check 1b again before doing anything.

### 1e. The row this touches

```sh
curl -s -X POST "$EP/v2/query" \
  -H "x-hasura-admin-secret: $HASURA_GRAPHQL_ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  --data-binary '{"type":"run_sql","args":{"source":"default","read_only":true,"sql":"SELECT id, response_variable_id, driving_variable_id FROM public.thread WHERE response_variable_id IS NOT NULL OR driving_variable_id IS NOT NULL UNION ALL SELECT id, response_variable_id, driving_variable_id FROM public.task WHERE response_variable_id IS NOT NULL OR driving_variable_id IS NOT NULL;"}}'
```

**Expected**: one row — thread `nzGQkhtRsudfSEHkDGct`, `response_variable_id`
`total_water_storage`, no driving variable. No task carries either column.

If you see more rows than that, the migration will rewrite them all. It maps by label and
**nulls** what it cannot map uniquely; 62 labels are shared by up to 6 standard variables. It
never drops a row. Note what you see here — step 5 checks it.

---

## Step 2 — apply the migration

```sh
hasura migrate apply $HC --version 1771200018000 --type up
```

The `--version` form states the intent and stays correct if someone lands another migration
between your reading and your apply.

**Run it once.** If it does not return in ~10 seconds it is waiting on a lock, not working. Do
not start a second apply in another shell — on 2026-08-10 that produced two stacked attempts
and one had to be cancelled by hand.

The SQL is one `BEGIN … COMMIT`: four `DROP CONSTRAINT`, a temp mapping table, eight `UPDATE`s,
four `ADD CONSTRAINT`. If it fails, nothing is applied.

**The migration is idempotent.** The dev cluster had the SQL applied by hand and `migrate apply`
re-ran `up.sql` over it cleanly: the DROP finds the constraint, both data steps match no rows,
the ADD re-creates it.

### If it stalls at `0 / 1`

That is a lock wait. Open a **second** shell to the pod:

```sh
curl -s -X POST "$EP/v2/query" \
  -H "x-hasura-admin-secret: $HASURA_GRAPHQL_ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  --data-binary '{"type":"run_sql","args":{"source":"default","read_only":true,"sql":"SELECT pid, pg_blocking_pids(pid) AS blocked_by, state, now()-xact_start AS xact_age, left(query,70) AS q FROM pg_stat_activity WHERE datname=current_database() ORDER BY xact_start NULLS LAST;"}}'
```

The row whose `blocked_by` is not empty is your migration; the pids it names are the holders.
Terminate an `idle in transaction` holder; wait out a young `active` one. The `hasura-backup`
CronJob is a common holder.

`Ctrl-C` aborts the HTTP request but does not reliably cancel the statement in Postgres, so
re-run step 1b before retrying and confirm the four rows still read `variable`.

To retry so it fails fast instead of queueing, send the SQL with a lock timeout in front, then
record the version separately — same shape as the #116 runbook, with the version changed:

```sh
python3 - <<'PY' > /tmp/payload.json
import json
sql = open('/hasura/migrations/1771200018000_response_variable_standard_variable_fk/up.sql').read()
print(json.dumps({"type": "run_sql", "args": {
    "source": "default",
    "sql": "SET lock_timeout = '5s';\n" + sql,
}}))
PY

curl -s -X POST "$EP/v2/query" \
  -H "x-hasura-admin-secret: $HASURA_GRAPHQL_ADMIN_SECRET" \
  -H 'Content-Type: application/json' --data-binary @/tmp/payload.json
```

On success, mark the version applied without running it again:

```sh
hasura migrate apply $HC --version 1771200018000 --type up --skip-execution
```

---

## Step 3 — confirm the version is recorded

```sh
hasura migrate status $HC | grep 1771200018000
```

**Expected**: `Present` on both sides. A recorded version stops a later `migrate apply` from
re-running these `ALTER`s.

---

## Step 4 — metadata apply

**A reload is not enough here.** #116 needed only `metadata reload`, because it changed no
metadata. This migration moves four array relationships, and Hasura will not infer that:
`tasksByDrivingVariable`, `tasksByResponseVariable`, `threadsByDrivingVariable` and
`threadsByResponseVariable` must move from `variable` to `modelcatalog_standard_variable`.
Leave them and they go inconsistent — measured on the dev cluster.

Look at the difference first:

```sh
hasura metadata diff --endpoint $EP --skip-update-check
```

Compare it against your 1d reading. It should show exactly the four relationships moving, and
nothing else you did not already see as pre-existing drift. **If it shows more, stop** — a
`metadata apply` overwrites the server's metadata with the image's, and unrelated drift would
go with it.

```sh
hasura metadata apply --endpoint $EP --skip-update-check
hasura metadata inconsistency list --endpoint $EP --skip-update-check
```

**Expected**: `metadata is consistent`.

Without the metadata half this returns four inconsistent array relationships.

---

## Step 5 — verify the schema

Run 1b again. **Expected after**: four rows, every `references` =
`modelcatalog_standard_variable`.

Run 1e again. **Expected after**: thread `nzGQkhtRsudfSEHkDGct` carries
`https://w3id.org/okn/i/mint/TOTAL_WATER_STORAGE`.

Then confirm the read surface flipped, from outside the pod:

```bash
curl -s -X POST https://graphql.mint.tacc.utexas.edu/v1/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ thread(limit: 1) { id response_variable { label } } }"}'
```

**Expected after**: data, not `validation-failed`. Before the migration this is the exact
error #136 was opened on.

---

## Step 6 — verify through the app

The SQL layer cannot prove this. #106 proved the write only under the **admin** role on the
dev cluster, and once under a real Tapis token on the dev cluster. Neither was TACC.

1. Sign in at `https://mint.tacc.utexas.edu` (MFA needed).
2. Open a thread. The page must load — before the migration it fails with
   `field 'label' not found in type: 'variable'`.
3. In the Variables step, pick an indicator and press Continue. It must save.
4. Reload. The choice must still be there, rendered as a label and not a URI.

This needs `ui-react` at the host, so it happens after the flip
([#77](https://github.com/mintproject/mint/issues/77)) unless you run a local client
against TACC's Hasura. If you do that, start it with `--strictPort` and read the request body
before believing the result — a stale dev server from another worktree produced a confident
wrong diagnosis on #116.

Record the result on [#136](https://github.com/mintproject/mint/issues/136).

---

## Rollback

**Two halves, in this order.**

```sh
hasura migrate apply $HC --version 1771200018000 --type down
```

Then put the metadata back, from an image built before `graphql_engine` #15, or by moving the
four array relationships to `variable` by hand. A database rollback without the metadata
rollback leaves the same inconsistency as the reverse mistake.

**The down migration is lossy by construction.** It maps standard variable ids back to
`variable.id` by label and nulls what has no counterpart — 431 of 668 at TACC. At TACC today
this does not bite: the single affected row, `total_water_storage`, maps in both directions.
Re-run 1e after a rollback and check that.

---

## Known bugs in `scripts/deploy-hasura.sh`

Measured on the dev cluster. None are fixed. Do not rely on the script for this run.

- **Line 150 picks a dying pod.** `items[0]` is not filtered by phase, so straight after a
  rollout it selects the Terminating pod with the pre-upgrade image. `migrate status` then
  reports the old list and `metadata apply` fails against the already-migrated database. This
  misfires precisely when `--skip-restart` is the right flag. Use
  `--field-selector=status.phase==Running`.
- **Lines 85-99 give false assurance.** An unchecked-out submodule is an empty directory;
  `pushd` succeeds and `git rev-parse` resolves against the parent repo. It reported a
  monorepo branch as the submodule's. Guard on `.git` existing.
- **Line 75 prints `kubectl: found ()`.** `kubectl version --client --short` no longer exists.

The script also runs a bare `hasura migrate apply` and `hasura metadata apply` with no
diff step. For this migration, read the diff first — step 4.

---

## Appendix: the pod is still on the old image

Use this **only** if dynamo#12 cannot be deployed. Both halves have to go by hand.

1. Copy `migrations/1771200018000_response_variable_standard_variable_fk/up.sql` from
   `graphql_engine` at `06492bd`.
2. Send it as one `run_sql` call with `"read_only": false`. Keep the `BEGIN` / `COMMIT`.
3. Record the version by hand in `hdb_catalog.schema_migrations`, with `dirty` false. Read the
   table shape first — do not assume the columns.
4. Move the four array relationships with the metadata API (`pg_drop_relationship` +
   `pg_create_array_relationship`), or the object relationships will follow the constraint
   while the array relationships do not. **Do not run `hasura metadata apply`** — the old
   image would undo step 4.

The recorded version is not optional. Without it the next `hasura migrate apply` re-runs these
`ALTER`s and fails on the missing constraint names.
