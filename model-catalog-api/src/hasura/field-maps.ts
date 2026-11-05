/**
 * GraphQL field selection strings for each Hasura modelcatalog entity table.
 *
 * Derived from graphql_engine/metadata/tables.yaml in the mint repository.
 * Each string lists:
 *   - All scalar columns (from select_permissions)
 *   - Object relationships (single FK joins, `{ id label }`)
 *   - Array relationships through junction tables (traverse to target entity `{ id label }`)
 *   - Direct array relationships (e.g., versions, setups)
 *
 * Junction tables themselves do not need standalone entries; they are always
 * accessed through the entity that owns the relationship.
 *
 * Export contract:
 *   - FIELD_SELECTIONS: Record<string, string> — table name to selection string
 *   - getFieldSelection(table): string — returns selection or falls back to `id label`
 */

export const FIELD_SELECTIONS: Record<string, string> = {
  // =========================================================================
  // modelcatalog_software
  // Columns: id, label, description, keywords, license, website,
  //          date_created, date_published, has_documentation, has_download_url,
  //          has_purpose, author_id, type
  // Object relationships: author -> modelcatalog_person
  // Array relationships:
  //   versions -> modelcatalog_software_version (direct)
  //   authors  -> modelcatalog_software_author (junction) -> person
  // =========================================================================
  modelcatalog_software: `
id
label
description
keywords
license
website
date_created
date_published
has_documentation
has_download_url
has_purpose
author_id
type
author {
  id
  label
}
versions {
  id
  label
  description
}
authors {
  person {
    id
    label
  }
}
categories {
  category {
    id
    label
  }
}
`.trim(),

  // =========================================================================
  // modelcatalog_software_version
  // Columns: id, software_id, version_id, label, description, keywords,
  //          has_usage_notes, date_created, has_source_code, short_description,
  //          limitations, parameterization, runtime_estimation, theoretical_basis,
  //          author_id
  // Object relationships: software -> modelcatalog_software
  //                       author   -> modelcatalog_person
  // Array relationships (direct): configurations -> modelcatalog_configuration
  // Array relationships (junction):
  //   categories        -> modelcatalog_software_version_category -> category
  //   processes         -> modelcatalog_software_version_process -> process
  //   grids             -> modelcatalog_software_version_grid -> grid
  //   explanation_diagrams -> modelcatalog_software_version_image -> image
  //   input_variables   -> modelcatalog_software_version_input_variable -> variable
  //   output_variables  -> modelcatalog_software_version_output_variable -> variable
  //   authors           -> modelcatalog_version_author -> person
  // =========================================================================
  modelcatalog_software_version: `
id
software_id
version_id
label
description
keywords
has_usage_notes
date_created
has_source_code
short_description
limitations
parameterization
runtime_estimation
theoretical_basis
author_id
software {
  id
  label
}
author {
  id
  label
}
configurations {
  id
  label
  description
}
categories {
  category {
    id
    label
  }
}
processes {
  process {
    id
    label
  }
}
grids {
  grid {
    id
    label
  }
}
explanation_diagrams {
  image {
    id
    label
  }
}
input_variables {
  variable {
    id
    label
  }
}
output_variables {
  variable {
    id
    label
  }
}
authors {
  person {
    id
    label
  }
}
`.trim(),

  // =========================================================================
  // modelcatalog_configuration (unified table for ModelConfiguration and ModelConfigurationSetup)
  // Columns from config: id, software_version_id, label, description, keywords,
  //          usage_notes, has_component_location, has_implementation_script_location,
  //          has_software_image, tapis_app_id, tapis_app_version,
  //          has_model_result_table, author_id
  // Columns from setup: model_configuration_id, has_region, calibration_interval,
  //          calibration_method, parameter_assignment_method, valid_until
  // Object relationships: software_version -> modelcatalog_software_version
  //                       author           -> modelcatalog_person
  //                       parent_configuration -> modelcatalog_configuration (self-referential)
  // Array relationships (direct): child_configurations -> modelcatalog_configuration (self-referential)
  // Array relationships (junction):
  //   inputs               -> modelcatalog_configuration_input -> input (dataset_specification)
  //   outputs              -> modelcatalog_configuration_output -> output (dataset_specification)
  //   parameters           -> modelcatalog_configuration_parameter -> parameter
  //   causal_diagrams      -> modelcatalog_configuration_causal_diagram -> causal_diagram
  //   time_intervals       -> modelcatalog_configuration_time_interval -> time_interval
  //   regions              -> modelcatalog_configuration_region -> region
  //   authors              -> modelcatalog_configuration_author -> person
  //   calibrated_variables -> modelcatalog_configuration_calibrated_variable -> variable
  //   calibration_targets  -> modelcatalog_configuration_calibration_target -> variable
  //   categories           -> modelcatalog_configuration_category -> category
  // =========================================================================
  modelcatalog_configuration: `
id
software_version_id
model_configuration_id
label
description
keywords
usage_notes
has_component_location
has_implementation_script_location
has_software_image
tapis_app_id
tapis_app_version
has_model_result_table
has_region
author_id
calibration_interval
calibration_method
parameter_assignment_method
valid_until
software_version {
  id
  label
}
author {
  id
  label
}
parent_configuration {
  id
  label
}
child_configurations {
  id
  label
  description
}
inputs {
  is_optional
  app_input_name
  input {
    id
    label
    description
    has_format
    has_dimensionality
    position
  }
}
outputs {
  output {
    id
    label
    description
    has_format
    has_dimensionality
    position
  }
}
parameters {
  parameter {
    id
    label
    description
    has_data_type
    has_default_value
    has_minimum_accepted_value
    has_maximum_accepted_value
    has_fixed_value
    has_accepted_values
    position
    parameter_type
  }
}
causal_diagrams {
  causal_diagram {
    id
    label
  }
}
time_intervals {
  time_interval {
    id
    label
    description
    interval_value
    interval_unit
  }
}
regions {
  region {
    id
    label
    description
  }
}
authors {
  person {
    id
    label
  }
}
calibrated_variables {
  variable {
    id
    label
  }
}
calibration_targets {
  variable {
    id
    label
  }
}
categories {
  category {
    id
    label
  }
}
`.trim(),

  // =========================================================================
  // modelcatalog_dataset_specification
  // Columns: id, label, description, has_format, has_dimensionality, position
  // Array relationships (junction):
  //   presentations -> modelcatalog_dataset_specification_presentation
  //
  // NOTE: FIELD_SELECTIONS_BY_ID.modelcatalog_configuration mirrors the
  // `presentations { presentation { ... } }` block under inputs.input /
  // outputs.output. Keep these in sync; drift causes different VP shapes
  // depending on whether the client GETs a config or a dataset spec by id.
  // =========================================================================
  modelcatalog_dataset_specification: `
id
label
description
has_format
has_dimensionality
position
presentations {
  presentation {
    id
    label
    description
    has_long_name
    has_short_name
    standard_variable {
      id
      label
      description
      same_as
    }
    unit {
      id
      label
    }
  }
}
`.trim(),

  // =========================================================================
  // modelcatalog_parameter
  // Columns: id, label, description, has_data_type, has_default_value,
  //          has_minimum_accepted_value, has_maximum_accepted_value,
  //          has_fixed_value, position, parameter_type
  // Array relationships (junction):
  //   interventions -> modelcatalog_parameter_intervention -> intervention
  //   adjusts_variables -> modelcatalog_parameter_adjusts_variable -> variable
  // =========================================================================
  modelcatalog_parameter: `
id
label
description
has_data_type
has_default_value
has_minimum_accepted_value
has_maximum_accepted_value
has_fixed_value
has_accepted_values
position
parameter_type
interventions {
  intervention {
    id
    label
  }
}
adjusts_variables {
  variable {
    id
    label
    description
    has_long_name
    has_short_name
    standard_variable {
      id
      label
      description
      same_as
    }
    unit {
      id
      label
    }
  }
}
`.trim(),

  // =========================================================================
  // modelcatalog_person
  // Columns: id, label, name
  // =========================================================================
  modelcatalog_person: `
id
label
name
`.trim(),

  // =========================================================================
  // modelcatalog_model_category
  // Columns: id, label, parent_category_id
  // Object relationships: parent_category -> modelcatalog_model_category (self)
  // Array relationships (direct): subcategories -> modelcatalog_model_category (self)
  // =========================================================================
  modelcatalog_model_category: `
id
label
parent_category_id
parent_category {
  id
  label
}
subcategories {
  id
  label
}
`.trim(),

  // =========================================================================
  // modelcatalog_region
  // Columns: id, label, description, part_of_id
  // Object relationships: part_of -> modelcatalog_region (self)
  // Array relationships (direct): subregions -> modelcatalog_region (self)
  // =========================================================================
  modelcatalog_region: `
id
label
description
part_of_id
part_of {
  id
  label
}
subregions {
  id
  label
}
`.trim(),

  // =========================================================================
  // modelcatalog_process
  // Columns: id, label
  // =========================================================================
  modelcatalog_process: `
id
label
`.trim(),

  // =========================================================================
  // modelcatalog_time_interval
  // Columns: id, label, description, interval_value, interval_unit
  // =========================================================================
  modelcatalog_time_interval: `
id
label
description
interval_value
interval_unit
`.trim(),

  // =========================================================================
  // modelcatalog_causal_diagram
  // Columns: id, label
  // Array relationships (junction):
  //   diagram_parts -> modelcatalog_diagram_part (polymorphic: part_id, part_type)
  // Note: diagram_parts is polymorphic (part_type: 'variable' | 'process'),
  //       so we include part_id and part_type from the junction itself
  // =========================================================================
  modelcatalog_causal_diagram: `
id
label
diagram_parts {
  part_id
  part_type
}
`.trim(),

  // =========================================================================
  // modelcatalog_image
  // Columns: id, label, description
  // =========================================================================
  modelcatalog_image: `
id
label
description
`.trim(),

  // =========================================================================
  // modelcatalog_variable_presentation
  // Columns: id, label, description, has_long_name, has_short_name
  // Object relationships: standard_variable, unit
  // =========================================================================
  modelcatalog_variable_presentation: `
id
label
description
has_long_name
has_short_name
standard_variable {
  id
  label
  description
  same_as
}
unit {
  id
  label
}
`.trim(),

  // =========================================================================
  // modelcatalog_intervention
  // Columns: id, label, description
  // =========================================================================
  modelcatalog_intervention: `
id
label
description
`.trim(),

  // =========================================================================
  // modelcatalog_grid
  // Columns: id, label, description, has_dimension, has_shape,
  //          has_spatial_resolution, has_coordinate_system, grid_type
  // =========================================================================
  modelcatalog_grid: `
id
label
description
has_dimension
has_shape
has_spatial_resolution
has_coordinate_system
grid_type
`.trim(),

  // =========================================================================
  // modelcatalog_standard_variable
  //          Columns: id, label, description, same_as
  // =========================================================================
  modelcatalog_standard_variable: `
id
label
description
same_as
`.trim(),

  // =========================================================================
  // modelcatalog_unit
  //          Columns: id, label
  // =========================================================================
  modelcatalog_unit: `
id
label
`.trim(),
};

