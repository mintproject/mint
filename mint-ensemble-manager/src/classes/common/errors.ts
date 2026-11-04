export class HttpError extends Error {
    constructor(
        public statusCode: number,
        message: string,
        /**
         * A stable machine-readable name for the cause. The message is for a
         * person and may change. A client branches on the code.
         */
        public code?: string
    ) {
        super(message);
        this.name = "HttpError";
    }
}

export class NotFoundError extends HttpError {
    constructor(message: string = "Resource not found") {
        super(404, message);
        this.name = "NotFoundError";
    }
}

export class BadRequestError extends HttpError {
    constructor(message: string = "Bad request") {
        super(400, message);
        this.name = "BadRequestError";
    }
}

export class UnauthorizedError extends HttpError {
    constructor(message: string = "Unauthorized") {
        super(401, message);
        this.name = "UnauthorizedError";
    }
}

export class ForbiddenError extends HttpError {
    constructor(message: string = "Forbidden") {
        super(403, message);
        this.name = "ForbiddenError";
    }
}

export class UnprocessableEntityError extends HttpError {
    constructor(message: string = "Unprocessable entity", code?: string) {
        super(422, message, code);
        this.name = "UnprocessableEntityError";
    }
}

/**
 * The execution succeeded and the model configuration declares no output.
 * Nothing is broken. The user must promote a file from the execution before
 * MINT can publish a result.
 */
export class NoOutputsDeclaredError extends UnprocessableEntityError {
    static readonly CODE = "NO_OUTPUTS_DECLARED";

    constructor() {
        super(
            "This model configuration declares no outputs. Promote a file from the execution first.",
            NoOutputsDeclaredError.CODE
        );
        this.name = "NoOutputsDeclaredError";
    }
}

export class InternalServerError extends HttpError {
    constructor(message: string = "Internal server error") {
        super(500, message);
        this.name = "InternalServerError";
    }
}

/**
 * A failure the unified execution API reports to the client with a stable
 * machine-readable code (and optional structured details).
 */
export class UnifiedExecutionError extends Error {
    constructor(
        public statusCode: number,
        message: string,
        public code?: string,
        public details?: unknown
    ) {
        super(message);
        this.name = "UnifiedExecutionError";
    }
}
