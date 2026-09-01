/** One pure decision shared by the interceptor and its regression tests. */
export function shouldVerifyRequest(options, eligibility) {
    return !eligibility.bypassed
        && eligibility.agentLoopRequest
        && eligibility.active
        && options.purpose === undefined
        && options.sessionId !== undefined
        && eligibility.initiatorSessionId !== undefined
        && String(options.sessionId) === eligibility.initiatorSessionId;
}
