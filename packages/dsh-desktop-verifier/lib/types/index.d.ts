import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "dsh-desktop-verifier";
export declare const inject: string[];
export interface Config {
    verifierModel?: string;
    baseURL?: string;
    apiKeyEnv?: string;
    reasoningEffort?: 'off' | 'low' | 'high' | 'max';
    maxTokens?: number;
}
export declare const Config: z<Schemastery.ObjectS<{
    verifierModel: z<string, string>;
    baseURL: z<string, string>;
    apiKeyEnv: z<string, string>;
    reasoningEffort: z<"off" | "low" | "high" | "max", "off" | "low" | "high" | "max">;
    maxTokens: z<number, number>;
}>, Schemastery.ObjectT<{
    verifierModel: z<string, string>;
    baseURL: z<string, string>;
    apiKeyEnv: z<string, string>;
    reasoningEffort: z<"off" | "low" | "high" | "max", "off" | "low" | "high" | "max">;
    maxTokens: z<number, number>;
}>>;
interface ResolvedConfig {
    verifierModel: string;
    baseURL: string;
    apiKeyEnv: string;
    reasoningEffort: 'off' | 'low' | 'high' | 'max';
    maxTokens: number;
}
export declare function resolveConfig(config: Config): ResolvedConfig;
export declare function apply(ctx: Context, entry?: Config): void;
export {};
