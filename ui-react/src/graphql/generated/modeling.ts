/**
 * GraphQL types, hooks, and documents for the modeling workflow.
 *
 * Covers: problem_statement, task, thread (public schema tables).
 * Hand-authored to match the Hasura schema defined in
 * graphql_engine/migrations/1662641297914_init/up.sql and
 * graphql_engine/metadata/tables.yaml.
 *
 * Regenerate via `npm run codegen` if the Hasura endpoint is accessible.
 */
import { gql } from '@apollo/client';
import * as Apollo from '@apollo/client';
import type { Problem_Statement_Bool_Exp } from './graphql';

// ─── Scalar types (reused from graphql.ts) ───────────────────────────────────

export type Maybe<T> = T | null;

const defaultOptions = {} as const;

// ─── Enums ───────────────────────────────────────────────────────────────────

export type ProblemStatementEvents =
  | 'CREATE'
  | 'UPDATE'
  | 'ADD_TASK'
  | 'DELETE_TASK';

export type TaskEvents = 'CREATE' | 'UPDATE' | 'ADD_THREAD' | 'DELETE_THREAD';

export type ThreadEvents =
  | 'CREATE'
  | 'UPDATE'
  | 'SELECT_DATA'
  | 'SELECT_MODELS'
  | 'SELECT_PARAMETERS'
  | 'EXECUTE'
  | 'INGEST'
  | 'VISUALIZE';

// ─── Entity types ────────────────────────────────────────────────────────────

export type ProblemStatementProvenance = {
  __typename?: 'problem_statement_provenance';
  problem_statement_id?: string;
  event: ProblemStatementEvents;
  userid: string;
  timestamp: string;
  notes?: Maybe<string>;
};

export type ProblemStatementPermission = {
  __typename?: 'problem_statement_permission';
  user_id: string;
  read: boolean;
  write: boolean;
};

export type ProblemStatement = {
  __typename?: 'problem_statement';
  id: string;
  name?: Maybe<string>;
  start_date: string;
  end_date: string;
  region_id: string;
  events: ProblemStatementProvenance[];
  permissions: ProblemStatementPermission[];
  tasks: Task[];
};

export type TaskProvenance = {
  __typename?: 'task_provenance';
  event: TaskEvents;
  userid: string;
  timestamp: string;
  notes?: Maybe<string>;
};

export type TaskPermission = {
  __typename?: 'task_permission';
  user_id: string;
  read: boolean;
  write: boolean;
};

export type ThreadPermission = {
  __typename?: 'thread_permission';
  user_id: string;
  read: boolean;
  write: boolean;
};

export type ThreadProvenance = {
  __typename?: 'thread_provenance';
  event: ThreadEvents;
  userid: string;
  timestamp: string;
  notes?: Maybe<string>;
};

/**
 * The indicator and adjustable variable a thread or task is framed by.
 *
 * These point at `modelcatalog_standard_variable`, not the legacy `variable`
 * table: the stored id is a URI, so the label is the only readable name for it.
 * See https://github.com/mintproject/monorepo/issues/106
 */
export type VariableRef = {
  __typename?: 'modelcatalog_standard_variable';
  id: string;
  label?: Maybe<string>;
};

export type ThreadModel = {
  __typename?: 'thread_model';
  id: string;
  thread_id: string;
  model_id?: string | null;
  modelcatalog_configuration_id?: string | null;
  modelcatalog_configuration?: Maybe<{
    __typename?: 'modelcatalog_configuration';
    id: string;
    label?: Maybe<string>;
  }>;
};

export type Thread = {
  __typename?: 'thread';
  id: string;
  name?: Maybe<string>;
  task_id: string;
  /**
   * The owning task, carried only for `problem_statement_id`: publishing a
   * thread's results is a REST call whose path needs the problem statement and
   * task ids, and `task_id` alone cannot name the problem statement (#110).
   */
  task?: Maybe<{ __typename?: 'task'; id: string; problem_statement_id: string }>;
  start_date: string;
  end_date: string;
  region_id?: Maybe<string>;
  driving_variable_id?: Maybe<string>;
  response_variable_id?: Maybe<string>;
  driving_variable?: Maybe<VariableRef>;
  response_variable?: Maybe<VariableRef>;
  /**
   * The thread's region, with the geometries the Datasets step narrows on.
   * `region_id` alone cannot do that job — it names the region without saying
   * where it is.
   */
  region?: Maybe<ThreadRegion>;
  events: ThreadProvenance[];
  permissions: ThreadPermission[];
  thread_models?: ThreadModel[];
};

export type ThreadRegion = {
  __typename?: 'region';
  id: string;
  name?: Maybe<string>;
  /** Hasura returns the jsonb `geometry` column already parsed. */
  geometries: Array<{ id: number; geometry?: Maybe<unknown> }>;
};

export type Task = {
  __typename?: 'task';
  id: string;
  name: string;
  problem_statement_id: string;
  start_date: string;
  end_date: string;
  region_id?: Maybe<string>;
  driving_variable_id?: Maybe<string>;
  response_variable_id?: Maybe<string>;
  events: TaskProvenance[];
  permissions: TaskPermission[];
  threads: Thread[];
};

// ─── Permission utils ─────────────────────────────────────────────────────────

export interface UserPermissions {
  owner: boolean;
  write: boolean;
  read: boolean;
}

/**
 * Derive effective permissions for the current user from the permissions array
 * and provenance events.  Mirrors the legacy getUserPermission() logic.
 */
