export type DirectedPair = readonly [a: number, b: number];
export interface PairScore {
    a: number;
    b: number;
}
/** Python random.Random(0).shuffle([0, 1, 2]) produces [0, 2, 1]. */
export declare const BO3_RING: readonly DirectedPair[];
export declare function bradleyTerry(rewardA: number, rewardB: number): number;
export declare function pairKey(pair: DirectedPair): string;
export declare function accumulate(pairs: readonly DirectedPair[], scores: ReadonlyMap<string, PairScore>, wins: number[], counts: number[]): void;
export declare function selectPivots(wins: readonly number[], counts: readonly number[], count: number): number[];
export declare function pivotRoundPairs(candidateCount: number, pivots: readonly number[]): DirectedPair[];
export declare function selectWinner(candidateCount: number, ringScores: ReadonlyMap<string, PairScore>, pivotPairs: readonly DirectedPair[], pivotScores: ReadonlyMap<string, PairScore>): {
    winner: number;
    means: number[];
};
