/**
 * Custom endpoint handlers for the /custom/, region-import, and /user/login endpoints.
 *
 * These endpoints perform cross-resource aggregation queries that require
 * nested GraphQL queries traversing multiple Hasura relationships. They
 * cannot be served by the generic CRUD Proxy in service.ts because they
 * join across resource types or return denormalized views.
 *
 * All handlers:
 * - Use readClient (Apollo Client) for queries via nested GraphQL
 * - Apply transformRow/transformList from mappers/response.ts
 * - Accept standard query params (username, label, page, per_page) where applicable
 * - username param is accepted but ignored (no per-user data segregation in PostgreSQL schema)
 * - Decode URI-encoded {id} parameters with decodeURIComponent()
 */

import { readClient, gql } from './hasura/client.js';
import { transformRow, transformList } from './mappers/response.js';
import { getResourceConfig } from './mappers/resource-registry.js';
import { Apps } from '@tapis/tapis-typescript';
import {
  custom_regions_import_access_get,
  custom_regions_import_post,
} from './region-import.js';
import { custom_regions_categories_post } from './region-category.js';
import { custom_flows_post, custom_flows_id_availability_get } from './flows.js';

/**
 * Resolve an incoming {id} path/query value to a full resource URI.
 * If already absolute (https:// or http://), return as-is; otherwise
 * prepend the resource's configured idPrefix to the bare slug.
 */
function resolveResourceId(
  id: string,
  resourceConfig: { idPrefix: string },
): string {
  if (id.startsWith('https://') || id.startsWith('http://')) return id;
  return `${resourceConfig.idPrefix}${id}`;
}

// ---------------------------------------------------------------------------
// Shared field selections for deep nested queries
// ---------------------------------------------------------------------------

const SOFTWARE_FIELDS = `
  id label description has_documentation date_created date_published
  keywords license website has_download_url has_purpose author_id type
  author { id label }
  authors {
    person { id label }
  }
  versions {
    id label description
    configurations {
      id label description
      setups { id label }
      inputs { input { id label } }
      outputs { output { id label } }
      parameters { parameter { id label } }
      regions { region { id label } }
    }
    input_variables { variable { id label } }
    output_variables { variable { id label } }
  }
`;

const SETUP_FIELDS = `
  id label description
  has_component_location has_implementation_script_location has_software_image
  tapis_app_id tapis_app_version has_region
  author_id calibration_interval calibration_method parameter_assignment_method valid_until
  model_configuration_id
  author { id label }
  parent_configuration {
    id label description
    software_version { id label }
  }
  inputs {
    input {
      id label description has_format has_dimensionality position
    }
  }
  outputs {
    output {
      id label description has_format has_dimensionality position
    }
  }
  parameters {
    parameter {
      id label description has_data_type has_default_value
      has_minimum_accepted_value has_maximum_accepted_value has_fixed_value
      position parameter_type
    }
  }
  authors {
    person { id label }
  }
  calibrated_variables {
    variable { id label }
  }
  calibration_targets {
    variable { id label }
  }
`;

const CONFIGURATION_FIELDS = `
  id label description keywords usage_notes
  has_component_location has_implementation_script_location has_software_image
  tapis_app_id tapis_app_version has_model_result_table
  software_version_id author_id
  author { id label }
  authors {
    person { id label }
  }
  software_version { id label description }
  child_configurations {
    id label description
    parameters { parameter { id label } }
    inputs { input { id label } }
    outputs { output { id label } }
  }
  inputs {
    input {
      id label description has_format has_dimensionality position
    }
  }
  outputs {
    output {
      id label description has_format has_dimensionality position
    }
  }
  parameters {
    parameter {
      id label description has_data_type has_default_value
      has_minimum_accepted_value has_maximum_accepted_value has_fixed_value
      position parameter_type
    }
  }
  causal_diagrams {
    causal_diagram { id label }
  }
  time_intervals {
    time_interval { id label description interval_value interval_unit }
  }
  regions {
    region { id label description }
  }
`;

