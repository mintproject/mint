import Queue from "bull";
import { EXECUTION_QUEUE_NAME, REDIS_URL } from "@/config/redis";
import { createResponse, GenericResponse } from "./util";

export interface QueueResponse {
    result: string;
    message?: string;
    data?: unknown;
}

export interface ExecutionQueueService {
    emptyExecutionQueue(): Promise<GenericResponse>;
    getExecutionQueue(thread: unknown): Promise<QueueResponse>;
}

// ./api-v1/services/executionsLocalService.js
const cleanQueue = (queue: Queue.Queue) => {
    queue.empty();
    queue.clean(0, "delayed");
    queue.clean(0, "wait");
    queue.clean(0, "active");
    queue.clean(0, "completed");
    queue.clean(0, "failed");

    const multi = queue.multi();
    multi.del(queue.toKey("repeat"));
    multi.exec();
};

const executionQueueService = {
    async emptyExecutionQueue() {
        const executionQueue = new Queue(EXECUTION_QUEUE_NAME, REDIS_URL);
        cleanQueue(executionQueue);
        return createResponse("success", "Queues emptied");
    },
    async getExecutionQueue() {
        const executionQueue = new Queue(EXECUTION_QUEUE_NAME, REDIS_URL);
        const count = await executionQueue.getActiveCount();
        return createResponse("success", "Number of Active Jobs: " + count);
    }
};

export default executionQueueService;