export function getUserPermission(
  permissions: Array<{ user_id: string; read: boolean; write: boolean }> | undefined | null,
  events: Array<{ event: string; userid: string }> | undefined | null,
  currentUserId?: string | null,
): UserPermissions {
  if (!currentUserId) {
    return { owner: false, write: false, read: false };
  }

  // Owner = created the resource
  const isOwner = (events ?? []).some(
    (e) => e.event === 'CREATE' && e.userid === currentUserId,
  );
  if (isOwner) {
    return { owner: true, write: true, read: true };
  }

  // Wildcard write permission
  const wildcardWrite = (permissions ?? []).some(
    (p) => p.user_id === '*' && p.write,
  );
  if (wildcardWrite) {
    return { owner: false, write: true, read: true };
  }

  // User-specific permission
  const userPerm = (permissions ?? []).find((p) => p.user_id === currentUserId);
  if (userPerm) {
    return { owner: false, write: userPerm.write, read: userPerm.read };
  }

  return { owner: false, write: false, read: false };
}

/**
 * Return the most-recent event from a provenance array.
 */
export function getLatestEvent<T extends { timestamp: string }>(
  events?: T[] | null,
): T | null {
  if (!events || events.length === 0) return null;
  return [...events].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))[0] ?? null;
}

/**
 * Return the most-recent event of the given types.
 */
export function getLatestEventOfType<T extends { event: string; timestamp: string }>(
  types: string[],
  events?: T[] | null,
): T | null {
  const filtered = (events ?? []).filter((e) => types.includes(e.event));
  return getLatestEvent(filtered);
}

// ─── Fragments ────────────────────────────────────────────────────────────────

const PROBLEM_STATEMENT_INFO = gql`
  fragment problem_statement_info on problem_statement {
    id
    name
    start_date
    end_date
    region_id
    permissions {
      user_id
      read
      write
    }
  }
`;

const TASK_INFO = gql`
  fragment task_info on task {
    id
    name
    problem_statement_id
    start_date
    end_date
    region_id
    driving_variable_id
    response_variable_id
    events {
      event
      timestamp
      userid
      notes
    }
    permissions {
      user_id
      read
      write
    }
  }
`;

const THREAD_INFO = gql`
  fragment thread_info on thread {
    id
    name
    task_id
    task {
      id
      problem_statement_id
    }
    start_date
    end_date
    region_id
    driving_variable_id
    response_variable_id
    events {
      event
      timestamp
      userid
      notes
    }
    permissions {
      user_id
      read
      write
    }
    driving_variable {
      id
      label
    }
    response_variable {
      id
      label
    }
    region {
      id
      name
      geometries {
        id
        geometry
      }
    }
    thread_models {
      id
      thread_id
      model_id
      modelcatalog_configuration_id
      modelcatalog_configuration {
        id
        label
      }
    }
  }
`;

// ─── Query: ListProblemStatements ────────────────────────────────────────────

export type ListProblemStatementsQueryVariables = {
  where: Problem_Statement_Bool_Exp;
};

export type ListProblemStatementsQuery = {
  __typename?: 'query_root';
  problem_statement: ProblemStatement[];
  problem_statement_provenance: ProblemStatementProvenance[];
};

export const ListProblemStatementsDocument = gql`
  ${PROBLEM_STATEMENT_INFO}
  query ListProblemStatements($where: problem_statement_bool_exp!) {
    problem_statement(where: $where, order_by: { id: desc }) {
      ...problem_statement_info
      tasks {
        id
        threads {
          id
          thread_models {
            id
          }
        }
      }
    }
    problem_statement_provenance {
      problem_statement_id
      event
      timestamp
      userid
      notes
    }
  }
`;

export function useListProblemStatementsQuery(
  baseOptions: Apollo.QueryHookOptions<
    ListProblemStatementsQuery,
    ListProblemStatementsQueryVariables
  > & { variables: ListProblemStatementsQueryVariables },
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<
    ListProblemStatementsQuery,
    ListProblemStatementsQueryVariables
  >(ListProblemStatementsDocument, options);
}

// ─── Query: GetProblemStatement ──────────────────────────────────────────────

export type GetProblemStatementQueryVariables = {
  id: string;
};

export type GetProblemStatementQuery = {
  __typename?: 'query_root';
  problem_statement_by_pk?: ProblemStatement & { tasks: (Task & { threads: Thread[] })[] } | null;
  problem_statement_provenance: ProblemStatementProvenance[];
};

export const GetProblemStatementDocument = gql`
  ${PROBLEM_STATEMENT_INFO}
  ${TASK_INFO}
  ${THREAD_INFO}
  query GetProblemStatement($id: String!) {
    problem_statement_by_pk(id: $id) {
      ...problem_statement_info
      tasks {
        ...task_info
        threads {
          ...thread_info
        }
      }
    }
    problem_statement_provenance(where: { problem_statement_id: { _eq: $id } }) {
      problem_statement_id
      event
      timestamp
      userid
      notes
    }
  }
`;

export function useGetProblemStatementQuery(
  baseOptions: Apollo.QueryHookOptions<
    GetProblemStatementQuery,
    GetProblemStatementQueryVariables
  > & { variables: GetProblemStatementQueryVariables },
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<GetProblemStatementQuery, GetProblemStatementQueryVariables>(
    GetProblemStatementDocument,
    options,
  );
}

