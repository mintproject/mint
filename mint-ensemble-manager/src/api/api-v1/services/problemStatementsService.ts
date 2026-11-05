import { MintPermission, ProblemStatement, ProblemStatementInfo } from "@/classes/mint/mint-types";
import { addProblemStatement, InsertOptions } from "@/classes/graphql/graphql_functions";
import { getTokenFromAuthorizationHeader } from "@/utils/authUtils";
import {
    UnauthorizedError,
    InternalServerError,
    NotFoundError,
    HttpError
} from "@/classes/common/errors";
import { getProblemStatements, getProblemStatement } from "@/classes/graphql/graphql_functions_v2";
import { problemStatementFromGQL } from "@/classes/graphql/adapters/problem_statement_adapter";

/**
 * What a caller may override when it creates a problem statement, task or
 * thread. `permissions` replaces the shared `userid: "*"` default; `id` and
 * `ifAbsent` make a create idempotent (see InsertOptions).
 */
export interface CreateOptions extends InsertOptions {
    permissions?: MintPermission[];
}

export const sharedPermissions = (): MintPermission[] => [
    { read: true, write: true, execute: true, owner: false, userid: "*" }
];

export interface ProblemStatementsService {
    getProblemStatements(authorizationHeader: string): Promise<ProblemStatement[]>;
    getProblemStatementById(id: string, authorizationHeader: string): Promise<ProblemStatement>;
    createProblemStatement(
        problemStatement: ProblemStatementInfo,
        authorizationHeader: string,
        options?: CreateOptions
    ): Promise<string>;
}

const problemStatementsService: ProblemStatementsService = {
    async getProblemStatements(authorizationHeader: string) {
        const access_token = getTokenFromAuthorizationHeader(authorizationHeader);
        if (!access_token) {
            throw new UnauthorizedError("Invalid authorization header");
        }
        const problemStatements = await getProblemStatements(access_token);
        return problemStatements.map((problemStatement) =>
            problemStatementFromGQL(problemStatement)
        );
    },

    async getProblemStatementById(id: string, authorizationHeader: string) {
        const access_token = getTokenFromAuthorizationHeader(authorizationHeader);
        if (!access_token) {
            throw new UnauthorizedError("Invalid authorization header");
        }

        const problemStatement = await getProblemStatement(id, access_token);
        if (!problemStatement) {
            throw new NotFoundError("Problem statement not found");
        }
        return problemStatementFromGQL(problemStatement);
    },

    async createProblemStatement(
        problemStatement: ProblemStatementInfo,
        authorizationHeader: string,
        options: CreateOptions = {}
    ) {
        const access_token = getTokenFromAuthorizationHeader(authorizationHeader);
        if (!access_token) {
            throw new UnauthorizedError("Invalid authorization header");
        }

        problemStatement.permissions = options.permissions ?? sharedPermissions();
        problemStatement.events = [
            {
                event: "CREATE",
                timestamp: new Date(),
                userid: "system",
                notes: "Added problem statement from API"
            }
        ];
        try {
            const id = await addProblemStatement(problemStatement, access_token, options);
            if (!id) {
                throw new InternalServerError("Failed to create problem statement");
            }
            return id;
        } catch (error) {
            if (error instanceof HttpError) throw error;
            console.error("Error creating problem statement:", error);
            throw new InternalServerError("Error creating problem statement: " + error.message);
        }
    }
};

export default problemStatementsService;
