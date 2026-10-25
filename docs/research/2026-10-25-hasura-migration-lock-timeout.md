# Can a Hasura CLI migration set a lock timeout?

Research for [mintproject/monorepo#344](https://github.com/mintproject/monorepo/issues/344)
(part of #342). Date: 2026-10-25.

**Setup under study.** `graphql_engine/Dockerfile` builds from `hasura/graphql-engine:v2.10.2`
and installs the CLI from the `stable` branch `get.sh`, which fetches the latest release. On
2026-10-25 that is **v2.51.2**. `graphql_engine/config.yaml` is `version: 2`. A Kubernetes Job runs
`hasura migrate apply && hasura metadata apply` against the Hasura server endpoint.

Sources: hasura/graphql-engine at tag
[`v2.10.2`](https://github.com/hasura/graphql-engine/tree/v2.10.2) (server and the CLI of that
time) and [`v2.51.2`](https://github.com/hasura/graphql-engine/tree/v2.51.2) (the CLI the image
actually installs). Where both tags agree, links point at v2.10.2.

## Answers

| # | Question | Answer |
|---|----------|--------|
| 1 | Transport, transaction, batching | Each SQL migration file goes as **one `run_sql` request** to `/v2/query`. The server runs it in **one transaction**. Files are **not batched**: one request per file, then a separate request for the version row. |
| 2 | Can we set `lock_timeout`? | **Yes: put `SET LOCAL lock_timeout = '…';` as the first statement of `up.sql`.** No CLI flag and no Hasura server env var or source setting exists for it. A role/database setting or a libpq `options` parameter also works, but it hits every Hasura connection. |
| 3 | Version on failure | **Not recorded.** The CLI writes the `hdb_catalog.schema_migrations` row only after the SQL request succeeds. The SQL rolls back. No dirty row is written. |
| 4 | Does `run_sql` time out? | **No.** The server sets no statement or lock timeout, Warp sets no request timeout, and the CLI's HTTP client has no timeout. A blocked migration waits forever. |

## 1. How `migrate apply` sends SQL

- The migrate loop hands each migration to the database driver, then records the version:
  [`runMigrations` (v2.10.2)](https://github.com/hasura/graphql-engine/blob/v2.10.2/cli/migrate/migrate.go#L1212-L1250),
  [`runMigrations` (v2.51.2)](https://github.com/hasura/graphql-engine/blob/v2.51.2/cli/migrate/migrate.go#L1486-L1543).
- The driver sends the whole file body as one `PGRunSQLInput{SQL: body}`:
  [`HasuraDB.Run` (v2.10.2)](https://github.com/hasura/graphql-engine/blob/v2.10.2/cli/migrate/database/hasuradb/hasuradb.go#L225-L262),
  [`HasuraDB.Run` (v2.51.2)](https://github.com/hasura/graphql-engine/blob/v2.51.2/cli/migrate/database/hasuradb/hasuradb.go#L285-L320).
  The `bulk` object built in `Lock()` is used only for metadata steps, not for SQL files.
- The request type is `run_sql`:
  [`sourceops/postgres/run_sql.go`](https://github.com/hasura/graphql-engine/blob/v2.10.2/cli/internal/hasura/sourceops/postgres/run_sql.go#L14).
  With config v2 on a v2 server, the CLI picks the `/v2/query` client:
  [`GetMigrationsStateStore` (v2.10.2)](https://github.com/hasura/graphql-engine/blob/v2.10.2/cli/cli.go#L994).
- Server side, `runRunSQL` runs the text with `Q.multiQE` inside `runTx` / `runTxWithCtx`, so all
  statements in the file share one transaction. A DDL-looking body also goes through
  `withMetadataCheck`, which reads table/function metadata in the same transaction:
  [`RunSQL.hs` `runRunSQL` (v2.10.2)](https://github.com/hasura/graphql-engine/blob/v2.10.2/server/src-lib/Hasura/Backends/Postgres/DDL/RunSQL.hs#L186-L206),
  [`runTxWithMetadataCheck`](https://github.com/hasura/graphql-engine/blob/v2.10.2/server/src-lib/Hasura/Backends/Postgres/DDL/RunSQL.hs#L279-L300).
- The docs agree: "Statements are executed within a transaction block … If any statement fails,
  all changes are rolled back."
  ([run_sql API reference](https://hasura.io/docs/2.0/api-reference/schema-api/run-sql/)).

**Caveat on `--no-transaction`.** CLI v2.51.2 has `--no-transaction` and
`--per-migration-transaction` (with a `-- hasura:no-transaction` first-line marker):
[`migrate_apply.go`](https://github.com/hasura/graphql-engine/blob/v2.51.2/cli/commands/migrate_apply.go#L138-L147),
[`detectNoTransactionComment`](https://github.com/hasura/graphql-engine/blob/v2.51.2/cli/migrate/migrate.go#L1461-L1478).
They send `no_transaction: true`. The v2.10.2 server's `RunSQL` parser does not read that key, and
aeson drops unknown keys, so on our server the flag is **silently ignored**:
[`instance FromJSON RunSQL` (v2.10.2)](https://github.com/hasura/graphql-engine/blob/v2.10.2/server/src-lib/Hasura/Backends/Postgres/DDL/RunSQL.hs#L74-L82).
Do not rely on it until the server is upgraded.

## 2. Setting `lock_timeout` / `statement_timeout`

**Recommended: `SET LOCAL` at the top of `up.sql`.**

```sql
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';  -- optional
ALTER TABLE ...;
```

Why this works: the file is one transaction (section 1), so `SET LOCAL` holds for every later
statement in the file and resets at commit or rollback. It does not leak to other requests on the
pooled connection. The metadata-check reads that the server runs before the SQL touch only
`pg_catalog`, so they do not wait on table locks.
Postgres semantics: [`SET` — `LOCAL`](https://www.postgresql.org/docs/current/sql-set.html),
[`lock_timeout`](https://www.postgresql.org/docs/current/runtime-config-client.html#GUC-LOCK-TIMEOUT).
Do not use plain `SET`: it outlives the transaction and stays on a pooled server connection.

Other routes, and why they are weaker:

| Route | Exists? | Note |
|-------|---------|------|
| CLI flag on `hasura migrate apply` | No | No timeout flag in [`migrate_apply.go`](https://github.com/hasura/graphql-engine/blob/v2.51.2/cli/commands/migrate_apply.go). |
| Hasura server env var / source setting | No | Postgres pool settings have `idle_timeout`, `pool_timeout` (wait for a pool slot) and `connection_lifetime`; none is a statement or lock timeout: [`Connection/Settings.hs`](https://github.com/hasura/graphql-engine/blob/v2.10.2/server/src-lib/Hasura/Backends/Postgres/Connection/Settings.hs#L55-L80). A grep for `statement_timeout`/`lock_timeout` in `server/src-lib/Hasura/Backends/Postgres` at v2.10.2 finds nothing. |
| `ALTER ROLE hasura_user SET lock_timeout = ...` or `ALTER DATABASE ... SET` | Yes (Postgres) | Applies to every new Hasura connection, including GraphQL traffic. Acceptable for `lock_timeout` only if a short value cannot hurt normal queries. |
| `?options=-c%20lock_timeout%3D10s` in the database URL | Yes (libpq) | Same scope problem: all Hasura traffic. [libpq `options`](https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNECT-OPTIONS). |

`lock_timeout` is the right knob for the incident. A 100-day idle-in-transaction session held a
lock, and the migration's DDL queued behind it. `lock_timeout` fails that wait fast.
`idle_in_transaction_session_timeout` on the server would remove the root cause; it is a
Postgres setting, not a Hasura one.

## 3. Version record on failure or timeout

- `runMigrations` calls `Run`, returns on error, and calls `SetVersion(version, false)` only after
  success: [v2.10.2 L1237](https://github.com/hasura/graphql-engine/blob/v2.10.2/cli/migrate/migrate.go#L1237),
  [v2.51.2 L1526](https://github.com/hasura/graphql-engine/blob/v2.51.2/cli/migrate/migrate.go#L1526).
  No "dirty" row is written before the run.
- `SetVersion` is its own `run_sql`:
  `INSERT INTO hdb_catalog.schema_migrations (version, dirty) VALUES (…, 'false') ON CONFLICT …`
  ([`hdbtable.go` (v2.10.2)](https://github.com/hasura/graphql-engine/blob/v2.10.2/cli/internal/statestore/migrations/hdbtable.go#L41)).
- So a failed or timed-out migration leaves **no row**. Its SQL rolls back. Earlier files in the
  same `apply` that already succeeded stay applied and recorded. The next `apply` retries the
  failed file.
- Gap: SQL commit and version insert are two transactions. If the job dies between them, the SQL
  is applied but unrecorded, and a retry re-runs it. Idempotent DDL (`IF NOT EXISTS`) guards this.

## 4. Does `run_sql` have its own timeout?

No.

- Server: no statement/lock timeout is set (section 2). Warp is configured with port, host and a
  30 s graceful-shutdown timeout only:
  [`App.hs` (v2.10.2)](https://github.com/hasura/graphql-engine/blob/v2.10.2/server/src-lib/Hasura/App.hs#L573-L578).
- CLI: `http.Client{Transport: tr}` with no `Timeout`:
  [`httpc.go` (v2.10.2)](https://github.com/hasura/graphql-engine/blob/v2.10.2/cli/internal/httpc/httpc.go#L186).
  The 30 s context in `cli.go` covers only the server-config fetch.
- The [run_sql docs](https://hasura.io/docs/2.0/api-reference/schema-api/run-sql/) mention no
  timeout.

**Not verified:** whether the v2.10.2 server cancels the Postgres query when the CLI disconnects
(for example, when a Job `activeDeadlineSeconds` kills the pod). Assume it does not; a
server-side `lock_timeout` is the reliable bound.
