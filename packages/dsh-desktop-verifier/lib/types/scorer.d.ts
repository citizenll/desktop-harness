import { type UsageTotal } from './usage.js';
export interface VerifierConnection {
    baseURL: string;
    apiKey: string;
    model: string;
    reasoningEffort: 'off' | 'low' | 'high' | 'max';
    maxTokens: number;
}
export interface ScorePairResult {
    score: {
        a: number;
        b: number;
    };
    usage: UsageTotal;
}
export interface ScorePairOptions {
    fetchImpl?: typeof fetch;
    now?: () => number;
    onResponse?: (at: number) => void;
}
interface WireLogprobAlternative {
    token: string;
    logprob: number;
}
interface WireLogprobPosition extends WireLogprobAlternative {
    top_logprobs?: WireLogprobAlternative[];
}
interface WireResponse {
    choices?: Array<{
        message?: {
            content?: string | null;
        };
        logprobs?: {
            content?: WireLogprobPosition[] | null;
        } | null;
    }>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
        prompt_tokens_details?: {
            cached_tokens?: number;
        };
        completion_tokens_details?: {
            reasoning_tokens?: number;
        };
    };
    error?: {
        message?: string;
    };
}
export declare function buildVerifierPrompt(task: string, traceA: string, traceB: string): string;
export declare function expectedScore(positions: readonly WireLogprobPosition[], tag: '<score_A>' | '<score_B>'): number;
export declare function usageFromWire(response: WireResponse): UsageTotal;
export declare function scorePair(connection: VerifierConnection, task: string, traceA: string, traceB: string, signal: AbortSignal, options?: ScorePairOptions): Promise<ScorePairResult>;
export {};
