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

INSERT INTO public.modelcatalog_standard_variable (id, label, description, same_as)
VALUES
  (
    'https://w3id.org/okn/i/mint/wmobley-standard-variable-aquifer-system-volumetric-budget',
    'aquifer_system__volumetric_budget',
    'Simulated volumetric inflow and outflow terms for groundwater budget accounting.',
    NULL
  ),
  (
    'https://w3id.org/okn/i/mint/wmobley-standard-variable-groundwater-drawdown',
    'groundwater__drawdown',
    'Reduction in groundwater hydraulic head relative to a reference condition.',
    NULL
  ),
  (
    'https://w3id.org/okn/i/mint/wmobley-standard-variable-groundwater-hydraulic-head',
    'groundwater__hydraulic_head',
    'Groundwater hydraulic head produced by a groundwater model.',
    NULL
  )
ON CONFLICT DO NOTHING;

-- Make the canonical MODFLOW 2005 inputs explicit in the catalog while
-- retaining their existing dataset IDs and runtime package relationships.
UPDATE public.modelcatalog_dataset_specification
SET label = 'MODFLOW 2005 well override',
    description = 'Required MODFLOW 2005 WEL input; the problem formulation may replace it with a compatible well-flow dataset.'
WHERE id = 'https://w3id.org/okn/i/mint/modflow_2005_Well';

UPDATE public.modelcatalog_dataset_specification
SET label = 'MODFLOW 2005 recharge override',
    description = 'Required MODFLOW 2005 RCH input; the problem formulation may replace it with a compatible recharge-flux dataset.'
WHERE id = 'https://w3id.org/okn/i/mint/modflow_2005_Rech';

UPDATE public.modelcatalog_variable_presentation
SET label = 'MODFLOW 2005 well override',
    description = 'MODFLOW 2005 well-flow input.',
    has_long_name = 'MODFLOW 2005 well override',
    has_short_name = 'wel_override',
    has_standard_variable = 'https://w3id.org/okn/i/mint/61e86974-f1bb-406c-ae52-f6c6eccb6c59'
WHERE id = 'https://w3id.org/okn/i/mint/modflow2005_q';

UPDATE public.modelcatalog_variable_presentation
SET label = 'MODFLOW 2005 recharge override',
    description = 'MODFLOW 2005 recharge-flux input.',
    has_long_name = 'MODFLOW 2005 recharge override',
    has_short_name = 'rch_override',
    has_standard_variable = 'https://w3id.org/okn/i/mint/GROUNDWATER__RECHARGE_VOLUME_FLUX'
WHERE id = 'https://w3id.org/okn/i/mint/modflow2005_rech';

-- Normalize output file formats and descriptions for the canonical family
-- configurations. CBC formats are consumed by the version-specific adapter
-- planner; HDS/DDN/LST identify the other native MODFLOW output files.
UPDATE public.modelcatalog_dataset_specification
SET label = 'MODFLOW 2000 cell-by-cell budget',
    description = 'MODFLOW 2000 cell-by-cell groundwater budget output.',
    has_format = 'cbc-mf2000'
WHERE id = 'https://w3id.org/okn/i/mint/6b16c7bc-25ef-4afb-bc4b-35b10cc409c9';

UPDATE public.modelcatalog_dataset_specification
SET label = 'MODFLOW 2000 drawdown',
    description = 'MODFLOW 2000 groundwater drawdown output.',
    has_format = 'ddn'
WHERE id = 'https://w3id.org/okn/i/mint/9aadd1a3-cd8c-4f52-8eda-4b897e1d786f';

UPDATE public.modelcatalog_dataset_specification
SET label = 'MODFLOW 2000 hydraulic head',
    description = 'MODFLOW 2000 groundwater hydraulic-head output.',
    has_format = 'hds'
WHERE id = 'https://w3id.org/okn/i/mint/d9caf5a9-335e-4883-a50b-699f387cf34a';

UPDATE public.modelcatalog_dataset_specification
SET label = 'MODFLOW 96 cell-by-cell budget',
    description = 'MODFLOW 96 cell-by-cell groundwater budget output.',
    has_format = 'cbc-mf96'
WHERE id = 'https://w3id.org/okn/i/mint/56acb8fe-9b53-4124-83c0-2b0025bf9361';

UPDATE public.modelcatalog_dataset_specification
SET label = 'MODFLOW 96 drawdown',
    description = 'MODFLOW 96 groundwater drawdown output.',
    has_format = 'ddn'
WHERE id = 'https://w3id.org/okn/i/mint/dce0bbf7-c09e-4588-9ec2-cb4fd932a191';

UPDATE public.modelcatalog_dataset_specification
SET label = 'MODFLOW 96 hydraulic head',
    description = 'MODFLOW 96 groundwater hydraulic-head output.',
    has_format = 'hds'
WHERE id = 'https://w3id.org/okn/i/mint/9381a5d1-41d4-4380-a43d-078586efeffc';

