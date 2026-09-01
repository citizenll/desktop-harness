import { type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { type UsageTotal } from './usage.js';
export interface BufferedCandidate {
    chunks: StreamChunk[];
    trace: string;
    usage: UsageTotal;
}
export interface CandidateCollectionObserver {
    now?: () => number;
    onFirstToken?: (at: number) => void;
}
export declare function serializeRequestContext(options: GenerateOptions): string;
export declare function requestContainsImage(options: GenerateOptions): boolean;
export declare function collectCandidate(stream: AsyncIterable<StreamChunk>, observer?: CandidateCollectionObserver): Promise<BufferedCandidate>;
