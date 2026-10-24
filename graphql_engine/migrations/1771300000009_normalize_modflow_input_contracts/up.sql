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

-- All four supported MODFLOW families use the same semantic input contract.
-- Archive inputs contain the complete model package; WEL and RCH inputs are
-- explicit override candidates for problem formulation and adapter planning.
INSERT INTO public.modelcatalog_standard_variable
  (id, label, description, same_as)
VALUES
  (
    'https://w3id.org/okn/i/mint/wmobley-standard-variable-groundwater-model-simulation-archive',
    'groundwater_model__simulation_archive',
    'Optional ZIP archive containing a complete groundwater model simulation and support files.',
    NULL
  ),
  (
    'https://w3id.org/okn/i/mint/61e86974-f1bb-406c-ae52-f6c6eccb6c59',
    'groundwater_well__volume_flow_rate',
    NULL,
    NULL
  ),
  (
    'https://w3id.org/okn/i/mint/GROUNDWATER__RECHARGE_VOLUME_FLUX',
    'groundwater__recharge_volume_flux',
    NULL,
    NULL
  )
ON CONFLICT DO NOTHING;

-- Existing family archive presentations were registered without their SVO
-- mapping. Keep their stable IDs and make the mapping explicit.
UPDATE public.modelcatalog_variable_presentation
SET has_standard_variable =
  'https://w3id.org/okn/i/mint/wmobley-standard-variable-groundwater-model-simulation-archive'
WHERE id IN (
  'https://w3id.org/okn/i/mint/wmobley-modflow-2000-simulation-archive',
  'https://w3id.org/okn/i/mint/wmobley-modflow-6-simulation-archive',
  'https://w3id.org/okn/i/mint/wmobley-modflow-96-simulation-archive',
  'https://w3id.org/okn/i/mint/b08fd7d3-24c2-48cc-83be-a52b73fdf212'
);

INSERT INTO public.modelcatalog_variable_presentation
  (id, label, description, has_long_name, has_short_name, has_standard_variable, uses_unit)
VALUES
  (
    'https://w3id.org/okn/i/mint/wmobley-modflow-2000-wel-override',
    'MODFLOW 2000 well override',
    'Optional replacement MODFLOW 2000 WEL package input.',
    'MODFLOW 2000 well override',
    'wel_override',
    'https://w3id.org/okn/i/mint/61e86974-f1bb-406c-ae52-f6c6eccb6c59',
    NULL
  ),
  (
    'https://w3id.org/okn/i/mint/wmobley-modflow-2000-rch-override',
    'MODFLOW 2000 recharge override',
    'Optional replacement MODFLOW 2000 recharge package input.',
    'MODFLOW 2000 recharge override',
    'rch_override',
    'https://w3id.org/okn/i/mint/GROUNDWATER__RECHARGE_VOLUME_FLUX',
    NULL
  ),
  (
    'https://w3id.org/okn/i/mint/wmobley-modflow-96-wel-override',
    'MODFLOW 96 well override',
    'Optional replacement MODFLOW 96 WEL package input.',
    'MODFLOW 96 well override',
    'wel_override',
    'https://w3id.org/okn/i/mint/61e86974-f1bb-406c-ae52-f6c6eccb6c59',
    NULL
  ),
  (
    'https://w3id.org/okn/i/mint/wmobley-modflow-96-rch-override',
    'MODFLOW 96 recharge override',
    'Optional replacement MODFLOW 96 recharge package input.',
    'MODFLOW 96 recharge override',
    'rch_override',
    'https://w3id.org/okn/i/mint/GROUNDWATER__RECHARGE_VOLUME_FLUX',
    NULL
  ),
  (
    'https://w3id.org/okn/i/mint/wmobley-modflow-2005-simulation-archive',
    'MODFLOW 2005 simulation archive',
    'ZIP archive containing a complete MODFLOW 2005 simulation and support files.',
    'MODFLOW 2005 simulation archive',
    'simulation_archive',
    'https://w3id.org/okn/i/mint/wmobley-standard-variable-groundwater-model-simulation-archive',
    NULL
  )
ON CONFLICT (id) DO UPDATE
SET has_standard_variable = EXCLUDED.has_standard_variable;

INSERT INTO public.modelcatalog_dataset_specification
  (id, label, description, has_format, has_dimensionality, "position")
