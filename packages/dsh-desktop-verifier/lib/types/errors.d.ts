export declare class VerifierError extends Error {
    readonly code: string;
    constructor(message: string, code: string, options?: ErrorOptions);
}
export declare function verifierError(error: unknown, fallbackCode: string): VerifierError;
export declare function isAbortFailure(error: unknown, signal?: AbortSignal): boolean;
