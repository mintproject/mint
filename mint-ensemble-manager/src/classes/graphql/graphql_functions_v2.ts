import { GraphQL } from "@/config/graphql";
import listProblemStatementsGQL from "./queries/problem-statement/list.graphql";
import getProblemStatementGQL from "./queries/problem-statement/get.graphql";
import { InternalServerError } from "@/classes/common/errors";
import { ApolloQueryResult } from "@apollo/client";
import { Problem_Statement, Task, Thread } from "./types";
import { KeycloakAdapter } from "@/config/keycloak-adapter";
import listTasksByProblemStatementGQL from "./queries/task/listTasksByProblemStatement.graphql";
import getThreadGQL from "./queries/thread/get.graphql";
import listExecutionHistoryGQL from "./queries/execution/list-history.graphql";
import checkVariableByIdGQL from "./queries/variable/check-by-id.graphql";
import getRegionGQL from "./queries/region/get.graphql";
import checkRegionByIdGQL from "./queries/region/check-by-id.graphql";

export const getProblemStatements = async (access_token: string): Promise<Problem_Statement[]> => {
    const APOLLO_CLIENT = GraphQL.instanceUsingAccessToken(access_token);
    const result: ApolloQueryResult<{ problem_statement: Problem_Statement[] }> =
        await APOLLO_CLIENT.query({
            query: listProblemStatementsGQL,
            fetchPolicy: "no-cache"
        });

    if (!result || (result.errors && result.errors.length > 0)) {
        throw new InternalServerError(
            "Error getting problem statements " + result.errors[0].message
        );
    }
    return result.data.problem_statement;
};

export const getProblemStatement = async (
    problem_statement_id: string,
    access_token?: string
): Promise<Problem_Statement> => {
    const APOLLO_CLIENT = access_token
        ? GraphQL.instanceUsingAccessToken(access_token)
        : GraphQL.instance(KeycloakAdapter.getUser());
    const result: ApolloQueryResult<{ problem_statement_by_pk: Problem_Statement }> =
        await APOLLO_CLIENT.query({
            query: getProblemStatementGQL,
            variables: {
                id: problem_statement_id
            }
        });
    if (!result || (result.errors && result.errors.length > 0)) {
        throw new InternalServerError(
            "Error getting problem statement " + result.errors[0].message
        );
    }
    return result.data.problem_statement_by_pk;
};

export const getTasksByProblemStatementId = async (
    problem_statement_id: string,
    access_token?: string
): Promise<Task[]> => {
    const APOLLO_CLIENT = access_token
        ? GraphQL.instanceUsingAccessToken(access_token)
        : GraphQL.instance(KeycloakAdapter.getUser());
    const result: ApolloQueryResult<{ task: Task[] }> = await APOLLO_CLIENT.query({
        query: listTasksByProblemStatementGQL,
        variables: {
            problem_statement_id: problem_statement_id
        }
    });
    if (!result || (result.errors && result.errors.length > 0)) {
        throw new InternalServerError(
            "Error getting tasks by problem statement id " + result.errors[0].message
        );
    }
    return result.data.task;
};

export const getSubtask = async (subtask_id: string, access_token?: string): Promise<Thread> => {
    return await getThread(subtask_id, access_token);
};

export const getThread = async (thread_id: string, access_token?: string): Promise<Thread> => {
    const APOLLO_CLIENT = access_token
        ? GraphQL.instanceUsingAccessToken(access_token)
        : GraphQL.instance(KeycloakAdapter.getUser());

    const result: ApolloQueryResult<{ thread_by_pk: Thread }> = await APOLLO_CLIENT.query({
        query: getThreadGQL,
        variables: { id: thread_id }
    });
    if (!result || (result.errors && result.errors.length > 0)) {
        throw new InternalServerError("Error getting thread " + result.errors[0].message);
    }
    return result.data.thread_by_pk;
};

/**
 * Read the durable execution rows for one thread model through the caller's
 * Hasura token. The history API uses this instead of the admin client so the
 * thread's existing row-level authorization is applied before provenance is
 * assembled.
 */
export const getExecutionHistory = async (
    threadModelId: string,
    access_token: string,
    limit: number
): Promise<any> => {
    const APOLLO_CLIENT = GraphQL.instanceUsingAccessToken(access_token);
    const result: ApolloQueryResult<any> = await APOLLO_CLIENT.query({
        query: listExecutionHistoryGQL,
        variables: { threadModelId, limit },
        fetchPolicy: "no-cache"
    });
    if (!result || (result.errors && result.errors.length > 0)) {
        throw new InternalServerError(
            "Error getting execution history " + (result?.errors?.[0]?.message || "unknown error")
        );
    }
    return result.data?.thread_model_by_pk || null;
};

export const checkVariableExistsById = async (
    variableId: string,
    access_token: string
): Promise<boolean> => {
    const APOLLO_CLIENT = GraphQL.instanceUsingAccessToken(access_token);

    const result: ApolloQueryResult<{ variable: { id: string; name: string }[] }> =
        await APOLLO_CLIENT.query({
            query: checkVariableByIdGQL,
            variables: {
                id: variableId
            }
        });

    if (!result || (result.errors && result.errors.length > 0)) {
        throw new InternalServerError("Error checking variable " + result.errors[0].message);
    }

    return result.data.variable.length > 0;
};

export const checkRegionExistsById = async (
    regionId: string,
    access_token: string
): Promise<boolean> => {
    const APOLLO_CLIENT = GraphQL.instanceUsingAccessToken(access_token);

    const result: ApolloQueryResult<{ region_by_pk: { id: string; name: string } | null }> =
        await APOLLO_CLIENT.query({
            query: checkRegionByIdGQL,
            variables: {
                id: regionId
            }
        });

    if (!result || (result.errors && result.errors.length > 0)) {
        throw new InternalServerError("Error checking region " + result.errors[0].message);
    }

    return result.data.region_by_pk !== null;
};

/** Region name and geometries, read with the service credentials. */
export const getRegionWithGeometries = async (
    regionId: string
): Promise<{ id: string; name: string; geometries: { geometry: unknown }[] } | null> => {
    const APOLLO_CLIENT = GraphQL.instance(KeycloakAdapter.getUser());
    const result = await APOLLO_CLIENT.query({
        query: getRegionGQL,
        variables: { id: regionId },
        fetchPolicy: "no-cache"
    });
    if (!result || (result.errors && result.errors.length > 0)) {
        throw new InternalServerError("Error reading region " + result?.errors?.[0]?.message);
    }
    return result.data.region_by_pk ?? null;
};
