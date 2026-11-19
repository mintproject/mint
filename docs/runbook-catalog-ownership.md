# Runbook: catalog ownership and admins

Who may change a row in the model catalog, and how an operator manages owners and admins.

## The rules

| Row | Who may edit | Who may delete |
|---|---|---|
| Software | owner, admin | owner, unless another user's Version or Configuration is under it; admin |
| Software Version | owner, admin | owner, unless another user's Configuration is under it; admin |
| Configuration | owner, admin | owner, unless it has setups; admin |
| Inputs, outputs, authors, categories, regions and the other link rows | owner of the parent row, admin | the same |
| Parameter | owner of the configuration that uses it, if no other user's configuration uses it; admin | the same |
| ETL piece | nobody; a changed piece is a new piece | owner, admin |

- The owner is set by the server from the caller's token when the row is created. A client
  cannot name it.
- Any signed-in user may add a Version under any Software, and a Configuration under any
  Version. The new row is theirs.
- An owner cannot give a row away or leave it without an owner. Only an admin changes
  `owner_username`.
- A row with no owner is read-only for ordinary users.
- A user cannot link another user's parameter to their own configuration.
- Because anyone may add a row under a shared model, an owner can be left unable to
  delete their own Software or Version: someone else's row is under it. Only an admin can
  then delete it. This is accepted so that one user can never remove another's work.
- The shared lookup tables (people, regions, dataset specifications, standard variables,
  units and similar) are not covered. Any signed-in user can still edit and delete them.
- Everyone can read every Software, Version and Configuration row.

The rules live in `graphql_engine/metadata/tables.yaml`. The REST API
(`model-catalog-api`) forwards the caller's token and returns `403` when the catalog
refuses an update or delete, and `404` when the row does not exist.

## Admins

An admin is a username in the table `modelcatalog_admin`. Admins keep the ordinary role;
the permission rules look them up in that table. Only the Hasura admin secret can change
the table. A signed-in user can read their own row and no one else's.

The username must match the Tapis username exactly, including case.

All statements below run with the admin secret, through the Hasura console's SQL tab or
`psql`.

Add an admin:

```sql
INSERT INTO modelcatalog_admin (username) VALUES ('<tapis username>');
```

Remove an admin:

```sql
DELETE FROM modelcatalog_admin WHERE username = '<tapis username>';
```

List admins:

```sql
SELECT username, created_at FROM modelcatalog_admin ORDER BY username;
```

## Rows without an owner

Rows that existed before migration `1771300000040` have no owner. The migration assigns
none: the catalog has no record of who registered a Software or Version row, and guessing
from the configurations underneath would hand a shared model to whoever added the only
configuration.

List what a guess would assign, for review. A row appears only when every configuration
under it has the same single owner:

```sql
SELECT v.id AS version_id, v.label, min(c.owner_username) AS proposed_owner, count(*) AS configurations
  FROM modelcatalog_software_version v
  JOIN modelcatalog_configuration c ON c.software_version_id = v.id
 WHERE v.owner_username IS NULL
 GROUP BY v.id, v.label
HAVING count(*) = count(c.owner_username) AND count(DISTINCT c.owner_username) = 1
 ORDER BY proposed_owner, v.label;
```

Assign the rows you agree with, one statement each, as below.

Count them:

```sql
SELECT 'software' AS level, count(*) FROM modelcatalog_software WHERE owner_username IS NULL
UNION ALL
SELECT 'version', count(*) FROM modelcatalog_software_version WHERE owner_username IS NULL;
```

Assign one. An admin can do this through the API as well, with their own token:

```sql
UPDATE modelcatalog_software SET owner_username = '<tapis username>' WHERE id = '<software id>';
UPDATE modelcatalog_software_version SET owner_username = '<tapis username>' WHERE id = '<version id>';
```

## Reassigning an ETL piece

```sql
UPDATE modelcatalog_etl_process SET owner_username = '<new owner>' WHERE id = '<piece id>';
```

Then run the adapter's catalog sync. The adapter keeps its own copy of each piece's owner
and decides from that copy whether a piece is the caller's own. Until the sync runs, the
adapter still treats the previous owner as the owner.

The new owner runs the piece without the approval step, as they would a piece they
registered. Reassign a piece only to someone who has agreed to take it.

## Rollback

Apply the metadata from the previous commit first, then roll the migration back through
Hasura, then reload:

```bash
cd graphql_engine
git checkout <previous commit> -- metadata/tables.yaml
hasura metadata apply
hasura migrate apply --down 1
hasura metadata reload
```

The order matters. The new metadata sets the owner on every insert, so it must go before
the columns do. The reload is needed too: without it Hasura still selects the dropped
column and every insert into Software fails. This sequence was tested locally.

Rolling back reopens the original rules: any signed-in user can again edit and delete any
Software or Version row. Owner assignments and the admin list are lost.
