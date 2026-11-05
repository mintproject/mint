/**
 * Resource registry: maps API resource path segments to Hasura table metadata,
 * type URIs/names, and relationship configurations.
 *
 * All 46 API resource types are covered. Types without a dedicated Hasura table
 * have hasuraTable set to null.
 */

export interface RelationshipConfig {
  /** Hasura relationship name (as defined in metadata) */
  hasuraRelName: string;
  /** Whether this is a single object or array relationship */
  type: 'object' | 'array';
  /** Junction table name, if this relationship goes through one */
  junctionTable?: string;
  /**
   * Relationship name inside the junction row that points to the target entity.
   * Only set when junctionTable is present.
   * e.g. for 'authors' -> modelcatalog_software_author -> person, junctionRelName = 'person'
   * e.g. for 'inputs' -> modelcatalog_configuration_input -> input, junctionRelName = 'input'
   */
  junctionRelName?: string;
  /** FK column name in the junction table pointing back to the parent entity. Required when junctionTable is set. */
  parentFkColumn?: string;
  /**
   * Optional override for the target-entity FK column on the junction row.
   * Defaults to `${junctionRelName}_id` (current convention).
   * Set explicitly when the convention does not match the schema (bug-087 fold-in).
   */
  targetFkColumn?: string;
  /**
   * FK column name on the child entity table pointing back to this parent (one-to-many FK relationships).
   * Set on parent.relationships[X] when the relationship is materialized as a direct FK on the child row,
   * not via a junction table. PUT/POST handler updates this FK to link/unlink child rows.
   * Mutually exclusive with junctionTable.
   * e.g. softwares.hasVersion: childFkColumn = 'software_id' (column on modelcatalog_software_version).
   */
  childFkColumn?: string;
  /** The API resource name of the target type (for nested transforms) */
  targetResource: string;
  /**
   * Extra scalar columns stored on the junction row itself (beyond the two FK columns).
   * Used by the PUT path in service.ts to pass per-row extra data.
   * Map from junction column name (snake_case) to the corresponding camelCase key in the request body item.
   */
  junctionColumns?: Record<string, string>;
}

export interface ResourceConfig {
  /** Hasura table name, or null if no dedicated table exists */
  hasuraTable: string | null;
  /** Primary OWL type URI */
  typeUri: string;
  /** Short type name (last segment of type URI) */
  typeName: string;
  /** Full type array for the 'type' field in responses (may include parent classes) */
  typeArray: string[];
  /** ID prefix for constructing full URIs */
  idPrefix: string;
  /** Map from API camelCase field name to Hasura relationship config */
  relationships: Record<string, RelationshipConfig>;
}

const ID_PREFIX = 'https://w3id.org/okn/i/mint/';

/**
 * All 46 API resource types mapped to their Hasura metadata.
 * Keys are the API path segments (as they appear in URL paths).
 */
