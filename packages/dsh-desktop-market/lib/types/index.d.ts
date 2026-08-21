/**
 * dsh-market host entry: mounts the market's HTTP routes once the profile
 * composes the webServer and shell services.
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-market";
/** Desktop owns the profile and process lifecycle; loader configuration is intentionally empty. */
export type Config = Record<string, never>;
export declare function apply(ctx: Context, config?: Config): void;
