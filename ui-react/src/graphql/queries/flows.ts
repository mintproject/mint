import { gql } from '@apollo/client';

/**
 * Flows: model configurations that have a row in `modelcatalog_configuration_flow`.
 *
 * Hand-authored beside `catalog-counts.ts` rather than generated: codegen needs a
 * live Hasura and these documents were added without one. Both queries are
 * deliberately separate from the page queries, so a deployment where they fail
 * loses the "Flow" badge or the Steps section, never the page.
 *
 * Permissions (graphql_engine/metadata/tables.yaml): the `anonymous` and `user`
 * roles may both select `modelcatalog_configuration_flow` (all rows),
 * `modelcatalog_configuration_step`, and `modelcatalog_etl_process` (anonymous:
 * public pieces only; user: public, shared and their own). A step whose piece the
 * caller may not read therefore comes back with `etl_process: null` while
 * `etl_process_id` is still set, the same as a step whose piece was deleted.
 */

/** The ids of every flow configuration, to join onto the browse list. */
export const GET_FLOW_CONFIGURATION_IDS = gql`
  query GetFlowConfigurationIds {
    modelcatalog_configuration_flow {
      configuration_id
    }
  }
`;

export interface GetFlowConfigurationIdsData {
  modelcatalog_configuration_flow: { configuration_id: string }[];
}

/** One flow with its steps in order and each step's piece. */
export const GET_CONFIGURATION_FLOW = gql`
  query GetConfigurationFlow($id: String!) {
    modelcatalog_configuration_flow_by_pk(configuration_id: $id) {
      configuration_id
      thread_bindings_json
      outputs_json
      steps(order_by: { position: asc }) {
        position
        etl_process_id
        settings_json
        wires_json
        pause_after
        etl_process {
          id
          label
          description
          owner_username
          visibility
        }
      }
    }
  }
`;

export interface FlowPieceRow {
  id: string;
  label?: string | null;
  description?: string | null;
  owner_username?: string | null;
  visibility?: string | null;
}

export interface FlowStepRow {
  position: number;
  etl_process_id?: string | null;
  settings_json?: unknown;
  wires_json?: unknown;
  pause_after?: boolean | null;
  etl_process?: FlowPieceRow | null;
}

export interface GetConfigurationFlowData {
  modelcatalog_configuration_flow_by_pk?: {
    configuration_id: string;
    thread_bindings_json?: unknown;
    outputs_json?: unknown;
    steps: FlowStepRow[];
  } | null;
}
