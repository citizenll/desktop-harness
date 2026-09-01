import { emptyUsage } from './usage.js';
export function idleProgress(now = Date.now()) {
    return {
        runId: null,
        status: 'idle',
        candidateCount: 3,
        candidatesCompleted: 0,
        comparisonsTotal: 5,
        comparisonsCompleted: 0,
        usage: {
            candidates: emptyUsage(),
            verifier: emptyUsage(),
        },
        timing: {
            startedAt: null,
            candidates: [],
            comparisons: [],
        },
        updatedAt: now,
    };
}
export class VerifierProgressStore {
    now;
    states = new Map();
    sequence = 0;
    constructor(now = Date.now) {
        this.now = now;
    }
    start(sessionId) {
        const startedAt = this.now();
        const state = {
            ...idleProgress(startedAt),
            runId: `${startedAt.toString(36)}-${(++this.sequence).toString(36)}`,
            status: 'generating',
            timing: {
                startedAt,
                candidates: [],
                comparisons: [],
            },
        };
        this.states.set(sessionId, state);
        return state;
    }
    read(sessionId) {
        return this.states.get(sessionId) ?? idleProgress(this.now());
    }
    update(sessionId, runId, update) {
        const current = this.states.get(sessionId);
        if (current?.runId !== runId)
            return;
        this.states.set(sessionId, { ...update(current), updatedAt: this.now() });
    }
    clear(sessionId) {
        this.states.delete(sessionId);
    }
}