// ---------------------------------------------------------------------------
// 1. /custom/model/index (custom_model_index_get)
// ---------------------------------------------------------------------------
async function custom_model_index_get(req: any, reply: any) {
  const resourceConfig = getResourceConfig('models')!;
  const { username: _username, label } = req.query || {};

  const whereConditions: string[] = [
    'type: { _eq: "https://w3id.org/okn/o/sdm#Model" }',
  ];
  const variables: Record<string, unknown> = {};

  if (label) {
    whereConditions.push('label: { _like: $label }');
    variables['label'] = `%${label}%`;
  }

  let varDecls = '';
  if (label) varDecls += ', $label: String!';
  if (varDecls.startsWith(', ')) varDecls = varDecls.slice(2);
  const sigDecl = varDecls ? `(${varDecls})` : '';

  const queryStr = `query CustomModelIndex${sigDecl} { modelcatalog_software(where: { ${whereConditions.join(', ')} } limit: 200 offset: 0) { ${SOFTWARE_FIELDS} } }`;

  try {
    const result = await readClient.query({
      query: gql`
        ${queryStr}
      `,
      variables,
    });
    const data = result.data as Record<string, unknown>;
    const rows = (data['modelcatalog_software'] ?? []) as Record<
      string,
      unknown
    >[];
    reply.code(200).send(transformList(rows, resourceConfig));
  } catch (err: any) {
    req.log.error({ err }, 'custom_model_index_get failed');
    reply
      .code(500)
      .send({ error: 'Internal server error', details: err?.message });
  }
}

// ---------------------------------------------------------------------------
// 2. /custom/model/intervention (custom_model_intervention_get)
// ---------------------------------------------------------------------------
async function custom_model_intervention_get(req: any, reply: any) {
  const resourceConfig = getResourceConfig('models')!;
  const { username: _username, label } = req.query || {};

  const queryStr = `
    query CustomModelIntervention {
      modelcatalog_software(where: { type: { _eq: "https://w3id.org/okn/o/sdm#Model" } } limit: 500 offset: 0) {
        id label description type
        author { id label }
        versions {
          id label
          configurations {
            id label
            setups {
              id label
              parameters { parameter { id label interventions { intervention { id label } } } }
            }
          }
        }
      }
    }
  `;

  try {
    const result = await readClient.query({
      query: gql`
        ${queryStr}
      `,
    });
    const data = result.data as Record<string, unknown>;
    let rows = (data['modelcatalog_software'] ?? []) as Record<
      string,
      unknown
    >[];

    rows = rows.filter((sw: any) => {
      for (const ver of sw.versions ?? []) {
        for (const cfg of ver.configurations ?? []) {
          for (const setup of cfg.setups ?? []) {
            for (const paramJunction of setup.parameters ?? []) {
              const param = paramJunction.parameter;
              if (!param) continue;
              if ((param.interventions ?? []).length > 0) {
                if (!label) return true;
                return (param.interventions as any[]).some(
                  (invJunction: any) => {
                    const inv = invJunction.intervention;
                    return inv?.label
                      ?.toLowerCase()
                      .includes(label.toLowerCase());
                  },
                );
              }
            }
          }
        }
      }
      return false;
    });

    reply.code(200).send(transformList(rows, resourceConfig));
  } catch (err: any) {
    req.log.error({ err }, 'custom_model_intervention_get failed');
    reply
      .code(500)
      .send({ error: 'Internal server error', details: err?.message });
  }
}

