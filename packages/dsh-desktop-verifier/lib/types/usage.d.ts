import type { TokenUsage } from '@deepseek-ai/dsh-llm';
export interface UsageTotal {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    complete: boolean;
}
export declare function emptyUsage(): UsageTotal;
export declare function usageFromDsh(usage: TokenUsage | undefined): UsageTotal;
export declare function addUsage(target: UsageTotal, value: UsageTotal): UsageTotal;
