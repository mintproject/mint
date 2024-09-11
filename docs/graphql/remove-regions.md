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
    AND region.parent_region_id != 'texas';
```

```sql
DELETE FROM region_geometry
USING region
WHERE region_geometry.region_id = region.id
AND region.parent_region_id != 'texas';
```

The following SQL query will remove all region geometry that are not California and are not a child of California:

```sql
DELETE FROM region
WHERE  region.parent_region_id != 'texas' AND region.id != 'texas';
```

Delete all region that the id is not `texas` and the `parent_region_id` is `NULL`:

```sql
DELETE FROM region
WHERE  region.parent_region_id IS NULL AND region.id != 'texas';
```