// ---------------------------------------------------------------------------
// 3. /custom/model/region (custom_model_region_get)
// ---------------------------------------------------------------------------
async function custom_model_region_get(req: any, reply: any) {
  const resourceConfig = getResourceConfig('models')!;
  const { username: _username, label } = req.query || {};

  const queryStr = `
    query CustomModelRegion {
      modelcatalog_software(where: { type: { _eq: "https://w3id.org/okn/o/sdm#Model" } } limit: 500 offset: 0) {
        id label description type
        author { id label }
        versions { id label configurations { id label regions { region { id label } } } }
      }
    }
  `;

  try {
    const result = await readClient.query({
      query: gql`
        ${queryStr}
      `,
    });
    const data = result.data as Record<string, unknown>;
    let rows = (data['modelcatalog_software'] ?? []) as Record<
      string,
      unknown
    >[];

    if (label) {
      const lbl = label.toLowerCase();
      rows = rows.filter((sw: any) => {
        for (const ver of sw.versions ?? []) {
          for (const cfg of ver.configurations ?? []) {
            for (const regionJunction of cfg.regions ?? []) {
              const region = regionJunction.region;
              if (region?.label?.toLowerCase().includes(lbl)) return true;
            }
          }
        }
        return false;
      });
    }

    reply.code(200).send(transformList(rows, resourceConfig));
  } catch (err: any) {
    req.log.error({ err }, 'custom_model_region_get failed');
    reply
      .code(500)
      .send({ error: 'Internal server error', details: err?.message });
  }
}

// ---------------------------------------------------------------------------
// 4. /custom/models/variable (custom_models_variable_get)
// ---------------------------------------------------------------------------
async function custom_models_variable_get(req: any, reply: any) {
  const resourceConfig = getResourceConfig('models')!;
  const { username: _username, label } = req.query || {};

  const queryStr = `
    query CustomModelsVariable {
      modelcatalog_software(where: { type: { _eq: "https://w3id.org/okn/o/sdm#Model" } } limit: 500 offset: 0) {
        id label description type
        author { id label }
        versions { id label input_variables { variable { id label } } output_variables { variable { id label } } }
      }
    }
  `;

  try {
    const result = await readClient.query({
      query: gql`
        ${queryStr}
      `,
    });
    const data = result.data as Record<string, unknown>;
    let rows = (data['modelcatalog_software'] ?? []) as Record<
      string,
      unknown
    >[];

    if (label) {
      const lbl = label.toLowerCase();
      rows = rows.filter((sw: any) => {
        for (const ver of sw.versions ?? []) {
          const allVarJunctions = [
            ...(ver.input_variables ?? []),
            ...(ver.output_variables ?? []),
          ];
          if (
            allVarJunctions.some((vj: any) =>
              vj.variable?.label?.toLowerCase().includes(lbl),
            )
          )
            return true;
        }
        return false;
      });
    }

    reply.code(200).send(transformList(rows, resourceConfig));
  } catch (err: any) {
    req.log.error({ err }, 'custom_models_variable_get failed');
    reply
      .code(500)
      .send({ error: 'Internal server error', details: err?.message });
  }
}

// ---------------------------------------------------------------------------
// 5. /custom/modelconfigurationsetups/variable (custom_modelconfigurationsetups_variable_get)
// ---------------------------------------------------------------------------
async function custom_modelconfigurationsetups_variable_get(
  req: any,
  reply: any,
) {
  const resourceConfig = getResourceConfig('modelconfigurationsetups')!;
  const { username: _username, label } = req.query || {};

  const queryStr = `
    query CustomSetupsVariable {
      modelcatalog_configuration(limit: 500 offset: 0) {
        id label description
        parent_configuration { id label }
        inputs { input { id label } }
        outputs { output { id label } }
      }
    }
  `;

  try {
    const result = await readClient.query({
      query: gql`
        ${queryStr}
      `,
    });
    const data = result.data as Record<string, unknown>;
    let rows = (data['modelcatalog_configuration'] ?? []) as Record<
      string,
      unknown
    >[];

    if (label) {
      const lbl = label.toLowerCase();
      rows = rows.filter((setup: any) => {
        const allJunctions = [
          ...(setup.inputs ?? []),
          ...(setup.outputs ?? []),
        ];
        for (const junction of allJunctions) {
          const entity = junction.input ?? junction.output;
          if (entity?.label?.toLowerCase().includes(lbl)) return true;
        }
        return false;
      });
    }

    reply.code(200).send(transformList(rows, resourceConfig));
  } catch (err: any) {
    req.log.error(
      { err },
      'custom_modelconfigurationsetups_variable_get failed',
    );
    reply
      .code(500)
      .send({ error: 'Internal server error', details: err?.message });
  }
}

