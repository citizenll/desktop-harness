import type { UsageTotal } from './usage.js';
export type VerifierProgressStatus = 'idle' | 'generating' | 'scoring-ring' | 'scoring-pivots' | 'replaying' | 'complete' | 'error' | 'cancelled';
export interface CandidateTiming {
    index: number;
    startedAt: number;
    firstTokenAt?: number;
    endedAt?: number;
    usage?: UsageTotal;
}
export interface ComparisonTiming {
    index: number;
    stage: 'scoring-ring' | 'scoring-pivots';
    pair: [number, number];
    startedAt: number;
    responseAt?: number;
    endedAt?: number;
    usage?: UsageTotal;
}
export interface VerifierRunTiming {
    startedAt: number | null;
    generationEndedAt?: number;
    scoringStartedAt?: number;
    scoringEndedAt?: number;
    replayStartedAt?: number;
    replayFirstTokenAt?: number;
    replayEndedAt?: number;
    endedAt?: number;
    candidates: CandidateTiming[];
    comparisons: ComparisonTiming[];
}
export interface VerifierProgressState {
    runId: string | null;
    status: VerifierProgressStatus;
    candidateCount: 3;
    candidatesCompleted: number;
    comparisonsTotal: 5;
    comparisonsCompleted: number;
    winner?: number;
    error?: {
        code: string;
        message: string;
    };
    usage: {
        candidates: UsageTotal;
        verifier: UsageTotal;
    };
    timing: VerifierRunTiming;
    updatedAt: number;
}
export declare function idleProgress(now?: number): VerifierProgressState;
export declare class VerifierProgressStore {
    private readonly now;
    private readonly states;
    private sequence;
    constructor(now?: () => number);
    start(sessionId: string): VerifierProgressState;
    read(sessionId: string): VerifierProgressState;
    update(sessionId: string, runId: string, update: (current: VerifierProgressState) => VerifierProgressState): void;
    clear(sessionId: string): void;
}