// ─── Mutation: InsertProblemStatement ────────────────────────────────────────

export type InsertProblemStatementMutationVariables = {
  id: string;
  name: string;
  regionId: string;
  startDate: string;
  endDate: string;
};

export type InsertProblemStatementMutation = {
  __typename?: 'mutation_root';
  insert_problem_statement?: {
    returning: { id: string }[];
  } | null;
};

export const InsertProblemStatementDocument = gql`
  mutation InsertProblemStatement(
    $id: String!
    $name: String!
    $regionId: String!
    $startDate: date!
    $endDate: date!
  ) {
    insert_problem_statement(
      objects: [
        {
          id: $id
          name: $name
          region_id: $regionId
          start_date: $startDate
          end_date: $endDate
        }
      ]
    ) {
      returning {
        id
      }
    }
  }
`;

export function useInsertProblemStatementMutation(
  baseOptions?: Apollo.MutationHookOptions<
    InsertProblemStatementMutation,
    InsertProblemStatementMutationVariables
  >,
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<
    InsertProblemStatementMutation,
    InsertProblemStatementMutationVariables
  >(InsertProblemStatementDocument, options);
}

// ─── Mutation: UpdateProblemStatement ────────────────────────────────────────

export type UpdateProblemStatementMutationVariables = {
  id: string;
  name: string;
  regionId: string;
  startDate: string;
  endDate: string;
};

export type UpdateProblemStatementMutation = {
  __typename?: 'mutation_root';
  update_problem_statement_by_pk?: { id: string } | null;
};

export const UpdateProblemStatementDocument = gql`
  mutation UpdateProblemStatement(
    $id: String!
    $name: String!
    $regionId: String!
    $startDate: date!
    $endDate: date!
  ) {
    update_problem_statement_by_pk(
      pk_columns: { id: $id }
      _set: {
        name: $name
        region_id: $regionId
        start_date: $startDate
        end_date: $endDate
      }
    ) {
      id
    }
  }
`;

export function useUpdateProblemStatementMutation(
  baseOptions?: Apollo.MutationHookOptions<
    UpdateProblemStatementMutation,
    UpdateProblemStatementMutationVariables
  >,
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<
    UpdateProblemStatementMutation,
    UpdateProblemStatementMutationVariables
  >(UpdateProblemStatementDocument, options);
}

// ─── Mutation: InsertProblemStatementProvenance ───────────────────────────────

export type InsertProblemStatementProvenanceMutationVariables = {
  problemStatementId: string;
  event: ProblemStatementEvents;
  userid: string;
  notes?: Maybe<string>;
};

export const InsertProblemStatementProvenanceDocument = gql`
  mutation InsertProblemStatementProvenance(
    $problemStatementId: String!
    $event: problem_statement_events!
    $userid: String!
    $notes: String
  ) {
    insert_problem_statement_provenance_one(
      object: {
        problem_statement_id: $problemStatementId
        event: $event
        userid: $userid
        notes: $notes
      }
    ) {
      problem_statement_id
    }
  }
`;

export function useInsertProblemStatementProvenanceMutation(
  baseOptions?: Apollo.MutationHookOptions<unknown, InsertProblemStatementProvenanceMutationVariables>,
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<unknown, InsertProblemStatementProvenanceMutationVariables>(
    InsertProblemStatementProvenanceDocument,
    options,
  );
}

// ─── Mutation: DeleteProblemStatement ────────────────────────────────────────

export type DeleteProblemStatementMutationVariables = {
  id: string;
};

export type DeleteProblemStatementMutation = {
  __typename?: 'mutation_root';
  delete_problem_statement_by_pk?: { id: string } | null;
};

/**
 * Deletes bottom-up, and never deletes a provenance or permission row.
 *
 * Every `user`-role delete on this tree is authorised by the subject's own
 * CREATE provenance event (or a permission row). Removing those first — which
 * this document used to do, copied from the Lit app — revoked the permission
 * for everything that came after, so the whole cascade silently matched 0 rows
 * (#99). Provenance and permission rows now go by ON DELETE CASCADE, once the
 * row they authorise is gone.
 *
 * Order is load-bearing: `dataslice` is filtered through `thread_data`, so it
 * must go before `thread_data` does. `thread_data.dataslice_id` is DEFERRABLE
 * INITIALLY DEFERRED, so that order is legal inside the one transaction Hasura
 * runs these root fields in.
 */
export const DeleteProblemStatementDocument = gql`
  mutation DeleteProblemStatement($id: String!) {
    delete_thread_model_execution_summary(
      where: { thread_model: { thread: { task: { problem_statement_id: { _eq: $id } } } } }
    ) { affected_rows }
    delete_thread_model_execution(
      where: { thread_model: { thread: { task: { problem_statement_id: { _eq: $id } } } } }
    ) { affected_rows }
    delete_thread_model_io(
      where: { thread_model: { thread: { task: { problem_statement_id: { _eq: $id } } } } }
    ) { affected_rows }
    delete_thread_model_parameter(
      where: { thread_model: { thread: { task: { problem_statement_id: { _eq: $id } } } } }
    ) { affected_rows }
    delete_dataslice_resource(
      where: { dataslice: { thread_data: { thread: { task: { problem_statement_id: { _eq: $id } } } } } }
    ) { affected_rows }
    delete_dataslice(
      where: { thread_data: { thread: { task: { problem_statement_id: { _eq: $id } } } } }
    ) { affected_rows }
    delete_thread_data(
      where: { thread: { task: { problem_statement_id: { _eq: $id } } } }
    ) { affected_rows }
    delete_thread_model(
      where: { thread: { task: { problem_statement_id: { _eq: $id } } } }
    ) { affected_rows }
    delete_thread(where: { task: { problem_statement_id: { _eq: $id } } }) {
      affected_rows
    }
    delete_task(where: { problem_statement_id: { _eq: $id } }) {
      affected_rows
    }
    delete_problem_statement_by_pk(id: $id) {
      id
    }
  }
`;