VALUES
  (
    'https://w3id.org/okn/i/mint/wmobley-modflow-2000-simulation-archive',
    'MODFLOW 2000 simulation archive',
    'ZIP archive containing a complete MODFLOW 2000 simulation and support files.',
    'zip',
    NULL,
    '1'
  ),
  (
    'https://w3id.org/okn/i/mint/wmobley-modflow-2000-wel-override',
    'MODFLOW 2000 well override',
    'Optional replacement MODFLOW 2000 WEL package input.',
    NULL,
    NULL,
    '3'
  ),
  (
    'https://w3id.org/okn/i/mint/wmobley-modflow-2000-rch-override',
    'MODFLOW 2000 recharge override',
    'Optional replacement MODFLOW 2000 recharge package input.',
    NULL,
    NULL,
    '2'
  ),
  (
    'https://w3id.org/okn/i/mint/wmobley-modflow-96-wel-override',
    'MODFLOW 96 well override',
    'Optional replacement MODFLOW 96 WEL package input.',
    NULL,
    NULL,
    '3'
  ),
  (
    'https://w3id.org/okn/i/mint/wmobley-modflow-96-rch-override',
    'MODFLOW 96 recharge override',
    'Optional replacement MODFLOW 96 recharge package input.',
    NULL,
    NULL,
    '2'
  ),
  (
    'https://w3id.org/okn/i/mint/wmobley-modflow-2005-simulation-archive',
    'MODFLOW 2005 simulation archive',
    'ZIP archive containing a complete MODFLOW 2005 simulation and support files.',
    'zip',
    NULL,
    '1'
  )
ON CONFLICT (id) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    has_format = EXCLUDED.has_format,
    "position" = EXCLUDED."position";

UPDATE public.modelcatalog_dataset_specification
SET has_format = 'zip', "position" = '1'
WHERE id = 'https://w3id.org/okn/i/mint/4cd57da2-9be9-440d-b6b4-5a4ca6edd370';

INSERT INTO public.modelcatalog_dataset_specification_presentation
  (dataset_specification_id, presentation_id)
VALUES
  ('https://w3id.org/okn/i/mint/wmobley-modflow-2000-simulation-archive', 'https://w3id.org/okn/i/mint/wmobley-modflow-2000-simulation-archive'),
  ('https://w3id.org/okn/i/mint/wmobley-modflow-2000-wel-override', 'https://w3id.org/okn/i/mint/wmobley-modflow-2000-wel-override'),
  ('https://w3id.org/okn/i/mint/wmobley-modflow-2000-rch-override', 'https://w3id.org/okn/i/mint/wmobley-modflow-2000-rch-override'),
  ('https://w3id.org/okn/i/mint/wmobley-modflow-96-wel-override', 'https://w3id.org/okn/i/mint/wmobley-modflow-96-wel-override'),
  ('https://w3id.org/okn/i/mint/wmobley-modflow-96-rch-override', 'https://w3id.org/okn/i/mint/wmobley-modflow-96-rch-override'),
  ('https://w3id.org/okn/i/mint/wmobley-modflow-2005-simulation-archive', 'https://w3id.org/okn/i/mint/wmobley-modflow-2005-simulation-archive')
ON CONFLICT DO NOTHING;

-- Older persistent catalogs may not contain the canonical MODFLOW 2000 and
-- MODFLOW 96 rows that are present in the fixture.  The input-contract
-- normalization below targets those stable IDs, so restore the parent rows
-- before adding their inputs.  Keep this idempotent for catalogs where the
-- rows already exist.
INSERT INTO public.modelcatalog_configuration
  (id, software_version_id, model_configuration_id, label, description,
   keywords, usage_notes, has_component_location,
   has_implementation_script_location, has_software_image,
   has_model_result_table, has_region, calibration_interval,
   calibration_method, parameter_assignment_method, valid_until, author_id)
VALUES
  (
    'https://w3id.org/okn/i/mint/90a6c0c2-a43b-4717-adb0-3a5a02737dc9',
    'https://w3id.org/okn/i/mint/f6b90f6f-1d66-4993-a3bf-5338fa76b383',
    NULL,
    'MODFLOW-2000 default configuration',
    'Default MF2000 configuration for Yegua-Jackson.',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  ),
  (
    'https://w3id.org/okn/i/mint/54a07d2a-c407-4f41-9c51-3245eabd2e61',
    'https://w3id.org/okn/i/mint/9fc65e72-413b-4e4e-b453-069efacefd69',
    NULL,
    'MODFLOW-96 default configuration',
    'Default MF96 configuration for Texas.',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  )
ON CONFLICT (id) DO NOTHING;

-- The same persistent-catalog gap can omit the canonical output metadata. Add
-- the fixture-equivalent specifications and presentations before linking them
-- to the repaired configurations.
INSERT INTO public.modelcatalog_dataset_specification
  (id, label, description, has_format, has_dimensionality, "position")
