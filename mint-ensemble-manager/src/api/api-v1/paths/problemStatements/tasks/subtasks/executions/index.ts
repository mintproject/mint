import { Router, Request, Response } from "express";
import executionOutputsService from "@/api/api-v1/services/tapis/executionOutputsService";
import { BadRequestError, NotFoundError, UnprocessableEntityError } from "@/classes/common/errors";
import { getTokenFromAuthorizationHeader } from "@/utils/authUtils";
import { getSubtask } from "@/classes/graphql/graphql_functions_v2";
import { Thread as GraphQLThread } from "@/classes/graphql/graphql";
import { threadFromGQL } from "@/classes/graphql/graphql_adapter";
import { Thread, Execution } from "@/classes/mint/mint-types";

interface ExecutionRequest extends Request {
    params: {
        problemStatementId: string;
        taskId: string;
        subtaskId?: string;
        executionId: string;
    };
    body: {
        datasetId: string;
    };
}
export const executionsRouter = (): Router => {
    const router = Router({ mergeParams: true });

    /**
     * @openapi
     * /problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}/executions:
     *   get:
     *     summary: Get all executions for a subtask
     *     description: Returns a list of all executions associated with a specific subtask
     *     security:
     *       - BearerAuth: []
     *         oauth2: []
     *     tags:
     *       - Subtasks
     *     parameters:
     *       - in: path
     *         name: problemStatementId
     *         required: true
     *         schema:
     *           type: string
     *         description: The problem statement ID
     *       - in: path
     *         name: taskId
     *         required: true
     *         schema:
     *           type: string
     *         description: The task ID
     *       - in: path
     *         name: subtaskId
     *         required: true
     *         schema:
     *           type: string
     *         description: The subtask ID
     *     responses:
     *       200:
     *         description: List of executions for the subtask
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 executions:
     *                   type: array
     *                   items:
     *                     $ref: '#/components/schemas/Execution'
     *       404:
     *         description: Subtask not found
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 message:
     *                   type: string
     *       500:
     *         description: Server error
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 message:
     *                   type: string
     */
    router.get("/", async (req: Request, res: Response) => {
        const authorizationHeader = req.headers.authorization;
        if (!authorizationHeader) {
            return res.status(401).json({ message: "Authorization header is required" });
        }

        const access_token = getTokenFromAuthorizationHeader(authorizationHeader);
        const { subtaskId } = req.params;

        try {
            const subtaskResponse: GraphQLThread = await getSubtask(subtaskId, access_token);
            if (!subtaskResponse) {
                return res.status(404).json({ message: "Subtask not found" });
            }

            // Extract executions from thread models
            const executions: Execution[] = [];

            if (subtaskResponse.thread_models) {
                for (const threadModel of subtaskResponse.thread_models) {
                    if (threadModel.executions) {
                        for (const executionWrapper of threadModel.executions) {
                            if (executionWrapper.execution) {
                                const graphqlExecution = executionWrapper.execution;

                                // Map data bindings to execution bindings format
                                const bindings: { [input: string]: string } = {};
                                if (threadModel.data_bindings) {
                                    // Query aliases modelcatalog_dataset_specification as
                                    // model_io; codegen schema type does not carry the alias.
                                    for (const binding of threadModel.data_bindings as Array<{
                                        model_io?: { name?: string | null } | null;
                                        dataslice_id?: string | null;
                                    }>) {
                                        if (binding.model_io?.name && binding.dataslice_id) {
                                            bindings[binding.model_io.name] = binding.dataslice_id;
                                        }
                                    }
                                }

                                // Add parameter bindings
                                if (threadModel.parameter_bindings) {
                                    for (const binding of threadModel.parameter_bindings) {
                                        if (binding.model_parameter_id && binding.parameter_value) {
                                            bindings[binding.model_parameter_id] =
                                                binding.parameter_value;
                                        }
                                    }
                                }

                                const execution: Execution = {
                                    id: graphqlExecution.id,
                                    modelid:
                                        threadModel.modelcatalog_configuration?.id ||
                                        graphqlExecution.modelcatalog_configuration_id ||
                                        "",
                                    bindings: bindings,
                                    runid: graphqlExecution.run_id || graphqlExecution.id,
                                    start_time: graphqlExecution.start_time
                                        ? new Date(graphqlExecution.start_time)
                                        : new Date(),
                                    end_time: graphqlExecution.end_time
                                        ? new Date(graphqlExecution.end_time)
                                        : undefined,
                                    execution_engine: graphqlExecution.execution_engine as
                                        "wings" | "localex" | "tapis" | undefined,
                                    status: (graphqlExecution.status || "WAITING") as
                                        "FAILURE" | "SUCCESS" | "RUNNING" | "WAITING",
                                    run_progress: Number(graphqlExecution.run_progress) || 0,
                                    results: graphqlExecution.results || [],
                                    selected: false
                                };
                                executions.push(execution);
                            }
                        }
                    }
                }
            }

            res.status(200).json({ executions });
        } catch (error) {
            if (error instanceof NotFoundError) {
                res.status(404).json({ message: error.message });
            } else {
                res.status(500).json({ message: error.message || "Internal server error" });
            }
        }
    });

    /**
     * @swagger
     * /problemStatements/{problemStatementId}/tasks/{taskId}/subtasks/{subtaskId}/executions/{executionId}/outputs:
     *   post:
     *     summary: Register Tapis Execution Outputs
     *     description: Register the outputs of a successful Tapis execution in the data catalog
     *     operationId: registerTapisExecutionOutputs
     *     tags:
     *       - Tapis
     *     security:
     *       - BearerAuth: []
     *       - oauth2: []
     *     parameters:
     *       - name: problemStatementId
     *         in: path
     *         required: true
     *         schema:
     *           type: string
     *       - name: taskId
     *         in: path
     *         required: true
     *         schema:
     *           type: string
     *       - name: subtaskId
     *         in: path
     *         required: true
     *         schema:
     *           type: string
     *       - name: executionId
     *         in: path
     *         required: true
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: Outputs registered successfully
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: '#/components/schemas/Execution_Result'
     *       400:
     *         description: Invalid request or registration failed
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 message:
     *                   type: string
     *       422:
     *         description: >
     *           The execution succeeded, but the model configuration declares no
     *           output. The user must promote a file from the execution first.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 code:
     *                   type: string
     *                   example: NO_OUTPUTS_DECLARED
     *                 message:
     *                   type: string
     *       500:
     *         description: Server error
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 message:
     *                   type: string
     */
    router.post("/:executionId/outputs", async (req: ExecutionRequest, res: Response) => {
        const authorizationHeader = req.headers.authorization;
        if (!authorizationHeader) {
            return res.status(401).json({ message: "Authorization header is required" });
        }
        const access_token = getTokenFromAuthorizationHeader(authorizationHeader);
        const { subtaskId, executionId } = req.params;
        try {
            const subtaskRespose: GraphQLThread = await getSubtask(subtaskId, access_token);
            if (!subtaskRespose) {
                return res.status(404).json({ message: "Subtask not found" });
            }
            const subtask: Thread = threadFromGQL(subtaskRespose);

            const executionResults = await executionOutputsService.registerOutputs(
                executionId,
                access_token,
                subtask,
                req.headers.origin,
                subtask.dataset_id
            );
            if (!executionResults || executionResults.length === 0) {
                return res
                    .status(400)
                    .json({ message: "No successful executions found to register outputs" });
            }

            res.status(200).json(executionResults);
        } catch (error) {
            if (error instanceof UnprocessableEntityError) {
                res.status(error.statusCode).json({
                    code: error.code,
                    message: error.message
                });
            } else if (error instanceof NotFoundError) {
                res.status(404).json({
                    message: error.message
                });
            } else if (error instanceof BadRequestError) {
                res.status(400).json({
                    message: "Execution is not successful"
                });
            } else {
                res.status(500).json({
                    message: error.message
                });
            }
        }
    });

    return router;
};