export function useDeleteProblemStatementMutation(
  baseOptions?: Apollo.MutationHookOptions<
    DeleteProblemStatementMutation,
    DeleteProblemStatementMutationVariables
  >,
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<
    DeleteProblemStatementMutation,
    DeleteProblemStatementMutationVariables
  >(DeleteProblemStatementDocument, options);
}

// ─── Mutation: InsertTask ─────────────────────────────────────────────────────

export type InsertTaskMutationVariables = {
  id: string;
  name: string;
  problemStatementId: string;
  startDate: string;
  endDate: string;
  regionId?: Maybe<string>;
};

export type InsertTaskMutation = {
  __typename?: 'mutation_root';
  insert_task?: {
    returning: { id: string; threads: { id: string }[] }[];
  } | null;
};

export const InsertTaskDocument = gql`
  mutation InsertTask(
    $id: String!
    $name: String!
    $problemStatementId: String!
    $startDate: date!
    $endDate: date!
    $regionId: String
  ) {
    insert_task(
      objects: [
        {
          id: $id
          name: $name
          problem_statement_id: $problemStatementId
          start_date: $startDate
          end_date: $endDate
          region_id: $regionId
        }
      ]
    ) {
      returning {
        id
        threads {
          id
        }
      }
    }
  }
`;

export function useInsertTaskMutation(
  baseOptions?: Apollo.MutationHookOptions<
    InsertTaskMutation,
    InsertTaskMutationVariables
  >,
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<InsertTaskMutation, InsertTaskMutationVariables>(
    InsertTaskDocument,
    options,
  );
}

// ─── Mutation: UpdateTask ─────────────────────────────────────────────────────

export type UpdateTaskMutationVariables = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  regionId?: Maybe<string>;
};

export type UpdateTaskMutation = {
  __typename?: 'mutation_root';
  update_task_by_pk?: { id: string } | null;
};

export const UpdateTaskDocument = gql`
  mutation UpdateTask(
    $id: String!
    $name: String!
    $startDate: date!
    $endDate: date!
    $regionId: String
  ) {
    update_task_by_pk(
      pk_columns: { id: $id }
      _set: {
        name: $name
        start_date: $startDate
        end_date: $endDate
        region_id: $regionId
      }
    ) {
      id
    }
  }
`;

export function useUpdateTaskMutation(
  baseOptions?: Apollo.MutationHookOptions<
    UpdateTaskMutation,
    UpdateTaskMutationVariables
  >,
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<UpdateTaskMutation, UpdateTaskMutationVariables>(
    UpdateTaskDocument,
    options,
  );
}

// ─── Mutation: DeleteTask ─────────────────────────────────────────────────────

export type DeleteTaskMutationVariables = {
  id: string;
};

export type DeleteTaskMutation = {
  __typename?: 'mutation_root';
  delete_task_by_pk?: { id: string } | null;
};

/** Bottom-up, provenance and permission left to cascade. See DeleteProblemStatementDocument. */
export const DeleteTaskDocument = gql`
  mutation DeleteTask($id: String!) {
    delete_thread_model_execution_summary(
      where: { thread_model: { thread: { task_id: { _eq: $id } } } }
    ) { affected_rows }
    delete_thread_model_execution(
      where: { thread_model: { thread: { task_id: { _eq: $id } } } }
    ) { affected_rows }
    delete_thread_model_io(
      where: { thread_model: { thread: { task_id: { _eq: $id } } } }
    ) { affected_rows }
    delete_thread_model_parameter(
      where: { thread_model: { thread: { task_id: { _eq: $id } } } }
    ) { affected_rows }
    delete_dataslice_resource(
      where: { dataslice: { thread_data: { thread: { task_id: { _eq: $id } } } } }
    ) { affected_rows }
    delete_dataslice(
      where: { thread_data: { thread: { task_id: { _eq: $id } } } }
    ) { affected_rows }
    delete_thread_data(
      where: { thread: { task_id: { _eq: $id } } }
    ) { affected_rows }
    delete_thread_model(
      where: { thread: { task_id: { _eq: $id } } }
    ) { affected_rows }
    delete_thread(where: { task_id: { _eq: $id } }) { affected_rows }
    delete_task_by_pk(id: $id) {
      id
    }
  }
`;

export function useDeleteTaskMutation(
  baseOptions?: Apollo.MutationHookOptions<
    DeleteTaskMutation,
    DeleteTaskMutationVariables
  >,
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<DeleteTaskMutation, DeleteTaskMutationVariables>(
    DeleteTaskDocument,
    options,
  );
}

// ─── Mutation: InsertTaskProvenance ──────────────────────────────────────────

export type InsertTaskProvenanceMutationVariables = {
  taskId: string;
  event: TaskEvents;
  userid: string;
  notes?: Maybe<string>;
};

