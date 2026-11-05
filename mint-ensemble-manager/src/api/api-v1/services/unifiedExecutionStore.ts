import { getConfiguration } from "@/classes/mint/mint-functions";

export interface UnifiedExecutionRecord {
    id: string;
    plan_id: string;
    thread_id: string;
    model_id: string;
    execution_engine: string;
    status: string;
    idempotency_key: string;
    plan_hash: string;
    adapter_steps: unknown[];
    adapter_run_ids: unknown[];
    parameter_values: Record<string, unknown>;
    parameter_values_hash?: string;
    schema_version?: number;
    state_revision?: number;
    model_child_id?: string | null;
    model_output_id?: string | null;
    output_handoff?: unknown;
    failure_code?: string | null;
    model_result?: unknown;
    error_message?: string | null;
    created_at?: string;
    updated_at?: string;
}

export interface UnifiedExecutionStep {
    id: string;
    execution_id: string;
    step_key: string;
    stage: string;
    external_id?: string | null;
    idempotency_key: string;
    plan_hash: string;
    parameter_values_hash?: string | null;
    status: string;
    attempt: number;
    output_reference?: unknown;
    error_message?: string | null;
    created_at?: string;
    updated_at?: string;
}

export interface UnifiedExecutionStore {
    getByPlanId(planId: string): Promise<UnifiedExecutionRecord | null>;
    getById(id: string): Promise<UnifiedExecutionRecord | null>;
    getByModelChildId?(modelChildId: string): Promise<UnifiedExecutionRecord | null>;
    listByThread?(threadId: string, modelId?: string): Promise<UnifiedExecutionRecord[]>;
    /** At most `limit` runs of any of the threads, newest first. */
    listByThreads?(threadIds: string[], limit?: number): Promise<UnifiedExecutionRecord[]>;
    findByIdempotencyKey?(key: string): Promise<UnifiedExecutionRecord | null>;
    listSteps?(executionId: string): Promise<UnifiedExecutionStep[]>;
    upsertStep?(input: Omit<UnifiedExecutionStep, "id">): Promise<UnifiedExecutionStep>;
    insert(input: Omit<UnifiedExecutionRecord, "id">): Promise<UnifiedExecutionRecord>;
    update(id: string, set: Record<string, unknown>): Promise<UnifiedExecutionRecord | null>;
    compareAndSet(
        id: string,
        expectedRevision: number,
        set: Record<string, unknown>
    ): Promise<UnifiedExecutionRecord | null>;
}

const GET_BY_PLAN = `
query GetUnifiedExecutionByPlan($planId: String!) {
  unified_execution(where: {plan_id: {_eq: $planId}}, limit: 1) {
    id plan_id thread_id model_id execution_engine status idempotency_key plan_hash
    adapter_steps adapter_run_ids parameter_values parameter_values_hash
    schema_version state_revision model_child_id model_output_id output_handoff
    failure_code model_result error_message created_at updated_at
  }
}`;

const GET_BY_ID = `
query GetUnifiedExecutionById($id: uuid!) {
  unified_execution_by_pk(id: $id) {
    id plan_id thread_id model_id execution_engine status idempotency_key plan_hash
    adapter_steps adapter_run_ids parameter_values parameter_values_hash
    schema_version state_revision model_child_id model_output_id output_handoff
    failure_code model_result error_message created_at updated_at
  }
}`;

const GET_BY_MODEL_CHILD_ID = `
query GetUnifiedExecutionByModelChild($modelChildId: String!) {
  unified_execution(where: {model_child_id: {_eq: $modelChildId}}, limit: 1) {
    id plan_id thread_id model_id execution_engine status idempotency_key plan_hash
    adapter_steps adapter_run_ids parameter_values parameter_values_hash
    schema_version state_revision model_child_id model_output_id output_handoff
    failure_code model_result error_message created_at updated_at
  }
}`;

const LIST_BY_THREAD = `
query ListUnifiedExecutionsByThread($threadId: String!) {
  unified_execution(
    where: {thread_id: {_eq: $threadId}}
    order_by: [{created_at: desc}, {id: desc}]
  ) {
    id plan_id thread_id model_id execution_engine status idempotency_key plan_hash
    adapter_steps adapter_run_ids parameter_values parameter_values_hash
    schema_version state_revision model_child_id model_output_id output_handoff
    failure_code model_result error_message created_at updated_at
  }
}`;

