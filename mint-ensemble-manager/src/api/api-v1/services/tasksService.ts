import { Task, ThreadInfo } from "@/classes/mint/mint-types";
import { addTask } from "@/classes/graphql/graphql_functions";
import { getTokenFromAuthorizationHeader } from "@/utils/authUtils";
import {
    UnauthorizedError,
    InternalServerError,
    NotFoundError,
    HttpError
} from "@/classes/common/errors";
import problemStatementsService, {
    CreateOptions,
    sharedPermissions
} from "./problemStatementsService";
import subTasksService from "./subTasksService";
import { getTasksByProblemStatementId } from "@/classes/graphql/graphql_functions_v2";
import { taskFromGQL } from "@/classes/graphql/adapters/problem_statement_adapter";

export interface TasksService {
    getTasksByProblemStatementId(
        problemStatementId: string,
        authorizationHeader: string
    ): Promise<Task[]>;
    createTask(
        problemStatementId: string,
        task: Task,
        authorizationHeader: string,
        options?: CreateOptions
    ): Promise<string>;
    createTaskWithThread(
        problemStatementId: string,
        task: Task,
        thread: ThreadInfo,
        authorizationHeader: string,
        options?: CreateOptions
    ): Promise<string[]>;
}

const tasksService: TasksService = {
    async getTasksByProblemStatementId(problemStatementId: string, authorizationHeader: string) {
        const access_token = getTokenFromAuthorizationHeader(authorizationHeader);
        if (!access_token) {
            throw new UnauthorizedError("Invalid authorization header");
        }

        const tasks = await getTasksByProblemStatementId(problemStatementId, access_token);

        return tasks.map((task) => taskFromGQL(task));
    },

    async createTask(
        problemStatementId: string,
        task: Task,
        authorizationHeader: string,
        options: CreateOptions = {}
    ) {
        const access_token = getTokenFromAuthorizationHeader(authorizationHeader);
        if (!access_token) {
            throw new UnauthorizedError("Invalid authorization header");
        }

        const problemStatement = await problemStatementsService.getProblemStatementById(
            problemStatementId,
            authorizationHeader
        );
        const region_id = task.regionid ? task.regionid : problemStatement.regionid;

        if (!problemStatement) {
            throw new NotFoundError("Problem statement not found");
        }

        task.events = [
            {
                event: "CREATE",
                timestamp: new Date(),
                userid: "system",
                notes: "Added task from API"
            }
        ];
        task.permissions = options.permissions ?? sharedPermissions();
        try {
            const id = await addTask(
                problemStatement,
                { ...task, regionid: region_id },
                access_token,
                options
            );
            if (!id) {
                throw new InternalServerError("Failed to create task");
            }
            return id;
        } catch (error) {
            if (error instanceof HttpError) throw error;
            console.error("Error creating task:", error);
            throw new InternalServerError("Error creating task: " + error.message);
        }
    },

    async createTaskWithThread(
        problemStatementId: string,
        task: Task,
        thread: ThreadInfo,
        authorizationHeader: string,
        options: CreateOptions = {}
    ) {
        const access_token = getTokenFromAuthorizationHeader(authorizationHeader);
        if (!access_token) {
            throw new UnauthorizedError("Invalid authorization header");
        }

        const problemStatement = await problemStatementsService.getProblemStatementById(
            problemStatementId,
            authorizationHeader
        );

        const region_id = thread.regionid ? thread.regionid : problemStatement.regionid;

        if (!problemStatement) {
            throw new NotFoundError("Problem statement not found");
        }

        task.events = [
            {
                event: "CREATE",
                timestamp: new Date(),
                userid: "system",
                notes: "Added task from API"
            }
        ];
        task.permissions = options.permissions ?? sharedPermissions();
        try {
            const id = await addTask(problemStatement, task);
            if (!id) {
                throw new InternalServerError("Failed to create task");
            }
            const subtaskId = await subTasksService.createSubtask(
                problemStatementId,
                id,
                { ...thread, regionid: region_id },
                authorizationHeader,
                { permissions: options.permissions }
            );
            return [id, subtaskId];
        } catch (error) {
            if (error instanceof HttpError) throw error;
            console.error("Error creating task with thread:", error);
            throw new InternalServerError("Error creating task with thread: " + error.message);
        }
    }
};

export default tasksService;