export const InsertTaskProvenanceDocument = gql`
  mutation InsertTaskProvenance(
    $taskId: String!
    $event: task_events!
    $userid: String!
    $notes: String
  ) {
    insert_task_provenance_one(
      object: {
        task_id: $taskId
        event: $event
        userid: $userid
        notes: $notes
      }
    ) {
      task_id
    }
  }
`;

export function useInsertTaskProvenanceMutation(
  baseOptions?: Apollo.MutationHookOptions<unknown, InsertTaskProvenanceMutationVariables>,
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<unknown, InsertTaskProvenanceMutationVariables>(
    InsertTaskProvenanceDocument,
    options,
  );
}

// ─── Mutation: InsertThread ───────────────────────────────────────────────────

export type InsertThreadMutationVariables = {
  id: string;
  name?: Maybe<string>;
  taskId: string;
  startDate: string;
  endDate: string;
  regionId?: Maybe<string>;
};

export type InsertThreadMutation = {
  __typename?: 'mutation_root';
  insert_thread?: {
    returning: { id: string }[];
  } | null;
};

export const InsertThreadDocument = gql`
  mutation InsertThread(
    $id: String!
    $name: String
    $taskId: String!
    $startDate: date!
    $endDate: date!
    $regionId: String
  ) {
    insert_thread(
      objects: [
        {
          id: $id
          name: $name
          task_id: $taskId
          start_date: $startDate
          end_date: $endDate
          region_id: $regionId
        }
      ]
    ) {
      returning {
        id
      }
    }
  }
`;

export function useInsertThreadMutation(
  baseOptions?: Apollo.MutationHookOptions<
    InsertThreadMutation,
    InsertThreadMutationVariables
  >,
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<InsertThreadMutation, InsertThreadMutationVariables>(
    InsertThreadDocument,
    options,
  );
}

// ─── Mutation: DeleteThread ───────────────────────────────────────────────────

export type DeleteThreadMutationVariables = {
  id: string;
};

export type DeleteThreadMutation = {
  __typename?: 'mutation_root';
  delete_thread_by_pk?: { id: string } | null;
};

/** Bottom-up, provenance and permission left to cascade. See DeleteProblemStatementDocument. */
export const DeleteThreadDocument = gql`
  mutation DeleteThread($id: String!) {
    delete_thread_model_execution_summary(
      where: { thread_model: { thread_id: { _eq: $id } } }
    ) { affected_rows }
    delete_thread_model_execution(
      where: { thread_model: { thread_id: { _eq: $id } } }
    ) { affected_rows }
    delete_thread_model_io(
      where: { thread_model: { thread_id: { _eq: $id } } }
    ) { affected_rows }
    delete_thread_model_parameter(
      where: { thread_model: { thread_id: { _eq: $id } } }
    ) { affected_rows }
    delete_dataslice_resource(
      where: { dataslice: { thread_data: { thread_id: { _eq: $id } } } }
    ) { affected_rows }
    delete_dataslice(where: { thread_data: { thread_id: { _eq: $id } } }) {
      affected_rows
    }
    delete_thread_data(where: { thread_id: { _eq: $id } }) {
      affected_rows
    }
    delete_thread_model(where: { thread_id: { _eq: $id } }) {
      affected_rows
    }
    delete_thread_by_pk(id: $id) {
      id
    }
  }
`;

export function useDeleteThreadMutation(
  baseOptions?: Apollo.MutationHookOptions<
    DeleteThreadMutation,
    DeleteThreadMutationVariables
  >,
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<DeleteThreadMutation, DeleteThreadMutationVariables>(
    DeleteThreadDocument,
    options,
  );
}

// ─── Query: GetThread ─────────────────────────────────────────────────────────

export type GetThreadQueryVariables = {
  id: string;
};

export type GetThreadQuery = {
  __typename?: 'query_root';
  thread_by_pk?: Thread | null;
};

export const GetThreadDocument = gql`
  ${THREAD_INFO}
  query GetThread($id: String!) {
    thread_by_pk(id: $id) {
      ...thread_info
    }
  }
`;

export function useGetThreadQuery(
  baseOptions: Apollo.QueryHookOptions<GetThreadQuery, GetThreadQueryVariables> & {
    variables: GetThreadQueryVariables;
  },
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<GetThreadQuery, GetThreadQueryVariables>(
    GetThreadDocument,
    options,
  );
}

// ─── Mutation: UpdateThread ───────────────────────────────────────────────────

export type UpdateThreadMutationVariables = {
  id: string;
  name?: string | null;
  startDate: string;
  endDate: string;
  regionId?: string | null;
  drivingVariableId?: string | null;
  responseVariableId?: string | null;
};

export type UpdateThreadMutation = {
  update_thread_by_pk?: Pick<Thread, 'id'> | null;
};

export const UpdateThreadDocument = gql`
  mutation UpdateThread(
    $id: String!
    $name: String
    $startDate: date!
    $endDate: date!
    $regionId: String
    $drivingVariableId: String
    $responseVariableId: String
  ) {
    update_thread_by_pk(
      pk_columns: { id: $id }
      _set: {
        name: $name
        start_date: $startDate
        end_date: $endDate
        region_id: $regionId
        driving_variable_id: $drivingVariableId
        response_variable_id: $responseVariableId
      }
    ) {
      id
    }
  }
`;

export function useUpdateThreadMutation(
  baseOptions?: Apollo.MutationHookOptions<UpdateThreadMutation, UpdateThreadMutationVariables>,
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<UpdateThreadMutation, UpdateThreadMutationVariables>(
    UpdateThreadDocument,
    options,
  );
}

