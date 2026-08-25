/**
 * HTTP routes bridging the browser market UI to the host. This layer only
 * parses requests, calls the service modules, and serializes responses —
 * process spawning lives in dsh-cli.ts, filesystem reads in profile.ts,
 * orchestration in install.ts / themes.ts / updates.ts.
 *
 * Security: install routes execute a package-manager command, so they accept
 * only same-origin POSTs. Catalog installs must resolve to the curated
 * registry; direct installs pass through the narrower source allowlist in
 * sources.ts and are confirmed by a dedicated client dialog.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type PluginCommandRuntime } from './dsh-cli.ts';
import { type AgentsLookup } from './agents.ts';
import { type Channel } from './channels.ts';
import { type LoaderEntry } from './themes.ts';
export type { LoaderEntry } from './themes.ts';
export type { UpdateStatus } from './updates.ts';
export interface WebServerService {
    register(route: {
        kind: 'exact' | 'prefix';
        path: string;
        handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
    }): () => void;
}
export interface MarketHost {
    webServer: WebServerService;
    loader: {
        entries(): Iterable<LoaderEntry>;
    };
    plugin(plugin: unknown, config: unknown): {
        await(): Promise<unknown>;
        dispose(): Promise<unknown> | void;
    };
    on?(event: string, callback: (fiber: {
        entry?: {
            options?: {
                name?: string;
            };
        };
    }) => void): () => void;
    logger?: {
        info?(message: string): void;
        warn(message: string): void;
    };
}
export interface MarketConfig {
    /** Profile the market installs into; matches the profile serving this UI. */
    profile: string;
    /** Host-authoritative profile directory; ordinary DSH derives it from DSH_HOME. */
    profileDirectory?: string;
    /** Detached self-restart is unsafe under systemd/launchd/pm2; operators can disable it (#14). */
    allowRestart?: boolean;
    /** Which release channel the market offers ITSELF from; other plugins never follow it. */
    channel?: Channel;
}
export declare function marketVersion(): string;
/**
 * Register the market's HTTP routes.
 * @param host - Acquired webServer + shell services.
 * @param config - Validated market configuration.
 * @returns Disposer removing every registered route.
 */
export declare function mountMarketRoutes(host: MarketHost, config: MarketConfig, commandRuntime?: PluginCommandRuntime, agentsLookup?: AgentsLookup): () => void;