// ---------------------------------------------------------------------------
// 6. /custom/configurationsetups/{id} (custom_configurationsetups_id_get)
// ---------------------------------------------------------------------------
async function custom_configurationsetups_id_get(req: any, reply: any) {
  const resourceConfig = getResourceConfig('configurationsetups')!;
  const id = decodeURIComponent(req.params.id);
  const fullId = resolveResourceId(id, resourceConfig);

  const queryStr = `
    query CustomConfigurationSetupById($id: String!) {
      modelcatalog_configuration_by_pk(id: $id) {
        ${SETUP_FIELDS}
      }
    }
  `;

  try {
    const result = await readClient.query({
      query: gql`
        ${queryStr}
      `,
      variables: { id: fullId },
    });
    const data = result.data as Record<string, unknown>;
    const row = data['modelcatalog_configuration_by_pk'] as Record<
      string,
      unknown
    > | null;
    if (!row) {
      reply.code(404).send({ error: 'Not found' });
      return;
    }
    reply.code(200).send(transformRow(row, resourceConfig));
  } catch (err: any) {
    req.log.error({ err }, 'custom_configurationsetups_id_get failed');
    reply
      .code(500)
      .send({ error: 'Internal server error', details: err?.message });
  }
}

// ---------------------------------------------------------------------------
// 7. /custom/modelconfigurationsetups/{id} (custom_modelconfigurationsetups_id_get)
// ---------------------------------------------------------------------------
async function custom_modelconfigurationsetups_id_get(req: any, reply: any) {
  const resourceConfig = getResourceConfig('modelconfigurationsetups')!;
  const id = decodeURIComponent(req.params.id);
  const fullId = resolveResourceId(id, resourceConfig);

  const queryStr = `
    query CustomModelConfigurationSetupById($id: String!) {
      modelcatalog_configuration_by_pk(id: $id) {
        ${SETUP_FIELDS}
      }
    }
  `;

  try {
    const result = await readClient.query({
      query: gql`
        ${queryStr}
      `,
      variables: { id: fullId },
    });
    const data = result.data as Record<string, unknown>;
    const row = data['modelcatalog_configuration_by_pk'] as Record<
      string,
      unknown
    > | null;
    if (!row) {
      reply.code(404).send({ error: 'Not found' });
      return;
    }
    reply.code(200).send(transformRow(row, resourceConfig));
  } catch (err: any) {
    req.log.error({ err }, 'custom_modelconfigurationsetups_id_get failed');
    reply
      .code(500)
      .send({ error: 'Internal server error', details: err?.message });
  }
}

// ---------------------------------------------------------------------------
// 8. /custom/modelconfigurations/{id} (custom_modelconfigurations_id_get)
// ---------------------------------------------------------------------------
async function custom_modelconfigurations_id_get(req: any, reply: any) {
  const resourceConfig = getResourceConfig('modelconfigurations')!;
  const id = decodeURIComponent(req.params.id);
  const fullId = resolveResourceId(id, resourceConfig);

  const queryStr = `
    query CustomModelConfigurationById($id: String!) {
      modelcatalog_configuration_by_pk(id: $id) {
        ${CONFIGURATION_FIELDS}
      }
    }
  `;

  try {
    const result = await readClient.query({
      query: gql`
        ${queryStr}
      `,
      variables: { id: fullId },
    });
    const data = result.data as Record<string, unknown>;
    const row = data['modelcatalog_configuration_by_pk'] as Record<
      string,
      unknown
    > | null;
    if (!row) {
      reply.code(404).send({ error: 'Not found' });
      return;
    }
    reply.code(200).send(transformRow(row, resourceConfig));
  } catch (err: any) {
    req.log.error({ err }, 'custom_modelconfigurations_id_get failed');
    reply
      .code(500)
      .send({ error: 'Internal server error', details: err?.message });
  }
}

