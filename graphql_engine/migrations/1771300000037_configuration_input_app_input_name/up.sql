BEGIN;
ALTER TABLE modelcatalog_configuration_input
    ADD COLUMN app_input_name TEXT;
COMMENT ON COLUMN modelcatalog_configuration_input.app_input_name IS
    'Name of the Tapis app file input that this dataset specification feeds in this configuration. NULL when the input is not bound to an app file input.';
COMMIT;