VALUES
  (
    'https://w3id.org/okn/i/mint/6b16c7bc-25ef-4afb-bc4b-35b10cc409c9',
    'Cell budget output', NULL, 'cbc-mf2000', NULL, 2
  ),
  (
    'https://w3id.org/okn/i/mint/9aadd1a3-cd8c-4f52-8eda-4b897e1d786f',
    'Drawdown output', NULL, 'ddn', NULL, 4
  ),
  (
    'https://w3id.org/okn/i/mint/d9caf5a9-335e-4883-a50b-699f387cf34a',
    'Hydraulic head output', NULL, 'hds', NULL, 3
  ),
  (
    'https://w3id.org/okn/i/mint/56acb8fe-9b53-4124-83c0-2b0025bf9361',
    'Cell-by-cell water budget',
    'Simulated volumetric inflow and outflow terms for groundwater budget accounting.',
    'cbc-mf96', NULL, NULL
  ),
  (
    'https://w3id.org/okn/i/mint/9381a5d1-41d4-4380-a43d-078586efeffc',
    'Groundwater hydraulic head',
    'Simulated groundwater hydraulic head from MODFLOW-96 output.',
    'hds', NULL, NULL
  ),
  (
    'https://w3id.org/okn/i/mint/dce0bbf7-c09e-4588-9ec2-cb4fd932a191',
    'Groundwater drawdown',
    'Simulated drawdown relative to initial or reference hydraulic head.',
    'ddn', NULL, NULL
  )
ON CONFLICT (id) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    has_format = EXCLUDED.has_format,
    "position" = EXCLUDED."position";

INSERT INTO public.modelcatalog_variable_presentation
  (id, label, description, has_long_name, has_short_name,
   has_standard_variable, uses_unit)