// ---------------------------------------------------------------------------
// 9. /custom/models/standard_variable (custom_models_standard_variable_get)
// NOTE: standardvariables table does not exist yet; search by variable presentation label instead.
// ---------------------------------------------------------------------------
async function custom_models_standard_variable_get(req: any, reply: any) {
  const resourceConfig = getResourceConfig('models')!;
  const { username: _username, label } = req.query || {};

  const queryStr = `
    query CustomModelsStandardVariable {
      modelcatalog_software(where: { type: { _eq: "https://w3id.org/okn/o/sdm#Model" } } limit: 500 offset: 0) {
        id label description type
        author { id label }
        versions { id label input_variables { variable { id label } } output_variables { variable { id label } } }
      }
    }
  `;

  try {
    const result = await readClient.query({
      query: gql`
        ${queryStr}
      `,
    });
    const data = result.data as Record<string, unknown>;
    let rows = (data['modelcatalog_software'] ?? []) as Record<
      string,
      unknown
    >[];

    if (label) {
      const lbl = label.toLowerCase();
      rows = rows.filter((sw: any) => {
        for (const ver of sw.versions ?? []) {
          const allVarJunctions = [
            ...(ver.input_variables ?? []),
            ...(ver.output_variables ?? []),
          ];
          if (
            allVarJunctions.some((vj: any) =>
              vj.variable?.label?.toLowerCase().includes(lbl),
            )
          )
            return true;
        }
        return false;
      });
    }

    reply.code(200).send(transformList(rows, resourceConfig));
  } catch (err: any) {
    req.log.error({ err }, 'custom_models_standard_variable_get failed');
    reply
      .code(500)
      .send({ error: 'Internal server error', details: err?.message });
  }
}

// ---------------------------------------------------------------------------
// 10. /custom/datasetspecifications/{id}/datatransformations
//     (custom_datasetspecifications_id_datatransformations_get)
// No dedicated datatransformations table exists in the PostgreSQL schema.
// Returns empty array, consistent with null-table resource type behavior.
// ---------------------------------------------------------------------------
async function custom_datasetspecifications_id_datatransformations_get(
  _req: any,
  reply: any,
) {
  reply.code(200).send([]);
}

