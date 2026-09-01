import { BO3_RING, accumulate, pairKey, pivotRoundPairs, selectPivots, selectWinner, } from './tournament.js';
import { addUsage, emptyUsage } from './usage.js';
async function scorePairs(pairs, candidates, scorer, progress) {
    const completed = await Promise.all(pairs.map(async (pair) => {
        const candidateA = candidates[pair[0]];
        const candidateB = candidates[pair[1]];
        if (candidateA === undefined || candidateB === undefined) {
            throw new Error(`Verifier comparison references an absent candidate: ${pairKey(pair)}.`);
        }
        const result = await scorer(pair, candidateA, candidateB);
        progress.comparisonCompleted(result.usage);
        return { pair, result };
    }));
    const scores = new Map();
    let usage = emptyUsage();
    for (const item of completed) {
        scores.set(pairKey(item.pair), item.result.score);
        usage = addUsage(usage, item.result.usage);
    }
    return { scores, usage };
}
export async function selectVerifiedCandidate(candidates, scorer, progress) {
    if (candidates.length !== 3)
        throw new Error('Verifier selection requires exactly three candidates.');
    progress.stage('scoring-ring');
    const ring = await scorePairs(BO3_RING, candidates, scorer, progress);
    const ringWins = [0, 0, 0];
    const ringCounts = [0, 0, 0];
    accumulate(BO3_RING, ring.scores, ringWins, ringCounts);
    const pivots = selectPivots(ringWins, ringCounts, 1);
    const pairs = pivotRoundPairs(3, pivots);
    progress.stage('scoring-pivots');
    const pivot = await scorePairs(pairs, candidates, scorer, progress);
    const selection = selectWinner(3, ring.scores, pairs, pivot.scores);
    return {
        ...selection,
        usage: addUsage(ring.usage, pivot.usage),
    };
}