export const RESOURCE_REGISTRY: Record<string, ResourceConfig> = {
  // =========================================================================
  // Core hierarchy: Software > SoftwareVersion > ModelConfiguration > Setup
  // =========================================================================

  softwares: {
    hasuraTable: 'modelcatalog_software',
    typeUri: 'https://w3id.org/okn/o/sd#Software',
    typeName: 'Software',
    typeArray: ['Software'],
    idPrefix: ID_PREFIX,
    relationships: {
      author: {
        hasuraRelName: 'author',
        type: 'object',
        targetResource: 'persons',
      },
      authors: {
        hasuraRelName: 'authors',
        type: 'array',
        junctionTable: 'modelcatalog_software_author',
        junctionRelName: 'person',
        parentFkColumn: 'software_id',
        targetResource: 'persons',
      },
      hasVersion: {
        hasuraRelName: 'versions',
        type: 'array',
        childFkColumn: 'software_id',
        targetResource: 'softwareversions',
      },
      hasModelCategory: {
        hasuraRelName: 'categories',
        type: 'array',
        junctionTable: 'modelcatalog_software_category',
        junctionRelName: 'category',
        parentFkColumn: 'software_id',
        targetResource: 'modelcategorys',
      },
    },
  },

  softwareversions: {
    hasuraTable: 'modelcatalog_software_version',
    typeUri: 'https://w3id.org/okn/o/sd#SoftwareVersion',
    typeName: 'SoftwareVersion',
    typeArray: ['SoftwareVersion'],
    idPrefix: ID_PREFIX,
    relationships: {
      software: {
        hasuraRelName: 'software',
        type: 'object',
        targetResource: 'softwares',
      },
      author: {
        hasuraRelName: 'author',
        type: 'object',
        targetResource: 'persons',
      },
      authors: {
        hasuraRelName: 'authors',
        type: 'array',
        junctionTable: 'modelcatalog_version_author',
        junctionRelName: 'person',
        parentFkColumn: 'software_version_id',
        targetResource: 'persons',
      },
      hasConfiguration: {
        hasuraRelName: 'configurations',
        type: 'array',
        childFkColumn: 'software_version_id',
        targetResource: 'modelconfigurations',
      },
      hasModelCategory: {
        hasuraRelName: 'categories',
        type: 'array',
        junctionTable: 'modelcatalog_software_version_category',
        junctionRelName: 'category',
        parentFkColumn: 'software_version_id',
        targetResource: 'modelcategorys',
      },
      hasProcess: {
        hasuraRelName: 'processes',
        type: 'array',
        junctionTable: 'modelcatalog_software_version_process',
        junctionRelName: 'process',
        parentFkColumn: 'software_version_id',
        targetResource: 'processs',
      },
      hasGrid: {
        hasuraRelName: 'grids',
        type: 'array',
        junctionTable: 'modelcatalog_software_version_grid',
        junctionRelName: 'grid',
        parentFkColumn: 'software_version_id',
        targetResource: 'grids',
      },
      hasExplanationDiagram: {
        hasuraRelName: 'explanation_diagrams',
        type: 'array',
        junctionTable: 'modelcatalog_software_version_image',
        junctionRelName: 'image',
        parentFkColumn: 'software_version_id',
        targetResource: 'images',
      },
      hasInputVariable: {
        hasuraRelName: 'input_variables',
        type: 'array',
        junctionTable: 'modelcatalog_software_version_input_variable',
        junctionRelName: 'variable',
        parentFkColumn: 'software_version_id',
        targetResource: 'variablepresentations',
      },
      hasOutputVariable: {
        hasuraRelName: 'output_variables',
        type: 'array',
        junctionTable: 'modelcatalog_software_version_output_variable',
        junctionRelName: 'variable',
        parentFkColumn: 'software_version_id',
        targetResource: 'variablepresentations',
      },
    },
  },

  modelconfigurations: {
    hasuraTable: 'modelcatalog_configuration',
    typeUri: 'https://w3id.org/okn/o/sdm#ModelConfiguration',
    typeName: 'ModelConfiguration',
    typeArray: ['ModelConfiguration'],
    idPrefix: ID_PREFIX,
    relationships: {
      softwareVersion: {
        hasuraRelName: 'software_version',
        type: 'object',
        targetResource: 'softwareversions',
      },
      author: {
        hasuraRelName: 'author',
        type: 'object',
        targetResource: 'persons',
      },
      authors: {
        hasuraRelName: 'authors',
        type: 'array',
        junctionTable: 'modelcatalog_configuration_author',
        junctionRelName: 'person',
        parentFkColumn: 'configuration_id',
        targetResource: 'persons',
      },
      hasSetup: {
        hasuraRelName: 'child_configurations',
        type: 'array',
        childFkColumn: 'model_configuration_id',
        targetResource: 'modelconfigurationsetups',
      },
      hasInput: {
        hasuraRelName: 'inputs',
        type: 'array',
        junctionTable: 'modelcatalog_configuration_input',
        junctionRelName: 'input',
        parentFkColumn: 'configuration_id',
        targetResource: 'datasetspecifications',
        junctionColumns: { is_optional: 'isOptional', app_input_name: 'appInputName' },
      },
      hasOutput: {
        hasuraRelName: 'outputs',
        type: 'array',
        junctionTable: 'modelcatalog_configuration_output',
        junctionRelName: 'output',
        parentFkColumn: 'configuration_id',
        targetResource: 'datasetspecifications',
      },
      hasParameter: {
        hasuraRelName: 'parameters',
        type: 'array',
        junctionTable: 'modelcatalog_configuration_parameter',
        junctionRelName: 'parameter',
        parentFkColumn: 'configuration_id',
        targetResource: 'parameters',
      },
      hasCausalDiagram: {
        hasuraRelName: 'causal_diagrams',
        type: 'array',
        junctionTable: 'modelcatalog_configuration_causal_diagram',
        junctionRelName: 'causal_diagram',
        parentFkColumn: 'configuration_id',
        targetResource: 'causaldiagrams',
      },
      hasOutputTimeInterval: {
        hasuraRelName: 'time_intervals',
        type: 'array',
        junctionTable: 'modelcatalog_configuration_time_interval',
        junctionRelName: 'time_interval',
        parentFkColumn: 'configuration_id',
        targetResource: 'timeintervals',
      },
      hasRegion: {
        hasuraRelName: 'regions',
        type: 'array',
        junctionTable: 'modelcatalog_configuration_region',
        junctionRelName: 'region',
        parentFkColumn: 'configuration_id',
        targetResource: 'regions',
      },
      hasModelCategory: {
        hasuraRelName: 'categories',
        type: 'array',
        junctionTable: 'modelcatalog_configuration_category',
        junctionRelName: 'category',
        parentFkColumn: 'configuration_id',
        targetResource: 'modelcategorys',
      },
    },
  },

  modelconfigurationsetups: {
    hasuraTable: 'modelcatalog_configuration',
    typeUri: 'https://w3id.org/okn/o/sdm#ModelConfigurationSetup',
    typeName: 'ModelConfigurationSetup',
    typeArray: ['ModelConfigurationSetup'],
    idPrefix: ID_PREFIX,
    relationships: {
      modelConfiguration: {
        hasuraRelName: 'parent_configuration',
        type: 'object',
        targetResource: 'modelconfigurations',
      },
      author: {
        hasuraRelName: 'author',
        type: 'object',
        targetResource: 'persons',
      },
      authors: {
        hasuraRelName: 'authors',
        type: 'array',
        junctionTable: 'modelcatalog_configuration_author',
        junctionRelName: 'person',
        parentFkColumn: 'configuration_id',
        targetResource: 'persons',
      },
      hasInput: {
        hasuraRelName: 'inputs',
        type: 'array',
        junctionTable: 'modelcatalog_configuration_input',
        junctionRelName: 'input',
        parentFkColumn: 'configuration_id',
        targetResource: 'datasetspecifications',
        junctionColumns: { is_optional: 'isOptional', app_input_name: 'appInputName' },
      },
      hasOutput: {
        hasuraRelName: 'outputs',
        type: 'array',
        junctionTable: 'modelcatalog_configuration_output',
        junctionRelName: 'output',
        parentFkColumn: 'configuration_id',
        targetResource: 'datasetspecifications',
      },
      hasParameter: {
        hasuraRelName: 'parameters',
        type: 'array',
        junctionTable: 'modelcatalog_configuration_parameter',
        junctionRelName: 'parameter',
        parentFkColumn: 'configuration_id',
        targetResource: 'parameters',
      },
      calibratedVariable: {
        hasuraRelName: 'calibrated_variables',
        type: 'array',
        junctionTable: 'modelcatalog_configuration_calibrated_variable',
        junctionRelName: 'variable',
        parentFkColumn: 'configuration_id',
        targetResource: 'variablepresentations',
      },
      calibrationTargetVariable: {
        hasuraRelName: 'calibration_targets',
        type: 'array',
        junctionTable: 'modelcatalog_configuration_calibration_target',
        junctionRelName: 'variable',
        parentFkColumn: 'configuration_id',
        targetResource: 'variablepresentations',
      },
      hasModelCategory: {
        hasuraRelName: 'categories',
        type: 'array',
        junctionTable: 'modelcatalog_configuration_category',
        junctionRelName: 'category',
        parentFkColumn: 'configuration_id',
        targetResource: 'modelcategorys',
      },
    },
  },

  // Alias: configurationsetups maps to the same table as modelconfigurationsetups
  configurationsetups: {
    hasuraTable: 'modelcatalog_configuration',
    typeUri: 'https://w3id.org/okn/o/sd#ConfigurationSetup',
    typeName: 'ConfigurationSetup',
    typeArray: ['ConfigurationSetup'],
    idPrefix: ID_PREFIX,
    relationships: {
      modelConfiguration: {
        hasuraRelName: 'parent_configuration',
        type: 'object',
        targetResource: 'modelconfigurations',
      },
      author: {
        hasuraRelName: 'author',
        type: 'object',
        targetResource: 'persons',
      },
      authors: {
        hasuraRelName: 'authors',
        type: 'array',
        junctionTable: 'modelcatalog_configuration_author',
        junctionRelName: 'person',
        parentFkColumn: 'configuration_id',
        targetResource: 'persons',
      },
      hasInput: {
        hasuraRelName: 'inputs',
        type: 'array',
        junctionTable: 'modelcatalog_configuration_input',
        junctionRelName: 'input',
        parentFkColumn: 'configuration_id',
        targetResource: 'datasetspecifications',
        junctionColumns: { is_optional: 'isOptional', app_input_name: 'appInputName' },
      },
      hasOutput: {
        hasuraRelName: 'outputs',
        type: 'array',
        junctionTable: 'modelcatalog_configuration_output',
        junctionRelName: 'output',
        parentFkColumn: 'configuration_id',
        targetResource: 'datasetspecifications',
      },
      hasParameter: {
        hasuraRelName: 'parameters',
        type: 'array',
        junctionTable: 'modelcatalog_configuration_parameter',
        junctionRelName: 'parameter',
        parentFkColumn: 'configuration_id',
        targetResource: 'parameters',
      },
      calibratedVariable: {
        hasuraRelName: 'calibrated_variables',
        type: 'array',
        junctionTable: 'modelcatalog_configuration_calibrated_variable',
        junctionRelName: 'variable',
        parentFkColumn: 'configuration_id',
        targetResource: 'variablepresentations',
      },
      calibrationTargetVariable: {
        hasuraRelName: 'calibration_targets',
        type: 'array',
        junctionTable: 'modelcatalog_configuration_calibration_target',
        junctionRelName: 'variable',
        parentFkColumn: 'configuration_id',
        targetResource: 'variablepresentations',
      },
    },
  },

  // =========================================================================
  // I/O and parameter entity types
  // =========================================================================

  datasetspecifications: {
    hasuraTable: 'modelcatalog_dataset_specification',
    typeUri: 'https://w3id.org/okn/o/sd#DatasetSpecification',
    typeName: 'DatasetSpecification',
    typeArray: ['DatasetSpecification'],
    idPrefix: ID_PREFIX,
    relationships: {
      hasPresentation: {
        hasuraRelName: 'presentations',
        type: 'array',
        junctionTable: 'modelcatalog_dataset_specification_presentation',
        junctionRelName: 'presentation',
        parentFkColumn: 'dataset_specification_id',
        targetResource: 'variablepresentations',
      },
    },
  },

  parameters: {
    hasuraTable: 'modelcatalog_parameter',
    typeUri: 'https://w3id.org/okn/o/sd#Parameter',
    typeName: 'Parameter',
    typeArray: ['Parameter'],
    idPrefix: ID_PREFIX,
    relationships: {
      hasIntervention: {
        hasuraRelName: 'interventions',
        type: 'array',
        junctionTable: 'modelcatalog_parameter_intervention',
        junctionRelName: 'intervention',
        parentFkColumn: 'parameter_id',
        targetResource: 'interventions',
      },
      adjustsVariable: {
        hasuraRelName: 'adjusts_variables',
        type: 'array',
        junctionTable: 'modelcatalog_parameter_adjusts_variable',
        junctionRelName: 'variable',
        parentFkColumn: 'parameter_id',
        targetResource: 'variablepresentations',
      },
    },
  },

  // =========================================================================
  // Reference entity types with dedicated Hasura tables
  // =========================================================================

  persons: {
    hasuraTable: 'modelcatalog_person',
    typeUri: 'https://w3id.org/okn/o/sd#Person',
    typeName: 'Person',
    typeArray: ['Person'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  modelcategorys: {
    hasuraTable: 'modelcatalog_model_category',
    typeUri: 'https://w3id.org/okn/o/sdm#ModelCategory',
    typeName: 'ModelCategory',
    typeArray: ['ModelCategory'],
    idPrefix: ID_PREFIX,
    relationships: {
      parentCategory: {
        hasuraRelName: 'parent_category',
        type: 'object',
        targetResource: 'modelcategorys',
      },
      subcategories: {
        hasuraRelName: 'subcategories',
        type: 'array',
        targetResource: 'modelcategorys',
      },
    },
  },

  regions: {
    hasuraTable: 'modelcatalog_region',
    typeUri: 'https://w3id.org/okn/o/sdm#Region',
    typeName: 'Region',
    typeArray: ['Region'],
    idPrefix: ID_PREFIX,
    relationships: {
      partOf: {
        hasuraRelName: 'part_of',
        type: 'object',
        targetResource: 'regions',
      },
      subregions: {
        hasuraRelName: 'subregions',
        type: 'array',
        targetResource: 'regions',
      },
    },
  },

  processs: {
    hasuraTable: 'modelcatalog_process',
    typeUri: 'https://w3id.org/okn/o/sdm#Process',
    typeName: 'Process',
    typeArray: ['Process'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  timeintervals: {
    hasuraTable: 'modelcatalog_time_interval',
    typeUri: 'https://w3id.org/okn/o/sdm#TimeInterval',
    typeName: 'TimeInterval',
    typeArray: ['TimeInterval'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  causaldiagrams: {
    hasuraTable: 'modelcatalog_causal_diagram',
    typeUri: 'https://w3id.org/okn/o/sdm#CausalDiagram',
    typeName: 'CausalDiagram',
    typeArray: ['CausalDiagram'],
    idPrefix: ID_PREFIX,
    relationships: {
      hasPart: {
        hasuraRelName: 'diagram_parts',
        type: 'array',
        junctionTable: 'modelcatalog_diagram_part',
        targetResource: 'variablepresentations',
      },
    },
  },

  images: {
    hasuraTable: 'modelcatalog_image',
    typeUri: 'https://w3id.org/okn/o/sd#Image',
    typeName: 'Image',
    typeArray: ['Image'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  variablepresentations: {
    hasuraTable: 'modelcatalog_variable_presentation',
    typeUri: 'https://w3id.org/okn/o/sd#VariablePresentation',
    typeName: 'VariablePresentation',
    typeArray: ['VariablePresentation'],
    idPrefix: ID_PREFIX,
    relationships: {
      hasStandardVariable: {
        hasuraRelName: 'standard_variable',
        type: 'object',
        targetResource: 'standardvariables',
      },
      usesUnit: {
        hasuraRelName: 'unit',
        type: 'object',
        targetResource: 'units',
      },
    },
  },

  interventions: {
    hasuraTable: 'modelcatalog_intervention',
    typeUri: 'https://w3id.org/okn/o/sdm#Intervention',
    typeName: 'Intervention',
    typeArray: ['Intervention'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  grids: {
    hasuraTable: 'modelcatalog_grid',
    typeUri: 'https://w3id.org/okn/o/sdm#Grid',
    typeName: 'Grid',
    typeArray: ['Grid'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  // =========================================================================
  // Software subtypes -- map to modelcatalog_software (type discriminator)
  // =========================================================================

  models: {
    // Model is a subclass of Software in the OKN ontology (sdm:Model rdfs:subClassOf sd:Software)
    hasuraTable: 'modelcatalog_software',
    typeUri: 'https://w3id.org/okn/o/sdm#Model',
    typeName: 'Model',
    typeArray: ['Model', 'SoftwareDescription'],
    idPrefix: ID_PREFIX,
    relationships: {
      author: {
        hasuraRelName: 'author',
        type: 'object',
        targetResource: 'persons',
      },
      authors: {
        hasuraRelName: 'authors',
        type: 'array',
        junctionTable: 'modelcatalog_software_author',
        junctionRelName: 'person',
        parentFkColumn: 'software_id',
        targetResource: 'persons',
      },
      hasVersion: {
        hasuraRelName: 'versions',
        type: 'array',
        childFkColumn: 'software_id',
        targetResource: 'softwareversions',
      },
      hasModelCategory: {
        hasuraRelName: 'categories',
        type: 'array',
        junctionTable: 'modelcatalog_software_category',
        junctionRelName: 'category',
        parentFkColumn: 'software_id',
        targetResource: 'modelcategorys',
      },
    },
  },

  empiricalmodels: {
    hasuraTable: 'modelcatalog_software',
    typeUri: 'https://w3id.org/okn/o/sdm#EmpiricalModel',
    typeName: 'EmpiricalModel',
    typeArray: ['EmpiricalModel'],
    idPrefix: ID_PREFIX,
    relationships: {
      author: {
        hasuraRelName: 'author',
        type: 'object',
        targetResource: 'persons',
      },
      hasVersion: {
        hasuraRelName: 'versions',
        type: 'array',
        childFkColumn: 'software_id',
        targetResource: 'softwareversions',
      },
      hasModelCategory: {
        hasuraRelName: 'categories',
        type: 'array',
        junctionTable: 'modelcatalog_software_category',
        junctionRelName: 'category',
        parentFkColumn: 'software_id',
        targetResource: 'modelcategorys',
      },
    },
  },

  hybridmodels: {
    hasuraTable: 'modelcatalog_software',
    typeUri: 'https://w3id.org/okn/o/sdm#HybridModel',
    typeName: 'HybridModel',
    typeArray: ['HybridModel'],
    idPrefix: ID_PREFIX,
    relationships: {
      author: {
        hasuraRelName: 'author',
        type: 'object',
        targetResource: 'persons',
      },
      hasVersion: {
        hasuraRelName: 'versions',
        type: 'array',
        childFkColumn: 'software_id',
        targetResource: 'softwareversions',
      },
      hasModelCategory: {
        hasuraRelName: 'categories',
        type: 'array',
        junctionTable: 'modelcatalog_software_category',
        junctionRelName: 'category',
        parentFkColumn: 'software_id',
        targetResource: 'modelcategorys',
      },
    },
  },

  emulators: {
    hasuraTable: 'modelcatalog_software',
    typeUri: 'https://w3id.org/okn/o/sdm#Emulator',
    typeName: 'Emulator',
    typeArray: ['Emulator'],
    idPrefix: ID_PREFIX,
    relationships: {
      author: {
        hasuraRelName: 'author',
        type: 'object',
        targetResource: 'persons',
      },
      hasVersion: {
        hasuraRelName: 'versions',
        type: 'array',
        childFkColumn: 'software_id',
        targetResource: 'softwareversions',
      },
      hasModelCategory: {
        hasuraRelName: 'categories',
        type: 'array',
        junctionTable: 'modelcatalog_software_category',
        junctionRelName: 'category',
        parentFkColumn: 'software_id',
        targetResource: 'modelcategorys',
      },
    },
  },

  'theory-guidedmodels': {
    hasuraTable: 'modelcatalog_software',
    typeUri: 'https://w3id.org/okn/o/sdm#Theory-GuidedModel',
    typeName: 'Theory-GuidedModel',
    typeArray: ['Theory-GuidedModel'],
    idPrefix: ID_PREFIX,
    relationships: {
      author: {
        hasuraRelName: 'author',
        type: 'object',
        targetResource: 'persons',
      },
      hasVersion: {
        hasuraRelName: 'versions',
        type: 'array',
        childFkColumn: 'software_id',
        targetResource: 'softwareversions',
      },
      hasModelCategory: {
        hasuraRelName: 'categories',
        type: 'array',
        junctionTable: 'modelcatalog_software_category',
        junctionRelName: 'category',
        parentFkColumn: 'software_id',
        targetResource: 'modelcategorys',
      },
    },
  },

  // Alias for theory-guidedmodels: OpenAPI operationId uses underscore (theory_guidedmodels_get)
  // while the URL path uses hyphen (/theory-guidedmodels). The Proxy routes operationId to resource name.
  theory_guidedmodels: {
    hasuraTable: 'modelcatalog_software',
    typeUri: 'https://w3id.org/okn/o/sdm#Theory-GuidedModel',
    typeName: 'Theory-GuidedModel',
    typeArray: ['Theory-GuidedModel'],
    idPrefix: ID_PREFIX,
    relationships: {
      author: {
        hasuraRelName: 'author',
        type: 'object',
        targetResource: 'persons',
      },
      hasVersion: {
        hasuraRelName: 'versions',
        type: 'array',
        childFkColumn: 'software_id',
        targetResource: 'softwareversions',
      },
      hasModelCategory: {
        hasuraRelName: 'categories',
        type: 'array',
        junctionTable: 'modelcatalog_software_category',
        junctionRelName: 'category',
        parentFkColumn: 'software_id',
        targetResource: 'modelcategorys',
      },
    },
  },

  coupledmodels: {
    hasuraTable: 'modelcatalog_software',
    typeUri: 'https://w3id.org/okn/o/sdm#CoupledModel',
    typeName: 'CoupledModel',
    typeArray: ['CoupledModel'],
    idPrefix: ID_PREFIX,
    relationships: {
      author: {
        hasuraRelName: 'author',
        type: 'object',
        targetResource: 'persons',
      },
      hasVersion: {
        hasuraRelName: 'versions',
        type: 'array',
        childFkColumn: 'software_id',
        targetResource: 'softwareversions',
      },
      hasModelCategory: {
        hasuraRelName: 'categories',
        type: 'array',
        junctionTable: 'modelcatalog_software_category',
        junctionRelName: 'category',
        parentFkColumn: 'software_id',
        targetResource: 'modelcategorys',
      },
    },
  },

  // =========================================================================
  // Entity types WITHOUT dedicated Hasura tables (hasuraTable: null)
  // These need views or alternative query strategies in future plans.
  // =========================================================================

  catalogidentifiers: {
    hasuraTable: null,
    typeUri: 'https://w3id.org/okn/o/sd#CatalogIdentifier',
    typeName: 'CatalogIdentifier',
    typeArray: ['CatalogIdentifier'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  constraints: {
    hasuraTable: null,
    typeUri: 'https://w3id.org/okn/o/sd#Constraint',
    typeName: 'Constraint',
    typeArray: ['Constraint'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  datatransformations: {
    hasuraTable: null,
    typeUri: 'https://w3id.org/okn/o/sd#DataTransformation',
    typeName: 'DataTransformation',
    typeArray: ['DataTransformation'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  datatransformationsetups: {
    hasuraTable: null,
    typeUri: 'https://w3id.org/okn/o/sd#DataTransformationSetup',
    typeName: 'DataTransformationSetup',
    typeArray: ['DataTransformationSetup'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  equations: {
    hasuraTable: null,
    typeUri: 'https://w3id.org/okn/o/sdm#Equation',
    typeName: 'Equation',
    typeArray: ['Equation'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  fundinginformations: {
    hasuraTable: null,
    typeUri: 'https://w3id.org/okn/o/sd#FundingInformation',
    typeName: 'FundingInformation',
    typeArray: ['FundingInformation'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  geocoordinatess: {
    hasuraTable: null,
    typeUri: 'https://w3id.org/okn/o/sdm#GeoCoordinates',
    typeName: 'GeoCoordinates',
    typeArray: ['GeoCoordinates'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  geoshapes: {
    hasuraTable: null,
    typeUri: 'https://w3id.org/okn/o/sdm#GeoShape',
    typeName: 'GeoShape',
    typeArray: ['GeoShape'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  numericalindexs: {
    hasuraTable: null,
    typeUri: 'https://w3id.org/okn/o/sd#NumericalIndex',
    typeName: 'NumericalIndex',
    typeArray: ['NumericalIndex'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  organizations: {
    hasuraTable: null,
    typeUri: 'https://w3id.org/okn/o/sd#Organization',
    typeName: 'Organization',
    typeArray: ['Organization'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  pointbasedgrids: {
    hasuraTable: null,
    typeUri: 'https://w3id.org/okn/o/sdm#PointBasedGrid',
    typeName: 'PointBasedGrid',
    typeArray: ['PointBasedGrid'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  samplecollections: {
    hasuraTable: null,
    typeUri: 'https://w3id.org/okn/o/sd#SampleCollection',
    typeName: 'SampleCollection',
    typeArray: ['SampleCollection'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  sampleexecutions: {
    hasuraTable: null,
    typeUri: 'https://w3id.org/okn/o/sd#SampleExecution',
    typeName: 'SampleExecution',
    typeArray: ['SampleExecution'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  sampleresources: {
    hasuraTable: null,
    typeUri: 'https://w3id.org/okn/o/sd#SampleResource',
    typeName: 'SampleResource',
    typeArray: ['SampleResource'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  softwareconfigurations: {
    hasuraTable: null,
    typeUri: 'https://w3id.org/okn/o/sd#SoftwareConfiguration',
    typeName: 'SoftwareConfiguration',
    typeArray: ['SoftwareConfiguration'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  softwareimages: {
    hasuraTable: null,
    typeUri: 'https://w3id.org/okn/o/sd#SoftwareImage',
    typeName: 'SoftwareImage',
    typeArray: ['SoftwareImage'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  sourcecodes: {
    hasuraTable: null,
    typeUri: 'https://w3id.org/okn/o/sd#SourceCode',
    typeName: 'SourceCode',
    typeArray: ['SourceCode'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  spatialresolutions: {
    hasuraTable: null,
    typeUri: 'https://w3id.org/okn/o/sdm#SpatialResolution',
    typeName: 'SpatialResolution',
    typeArray: ['SpatialResolution'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  spatiallydistributedgrids: {
    hasuraTable: null,
    typeUri: 'https://w3id.org/okn/o/sdm#SpatiallyDistributedGrid',
    typeName: 'SpatiallyDistributedGrid',
    typeArray: ['SpatiallyDistributedGrid'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  standardvariables: {
    hasuraTable: 'modelcatalog_standard_variable',
    typeUri: 'https://w3id.org/okn/o/sd#StandardVariable',
    typeName: 'StandardVariable',
    typeArray: ['StandardVariable'],
    idPrefix: ID_PREFIX,
    relationships: {
      variablePresentations: {
        hasuraRelName: 'variable_presentations',
        type: 'array',
        targetResource: 'variablepresentations',
      },
    },
  },

  units: {
    hasuraTable: 'modelcatalog_unit',
    typeUri: 'https://w3id.org/okn/o/sd#Unit',
    typeName: 'Unit',
    typeArray: ['Unit', 'http://qudt.org/1.1/schema/qudt#Unit'],
    idPrefix: ID_PREFIX,
    relationships: {
      variablePresentations: {
        hasuraRelName: 'variable_presentations',
        type: 'array',
        targetResource: 'variablepresentations',
      },
    },
  },

  variables: {
    hasuraTable: null,
    typeUri: 'https://w3id.org/okn/o/sd#Variable',
    typeName: 'Variable',
    typeArray: ['Variable'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },

  visualizations: {
    hasuraTable: null,
    typeUri: 'https://w3id.org/okn/o/sd#Visualization',
    typeName: 'Visualization',
    typeArray: ['Visualization'],
    idPrefix: ID_PREFIX,
    relationships: {},
  },
};

/**
 * Look up a resource config by its API path segment.
 * Returns undefined if not found.
 */
export function getResourceConfig(pathSegment: string): ResourceConfig | undefined {
  return RESOURCE_REGISTRY[pathSegment];
}

/**
 * Look up a resource config by its Hasura table name.
 * Returns the first match (useful for reverse lookups; note some resources share a table).
 */
export function getResourceByTable(tableName: string): ResourceConfig | undefined {
  return Object.values(RESOURCE_REGISTRY).find((r) => r.hasuraTable === tableName);
}
