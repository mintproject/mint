BEGIN;
ALTER TABLE modelcatalog_configuration_input
    DROP COLUMN app_input_name;
COMMIT;
