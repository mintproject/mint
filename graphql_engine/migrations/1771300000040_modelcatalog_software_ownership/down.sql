BEGIN;

DROP TABLE IF EXISTS modelcatalog_admin;

DROP INDEX IF EXISTS idx_mc_software_version_owner;
DROP INDEX IF EXISTS idx_mc_software_owner;

ALTER TABLE modelcatalog_software_version DROP COLUMN IF EXISTS owner_username;
ALTER TABLE modelcatalog_software DROP COLUMN IF EXISTS owner_username;

COMMIT;