// ---------------------------------------------------------------------------
// 11. /custom/datasetspecifications (custom_datasetspecifications_get)
// ---------------------------------------------------------------------------
async function custom_datasetspecifications_get(req: any, reply: any) {
  const resourceConfig = getResourceConfig('datasetspecifications')!;
  const { username: _username, configurationid } = req.query || {};

  if (configurationid) {
    const cfgId = decodeURIComponent(configurationid);
    const fullCfgId = resolveResourceId(cfgId, {
      idPrefix: getResourceConfig('modelconfigurations')!.idPrefix,
    });
    const innerVars: Record<string, unknown> = { cfgId: fullCfgId };

    // Query junction tables directly; relationship names on junction rows are `input` and `output`
    const cfgQuery = `
      query CustomDatasetSpecificationsByConfig($cfgId: String!) {
        modelcatalog_configuration_input(where: { configuration_id: { _eq: $cfgId } }) {
          input { id label description has_format has_dimensionality position }
        }
        modelcatalog_configuration_output(where: { configuration_id: { _eq: $cfgId } }) {
          output { id label description has_format has_dimensionality position }
        }
      }
    `;

    try {
      const result = await readClient.query({
        query: gql`
          ${cfgQuery}
        `,
        variables: innerVars,
      });
      const cfgData = result.data as Record<string, unknown>;
      const inputSpecs = (
        (cfgData['modelcatalog_configuration_input'] ?? []) as any[]
      )
        .map((r: any) => r.input)
        .filter(Boolean) as Record<string, unknown>[];
      const outputSpecs = (
        (cfgData['modelcatalog_configuration_output'] ?? []) as any[]
      )
        .map((r: any) => r.output)
        .filter(Boolean) as Record<string, unknown>[];

      const seen = new Set<string>();
      const allSpecs = [...inputSpecs, ...outputSpecs].filter((spec: any) => {
        if (seen.has(spec.id)) return false;
        seen.add(spec.id);
        return true;
      });
      reply.code(200).send(transformList(allSpecs, resourceConfig));
    } catch (err: any) {
      req.log.error(
        { err },
        'custom_datasetspecifications_get (configurationid) failed',
      );
      reply
        .code(500)
        .send({ error: 'Internal server error', details: err?.message });
    }
    return;
  }

  const { page = 1, per_page = 25 } = req.query || {};
  const limit = parseInt(String(per_page), 10) || 25;
  const offset = (parseInt(String(page), 10) - 1) * limit || 0;

  const variables: Record<string, unknown> = { limit, offset };

  const listQuery = `
    query CustomDatasetSpecifications($limit: Int!, $offset: Int!) {
      modelcatalog_dataset_specification(limit: $limit offset: $offset) {
        id label description has_format has_dimensionality position
      }
    }
  `;

  try {
    const result = await readClient.query({
      query: gql`
        ${listQuery}
      `,
      variables,
    });
    const data = result.data as Record<string, unknown>;
    const rows = (data['modelcatalog_dataset_specification'] ?? []) as Record<
      string,
      unknown
    >[];
    reply.code(200).send(transformList(rows, resourceConfig));
  } catch (err: any) {
    req.log.error({ err }, 'custom_datasetspecifications_get failed');
    reply
      .code(500)
      .send({ error: 'Internal server error', details: err?.message });
  }
}

// ---------------------------------------------------------------------------
// 12. /custom/configuration/{id}/inputs (custom_configuration_id_inputs_get)
// ---------------------------------------------------------------------------
async function custom_configuration_id_inputs_get(req: any, reply: any) {
  const resourceConfig = getResourceConfig('datasetspecifications')!;
  const id = decodeURIComponent(req.params.id);
  const fullId = resolveResourceId(id, {
    idPrefix: getResourceConfig('modelconfigurations')!.idPrefix,
  });

  const queryStr = `
    query CustomConfigurationInputs($id: String!) {
      modelcatalog_configuration_by_pk(id: $id) {
        inputs {
          input { id label description has_format has_dimensionality position }
        }
      }
    }
  `;

  try {
    const result = await readClient.query({
      query: gql`
        ${queryStr}
      `,
      variables: { id: fullId },
    });
    const data = result.data as Record<string, unknown>;
    const cfg = data['modelcatalog_configuration_by_pk'] as {
      inputs?: Record<string, unknown>[];
    } | null;
    if (!cfg) {
      reply.code(404).send({ error: 'Configuration not found' });
      return;
    }
    // Unwrap junction rows to get the actual dataset_specification entities
    const rows = ((cfg.inputs ?? []) as any[])
      .map((j: any) => j.input)
      .filter(Boolean) as Record<string, unknown>[];
    reply.code(200).send(transformList(rows, resourceConfig));
  } catch (err: any) {
    req.log.error({ err }, 'custom_configuration_id_inputs_get failed');
    reply
      .code(500)
      .send({ error: 'Internal server error', details: err?.message });
  }
}

// ---------------------------------------------------------------------------
// 13. /user/login (user_login_post)
// Auth is handled externally via Keycloak. Returns 501.
// ---------------------------------------------------------------------------
async function user_login_post(_req: any, reply: any) {
  reply.code(501).send({
    error: 'Login endpoint not implemented',
    message:
      'Authenticate directly with the Keycloak auth server to obtain a JWT token.',
  });
}

