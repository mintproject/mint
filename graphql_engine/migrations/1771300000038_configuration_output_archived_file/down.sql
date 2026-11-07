BEGIN;
ALTER TABLE modelcatalog_configuration_output
    DROP COLUMN archived_file;
COMMIT;
