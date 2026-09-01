import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

export interface VerifierEligibility {
  bypassed: boolean
  agentLoopRequest: boolean
  active: boolean
  initiatorSessionId?: string
}

/** One pure decision shared by the interceptor and its regression tests. */
export function shouldVerifyRequest(
  options: GenerateOptions,
  eligibility: VerifierEligibility,
): boolean {
  return !eligibility.bypassed
    && eligibility.agentLoopRequest
    && eligibility.active
    && options.purpose === undefined
    && options.sessionId !== undefined
    && eligibility.initiatorSessionId !== undefined
    && String(options.sessionId) === eligibility.initiatorSessionId
}
