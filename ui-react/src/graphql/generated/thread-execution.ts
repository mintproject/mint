/**
 * GraphQL operations for the thread execution pipeline.
 *
 * Covers the `thread_model*`, `thread_data`, `dataslice` and `execution` tables
 * that the Datasets, Parameters, Runs and Results steps read and write.
 *
 * Hand-authored in the same style as modeling.ts, and mirroring the legacy Lit
 * operations one for one:
 *   ui/src/queries/thread/get.graphql                     -> GetThreadExecution
 *   ui/src/queries/thread/update-parameters.graphql       -> UpdateThreadParameters
 *   ui/src/queries/execution/executions-for-thread-model  -> GetThreadModelExecutions
 *
 * No aggregate field is selected here on purpose: `*_aggregate` is not exposed
 * to Hasura's `anonymous` role on either deployment, so an aggregate would fail
 * the whole document for a signed-out reader. Resource rows are counted
 * client-side instead (see threadExecutionFromGQL).
 */
import { gql } from '@apollo/client';
import * as Apollo from '@apollo/client';

const defaultOptions = {} as const;

// ─── Row types ────────────────────────────────────────────────────────────────

export type ExecutionSummaryRow = {
  __typename?: 'thread_model_execution_summary';
  total_runs: number;
  submitted_runs: number;
  successful_runs: number;
  failed_runs: number;
  ingested_runs: number;
  registered_runs: number;
  published_runs: number;
  fetched_run_outputs: number;
  submission_time?: string | null;
  submitted_for_execution: boolean;
  submitted_for_ingestion: boolean;
  submitted_for_publishing: boolean;
  submitted_for_registration: boolean;
  workflow_name?: string | null;
};

export type StandardVariableRow = { id: string; label?: string | null };

export type DatasetSpecRow = {
  id: string;
  label?: string | null;
  has_format?: string | null;
  presentations: Array<{
    dataset_specification_id?: string;
    presentation_id?: string;
    presentation: { id: string; standard_variable?: StandardVariableRow | null };
  }>;
};

export type ParameterRow = {
  id: string;
  label?: string | null;
  description?: string | null;
  has_data_type?: string | null;
  has_default_value?: string | null;
  has_fixed_value?: string | null;
  has_minimum_accepted_value?: string | null;
  has_maximum_accepted_value?: string | null;
  has_accepted_values?: string[] | null;
  position?: number | null;
  parameter_type?: string | null;
};

export type ThreadModelRow = {
  __typename?: 'thread_model';
  id: string;
  modelcatalog_configuration_id?: string | null;
  execution_summary: ExecutionSummaryRow[];
  modelcatalog_configuration?: {
    id: string;
    label?: string | null;
    description?: string | null;
    usage_notes?: string | null;
    inputs: Array<{
      configuration_id?: string;
      input_id?: string;
      is_optional?: boolean | null;
      input: DatasetSpecRow;
    }>;
    outputs: Array<{
      configuration_id?: string;
      output_id?: string;
      output: DatasetSpecRow;
    }>;
    parameters: Array<{
      configuration_id?: string;
      parameter_id?: string;
      parameter: ParameterRow;
    }>;
  } | null;
  data_bindings: Array<{
    thread_model_id?: string;
    model_io_id: string;
    dataslice_id: string;
  }>;
  parameter_bindings: Array<{
    thread_model_id?: string;
    model_parameter_id: string;
    parameter_value: string;
  }>;
};

export type ThreadDataRow = {
  __typename?: 'thread_data';
  thread_id?: string;
  dataslice: {
    id: string;
    name: string;
    start_date?: string | null;
    end_date?: string | null;
    resource_count: number;
    dataset: { id: string; name: string };
    resources: Array<{
      dataslice_id?: string;
      resource_id?: string;
      selected: boolean;
      resource: { id: string; dcid?: string | null; name: string; url: string };
    }>;
  };
};

export type ThreadExecutionRow = {
  __typename?: 'thread';
  id: string;
  response_variable_id?: string | null;
  thread_data: ThreadDataRow[];
  thread_models: ThreadModelRow[];
};

// ─── Query: GetThreadExecution ───────────────────────────────────────────────

export type GetThreadExecutionQueryVariables = { id: string };

export type GetThreadExecutionQuery = {
  __typename?: 'query_root';
  thread_by_pk?: ThreadExecutionRow | null;
};

const DATASET_SPEC_IO = gql`
  fragment thread_dataset_spec on modelcatalog_dataset_specification {
    id
    label
    has_format
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
`;

export const GetThreadExecutionDocument = gql`
  ${DATASET_SPEC_IO}
  query GetThreadExecution($id: String!) {
    thread_by_pk(id: $id) {
      id
      response_variable_id
      thread_data {
        thread_id
        dataslice {
          id
          name
          start_date
          end_date
          resource_count
          dataset {
            id
            name
          }
          resources {
            dataslice_id
            resource_id
            selected
            resource {
              id
              dcid
              name
              url
            }
          }
        }
      }
      thread_models {
        id
        modelcatalog_configuration_id
        execution_summary {
          total_runs
          submitted_runs
          successful_runs
          failed_runs
          ingested_runs
          registered_runs
          published_runs
          fetched_run_outputs
          submission_time
          submitted_for_execution
          submitted_for_ingestion
          submitted_for_publishing
          submitted_for_registration
          workflow_name
        }
        modelcatalog_configuration {
          id
          label
          description
          usage_notes
          inputs {
            configuration_id
            input_id
            is_optional
            input {
              ...thread_dataset_spec
            }
          }
          outputs {
            configuration_id
            output_id
            output {
              ...thread_dataset_spec
            }
          }
          parameters {
            configuration_id
            parameter_id
            parameter {
              id
              label
              description
              has_data_type
              has_default_value
              has_fixed_value
              has_minimum_accepted_value
              has_maximum_accepted_value
              has_accepted_values
              position
              parameter_type
            }
          }
        }
        data_bindings {
          thread_model_id
          model_io_id
          dataslice_id
        }
        parameter_bindings {
          thread_model_id
          model_parameter_id
          parameter_value
        }
      }
    }
  }
`;