const LIST_BY_THREADS = `
query ListUnifiedExecutionsByThreads($threadIds: [String!]!, $limit: Int!) {
  unified_execution(
    where: {thread_id: {_in: $threadIds}}
    limit: $limit
    order_by: [{created_at: desc}, {id: desc}]
  ) {
    id plan_id thread_id model_id execution_engine status idempotency_key plan_hash
    adapter_steps adapter_run_ids parameter_values parameter_values_hash
    schema_version state_revision model_child_id model_output_id output_handoff
    failure_code model_result error_message created_at updated_at
  }
}`;

const GET_BY_IDEMPOTENCY_KEY = `
query GetUnifiedExecutionByIdempotencyKey($key: String!) {
  unified_execution(where: {idempotency_key: {_eq: $key}}, limit: 1) {
    id plan_id thread_id model_id execution_engine status idempotency_key plan_hash
    adapter_steps adapter_run_ids parameter_values parameter_values_hash
    schema_version state_revision model_child_id model_output_id output_handoff
    failure_code model_result error_message created_at updated_at
  }
}`;

const LIST_BY_THREAD_MODEL = `
query ListUnifiedExecutionsByThreadModel($threadId: String!, $modelId: String!) {
  unified_execution(
    where: {thread_id: {_eq: $threadId}, model_id: {_eq: $modelId}}
    order_by: [{created_at: desc}, {id: desc}]
  ) {
    id plan_id thread_id model_id execution_engine status idempotency_key plan_hash
    adapter_steps adapter_run_ids parameter_values parameter_values_hash
    schema_version state_revision model_child_id model_output_id output_handoff
    failure_code model_result error_message created_at updated_at
  }
}`;

const INSERT = `
mutation InsertUnifiedExecution($object: unified_execution_insert_input!) {
  insert_unified_execution_one(
    object: $object
    on_conflict: {constraint: unified_execution_plan_id_key, update_columns: []}
  ) {
    id plan_id thread_id model_id execution_engine status idempotency_key plan_hash
    adapter_steps adapter_run_ids parameter_values parameter_values_hash
    schema_version state_revision model_child_id model_output_id output_handoff
    failure_code model_result error_message created_at updated_at
  }
}`;

const UPDATE = `
mutation UpdateUnifiedExecution($id: uuid!, $set: unified_execution_set_input!) {
  update_unified_execution_by_pk(pk_columns: {id: $id}, _set: $set) {
    id plan_id thread_id model_id execution_engine status idempotency_key plan_hash
    adapter_steps adapter_run_ids parameter_values parameter_values_hash
    schema_version state_revision model_child_id model_output_id output_handoff
    failure_code model_result error_message created_at updated_at
  }
}`;

const COMPARE_AND_SET = `
mutation CompareAndSetUnifiedExecution(
  $id: uuid!
  $expectedRevision: Int!
  $set: unified_execution_set_input!
) {
  update_unified_execution(
    where: {id: {_eq: $id}, state_revision: {_eq: $expectedRevision}}
    _set: $set
    _inc: {state_revision: 1}
  ) {
    returning {
      id plan_id thread_id model_id execution_engine status idempotency_key plan_hash
      adapter_steps adapter_run_ids parameter_values parameter_values_hash
      schema_version state_revision model_child_id model_output_id output_handoff
      failure_code model_result error_message created_at updated_at
    }
  }
}`;

const LIST_STEPS = `
query ListUnifiedExecutionSteps($executionId: uuid!) {
  unified_execution_step(
    where: {execution_id: {_eq: $executionId}}
    order_by: [{created_at: asc}, {step_key: asc}]
  ) {
    id execution_id step_key stage external_id idempotency_key plan_hash
    parameter_values_hash status attempt output_reference error_message
    created_at updated_at
  }
}`;

