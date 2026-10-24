BEGIN;

-- This is a data repair. On a cold start it runs before the catalog rows
-- exist: `hasura migrate apply` runs first, and the catalog loads after it.
-- The statements below reference catalog rows, so they fail on an empty
-- catalog. An empty catalog has nothing to repair, so the block returns.
DO $$
BEGIN
IF NOT EXISTS (SELECT 1 FROM public.modelcatalog_configuration) THEN
  RETURN;
END IF;

INSERT INTO public.modelcatalog_standard_variable
  (id, label, description, same_as)
VALUES (
  'https://w3id.org/okn/i/mint/wmobley-standard-variable-groundwater-model-simulation-archive',
  'groundwater_model__simulation_archive',
  'Optional ZIP archive containing a full MODFLOW 6 simulation and support files.',
  NULL
)
ON CONFLICT DO NOTHING;

INSERT INTO public.modelcatalog_variable_presentation
  (id, label, description, has_long_name, has_short_name, has_standard_variable, uses_unit)
VALUES (
  'https://w3id.org/okn/i/mint/wmobley-modflow-6-simulation-archive',
  'MODFLOW 6 simulation archive',
  'Optional ZIP archive containing a full MODFLOW 6 simulation and support files.',
  'MODFLOW 6 simulation archive',
  'simulation_archive',
  'https://w3id.org/okn/i/mint/wmobley-standard-variable-groundwater-model-simulation-archive',
  NULL
)
ON CONFLICT (id) DO UPDATE
SET has_standard_variable = EXCLUDED.has_standard_variable;

INSERT INTO public.modelcatalog_dataset_specification
  (id, label, description, has_format, has_dimensionality, "position")
VALUES (
  'https://w3id.org/okn/i/mint/wmobley-modflow-6-simulation-archive',
  'MODFLOW 6 simulation archive',
  'ZIP archive containing a full MODFLOW 6 simulation and support files.',
  'zip',
  NULL,
  '1'
)
ON CONFLICT DO NOTHING;

INSERT INTO public.modelcatalog_dataset_specification_presentation
  (dataset_specification_id, presentation_id)
VALUES (
  'https://w3id.org/okn/i/mint/wmobley-modflow-6-simulation-archive',
  'https://w3id.org/okn/i/mint/wmobley-modflow-6-simulation-archive'
)
ON CONFLICT DO NOTHING;

DELETE FROM public.modelcatalog_configuration_input
WHERE configuration_id =
  'https://w3id.org/okn/i/mint/ce445698-1d76-4833-95e8-a12eb3da2488'
  AND input_id = 'https://w3id.org/okn/i/mint/89dc3d46-625b-4929-9732-c91bd0bdd28d';

INSERT INTO public.modelcatalog_configuration_input
  (configuration_id, input_id, is_optional)
VALUES (
  'https://w3id.org/okn/i/mint/ce445698-1d76-4833-95e8-a12eb3da2488',
  'https://w3id.org/okn/i/mint/wmobley-modflow-6-simulation-archive',
  FALSE
)
ON CONFLICT DO NOTHING;

END
$$;

COMMIT;
