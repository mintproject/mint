# Owner-scoped writes on catalog Software and Version rows

## Status

Implementing. Approved by the user on 2026-11-19 ("Ok do the ownership fix"). Built and
tested locally on branch `fix/catalog-software-ownership`; not yet pushed or deployed.

## Objective

Stop any signed-in user from editing or deleting another user's Software or Software
Version row in the model catalog, and from deleting other users' configurations by
deleting the row above them.

## User need

A user who registers a model expects that only they, or an operator, can change or remove
it. The same must hold for flows if they are stored in these tables
(see `2026-11-19-public-flows-in-mint.md`).

## Current code/system summary

Checked on `develop` at 3732e7b, in `graphql_engine/metadata/tables.yaml`.

| Table | Insert | Update | Delete |
|---|---|---|---|
| `modelcatalog_software` | any user | any user | any user |
| `modelcatalog_software_version` | any user | any user | any user |
| The nine child link tables of those two (authors, categories, processes, grids, images, input and output variables) | any user | - | any user |
| `modelcatalog_configuration` | owner preset | owner | owner, if it has no setups |

- `modelcatalog_software` and `modelcatalog_software_version` have no `owner_username`
  column. Configurations gained one in migration `1771200026000`, and owner-only writes in
  commit 1a710b6.
- `software_version.software_id` and `configuration.software_version_id` are
  `ON DELETE CASCADE`. Deleting a Software row removes every version and every
  configuration under it, whoever owns them.
- `model-catalog-api` forwards the caller's token to Hasura on writes and adds no check of
  its own. Hasura is the only enforcement point.
- `ui-react` creates Software and Version rows in two mutations
  (`ui-react/src/graphql/mutations/model-catalog.graphql`, `CreateModel…` and
  `CreateModelFamily`). Neither sends an owner for the Software or Version row.
- There is no per-user admin role. Every Tapis user is Hasura role `user`. "Admin" means
  the Hasura admin secret.

## Proposed design

1. **Owner column.** Add `owner_username TEXT` to `modelcatalog_software` and
   `modelcatalog_software_version`, with an index on each.
2. **Owner is set by the server.** The insert permission presets
   `owner_username` from `X-Hasura-User-Id`. The column is not in the insert or update
   column lists, so a caller can neither claim a row for someone else nor hand one over.
   No change to the UI mutations is needed.
3. **Update is owner only**, on both tables.
4. **Delete is owner only, and never removes someone else's work.** The owner may delete
   a Software or Version row only when no configuration under it belongs to another user
   or has no owner.
5. **Adding under someone else's row stays open.** Any user may add a Version under any
   Software, and a Configuration under any Version, as they can today. The new row is
   theirs. Registering your own configuration of a shared model is existing behaviour and
   is kept.
6. **Child link tables follow the parent.** Insert and delete on the nine link tables
   require owning the parent Software or Version row.
7. **Existing rows have no owner.** They become read-only for role `user`. An admin
   assigns owners after the deploy. As approved, this point also assigned a row to the
   single owner of every configuration under it; that was removed after the security
   review (see Decisions).

8. **Named admin accounts.** A new table `modelcatalog_admin(username)` lists the admin
   usernames. Only the admin secret can write it; every user can read it. Each update and
   delete rule becomes "the caller owns the row, or the caller is in the admin table"
   (Hasura `_exists`). The sign-in webhook is an external Tapis image that returns
   identity only, so the role is not assigned there. Admins stay Hasura role `user`.
9. **An admin may change the owner of a Software, Version, Configuration or ETL piece.**
   Nobody else may. An owner cannot give a row away: the adapter runs a caller's own
   pieces without approval, so an owner-assigned transfer would put unreviewed code into
   the recipient's trusted set without their consent. An offer that the recipient accepts
   is left as a later change.

## Files likely affected

- `graphql_engine/migrations/<next>_modelcatalog_software_ownership/{up,down}.sql`
- `graphql_engine/metadata/tables.yaml`
- `graphql_engine/tests/test_catalog_software_owner_scoped_writes.py` (new)
- `ui-react/src/graphql/` generated types, if the UI needs to read the owner to hide
  edit and delete controls
- DSO-Architecture docs: the model catalog service page

## API/schema changes

- Two new nullable columns, readable by every role.
- Role `user` loses update and delete on Software and Version rows it does not own, and
  insert and delete on their link rows.
- REST API: `PUT` and `DELETE` on another user's Software or Version now affect no row.
  The response for that case is checked in the test plan.

## Data flow

Unchanged. Hasura evaluates the new filters against the caller's token on every write.

## Risks and tradeoffs

- **Unowned rows are frozen for ordinary users.** Intended. The backfill in point 7
  limits how many rows this touches; the count on dev and production is reported before
  the migration runs.
- **A script that writes as a user to a row it does not own will start failing.**
  `register_to_mint.py` and the MCP servers are checked in the test plan.
- **Hasura reports a refused update or delete as zero affected rows, not as an error.**
  Callers that do not check the count will report success. The REST API's behaviour is
  tested and fixed if it reports success.
- **A user can still add a version or a configuration under someone else's model.** Kept
  on purpose (point 5). It lets them attach content to a model page; it does not let them
  change or remove anything.