// ---------------------------------------------------------------------------
// Tapis proxy endpoints (migrated from model-catalog-fastapi)
// Uses @tapis/tapis-typescript SDK. Forwards the user's Bearer JWT as the
// Tapis X-Tapis-Token via Configuration.apiKey.
// ---------------------------------------------------------------------------
function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : authHeader;
}

function buildAppsApi(tenant: string, token: string): Apps.ApplicationsApi {
  // SDK paths already include `/v3/...`, so basePath must not duplicate it.
  const config = new Apps.Configuration({
    basePath: `https://${tenant}.tapis.io`,
    apiKey: () => token,
  });
  return new Apps.ApplicationsApi(config);
}

async function custom_tapis_apps_get(req: any, reply: any) {
  const tenant = req.params?.tenant;
  if (!tenant) {
    reply.code(400).send({ error: 'tenant path parameter required' });
    return;
  }
  const token = extractBearerToken(req.headers?.authorization);
  if (!token) {
    reply.code(401).send({ error: 'Authorization header required' });
    return;
  }
  try {
    const api = buildAppsApi(tenant, token);
    const resp = await api.getApps({});
    const result = (resp.result ?? []) as Array<{
      id?: string;
      version?: string;
    }>;
    const apps = result.map((a) => ({ tenant, id: a.id, version: a.version }));
    reply.code(200).send(apps);
  } catch (err: any) {
    const status = err?.status ?? err?.response?.status;
    req.log.error({ err, tenant }, 'Tapis apps list failed');
    if (status) {
      const body = await (err?.response?.text?.() ??
        Promise.resolve(err?.message ?? ''));
      reply.code(status).send({ error: 'Tapis error', details: body });
      return;
    }
    reply.code(502).send({ error: 'Bad gateway', details: err?.message });
  }
}

async function custom_tapis_apps_id_get(req: any, reply: any) {
  const tenant = req.params?.tenant;
  const appId = req.params?.app_id;
  const appVersion = req.params?.app_version;
  if (!tenant || !appId || !appVersion) {
    reply
      .code(400)
      .send({ error: 'tenant, app_id, app_version path parameters required' });
    return;
  }
  const token = extractBearerToken(req.headers?.authorization);
  if (!token) {
    reply.code(401).send({ error: 'Authorization header required' });
    return;
  }
  try {
    const api = buildAppsApi(tenant, token);
    const resp = await api.getApp({ appId, appVersion });
    const app = (resp.result ?? {}) as Record<string, unknown>;
    reply.code(200).send({ tenant, ...app });
  } catch (err: any) {
    const status = err?.status ?? err?.response?.status;
    req.log.error({ err, tenant, appId, appVersion }, 'Tapis app get failed');
    if (status) {
      const body = await (err?.response?.text?.() ??
        Promise.resolve(err?.message ?? ''));
      reply.code(status).send({ error: 'Tapis error', details: body });
      return;
    }
    reply.code(502).send({ error: 'Bad gateway', details: err?.message });
  }
}

// ---------------------------------------------------------------------------
// Export all handlers keyed by operationId
// ---------------------------------------------------------------------------
export const customHandlers: Record<
  string,
  (req: any, reply: any) => Promise<void>
> = {
  custom_model_index_get,
  custom_model_intervention_get,
  custom_model_region_get,
  custom_models_variable_get,
  custom_modelconfigurationsetups_variable_get,
  custom_configurationsetups_id_get,
  custom_modelconfigurationsetups_id_get,
  custom_modelconfigurations_id_get,
  custom_models_standard_variable_get,
  custom_datasetspecifications_id_datatransformations_get,
  custom_datasetspecifications_get,
  custom_configuration_id_inputs_get,
  custom_tapis_apps_get,
  custom_tapis_apps_id_get,
  custom_regions_import_access_get,
  custom_regions_import_post,
  custom_regions_categories_post,
  custom_flows_post,
  custom_flows_id_availability_get,
  user_login_post,
};
