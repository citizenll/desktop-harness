export class VerifierError extends Error {
  readonly code: string

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VerifierError'
    this.code = code
  }
}

export function verifierError(error: unknown, fallbackCode: string): VerifierError {
  if (error instanceof VerifierError) return error
  if (error instanceof Error) return new VerifierError(error.message, fallbackCode, { cause: error })
  return new VerifierError(String(error), fallbackCode)
}

export function isAbortFailure(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true
  return error instanceof DOMException && error.name === 'AbortError'
}