// ─── Mutation: InsertThreadProvenance ─────────────────────────────────────────

export type InsertThreadProvenanceMutationVariables = {
  threadId: string;
  event: ThreadEvents;
  userid: string;
  notes?: string | null;
};

export type InsertThreadProvenanceMutation = {
  insert_thread_provenance_one?: { thread_id: string } | null;
};

export const InsertThreadProvenanceDocument = gql`
  mutation InsertThreadProvenance(
    $threadId: String!
    $event: thread_events!
    $userid: String!
    $notes: String
  ) {
    insert_thread_provenance_one(
      object: {
        thread_id: $threadId
        event: $event
        userid: $userid
        notes: $notes
      }
    ) {
      thread_id
    }
  }
`;

export function useInsertThreadProvenanceMutation(
  baseOptions?: Apollo.MutationHookOptions<
    InsertThreadProvenanceMutation,
    InsertThreadProvenanceMutationVariables
  >,
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<InsertThreadProvenanceMutation, InsertThreadProvenanceMutationVariables>(
    InsertThreadProvenanceDocument,
    options,
  );
}

// ─── Thread data binding mutations ───────────────────────────────────────────
//
// Used by the MintDatasets step to write dataset selections into the database.
// Mirrors: ui/src/queries/thread/update-datasets.graphql

export type UpdateThreadDataMutationVariables = {
  threadId: string;
  event: {
    thread_id: string;
    event: string;
    userid: string;
    notes?: string | null;
  };
  data: Array<{
    thread_id: string;
    dataslice: {
      data: {
        id: string;
        name: string;
        region_id: string;
        start_date: string | null;
        end_date: string | null;
        resource_count: number;
        dataset: {
          data: { id: string; name: string };
          on_conflict: { constraint: string; update_columns: string[] };
        };
        resources: {
          data: Array<{
            resource: {
              data: {
                id: string;
                dcid?: string | null;
                name: string;
                url: string;
                start_date?: string | null;
                end_date?: string | null;
              };
              on_conflict: { constraint: string; update_columns: string[] };
            };
            selected: boolean;
          }>;
          on_conflict: { constraint: string; update_columns: string[] };
        };
      };
      on_conflict: { constraint: string; update_columns: string[] };
    };
  }>;
  modelIO: Array<{
    thread_model_id: string;
    model_io_id: string;
    dataslice_id: string;
  }>;
};

export type UpdateThreadDataMutation = {
  insert_thread_data?: { returning: Array<{ thread_id: string }> } | null;
  insert_thread_model_io?: { returning: Array<{ model_io_id: string }> } | null;
  insert_thread_provenance_one?: { thread_id: string } | null;
};

export const UpdateThreadDataDocument = gql`
  mutation UpdateThreadData(
    $threadId: String!
    $event: thread_provenance_insert_input!
    $data: [thread_data_insert_input!]!
    $modelIO: [thread_model_io_insert_input!]!
  ) {
    delete_thread_model_execution_summary(
      where: { thread_model: { thread_id: { _eq: $threadId } } }
    ) {
      affected_rows
    }
    delete_thread_model_execution(
      where: { thread_model: { thread_id: { _eq: $threadId } } }
    ) {
      affected_rows
    }
    delete_thread_model_io(
      where: { thread_model: { thread_id: { _eq: $threadId } } }
    ) {
      affected_rows
    }
    delete_thread_model_parameter(
      where: { thread_model: { thread_id: { _eq: $threadId } } }
    ) {
      affected_rows
    }
    delete_dataslice_resource(
      where: { dataslice: { thread_data: { thread_id: { _eq: $threadId } } } }
    ) {
      affected_rows
    }
    delete_dataslice(
      where: { thread_data: { thread_id: { _eq: $threadId } } }
    ) {
      affected_rows
    }
    delete_thread_data(where: { thread_id: { _eq: $threadId } }) {
      affected_rows
    }
    insert_thread_data(objects: $data) {
      returning {
        thread_id
      }
    }
    insert_thread_model_io(objects: $modelIO) {
      returning {
        model_io_id
      }
    }
    insert_thread_provenance_one(object: $event) {
      thread_id
    }
  }
`;

export function useUpdateThreadDataMutation(
  baseOptions?: Apollo.MutationHookOptions<
    UpdateThreadDataMutation,
    UpdateThreadDataMutationVariables
  >,
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<UpdateThreadDataMutation, UpdateThreadDataMutationVariables>(
    UpdateThreadDataDocument,
    options,
  );
}

// ─── ID generator (mirrors legacy GraphQL adapter) ────────────────────────────

/**
 * Generate a unique ID for new problem statements / tasks / threads.
 *
 * The value is stored verbatim as the table primary key (and FK target) and is
 * embedded directly in route URLs, so it must be a bare short token like the
 * existing DB rows (e.g. `uPOdCNpNNscghQbJda73`). It must NOT be a
 * `mint://<type>/...` URI: that prefix is not what the DB stores (so by_pk
 * lookups miss) and its `//` collapses to `/` in the browser URL. The `_type`
 * argument is retained only for call-site readability.
 */
export function generateModelingId(_type: 'problem_statement' | 'task' | 'thread'): string {
  const rand = Math.random().toString(36).substring(2, 10);
  const ts = Date.now().toString(36);
  return `${rand}${ts}`;
}

