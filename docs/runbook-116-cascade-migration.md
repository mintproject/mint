# TACC: apply the modeling provenance cascade migration

Apply migration `1771200017000_modeling_provenance_cascade_on_delete` against TACC's Hasura,
then sync metadata, so `delete` works at `mint.tacc.utexas.edu`.

**Scope**: TACC production. Six `ALTER TABLE` statements inside one transaction. No data is
deleted, no PVC is touched, no seeds are run.

**Ticket**: [monorepo#116](https://github.com/mintproject/monorepo/issues/116).
Evidence and the dev-cluster rehearsal are on [#99](https://github.com/mintproject/monorepo/issues/99).

**Why by hand**: at the time, the chart job (now
`charts/mint/templates/hasura-migrate-job.yaml`) carried `"helm.sh/hook": post-install` only.
A `helm upgrade` never ran `hasura migrate apply`. The image shipped the migration files;
nothing ran them. The values key `jobs.hasura.run_on_upgrade` now adds `post-upgrade`.

---

## Prerequisites

| Item | Value |
|---|---|
| `kubectl` context | TACC production |
| Namespace | the MINT namespace (add `-n mint` to every command if it is not your default) |
| Hasura pod image | `c274ce090ddd1ecd33b25dce2a235f0de0b4fcab` or later |
| Signed-in browser | needed for step 6 — TACC login needs MFA |

The image tag matters. The migration directory only exists inside images built from
`graphql_engine` `main` at `c274ce0` or later — that is what
[dynamo#9](https://github.com/In-For-Disaster-Analytics/dynamo/pull/9) deploys. Check the
running pod:

```bash
kubectl get pod -l app=mint-hasura \
  -o jsonpath='{.items[0].spec.containers[0].image}{"\n"}'
```

Step 1a is the check that really counts: `SOURCE STATUS: Present` on `1771200017000` proves the
file is in the pod, whatever the tag says. If the source status is `Not Present`, deploy first,
or use the appendix if the deploy cannot happen.

---

## Step 0 — get a shell in the pod

```bash
kubectl exec -ti $(kubectl get pod -l app=mint-hasura -o jsonpath='{.items[0].metadata.name}') -- sh
```

Every command below runs **inside that shell**. The pod already has:

- `/hasura` — `config.yaml`, `migrations/`, `metadata/`
- the `hasura` CLI on `$PATH`
- `HASURA_GRAPHQL_ADMIN_SECRET` and `HASURA_GRAPHQL_DATABASE_URL` in the environment

`HASURA_GRAPHQL_ENDPOINT` is **not** set in the server pod, so pass `--endpoint` every time.
`bash` is available if you prefer it to `sh`.

Set these once to keep the commands short:

```sh
cd /hasura
export EP=http://localhost:8080
export HC="--endpoint $EP --database-name default --skip-update-check"
```

---

## Step 1 — read the current state

Do this before you change anything.

### 1a. Migration state

```sh
hasura migrate status $HC
```

**Observed 2026-08-10** — the last three lines are what matter:

```
VERSION        NAME                                          SOURCE STATUS  DATABASE STATUS
...
1771200016000  modelcatalog_configuration_input_is_optional  Present        Present
1771200017000  modeling_provenance_cascade_on_delete         Present        Not Present
```

Two things are settled by that reading:

- **No drift.** Every version through `1771200016000` is `Present / Present`. The cluster sits
  exactly at the repo's tip before PR #14. The ticket's worry — that `migrate apply` would drag
  in whatever else is pending — does not apply: `1771200017000` is the only unapplied version.
- **The image carries the migration.** `SOURCE STATUS: Present` means
  `/hasura/migrations/1771200017000_.../up.sql` exists in this pod. The appendix is not needed.

If your reading differs from this, stop and report on #116 before continuing.

### 1b. FK state

```sh
curl -s -X POST "$EP/v2/query" \
  -H "x-hasura-admin-secret: $HASURA_GRAPHQL_ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  --data-binary '{"type":"run_sql","args":{"source":"default","read_only":true,"sql":"SELECT conname, confdeltype FROM pg_constraint WHERE conname IN ('"'"'problem_statement_provenance_problem_statement_id_fkey'"'"','"'"'problem_statement_permission_problem_statement_id_fkey'"'"','"'"'task_provenance_task_id_fkey'"'"','"'"'task_permission_task_id_fkey'"'"','"'"'thread_provenance_thread_id_fkey'"'"','"'"'thread_permission_thread_id_fkey'"'"') ORDER BY conname;"}}'
```

**Expected before**: six rows, every `confdeltype` = `r` (RESTRICT).

Read the result carefully:

| What you see | What it means | What to do |
|---|---|---|
| six rows, all `r` | the migration is not applied | continue to step 2 |
| six rows, all `c` | already applied | skip to step 3, then step 5 |
| a mix of `r` and `c` | a partial apply | **stop**, report on #116 |
| fewer than six rows | a constraint is named differently | **stop**, report on #116 |

`r` here is consistent with `1771200017000` reading `Not Present` in step 1a. The two readings
must agree. If they disagree, stop.

### 1c. Long-lived transactions — do not skip this

**This is what went wrong on 2026-08-10.** Run it before every apply:

```sh
cat > /tmp/idle.json <<'JSON'
{"type":"run_sql","args":{"source":"default","read_only":true,"sql":"SELECT pid, state, now()-xact_start AS age, left(query,60) AS q FROM pg_stat_activity WHERE datname=current_database() AND xact_start < now()-interval '1 minute' ORDER BY xact_start;"}}
JSON
curl -s -X POST "$EP/v2/query" -H "x-hasura-admin-secret: $HASURA_GRAPHQL_ADMIN_SECRET" \
  -H 'Content-Type: application/json' --data-binary @/tmp/idle.json
```

**Expected**: no rows, or nothing older than a few seconds.

Any `idle in transaction` row is a blocker in waiting. Clear it before you apply — see step 2.
On 2026-08-10 this query would have shown a session `idle in transaction` for **100 days**,
holding a lock from an abandoned `COPY public.dataslice`.

---

## Step 2 — apply the migration

Apply **only** this version:

```sh
hasura migrate apply $HC --version 1771200017000 --type up
```

Step 1a showed `1771200017000` is the only unapplied version, so a bare `hasura migrate apply`
would do the same thing today. Use the `--version` form anyway. It states the intent, and it
stays correct if someone lands another migration between your reading and your apply.

**Run it once.** If it does not return in ~10 seconds it is waiting on a lock, not working. Do
not start a second apply in another shell — on 2026-08-10 that produced two stacked attempts,
and the second had to be cancelled by hand. Go to the next section instead.

This runs `migrations/1771200017000_modeling_provenance_cascade_on_delete/up.sql` and records
the version in `hdb_catalog.schema_migrations` in one action. Step 3 of the ticket is done by
this command — you do not need a separate `INSERT`.

The SQL is one `BEGIN … COMMIT`. It drops and recreates six foreign keys with
`ON UPDATE RESTRICT ON DELETE CASCADE`. If it fails, nothing is applied.

### If it stalls at `0 / 1`

```
Applying migrations:  0 / 1 [......................]   0.00%
```

That is a lock wait, not a slow migration. The work itself takes milliseconds.

`ALTER TABLE … DROP CONSTRAINT` takes an ACCESS EXCLUSIVE lock on the child table **and** on the
referenced parent — `problem_statement`, `task`, `thread`. Any open transaction touching those
tables holds it off. Worse, a *waiting* ACCESS EXCLUSIVE request queues ahead of every later
reader, so the app starts stalling behind your migration. Do not let it sit.

Open a **second** shell to the pod and find the blocker:

```sh
curl -s -X POST "$EP/v2/query" \
  -H "x-hasura-admin-secret: $HASURA_GRAPHQL_ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  --data-binary '{"type":"run_sql","args":{"source":"default","read_only":true,"sql":"SELECT pid, pg_blocking_pids(pid) AS blocked_by, state, now()-xact_start AS xact_age, left(query,70) AS q FROM pg_stat_activity WHERE datname=current_database() ORDER BY xact_start NULLS LAST;"}}'
```

Read the row whose `blocked_by` is not empty — that is your migration. The pids it names are the
holders.

| Holder's `state` | Meaning | Action |
|---|---|---|
| `idle in transaction` | a client left a transaction open | `SELECT pg_terminate_backend(<pid>);` — safe, it is doing nothing |
| `idle in transaction`, `age` in days | an abandoned transaction — **the 2026-08-10 case** | terminate it; an uncommitted transaction that old is invisible to every client and cannot be recovered |
| `active`, young `xact_age` | ordinary traffic | wait a few seconds, it should clear on its own |
| `active`, old `xact_age` | a long query or a backup | decide whether to kill it or wait for it |

The `hasura-backup` CronJob is a common holder. Check it is not running before you retry.

To stop waiting, `Ctrl-C` the CLI. That aborts the HTTP request but does **not** reliably cancel
the statement in Postgres, so re-run step 1b before you retry, and confirm the six rows are still
`r`. The migration is one transaction, so a killed apply leaves nothing half-done.

**Retry so it fails fast instead of queueing.** Send the SQL yourself with a lock timeout in
front of it, then record the version separately:

```sh
# in the pod: build the payload from the migration file, prefixed with a lock timeout
python3 - <<'PY' > /tmp/payload.json
import json
sql = open('/hasura/migrations/1771200017000_modeling_provenance_cascade_on_delete/up.sql').read()
print(json.dumps({"type": "run_sql", "args": {
    "source": "default",
    "sql": "SET lock_timeout = '5s';\n" + sql,
}}))
PY

curl -s -X POST "$EP/v2/query" \
  -H "x-hasura-admin-secret: $HASURA_GRAPHQL_ADMIN_SECRET" \
  -H 'Content-Type: application/json' --data-binary @/tmp/payload.json
```

If it returns a `lock_timeout` error, nothing was applied — clear the blocker and run it again.
On success, mark the version as applied (it will not be recorded by `run_sql`):

```sh
hasura migrate apply $HC --version 1771200017000 --type up --skip-execution
```

Then carry on at step 3. If `python3` is absent in the pod, build the same JSON on your laptop
and paste it.

---

## Step 3 — confirm the version is recorded

```sh
hasura migrate status $HC | grep 1771200017000
```

**Expected**: `Present` on both sides — source status and database status.

If the SQL is applied but the version is *not* recorded, mark it without running it again:

```sh
hasura migrate apply $HC --version 1771200017000 --type up --skip-execution
```

A recorded version stops a later `hasura migrate apply` from running these `ALTER`s a second
time, which would fail on the already-dropped constraint names.

---

## Step 4 — metadata sync

`graphql_engine` PR #14 changes no metadata. What Hasura needs after raw DDL is a **reload**,
so it re-reads the database schema:

```sh
hasura metadata reload --endpoint $EP --skip-update-check
```

Then check nothing came loose:

```sh
hasura metadata inconsistency list --endpoint $EP --skip-update-check
```

**Expected**: `metadata is consistent`.

### Optional: full metadata apply

Only if you also want to close metadata drift between the image and the live server. This
overwrites the server's metadata with `/hasura/metadata/`. **Look at the difference first:**

```sh
hasura metadata diff --endpoint $EP --skip-update-check
```

If the diff is empty, there is nothing to do — stop here. If it is not empty, that drift is a
separate problem from #116. Decide on it deliberately, and only then:

```sh
hasura metadata apply --endpoint $EP --skip-update-check
```

---

## Step 5 — verify the schema

Run the step 1 query again.

**Expected after**: six rows, every `confdeltype` = `c` (CASCADE).

---

## Step 6 — verify the delete through the app

This is the part the SQL layer cannot prove. #99 tested at the database. This tests the round
trip through Hasura under a real Tapis token.

1. Sign in at `https://mint.tacc.utexas.edu` (MFA needed).
2. Create a throwaway problem statement.
3. Delete it.
4. Reload the list. It must be gone.

Before, the delete returned success and changed nothing. A successful response is not proof —
you must see the row disappear after a reload.

Record the result on [#116](https://github.com/mintproject/monorepo/issues/116).

---

## What happened on 2026-08-10

The run against TACC production, for the next person:

1. `hasura migrate status` showed no drift. Every version through `1771200016000` was applied.
   `1771200017000` was the only one pending.
2. `hasura migrate apply` stalled at `0 / 1` for about five minutes. A second attempt was
   started in another shell and stalled behind the first.
3. `pg_blocking_pids` named one holder: a session `idle in transaction` for **100 days**,
   left over from a `COPY public.dataslice`.
4. `pg_cancel_backend` on the duplicate attempt, then `pg_terminate_backend` on the 100-day
   session. The first apply then took the lock and committed at once.
5. All six constraints read `confdeltype = c`.

Two lessons are already folded into the steps above: run step 1c first, and never start a
second apply.

The 100-day session was possible because `idle_in_transaction_session_timeout` is unset on that
database. That is a separate problem — it also stalled vacuum for 100 days.

---

## Rollback

```sh
hasura migrate apply $HC --version 1771200017000 --type down
```

This restores `ON DELETE RESTRICT` on all six constraints and removes the recorded version.
Delete goes back to being broken, which is where TACC was before this runbook.

---

## Appendix: the pod is still on the old image

Use this **only** if `dynamo#9` cannot be deployed. The migration directory is absent, so the
CLI has nothing to apply. Send the SQL over `run_sql` instead.

1. Copy the SQL from `graphql_engine` at `c274ce0`:
   `migrations/1771200017000_modeling_provenance_cascade_on_delete/up.sql`.
2. Send it as one `run_sql` call with `"read_only": false`. Keep the `BEGIN` / `COMMIT`.
3. Record the version by hand. Read the table shape first — do not assume the columns:

```sh
curl -s -X POST "$EP/v2/query" \
  -H "x-hasura-admin-secret: $HASURA_GRAPHQL_ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  --data-binary '{"type":"run_sql","args":{"source":"default","read_only":true,"sql":"SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='"'"'hdb_catalog'"'"' AND table_name='"'"'schema_migrations'"'"';"}}'
```

Then insert `1771200017000` into it, matching that shape, with `dirty` false.

4. Reload metadata as in step 4.

The recorded version is not optional. Without it, the next `hasura migrate apply` re-runs these
`ALTER`s and fails on the missing constraint names.
