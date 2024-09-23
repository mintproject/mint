Helm charts are configured to populate the database with initial data containing multiple regions. You can remove the regions by querying the database and deleting the regions. The following sections describe how to query the database and delete the regions.

## Open the database

To open the database, use the following command:

```bash
$ kubectl exec -ti $(kubectl get pod -l app=mint-hasura -o jsonpath='{.items[0].metadata.name}') -c hasura-db -- sh
```

## Query the database

To query the database, use the following command:

```bash
$ psql -U postgres -d hasura
```

The following SQL query will remove all region geometry that are not California:

```sql
SELECT
    rg.region_id
FROM
    region
INNER JOIN
    region_geometry rg
ON
    region.id = rg.region_id
WHERE
    region.parent_region_id IS NULL
    AND region.parent_region_id != 'california';
```

```sql
DELETE FROM region_geometry
USING region
WHERE region_geometry.region_id = region.id
AND region.parent_region_id != 'california';
```

The following SQL query will remove all region geometry that are not California and are not a child of California:

```sql
DELETE FROM region
WHERE  region.parent_region_id != 'california' AND region.id != 'california';
```

Delete all region that the id is not `california` and the `parent_region_id` is `NULL`:

```sql
DELETE FROM region
WHERE  region.parent_region_id IS NULL AND region.id != 'california';
```
