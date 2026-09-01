export const INITIAL_VERIFIER_STATE = Object.freeze({
    active: false,
    running: null,
});
export function parseVerifierTarget(raw) {
    const value = raw?.trim();
    if (value === 'on')
        return true;
    if (value === 'off')
        return false;
    return undefined;
}
export function applyVerifierEvent(state, event) {
    if (event.type === 'command/run' && event.data.name === 'verify') {
        const wanted = parseVerifierTarget(event.data.args);
        if (wanted === undefined)
            return state;
        return {
            ...state,
            running: {
                commandId: event.data.commandId,
                wanted,
            },
        };
    }
    if (event.type === 'command/done' && event.data.commandId === state.running?.commandId) {
        return {
            active: event.data.kind === 'success' ? state.running.wanted : state.active,
            running: null,
        };
    }
    return state;
}
export function foldVerifierState(events) {
    let state = INITIAL_VERIFIER_STATE;
    for (const event of events)
        state = applyVerifierEvent(state, event);
    return state;
}
export function verifierProjection(state) {
    return {
        active: state.active,
        pending: state.running !== null && state.running.wanted !== state.active,
    };
}
export function foldVerifierMode(events) {
    return foldVerifierState(events).active;
}
