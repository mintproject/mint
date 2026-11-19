BEGIN;

-- A flow is a model configuration that runs a graph of ETL pieces instead of a Tapis
-- app. A configuration is a flow when it has a row here; that row is the only marker.
CREATE TABLE modelcatalog_configuration_flow (
    configuration_id TEXT PRIMARY KEY
        REFERENCES modelcatalog_configuration(id) ON DELETE CASCADE,
    -- Which outputs of which steps are the flow's outputs:
    --   [{"step": 3, "output": 1, "output_id": "<dataset specification id>"},
    --    {"step": 1, "value": "job_uuid"}, {"step": 3, "record": "catalog"}]
    outputs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Which inputs and settings the thread's region and dates fill in:
    --   {"region": {"input": "<id>"}, "start_date": {"parameter": "<id>"}, ...}
    thread_bindings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT configuration_flow_outputs_is_array CHECK (jsonb_typeof(outputs_json) = 'array'),
    CONSTRAINT configuration_flow_outputs_size CHECK (jsonb_array_length(outputs_json) <= 64),
    CONSTRAINT configuration_flow_bindings_is_object CHECK (jsonb_typeof(thread_bindings_json) = 'object')
);

CREATE TABLE modelcatalog_configuration_step (
    configuration_id TEXT NOT NULL
        REFERENCES modelcatalog_configuration_flow(configuration_id) ON DELETE CASCADE,
    -- Steps are numbered in an order they can run in: a step reads only from the flow's
    -- inputs and from steps with a lower position, so the graph cannot contain a loop.
    position INTEGER NOT NULL,
    -- SET NULL, not RESTRICT: a flow must never stop a piece's owner deleting the piece.
    -- The flow is left with an empty step and is refused as unavailable.
    etl_process_id TEXT REFERENCES modelcatalog_etl_process(id) ON DELETE SET NULL,
    -- Default values for the piece's run arguments, by argument name.
    settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- What this step receives, one entry per link:
    --   {"to": {"input": 1},        "from": {"flow_input": "<dataset specification id>"}}
    --   {"to": {"input": 2},        "from": {"step": 1, "output": 1}}
    --   {"to": {"setting": "name"}, "from": {"step": 1, "value": "manifest_name"}}
    --   {"to": {"setting": "name"}, "from": {"flow_parameter": "<parameter id>"}}
    --   {"to": {},                  "from": {"step": 2}}          -- runs after step 2
    wires_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- The run stops after this step for the user to edit its output.
    pause_after BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (configuration_id, position),
    CONSTRAINT configuration_step_position_check CHECK (position >= 1 AND position <= 24),
    CONSTRAINT configuration_step_settings_is_object CHECK (jsonb_typeof(settings_json) = 'object'),
    CONSTRAINT configuration_step_wires_is_array CHECK (jsonb_typeof(wires_json) = 'array'),
    CONSTRAINT configuration_step_wires_size CHECK (jsonb_array_length(wires_json) <= 64)
);

-- A flow is written whole and never changed in place: its steps are added in the
-- transaction that creates it, and at no other time. Without this the owner of a flow
-- that other people run could slip a new piece into a free position.
CREATE FUNCTION modelcatalog_configuration_step_only_with_its_flow() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM modelcatalog_configuration_flow f
         WHERE f.configuration_id = NEW.configuration_id
           AND f.created_at = now()   -- now() is the start of the current transaction
    ) THEN
        RAISE EXCEPTION 'a step can only be added when its flow is created'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER configuration_step_only_with_its_flow
    BEFORE INSERT ON modelcatalog_configuration_step
    FOR EACH ROW EXECUTE FUNCTION modelcatalog_configuration_step_only_with_its_flow();

COMMENT ON TABLE modelcatalog_configuration_flow IS
    'Marks a model configuration as a flow of ETL pieces. The graph is checked by the SVO adapter when the flow is registered and again when it is planned.';
COMMENT ON COLUMN modelcatalog_configuration_step.etl_process_id IS
    'The piece run at this step. NULL after the piece was deleted: the flow is unavailable.';

CREATE INDEX idx_mc_configuration_step_process ON modelcatalog_configuration_step(etl_process_id);

COMMIT;
