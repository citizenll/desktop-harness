/** Python random.Random(0).shuffle([0, 1, 2]) produces [0, 2, 1]. */
export const BO3_RING = Object.freeze([
    Object.freeze([0, 2]),
    Object.freeze([2, 1]),
    Object.freeze([1, 0]),
]);
export function bradleyTerry(rewardA, rewardB) {
    return 1 / (1 + Math.exp(-(rewardA - rewardB)));
}
export function pairKey(pair) {
    return `${pair[0]}:${pair[1]}`;
}
export function accumulate(pairs, scores, wins, counts) {
    for (const pair of pairs) {
        const score = scores.get(pairKey(pair));
        if (score === undefined)
            throw new Error(`Missing directed score for ${pairKey(pair)}.`);
        const winA = wins[pair[0]];
        const countA = counts[pair[0]];
        const winB = wins[pair[1]];
        const countB = counts[pair[1]];
        if (winA === undefined || countA === undefined || winB === undefined || countB === undefined) {
            throw new Error(`Directed score references an absent candidate: ${pairKey(pair)}.`);
        }
        const preference = bradleyTerry(score.a, score.b);
        wins[pair[0]] = winA + preference;
        counts[pair[0]] = countA + 1;
        wins[pair[1]] = winB + 1 - preference;
        counts[pair[1]] = countB + 1;
    }
}
export function selectPivots(wins, counts, count) {
    if (wins.length !== counts.length)
        throw new Error('Tournament win and count vectors differ in length.');
    return Array.from({ length: wins.length }, (_, index) => index)
        .sort((left, right) => {
        const leftCount = counts[left] ?? 0;
        const rightCount = counts[right] ?? 0;
        const leftMean = leftCount === 0 ? 0 : (wins[left] ?? 0) / leftCount;
        const rightMean = rightCount === 0 ? 0 : (wins[right] ?? 0) / rightCount;
        return rightMean - leftMean || left - right;
    })
        .slice(0, Math.min(count, wins.length));
}
export function pivotRoundPairs(candidateCount, pivots) {
    const pivotSet = new Set(pivots);
    const pairs = [];
    for (let candidate = 0; candidate < candidateCount; candidate++) {
        if (pivotSet.has(candidate))
            continue;
        for (const pivot of pivots)
            pairs.push([candidate, pivot]);
    }
    const ordered = [...pivots].sort((left, right) => left - right);
    for (let left = 0; left < ordered.length; left++) {
        for (let right = left + 1; right < ordered.length; right++) {
            const candidateA = ordered[left];
            const candidateB = ordered[right];
            if (candidateA === undefined || candidateB === undefined)
                continue;
            pairs.push([candidateA, candidateB]);
        }
    }
    return pairs;
}
export function selectWinner(candidateCount, ringScores, pivotPairs, pivotScores) {
    if (!Number.isSafeInteger(candidateCount) || candidateCount < 1) {
        throw new Error('Tournament requires at least one candidate.');
    }
    const wins = Array.from({ length: candidateCount }, () => 0);
    const counts = Array.from({ length: candidateCount }, () => 0);
    accumulate(BO3_RING, ringScores, wins, counts);
    accumulate(pivotPairs, pivotScores, wins, counts);
    const means = wins.map((win, index) => {
        const count = counts[index] ?? 0;
        return count === 0 ? 0 : win / count;
    });
    let winner = 0;
    for (let index = 1; index < candidateCount; index++) {
        if ((means[index] ?? 0) > (means[winner] ?? 0))
            winner = index;
    }
    return { winner, means };
}