// ─── Mutation: SetThreadModels ────────────────────────────────────────────────

/**
 * Apply a change of model selection for a thread in a single transaction.
 *
 * `$removedIds` are the `thread_model.id` values that are no longer selected.
 * Rows that stay selected are not named here, so they keep their id and the
 * dataset and parameter bindings that hang off it.
 *
 * The four child tables are deleted first, scoped to the removed rows only:
 * every one of them references `thread_model.id` with `ON DELETE RESTRICT`, so
 * without this the delete is refused for any thread that has been through the
 * Datasets or Parameters step (monorepo#107). Hasura runs a mutation's root
 * fields in order inside one transaction, so the ordering here is the ordering
 * Postgres sees.
 */
export type SetThreadModelsMutationVariables = {
  threadId: string;
  removedIds: string[];
  models: Array<{ thread_id: string; modelcatalog_configuration_id: string }>;
  userid: string;
  notes?: string | null;
};

export type SetThreadModelsMutation = {
  delete_thread_model_execution_summary?: { affected_rows: number } | null;
  delete_thread_model_execution?: { affected_rows: number } | null;
  delete_thread_model_io?: { affected_rows: number } | null;
  delete_thread_model_parameter?: { affected_rows: number } | null;
  delete_thread_model?: { affected_rows: number } | null;
  insert_thread_model?: {
    returning: Array<{ id: string; thread_id: string; modelcatalog_configuration_id?: string | null }>;
  } | null;
  insert_thread_provenance_one?: { thread_id: string } | null;
};

export const SetThreadModelsDocument = gql`
  mutation SetThreadModels(
    $threadId: String!
    $removedIds: [uuid!]!
    $models: [thread_model_insert_input!]!
    $userid: String!
    $notes: String
  ) {
    delete_thread_model_execution_summary(
      where: { thread_model_id: { _in: $removedIds } }
    ) {
      affected_rows
    }
    delete_thread_model_execution(where: { thread_model_id: { _in: $removedIds } }) {
      affected_rows
    }
    delete_thread_model_io(where: { thread_model_id: { _in: $removedIds } }) {
      affected_rows
    }
    delete_thread_model_parameter(where: { thread_model_id: { _in: $removedIds } }) {
      affected_rows
    }
    delete_thread_model(where: { id: { _in: $removedIds } }) {
      affected_rows
    }
    insert_thread_model(objects: $models) {
      returning {
        id
        thread_id
        modelcatalog_configuration_id
      }
    }
    insert_thread_provenance_one(
      object: {
        thread_id: $threadId
        event: SELECT_MODELS
        userid: $userid
        notes: $notes
      }
    ) {
      thread_id
    }
  }
`;

export function useSetThreadModelsMutation(
  baseOptions?: Apollo.MutationHookOptions<SetThreadModelsMutation, SetThreadModelsMutationVariables>,
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<SetThreadModelsMutation, SetThreadModelsMutationVariables>(
    SetThreadModelsDocument,
    options,
  );
}

// ─── Query: GetModelTreeWithRegions ──────────────────────────────────────────

/**
 * Extended model tree query that includes region data for filtering.
 */

// ─── Model I/O sub-types (Task 1) ────────────────────────────────────────────

export type StandardVariableRef = { id: string; label?: string | null };

export type VariablePresentationRef = {
  // Composite keyFields for the modelcatalog_dataset_specification_presentation
  // junction (see apollo-client.ts) — required so InMemoryCache can normalize.
  dataset_specification_id?: string;
  presentation_id?: string;
  presentation: {
    id: string;
    standard_variable?: StandardVariableRef | null;
  };
};

export type DatasetSpecRef = {
  id: string;
  label?: string | null;
  has_format?: string | null;
  presentations: VariablePresentationRef[];
};

export type ConfigInputRef = {
  // Composite keyFields for modelcatalog_configuration_input.
  configuration_id?: string;
  input_id?: string;
  is_optional?: boolean | null;
  input: DatasetSpecRef;
};

export type ConfigOutputRef = {
  // Composite keyFields for modelcatalog_configuration_output.
  configuration_id?: string;
  output_id?: string;
  output: DatasetSpecRef;
};

/** A configuration_region junction row — composite keyFields configuration_id + region_id. */
export type ConfigRegionRef = {
  configuration_id?: string;
  region_id?: string;
  region: { id: string; label?: string | null };
};

export type ModelSetupInfo = {
  id: string;
  label?: string | null;
  description?: string | null;
  regions: ConfigRegionRef[];
  inputs: ConfigInputRef[];
  outputs: ConfigOutputRef[];
};

export type ModelConfigInfo = {
  id: string;
  label?: string | null;
  /** Non-null only when the configuration is a flow. */
  flow?: { configuration_id: string } | null;
  regions: ConfigRegionRef[];
  inputs: ConfigInputRef[];
  outputs: ConfigOutputRef[];
  child_configurations: ModelSetupInfo[];
};

/** A configuration or setup that carries inputs/outputs — the unit extractModelIO consumes. */
// `regions` is optional: the thread execution query reads a configuration's I/O
// without its regions, and extractModelIO never looks at them.
export type ModelIOConfig = Pick<ModelConfigInfo, 'id' | 'label' | 'inputs' | 'outputs'> & {
  regions?: ConfigRegionRef[];
  child_configurations?: ModelSetupInfo[];
};

