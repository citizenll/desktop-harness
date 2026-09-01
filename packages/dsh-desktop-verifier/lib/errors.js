export class VerifierError extends Error {
    code;
    constructor(message, code, options) {
        super(message, options);
        this.name = 'VerifierError';
        this.code = code;
    }
}
export function verifierError(error, fallbackCode) {
    if (error instanceof VerifierError)
        return error;
    if (error instanceof Error)
        return new VerifierError(error.message, fallbackCode, { cause: error });
    return new VerifierError(String(error), fallbackCode);
}
export function isAbortFailure(error, signal) {
    if (signal?.aborted === true)
        return true;
    return error instanceof DOMException && error.name === 'AbortError';
}
