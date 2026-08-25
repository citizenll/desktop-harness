/**
 * Persistent, staged access to the curated plugin catalog.
 *
 * The active catalog is read from the profile immediately after the first
 * successful download. Remote checks happen in the background and stage a
 * newer catalog until the user explicitly applies it, so opening the market
 * never turns into a network loading screen again.
 */
import { marketFetch } from './net.ts';
export interface RegistryPlugin {
    name: string;
    owner: string;
    url: string;
    category: string;
    description: Record<string, string>;
    npm?: string | null;
    stars?: number | null;
    /** npm downloads in the last 30 days. */
    downloads?: number | null;
    install: string;
    added: string;
    deprecated?: boolean;
    replacement?: string;
}
export interface Registry {
    updated: string;
    count: number;
    categories: Record<string, Record<string, string>>;
    plugins: RegistryPlugin[];
}
export interface CatalogStatus {
    checking: boolean;
    updateAvailable: boolean;
    activeUpdated: string | null;
    pendingUpdated: string | null;
    lastCheckedAt: string | null;
    error: string | null;
}
export interface CatalogStore {
    /** Return the active local catalog, downloading it only when none exists. */
    load(): Promise<Registry>;
    /** Start a throttled remote check without delaying the caller. */
    scheduleCheck(): void;
    /** Check the source now; primarily useful to diagnostics and tests. */
    checkForUpdate(force?: boolean): Promise<CatalogStatus>;
    /** Promote the already-downloaded pending catalog. */
    applyUpdate(): Promise<Registry | null>;
    status(): CatalogStatus;
}
type MarketFetcher = typeof marketFetch;
export interface CatalogStoreOptions {
    /** Override used by tests and private mirrors. */
    sourceUrl?: string;
    /** Null disables persistence while retaining the same staged semantics. */
    cachePath?: string | null;
    /** Remote revalidation cadence. */
    checkIntervalMs?: number;
    fetcher?: MarketFetcher;
    now?: () => number;
}
export declare const CATALOG_CHECK_INTERVAL_MS: number;
/**
 * Create one catalog store for one profile. The cache belongs to the profile
 * because a Desktop installation can host more than one isolated profile.
 */
export declare function createCatalogStore(profileDirectory?: string, options?: CatalogStoreOptions): CatalogStore;
export declare function loadRegistry(): Promise<Registry>;
/** Reset the compatibility store between tests. */
export declare function forgetCatalog(): void;
/** Describe a catalog failure with enough network context for exported logs. */
export declare function describeFetchFailure(error: unknown, elapsedMs: number): string;
export {};