export type GetModelTreeWithRegionsQuery = {
  __typename?: 'query_root';
  modelcatalog_software: Array<{
    id: string;
    label?: string | null;
    versions: Array<{
      id: string;
      label?: string | null;
      configurations: ModelConfigInfo[];
    }>;
  }>;
};

// ─── I/O extractor (Task 1) ──────────────────────────────────────────────────

export type ModelInputVar = {
  id: string;
  name: string;
  variableIds: string[];
  variableLabels: string[];
  format?: string | null;
  optional: boolean;
};

export type ModelIO = {
  inputs: ModelInputVar[];
  outputs: ModelInputVar[];
  /** Flat list of all standard-variable ids this config produces (for the indicator filter). */
  producesVariableIds: string[];
};

function specToVar(spec: DatasetSpecRef, optional: boolean): ModelInputVar {
  // An input with no variable presentation is a real state in the catalog, and
  // it must not take the whole step down with it.
  const svs = (spec.presentations ?? [])
    .map((p) => p.presentation?.standard_variable)
    .filter((sv): sv is StandardVariableRef => !!sv);
  return {
    id: spec.id,
    name: spec.label ?? spec.id,
    variableIds: svs.map((sv) => sv.id),
    variableLabels: svs.map((sv) => sv.label ?? sv.id),
    format: spec.has_format ?? null,
    optional,
  };
}

export function extractModelIO(config: ModelIOConfig): ModelIO {
  const inputs = (config.inputs ?? []).map((i) => specToVar(i.input, !!i.is_optional));
  const outputs = (config.outputs ?? []).map((o) => specToVar(o.output, false));
  const producesVariableIds = outputs.flatMap((o) => o.variableIds);
  return { inputs, outputs, producesVariableIds };
}

// No type predicate — deliberate. `modelcatalog_software.type` classifies a model
// (Empirical, Coupled, Theory-Guided, ...); it does not say whether a row is a model.
// Filtering on `sdm#Model` showed the thread wizard 18 of TACC's 175 runnable leaf
// configurations, and none of the 61 that have data annotated. See #98.
export const GetModelTreeWithRegionsDocument = gql`
  query GetModelTreeWithRegions {
    modelcatalog_software(order_by: { label: asc }) {
      id
      label
      versions(order_by: { label: asc }) {
        id
        label
        configurations(
          order_by: { label: asc }
          where: { model_configuration_id: { _is_null: true } }
        ) {
          id
          label
          flow { configuration_id }
          regions { configuration_id region_id region { id label } }
          inputs {
            configuration_id
            input_id
            is_optional
            input {
              id
              label
              has_format
              presentations {
                dataset_specification_id
                presentation_id
                presentation { id standard_variable { id label } }
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
              presentations {
                dataset_specification_id
                presentation_id
                presentation { id standard_variable { id label } }
              }
            }
          }
          child_configurations(order_by: { label: asc }) {
            id
            label
            description
            regions { configuration_id region_id region { id label } }
            inputs {
              configuration_id
              input_id
              is_optional
              input {
                id
                label
                has_format
                presentations {
                  dataset_specification_id
                  presentation_id
                  presentation { id standard_variable { id label } }
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
                presentations {
                  dataset_specification_id
                  presentation_id
                  presentation { id standard_variable { id label } }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export function useGetModelTreeWithRegionsQuery(
  baseOptions?: Apollo.QueryHookOptions<GetModelTreeWithRegionsQuery, Record<string, never>>,
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<GetModelTreeWithRegionsQuery, Record<string, never>>(
    GetModelTreeWithRegionsDocument,
    options,
  );
}

// ─── Query: ListRecentProblemStatementActivity ───────────────────────────────

/**
 * The signed-in user's own provenance feed, newest first.
 *
 * There is no "last touched" column on `problem_statement`, so recency comes
 * from the provenance table instead. Hasura's row-level filter on
 * `problem_statement_provenance` nulls the relationship out for any event whose
 * statement the user may no longer read, so a row can come back without one.
 * `pickRecentProblemStatements` in `lib/modeling/recent-problem-statements.ts`
 * drops those and deduplicates the rest.
 *
 * Only the `user` role may select this table; the query is skipped when signed
 * out.
 */
export type ListRecentProblemStatementActivityQueryVariables = {
  userid: string;
  limit: number;
};

export type ListRecentProblemStatementActivityQuery = {
  __typename?: 'query_root';
  problem_statement_provenance: {
    __typename?: 'problem_statement_provenance';
    timestamp: string;
    problem_statement?: {
      __typename?: 'problem_statement';
      id: string;
      name?: Maybe<string>;
      region_id: string;
    } | null;
  }[];
};

export const ListRecentProblemStatementActivityDocument = gql`
  query ListRecentProblemStatementActivity($userid: String!, $limit: Int!) {
    problem_statement_provenance(
      where: { userid: { _eq: $userid } }
      order_by: { timestamp: desc }
      limit: $limit
    ) {
      timestamp
      problem_statement {
        id
        name
        region_id
      }
    }
  }
`;

export function useListRecentProblemStatementActivityQuery(
  baseOptions: Apollo.QueryHookOptions<
    ListRecentProblemStatementActivityQuery,
    ListRecentProblemStatementActivityQueryVariables
  > & { variables: ListRecentProblemStatementActivityQueryVariables },
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<
    ListRecentProblemStatementActivityQuery,
    ListRecentProblemStatementActivityQueryVariables
  >(ListRecentProblemStatementActivityDocument, options);
}
