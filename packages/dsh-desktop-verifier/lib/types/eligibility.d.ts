import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
export interface VerifierEligibility {
    bypassed: boolean;
    agentLoopRequest: boolean;
    active: boolean;
    initiatorSessionId?: string;
}
/** One pure decision shared by the interceptor and its regression tests. */
export declare function shouldVerifyRequest(options: GenerateOptions, eligibility: VerifierEligibility): boolean;
