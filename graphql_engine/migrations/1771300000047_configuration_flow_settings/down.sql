ALTER TABLE modelcatalog_configuration_flow
    DROP CONSTRAINT IF EXISTS configuration_flow_settings_is_object,
    DROP COLUMN IF EXISTS settings_json;
