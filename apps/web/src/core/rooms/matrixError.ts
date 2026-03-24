interface MatrixLikeErrorData {
    errcode?: unknown;
    error?: unknown;
    retry_after_ms?: unknown;
    status?: unknown;
    statusCode?: unknown;
}

interface MatrixLikeError {
    errcode?: unknown;
    httpStatus?: unknown;
    status?: unknown;
    statusCode?: unknown;
    data?: MatrixLikeErrorData;
    message?: unknown;
}

export function getMatrixErrorMessage(error: unknown): string {
    if (!error || typeof error !== "object") {
        return "";
    }

    const matrixError = error as MatrixLikeError;
    if (typeof matrixError.data?.error === "string" && matrixError.data.error.trim().length > 0) {
        return matrixError.data.error;
    }
    if (typeof matrixError.message === "string" && matrixError.message.trim().length > 0) {
        return matrixError.message;
    }

    return "";
}

export function getMatrixErrorCode(error: unknown): string | null {
    if (!error || typeof error !== "object") {
        return null;
    }

    const matrixError = error as MatrixLikeError;
    if (typeof matrixError.errcode === "string") {
        return matrixError.errcode;
    }
    if (typeof matrixError.data?.errcode === "string") {
        return matrixError.data.errcode;
    }

    return null;
}

export function getMatrixErrorStatus(error: unknown): number | null {
    if (!error || typeof error !== "object") {
        return null;
    }

    const matrixError = error as MatrixLikeError;
    const candidate =
        typeof matrixError.httpStatus === "number"
            ? matrixError.httpStatus
            : typeof matrixError.statusCode === "number"
              ? matrixError.statusCode
              : typeof matrixError.status === "number"
                ? matrixError.status
                : typeof matrixError.data?.statusCode === "number"
                  ? matrixError.data.statusCode
                  : typeof matrixError.data?.status === "number"
                    ? matrixError.data.status
                    : null;

    if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
        return null;
    }

    return candidate;
}

export function getMatrixRetryAfterMs(error: unknown): number | null {
    if (!error || typeof error !== "object") {
        return null;
    }

    const matrixError = error as MatrixLikeError;
    const candidate = matrixError.data?.retry_after_ms;
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
        return null;
    }

    return candidate;
}