UPDATE public.modelcatalog_dataset_specification
SET label = 'MODFLOW 2005 cell-by-cell budget',
    description = 'MODFLOW 2005 cell-by-cell groundwater budget output.',
    has_format = 'cbc-mf2005'
WHERE id = 'https://w3id.org/okn/i/mint/modflow_2005_cbb';

UPDATE public.modelcatalog_dataset_specification
SET label = 'MODFLOW 2005 drawdown',
    description = 'MODFLOW 2005 groundwater drawdown output.',
    has_format = 'ddn'
WHERE id = 'https://w3id.org/okn/i/mint/modflow_2005_ddown';

UPDATE public.modelcatalog_dataset_specification
SET label = 'MODFLOW 2005 hydraulic head',
    description = 'MODFLOW 2005 groundwater hydraulic-head output.',
    has_format = 'hds'
WHERE id = 'https://w3id.org/okn/i/mint/modflow_2005_heads';

UPDATE public.modelcatalog_dataset_specification
SET label = 'MODFLOW 2005 listing',
    description = 'MODFLOW 2005 listing output containing model budget summaries.',
    has_format = 'lst'
WHERE id = 'https://w3id.org/okn/i/mint/modflow_2005_list';

UPDATE public.modelcatalog_dataset_specification
SET label = 'MODFLOW 6 cell-by-cell budget',
    description = 'MODFLOW 6 cell-by-cell groundwater budget output consumed by the SVO adapter chain.',
    has_format = 'cbc-mf6'
WHERE id = 'https://w3id.org/okn/i/mint/modflow6_cbc_output';

-- Existing family-specific presentations are only used by the canonical
-- MODFLOW outputs, so their standard-variable mappings can be corrected in
-- place without changing unrelated catalog rows.
UPDATE public.modelcatalog_variable_presentation
SET has_standard_variable = 'https://w3id.org/okn/i/mint/wmobley-standard-variable-aquifer-system-volumetric-budget'
WHERE id IN (
  'https://w3id.org/okn/i/mint/7e82b186-11ae-49ae-a2e0-fdd872d39cc4',
  'https://w3id.org/okn/i/mint/1d998c24-ea65-47b4-8526-e579898a6ed8',
  'https://w3id.org/okn/i/mint/wmobley-modflow-6-cell-budget'
);

UPDATE public.modelcatalog_variable_presentation
SET has_standard_variable = 'https://w3id.org/okn/i/mint/wmobley-standard-variable-groundwater-drawdown'
WHERE id IN (
  'https://w3id.org/okn/i/mint/2bddcbf0-6235-4dbd-b94a-6c3284d72897',
  'https://w3id.org/okn/i/mint/de1bc743-cbc0-4940-9933-124fb5f895ad'
);

UPDATE public.modelcatalog_variable_presentation
SET has_standard_variable = 'https://w3id.org/okn/i/mint/wmobley-standard-variable-groundwater-hydraulic-head'
WHERE id IN (
  'https://w3id.org/okn/i/mint/fedd3f44-4045-42fd-bbd0-a8c67ae2e1af',
  'https://w3id.org/okn/i/mint/43ae2275-6ba6-408c-a737-7b48f29827e8'
);

INSERT INTO public.modelcatalog_variable_presentation
  (id, label, description, has_long_name, has_short_name, has_standard_variable, uses_unit)
VALUES (
  'https://w3id.org/okn/i/mint/wmobley-modflow-2005-cell-budget',
  'MODFLOW 2005 cell-by-cell budget',
  'MODFLOW 2005 cell-by-cell groundwater budget output.',
  'MODFLOW 2005 cell-by-cell budget',
  'cell_budget',
  'https://w3id.org/okn/i/mint/wmobley-standard-variable-aquifer-system-volumetric-budget',
  NULL
), (
  'https://w3id.org/okn/i/mint/wmobley-modflow-2005-drawdown',
  'MODFLOW 2005 drawdown',
  'MODFLOW 2005 groundwater drawdown output.',
  'MODFLOW 2005 drawdown',
  'drawdown',
  'https://w3id.org/okn/i/mint/wmobley-standard-variable-groundwater-drawdown',
  NULL
)
ON CONFLICT (id) DO UPDATE
SET has_standard_variable = EXCLUDED.has_standard_variable;

INSERT INTO public.modelcatalog_dataset_specification_presentation
  (dataset_specification_id, presentation_id)
VALUES
  ('https://w3id.org/okn/i/mint/modflow_2005_cbb', 'https://w3id.org/okn/i/mint/wmobley-modflow-2005-cell-budget'),
  ('https://w3id.org/okn/i/mint/modflow_2005_ddown', 'https://w3id.org/okn/i/mint/wmobley-modflow-2005-drawdown'),
  ('https://w3id.org/okn/i/mint/modflow6_cbc_output', 'https://w3id.org/okn/i/mint/wmobley-modflow-6-cell-budget')
ON CONFLICT DO NOTHING;

END
$$;

COMMIT;