export function useGetThreadExecutionQuery(
  baseOptions: Apollo.QueryHookOptions<
    GetThreadExecutionQuery,
    GetThreadExecutionQueryVariables
  > & { variables: GetThreadExecutionQueryVariables },
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<GetThreadExecutionQuery, GetThreadExecutionQueryVariables>(
    GetThreadExecutionDocument,
    options,
  );
}

// ─── Mutation: UpdateThreadParameters ────────────────────────────────────────

export type ThreadModelParameterInsert = {
  thread_model_id: string;
  model_parameter_id: string;
  parameter_value: string;
};

export type ThreadModelSummaryInsert = {
  thread_model_id: string;
  total_runs: number;
  submitted_runs: number;
  successful_runs: number;
  failed_runs: number;
};

export type UpdateThreadParametersMutationVariables = {
  threadId: string;
  event: {
    thread_id: string;
    event: string;
    userid: string;
    notes?: string | null;
  };
  summaries: ThreadModelSummaryInsert[];
  modelParams: ThreadModelParameterInsert[];
};

export type UpdateThreadParametersMutation = {
  insert_thread_model_parameter?: { returning: Array<{ model_parameter_id: string }> } | null;
  insert_thread_model_execution_summary?: {
    returning: Array<{ thread_model_id: string }>;
  } | null;
  insert_thread_provenance_one?: { thread_id: string } | null;
};

/**
 * Replace a thread's parameter bindings and execution summaries in one document.
 *
 * The deletes are not optional: a parameter change invalidates every run that
 * came before it, so the executions and their summaries go with it. Hasura runs
 * a mutation's root fields in a single transaction, so the thread is never left
 * with bindings from one save and summaries from another.
 */
export const UpdateThreadParametersDocument = gql`
  mutation UpdateThreadParameters(
    $threadId: String!
    $event: thread_provenance_insert_input!
    $summaries: [thread_model_execution_summary_insert_input!]!
    $modelParams: [thread_model_parameter_insert_input!]!
  ) {
    delete_thread_model_execution_summary(
      where: { thread_model: { thread_id: { _eq: $threadId } } }
    ) {
      affected_rows
    }
    delete_thread_model_parameter(where: { thread_model: { thread_id: { _eq: $threadId } } }) {
      affected_rows
    }
    delete_thread_model_execution(where: { thread_model: { thread_id: { _eq: $threadId } } }) {
      affected_rows
    }
    insert_thread_model_parameter(objects: $modelParams) {
      returning {
        model_parameter_id
      }
    }
    insert_thread_model_execution_summary(objects: $summaries) {
      returning {
        thread_model_id
      }
    }
    insert_thread_provenance_one(object: $event) {
      thread_id
    }
  }
`;

export function useUpdateThreadParametersMutation(
  baseOptions?: Apollo.MutationHookOptions<
    UpdateThreadParametersMutation,
    UpdateThreadParametersMutationVariables
  >,
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<
    UpdateThreadParametersMutation,
    UpdateThreadParametersMutationVariables
  >(UpdateThreadParametersDocument, options);
}

// ─── Query: GetThreadModelExecutions ─────────────────────────────────────────

export type ExecutionRow = {
  __typename?: 'execution';
  id: string;
  status?: string | null;
  run_progress: number;
  run_id?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  execution_engine?: string | null;
  modelcatalog_configuration_id?: string | null;
  parameter_bindings: Array<{
    execution_id?: string;
    model_parameter_id: string;
    parameter_value: string;
  }>;
  data_bindings: Array<{
    execution_id?: string;
    model_io_id: string;
    resource: { id: string; name: string; url?: string | null };
  }>;
  results: Array<{
    execution_id?: string;
    model_io_id: string;
    resource: { id: string; name: string; url?: string | null };
  }>;
};

export type GetThreadModelExecutionsQueryVariables = {
  threadModelId: string;
  offset: number;
  limit: number;
};

export type GetThreadModelExecutionsQuery = {
  __typename?: 'query_root';
  execution: ExecutionRow[];
};

export const GetThreadModelExecutionsDocument = gql`
  query GetThreadModelExecutions($threadModelId: uuid!, $offset: Int!, $limit: Int!) {
    execution(
      offset: $offset
      limit: $limit
      order_by: { start_time: desc }
      where: { thread_model_executions: { thread_model_id: { _eq: $threadModelId } } }
    ) {
      id
      status
      run_progress
      run_id
      start_time
      end_time
      execution_engine
      modelcatalog_configuration_id
      parameter_bindings {
        execution_id
        model_parameter_id
        parameter_value
      }
      data_bindings {
        execution_id
        model_io_id
        resource {
          id
          name
          url
        }
      }
      results {
        execution_id
        model_io_id
        resource {
          id
          name
          url
        }
      }
    }
  }
`;
