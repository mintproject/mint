import {
    BadRequestError,
    ForbiddenError,
    InternalServerError,
    NotFoundError,
    UnauthorizedError
} from "@/classes/common/errors";

const errorDecoder = async <T>(func: () => Promise<T>) => {
    try {
        // Call the specified function name, and expect that specific return type
        const result: T = await func();
        return result;
    } catch (error) {
        // If an exception occurred, try to decode the json response from it and
        // rethrow it
        const failure = error as { json?: () => Promise<{ message: string }>; status?: number };
        if (failure.json) {
            const decoded = await failure.json();
            if (failure.status == 404) {
                throw new NotFoundError(decoded.message);
            } else if (failure.status == 401) {
                throw new UnauthorizedError(decoded.message);
            } else if (failure.status == 403) {
                throw new ForbiddenError(decoded.message);
            } else if (failure.status == 400) {
                throw new BadRequestError(decoded.message);
            } else if (failure.status == 500) {
                throw new InternalServerError(decoded.message);
            } else {
                throw new Error(decoded.message);
            }
        } else {
            throw error;
        }
    }
};

export default errorDecoder;