## Alternatives considered

- **Admin only for all Software and Version writes.** Simplest, but users could no longer
  register a model family from the UI.
- **Owner on Software only, versions inherit.** Fewer columns, but a user who adds a
  version under a shared model could not then edit their own version.
- **`ON DELETE RESTRICT` instead of the delete filter.** Stops the cascade for the admin
  secret too, which operators rely on for cleanup.

## Test plan

- Metadata tests for each permission in the table above, in the style of
  `test_catalog_owner_scoped_writes.py`.
- Migration applied and rolled back on a local Postgres restored from
  `backups/production-backup.sql`; count of rows left without an owner reported.
- On dev, with two accounts: the owner edits and deletes their own row; the second
  account can do neither; the second account can add a configuration under the first
  account's version; deleting a Software row that holds another user's configuration is
  refused; the registration screens still create a model.
- `register_to_mint.py` dry run and the catalog MCP tools against dev.

## Documentation plan

- `docs/runbook-catalog-ownership.md` (new): the rules, admins, unowned rows, reassigning
  a piece, rollback.
- DSO-Architecture: model catalog service page, permissions section.

## Rollout/rollback plan

- Merge to `develop`; the dev deploy applies the migration and metadata.
- Rollback: the down migration drops the two columns and the previous metadata is
  reapplied. No data is lost; owner assignments are.
- Production follows the normal `develop` to `main` release.

## Open questions

1. Is point 5 right: may any user add a Version under someone else's Software? Built as
   yes.
2. The UI still shows edit and delete controls on rows the user does not own. Hiding
   them is a follow-up.
3. `modelcatalog_dataset_specification`, `modelcatalog_person` and the other shared
   lookup tables are still editable and deletable by any signed-in user. Deleting a
   dataset specification removes it from every configuration that uses it. Not in this
   change.

## Decisions

- 2026-11-19: Raised by the user: "the deleting software and etc by anyone seems like a
  security flaw." Treated as its own change, ahead of flows.

- 2026-11-19: Ownership transfer is admin only. User: "allow it for the admin." The user
  asked why an owner could not give ownership away; the reason is in point 9.
- 2026-11-19: Any user may add a Version under another user's Software, and named admin
  accounts are in scope. Assistant's defaults, stated to the user; not yet confirmed.

- 2026-11-19, deviations from the approved text:
  - **Admins also cover Configurations, their parameter and input/output links, and
    pieces.** The text named only Software and Version for points 3 and 4. "Admins have
    privilege overall" was the user's question, so every owner rule gained the admin
    clause.
  - **The update check carries `_is_null: false`.** Found in the local test: Hasura lets a
    post-update check through when the comparison is NULL, so an owner could blank
    `owner_username`. Fixed and tested.
  - **`owner_username` is in the update columns.** It has to be, for an admin to reassign
    a row. The post-update check is what stops an owner.
  - **A piece gained an update permission**, for `owner_username` only and for admins
    only. Pieces are otherwise still not editable. The adapter needs a catalog sync after
    a reassignment (runbook).
  - **The REST API reported refused writes as success.** `PUT` and `DELETE` returned 200
    and 202 when the catalog changed nothing. Now 403, or 404 when the row is missing.
    This was already true for configurations since commit 1a710b6.
  - **The count of unowned rows on dev was not taken.** Anonymous readers cannot see
    `owner_username`. It is taken after the deploy (runbook query).
  - **Tested on a local Postgres and Hasura from the repo's images**, not on a restore of
    `backups/production-backup.sql`.
- 2026-11-19, changes after an independent security review of the first build:
  - **The Configuration link tables were still open.** Authors, categories, regions, time
    intervals, causal diagrams and the two calibration tables let any user add or remove
    links on another user's configuration, and a refused REST `PUT` still committed those
    link changes. All seven now require owning the configuration, and a test fails if a
    new `modelcatalog_configuration_*` table is left open.
  - **A parameter could be taken over.** A user could link another user's parameter to
    their own configuration, which satisfied the edit and delete rule. The rule now also
    requires that no other user's configuration uses the parameter, and the link itself is
    refused. The two parameter link tables are scoped the same way.
  - **Point 7's automatic owner assignment is removed.** It would give a shared model to
    whoever added its only configuration, and a user could arrange that before the
    migration ran. The migration now assigns nothing; the runbook has a query that lists
    the same proposals for an admin to review and apply. This reverses part of what the
    user approved and is flagged to them.
  - **Users can read only their own row of the admin table**, not the list of admins.
  - **Rollback order corrected and tested**: old metadata, down migration, reload.
  - **A refused nested write returns 403** from the REST API, not a constraint error.
  - **Accepted, documented in the runbook:** an owner can be blocked from deleting their
    own Software or Version by another user's row under it; only an admin can then delete.
  - Verified live: an upsert cannot overwrite or take over another user's Software,
    Version, Configuration or parameter.

## User feedback / decisions

- 2026-11-19: "ok so a different author can add a child? Admins have privilege overall?
  and Can we switch authors of pieces?" Answered: yes; yes through the admin secret, with
  named admin accounts added as point 8; transfer added as point 9.
