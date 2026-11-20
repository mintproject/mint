-- Flow-level choices the author makes about each setting, by setting name:
--   {"match_mode": {"visibility": "shown"}, "output_uri": {"visibility": "hidden", "fixed": true}}
-- visibility is shown, advanced or hidden. Values stay in each step's settings_json and
-- are mirrored onto the flow's parameter rows. It sits on the flow, not on a step,
-- because one setting name used by several steps is one flow parameter.
ALTER TABLE modelcatalog_configuration_flow
    ADD COLUMN settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD CONSTRAINT configuration_flow_settings_is_object CHECK (jsonb_typeof(settings_json) = 'object');
