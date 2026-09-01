import type { BufferedCandidate } from './candidate.js';
import type { ScorePairResult } from './scorer.js';
import { type DirectedPair } from './tournament.js';
import { type UsageTotal } from './usage.js';
export interface TournamentProgress {
    stage(stage: 'scoring-ring' | 'scoring-pivots'): void;
    comparisonCompleted(usage: UsageTotal): void;
}
export type DirectedScorer = (pair: DirectedPair, candidateA: BufferedCandidate, candidateB: BufferedCandidate) => Promise<ScorePairResult>;
export declare function selectVerifiedCandidate(candidates: readonly BufferedCandidate[], scorer: DirectedScorer, progress: TournamentProgress): Promise<{
    winner: number;
    means: number[];
    usage: UsageTotal;
}>;