VALUES
  (
    'https://w3id.org/okn/i/mint/7e82b186-11ae-49ae-a2e0-fdd872d39cc4',
    'Cell budget presentation', NULL, 'Groundwater cell budget',
    'cell-budget', NULL, NULL
  ),
  (
    'https://w3id.org/okn/i/mint/2bddcbf0-6235-4dbd-b94a-6c3284d72897',
    'Drawdown presentation', NULL, 'Groundwater drawdown',
    'drawdown', NULL, NULL
  ),
  (
    'https://w3id.org/okn/i/mint/fedd3f44-4045-42fd-bbd0-a8c67ae2e1af',
    'Hydraulic head presentation', NULL, 'Groundwater hydraulic head',
    'hydraulic-head', NULL, NULL
  ),
  (
    'https://w3id.org/okn/i/mint/1d998c24-ea65-47b4-8526-e579898a6ed8',
    'Cell-by-cell water budget presentation', NULL,
    'Cell-by-cell water budget', 'cell-budget', NULL, NULL
  ),
  (
    'https://w3id.org/okn/i/mint/43ae2275-6ba6-408c-a737-7b48f29827e8',
    'Groundwater hydraulic head presentation', NULL,
    'Groundwater hydraulic head', 'hydraulic-head', NULL, NULL
  ),
  (
    'https://w3id.org/okn/i/mint/de1bc743-cbc0-4940-9933-124fb5f895ad',
    'Groundwater drawdown presentation', NULL, 'Groundwater drawdown',
    'drawdown', NULL, NULL
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.modelcatalog_dataset_specification_presentation
  (dataset_specification_id, presentation_id)
VALUES
  (
    'https://w3id.org/okn/i/mint/6b16c7bc-25ef-4afb-bc4b-35b10cc409c9',
    'https://w3id.org/okn/i/mint/7e82b186-11ae-49ae-a2e0-fdd872d39cc4'
  ),
  (
    'https://w3id.org/okn/i/mint/9aadd1a3-cd8c-4f52-8eda-4b897e1d786f',
    'https://w3id.org/okn/i/mint/2bddcbf0-6235-4dbd-b94a-6c3284d72897'
  ),
  (
    'https://w3id.org/okn/i/mint/d9caf5a9-335e-4883-a50b-699f387cf34a',
    'https://w3id.org/okn/i/mint/fedd3f44-4045-42fd-bbd0-a8c67ae2e1af'
  ),
  (
    'https://w3id.org/okn/i/mint/56acb8fe-9b53-4124-83c0-2b0025bf9361',
    'https://w3id.org/okn/i/mint/1d998c24-ea65-47b4-8526-e579898a6ed8'
  ),
  (
    'https://w3id.org/okn/i/mint/9381a5d1-41d4-4380-a43d-078586efeffc',
    'https://w3id.org/okn/i/mint/43ae2275-6ba6-408c-a737-7b48f29827e8'
  ),
  (
    'https://w3id.org/okn/i/mint/dce0bbf7-c09e-4588-9ec2-cb4fd932a191',
    'https://w3id.org/okn/i/mint/de1bc743-cbc0-4940-9933-124fb5f895ad'
  )
ON CONFLICT DO NOTHING;

-- Link the repaired output metadata to the canonical configurations so the
-- model browser can infer outcomes for MODFLOW 2000 and MODFLOW 96.
INSERT INTO public.modelcatalog_configuration_output
  (configuration_id, output_id)
VALUES
  (
    'https://w3id.org/okn/i/mint/90a6c0c2-a43b-4717-adb0-3a5a02737dc9',
    'https://w3id.org/okn/i/mint/6b16c7bc-25ef-4afb-bc4b-35b10cc409c9'
  ),
  (
    'https://w3id.org/okn/i/mint/90a6c0c2-a43b-4717-adb0-3a5a02737dc9',
    'https://w3id.org/okn/i/mint/9aadd1a3-cd8c-4f52-8eda-4b897e1d786f'
  ),
  (
    'https://w3id.org/okn/i/mint/90a6c0c2-a43b-4717-adb0-3a5a02737dc9',
    'https://w3id.org/okn/i/mint/d9caf5a9-335e-4883-a50b-699f387cf34a'
  ),
  (
    'https://w3id.org/okn/i/mint/54a07d2a-c407-4f41-9c51-3245eabd2e61',
    'https://w3id.org/okn/i/mint/56acb8fe-9b53-4124-83c0-2b0025bf9361'
  ),
  (
    'https://w3id.org/okn/i/mint/54a07d2a-c407-4f41-9c51-3245eabd2e61',
    'https://w3id.org/okn/i/mint/9381a5d1-41d4-4380-a43d-078586efeffc'
  ),
  (
    'https://w3id.org/okn/i/mint/54a07d2a-c407-4f41-9c51-3245eabd2e61',
    'https://w3id.org/okn/i/mint/dce0bbf7-c09e-4588-9ec2-cb4fd932a191'
  )
ON CONFLICT DO NOTHING;

-- MODFLOW 2000 and MODFLOW 96 previously exposed only generic file bundles.
-- The archive now carries the complete simulation, with explicit semantic
-- override candidates matching MF6.
DELETE FROM public.modelcatalog_configuration_input
WHERE configuration_id = 'https://w3id.org/okn/i/mint/90a6c0c2-a43b-4717-adb0-3a5a02737dc9'
  AND input_id IN (
    'https://w3id.org/okn/i/mint/afd525ba-a1a1-42f7-a743-2aeaf2891f42',
    'https://w3id.org/okn/i/mint/577fa3fa-6ce2-4b3e-ad07-9773daa49d4c'
  );

DELETE FROM public.modelcatalog_configuration_input
WHERE configuration_id = 'https://w3id.org/okn/i/mint/54a07d2a-c407-4f41-9c51-3245eabd2e61'
  AND input_id IN (
    'https://w3id.org/okn/i/mint/98325827-1b40-4a79-8fc1-599140badb9d',
    'https://w3id.org/okn/i/mint/626ff050-d44f-4d2f-b219-21130c69f517'
  );

INSERT INTO public.modelcatalog_configuration_input
  (configuration_id, input_id, is_optional)
VALUES
  ('https://w3id.org/okn/i/mint/90a6c0c2-a43b-4717-adb0-3a5a02737dc9', 'https://w3id.org/okn/i/mint/wmobley-modflow-2000-simulation-archive', FALSE),
  ('https://w3id.org/okn/i/mint/90a6c0c2-a43b-4717-adb0-3a5a02737dc9', 'https://w3id.org/okn/i/mint/wmobley-modflow-2000-rch-override', FALSE),
  ('https://w3id.org/okn/i/mint/90a6c0c2-a43b-4717-adb0-3a5a02737dc9', 'https://w3id.org/okn/i/mint/wmobley-modflow-2000-wel-override', FALSE),
  ('https://w3id.org/okn/i/mint/54a07d2a-c407-4f41-9c51-3245eabd2e61', 'https://w3id.org/okn/i/mint/4cd57da2-9be9-440d-b6b4-5a4ca6edd370', FALSE),
  ('https://w3id.org/okn/i/mint/54a07d2a-c407-4f41-9c51-3245eabd2e61', 'https://w3id.org/okn/i/mint/wmobley-modflow-96-rch-override', FALSE),
  ('https://w3id.org/okn/i/mint/54a07d2a-c407-4f41-9c51-3245eabd2e61', 'https://w3id.org/okn/i/mint/wmobley-modflow-96-wel-override', FALSE),
  ('https://w3id.org/okn/i/mint/modflow_2005_cfg', 'https://w3id.org/okn/i/mint/wmobley-modflow-2005-simulation-archive', FALSE)
ON CONFLICT DO NOTHING;

-- Correct the existing MODFLOW 2005 WEL semantic mapping. Its RCH mapping is
-- already correct and the package inputs remain available to the runtime.
UPDATE public.modelcatalog_variable_presentation
SET has_standard_variable =
  'https://w3id.org/okn/i/mint/61e86974-f1bb-406c-ae52-f6c6eccb6c59'
WHERE id = 'https://w3id.org/okn/i/mint/modflow2005_q';

END
$$;

COMMIT;