/**
 * Per-table deep field selections used ONLY by the by-id read path.
 * Mirrors the structure of FIELD_SELECTIONS but adds an extra hop into
 * junction tables for resources that need a single-round-trip nested read.
 *
 * Lookup falls back to FIELD_SELECTIONS when no entry is present, so adding
 * a deep variant for a new table is purely additive — existing list/byId
 * behavior for every other table is preserved.
 *
 * Depth note: response.ts:71 caps recursion at depth<2. Anything at depth 2
 * (e.g. VariablePresentation hoisted from inputs.input.presentations) gets
 * its relationships stripped — only scalars survive to the wire. Selecting
 * `standard_variable` / `unit` here would be wasted work; bump
 * response.ts depth budget if that ever changes.
 */
export const FIELD_SELECTIONS_BY_ID: Record<string, string> = {
  // =========================================================================
  // modelcatalog_configuration — deep variant for GET /modelconfigurations/{id}
  // Mirrors FIELD_SELECTIONS.modelcatalog_configuration but appends
  // `presentations { presentation { ... } }` inside both inputs.input{} and
  // outputs.output{}. VP at depth 2 — scalars only survive response.ts
  // depth<2 guard. Keep the presentations selection in sync with
  // FIELD_SELECTIONS.modelcatalog_dataset_specification.
  // =========================================================================
  modelcatalog_configuration: `
id
software_version_id
model_configuration_id
label
description
keywords
usage_notes
has_component_location
has_implementation_script_location
has_software_image
tapis_app_id
tapis_app_version
has_model_result_table
has_region
author_id
calibration_interval
calibration_method
parameter_assignment_method
valid_until
software_version {
  id
  label
}
author {
  id
  label
}
parent_configuration {
  id
  label
}
child_configurations {
  id
  label
  description
}
inputs {
  is_optional
  app_input_name
  input {
    id
    label
    description
    has_format
    has_dimensionality
    position
    presentations {
      presentation {
        id
        label
        description
        has_long_name
        has_short_name
      }
    }
  }
}
outputs {
  output {
    id
    label
    description
    has_format
    has_dimensionality
    position
    presentations {
      presentation {
        id
        label
        description
        has_long_name
        has_short_name
      }
    }
  }
}
parameters {
  parameter {
    id
    label
    description
    has_data_type
    has_default_value
    has_minimum_accepted_value
    has_maximum_accepted_value
    has_fixed_value
    has_accepted_values
    position
    parameter_type
  }
}
causal_diagrams {
  causal_diagram {
    id
    label
  }
}
time_intervals {
  time_interval {
    id
    label
    description
    interval_value
    interval_unit
  }
}
regions {
  region {
    id
    label
    description
  }
}
authors {
  person {
    id
    label
  }
}
calibrated_variables {
  variable {
    id
    label
  }
}
calibration_targets {
  variable {
    id
    label
  }
}
categories {
  category {
    id
    label
  }
}
`.trim(),
};

/**
 * Return the GraphQL field selection string for a given Hasura table name.
 *
 * @param tableName Hasura table name (e.g. `modelcatalog_configuration`).
 * @param mode `'list'` (default) returns the shallow selection used by list
 * routes. `'byId'` prefers FIELD_SELECTIONS_BY_ID when an entry exists,
 * else falls back to the shallow map.
 *
 * Falls back to `id label` if neither map has the table.
 */
export function getFieldSelection(
  tableName: string,
  mode: 'list' | 'byId' = 'list',
): string {
  if (mode === 'byId') {
    const deep = FIELD_SELECTIONS_BY_ID[tableName];
    if (deep) return deep;
  }
  return FIELD_SELECTIONS[tableName] ?? 'id label';
}
