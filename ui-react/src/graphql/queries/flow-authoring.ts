import { gql } from '@apollo/client';

import type { StoredFlowSource } from '@/lib/flow-authoring';

/**
 * Reads for the flow form, hand-authored beside `flows.ts` for the same reason
 * (codegen needs a live Hasura). The pieces are read with the caller's token, so
 * Hasura's select rules already hide another user's private piece.
 */

/** Every piece the caller may see, for the step picker. */
export const GET_FLOW_PIECES = gql`
  query GetFlowAuthoringPieces {
    modelcatalog_etl_process(order_by: { label: asc }, limit: 1000) {
      id
      label
      description
      visibility
      owner_username
    }
  }
`;

export interface PickerPiece {
  id: string;
  label?: string | null;
  description?: string | null;
  visibility?: string | null;
  owner_username?: string | null;
}

export interface GetFlowPiecesData {
  modelcatalog_etl_process: PickerPiece[];
}

/** A flow with what the form needs to open it as a copy. */
export const GET_FLOW_FOR_COPY = gql`
  query GetFlowForCopy($pattern: String!) {
    modelcatalog_configuration(
      where: { id: { _ilike: $pattern }, flow: {} }
      order_by: { id: asc }
      limit: 1
    ) {
      id
      label
      description
      software_version {
        id
        version_id
        software {
          id
          label
        }
      }
      inputs {
        configuration_id
        input_id
        is_optional
        input {
          id
          label
          has_format
          position
          presentations {
            dataset_specification_id
            presentation_id
            presentation {
              id
              standard_variable {
                id
                label
              }
            }
          }
        }
      }
      outputs {
        configuration_id
        output_id
        output {
          id
          label
          has_format
        }
      }
      parameters {
        configuration_id
        parameter_id
        parameter {
          id
          label
        }
      }
      flow {
        thread_bindings_json
        outputs_json
        settings_json
        steps(order_by: { position: asc }) {
          position
          etl_process_id
          settings_json
          wires_json
          pause_after
          etl_process {
            id
          }
        }
      }
    }
  }
`;

export interface GetFlowForCopyData {
  modelcatalog_configuration: (StoredFlowSource['configuration'] & {
    id: string;
    flow?: StoredFlowSource['flow'] | null;
  })[];
}