const UPSERT_STEP = `
mutation UpsertUnifiedExecutionStep($object: unified_execution_step_insert_input!) {
  insert_unified_execution_step_one(
    object: $object
    on_conflict: {
      constraint: unified_execution_step_key
      update_columns: [stage, external_id, parameter_values_hash, status, attempt, output_reference, error_message, updated_at]
    }
  ) {
    id execution_id step_key stage external_id idempotency_key plan_hash
    parameter_values_hash status attempt output_reference error_message
    created_at updated_at
  }
}`;

function graphqlEndpoint(): string {
    const prefs = getConfiguration();
    const endpoint = prefs.graphql?.endpoint?.trim() || "";
    if (/^https?:\/\//i.test(endpoint)) return endpoint;
    return `${prefs.graphql?.enable_ssl ? "https" : "http"}://${endpoint}`;
}

async function hasuraRequest<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const prefs = getConfiguration();
    if (!prefs.graphql?.secret || !prefs.graphql.endpoint) {
        throw new Error("Hasura admin configuration is required for unified execution state");
    }
    const response = await fetch(graphqlEndpoint(), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Hasura-Admin-Secret": prefs.graphql.secret
        },
        body: JSON.stringify({ query, variables })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.errors?.length) {
        throw new Error(body.errors?.[0]?.message || `Hasura returned ${response.status}`);
    }
    return body.data as T;
}

export function createHasuraUnifiedExecutionStore(): UnifiedExecutionStore {
    return {
        async getByPlanId(planId) {
            const data = await hasuraRequest<{ unified_execution: UnifiedExecutionRecord[] }>(
                GET_BY_PLAN,
                { planId }
            );
            return data.unified_execution[0] || null;
        },
        async getById(id) {
            const data = await hasuraRequest<{
                unified_execution_by_pk: UnifiedExecutionRecord | null;
            }>(GET_BY_ID, { id });
            return data.unified_execution_by_pk;
        },
        async getByModelChildId(modelChildId) {
            const data = await hasuraRequest<{ unified_execution: UnifiedExecutionRecord[] }>(
                GET_BY_MODEL_CHILD_ID,
                { modelChildId }
            );
            return data.unified_execution[0] || null;
        },
        async listByThread(threadId, modelId) {
            const data = await hasuraRequest<{ unified_execution: UnifiedExecutionRecord[] }>(
                modelId ? LIST_BY_THREAD_MODEL : LIST_BY_THREAD,
                modelId ? { threadId, modelId } : { threadId }
            );
            return data.unified_execution || [];
        },
        async listByThreads(threadIds, limit = 200) {
            if (threadIds.length === 0) return [];
            const data = await hasuraRequest<{ unified_execution: UnifiedExecutionRecord[] }>(
                LIST_BY_THREADS,
                { threadIds, limit }
            );
            return data.unified_execution || [];
        },
        async findByIdempotencyKey(key) {
            const data = await hasuraRequest<{ unified_execution: UnifiedExecutionRecord[] }>(
                GET_BY_IDEMPOTENCY_KEY,
                { key }
            );
            return data.unified_execution[0] || null;
        },
        async listSteps(executionId) {
            const data = await hasuraRequest<{ unified_execution_step: UnifiedExecutionStep[] }>(
                LIST_STEPS,
                { executionId }
            );
            return data.unified_execution_step || [];
        },
        async upsertStep(input) {
            const data = await hasuraRequest<{
                insert_unified_execution_step_one: UnifiedExecutionStep;
            }>(UPSERT_STEP, { object: input });
            return data.insert_unified_execution_step_one;
        },
        async insert(input) {
            const data = await hasuraRequest<{
                insert_unified_execution_one: UnifiedExecutionRecord;
            }>(INSERT, { object: input });
            return data.insert_unified_execution_one;
        },
        async update(id, set) {
            const data = await hasuraRequest<{
                update_unified_execution_by_pk: UnifiedExecutionRecord | null;
            }>(UPDATE, { id, set });
            return data.update_unified_execution_by_pk;
        },
        async compareAndSet(id, expectedRevision, set) {
            const data = await hasuraRequest<{
                update_unified_execution: { returning: UnifiedExecutionRecord[] };
            }>(COMPARE_AND_SET, { id, expectedRevision, set });
            return data.update_unified_execution.returning[0] || null;
        }
    };
}
