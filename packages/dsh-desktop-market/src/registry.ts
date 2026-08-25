/**
 * Persistent, staged access to the curated plugin catalog.
 *
 * The active catalog is read from the profile immediately after the first
 * successful download. Remote checks happen in the background and stage a
 * newer catalog until the user explicitly applies it, so opening the market
 * never turns into a network loading screen again.
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { configuredProxy, marketFetch } from './net.ts'

export interface RegistryPlugin {
  name: string
  owner: string
  url: string
  category: string
  description: Record<string, string>
  npm?: string | null
  stars?: number | null
  /** npm downloads in the last 30 days. */
  downloads?: number | null
  install: string
  added: string
  deprecated?: boolean
  replacement?: string
}

export interface Registry {
  updated: string
  count: number
  categories: Record<string, Record<string, string>>
  plugins: RegistryPlugin[]
}

export interface CatalogStatus {
  checking: boolean
  updateAvailable: boolean
  activeUpdated: string | null
  pendingUpdated: string | null
  lastCheckedAt: string | null
  error: string | null
}

export interface CatalogStore {
  /** Return the active local catalog, downloading it only when none exists. */
  load(): Promise<Registry>
  /** Start a throttled remote check without delaying the caller. */
  scheduleCheck(): void
  /** Check the source now; primarily useful to diagnostics and tests. */
  checkForUpdate(force?: boolean): Promise<CatalogStatus>
  /** Promote the already-downloaded pending catalog. */
  applyUpdate(): Promise<Registry | null>
  status(): CatalogStatus
}

type MarketFetcher = typeof marketFetch

export interface CatalogStoreOptions {
  /** Override used by tests and private mirrors. */
  sourceUrl?: string
  /** Null disables persistence while retaining the same staged semantics. */
  cachePath?: string | null
  /** Remote revalidation cadence. */
  checkIntervalMs?: number
  fetcher?: MarketFetcher
  now?: () => number
}

interface CatalogSnapshot {
  etag: string | null
  modified: string | null
  fetchedAt: number
  data: Registry
}

interface CatalogCacheFile {
  schema: 1
  source: string
  checkedAt: number
  attemptedAt: number
  active: CatalogSnapshot
  pending?: CatalogSnapshot
}

const DEFAULT_REGISTRY_URL = 'https://awesome-dsh-plugin.com/plugins.json'
const FETCH_TIMEOUT_MS = 15_000
export const CATALOG_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const CACHE_FILE = 'catalog-v1.json'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRegistry(value: unknown): value is Registry {
  if (!isObject(value)) return false
  return typeof value.updated === 'string'
    && typeof value.count === 'number'
    && isObject(value.categories)
    && Array.isArray(value.plugins)
    && value.plugins.length > 0
}

function isSnapshot(value: unknown): value is CatalogSnapshot {
  if (!isObject(value)) return false
  return (typeof value.etag === 'string' || value.etag === null)
    && (typeof value.modified === 'string' || value.modified === null)
    && typeof value.fetchedAt === 'number'
    && isRegistry(value.data)
}

function parseCache(value: unknown, source: string): CatalogCacheFile | null {
  if (!isObject(value)
    || value.schema !== 1
    || value.source !== source
    || typeof value.checkedAt !== 'number'
    || typeof value.attemptedAt !== 'number'
    || !isSnapshot(value.active)
    || (value.pending !== undefined && !isSnapshot(value.pending))) return null
  return value as unknown as CatalogCacheFile
}

function sameRegistry(left: Registry, right: Registry): boolean {
  if (left.updated !== right.updated || left.count !== right.count) return false
  return JSON.stringify(left) === JSON.stringify(right)
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

type FetchResult =
  | { kind: 'not-modified' }
  | { kind: 'data'; snapshot: CatalogSnapshot }

/**
 * Create one catalog store for one profile. The cache belongs to the profile
 * because a Desktop installation can host more than one isolated profile.
 */
export function createCatalogStore(
  profileDirectory?: string,
  options: CatalogStoreOptions = {},
): CatalogStore {
  const source = options.sourceUrl ?? process.env.DSHM_REGISTRY_URL ?? DEFAULT_REGISTRY_URL
  const cachePath = options.cachePath === undefined
    ? (profileDirectory === undefined ? null : join(profileDirectory, '.dsh-market', CACHE_FILE))
    : options.cachePath
  const interval = options.checkIntervalMs ?? CATALOG_CHECK_INTERVAL_MS
  const fetcher = options.fetcher ?? marketFetch
  const now = options.now ?? Date.now

  let cache: CatalogCacheFile | null = null
  let loadedFromDisk = false
  let loading: Promise<Registry> | null = null
  let checking = false
  let checkPromise: Promise<CatalogStatus> | null = null
  let lastError: string | null = null

  const status = (): CatalogStatus => ({
    checking,
    updateAvailable: cache?.pending !== undefined,
    activeUpdated: cache?.active.data.updated ?? null,
    pendingUpdated: cache?.pending?.data.updated ?? null,
    lastCheckedAt: cache === null || cache.checkedAt <= 0 ? null : new Date(cache.checkedAt).toISOString(),
    error: lastError,
  })

  async function persist(strict = false): Promise<void> {
    if (cachePath === null || cache === null) return
    try {
      await writeFileAtomic(cachePath, `${JSON.stringify(cache)}\n`)
    } catch (error) {
      lastError = `catalog cache could not be saved: ${error instanceof Error ? error.message : String(error)}`
      if (strict) throw error
    }
  }

  async function readCached(): Promise<CatalogCacheFile | null> {
    if (loadedFromDisk || cachePath === null) return null
    loadedFromDisk = true
    try {
      return parseCache(JSON.parse(await readFile(cachePath, 'utf8')) as unknown, source)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        lastError = `catalog cache could not be read: ${error instanceof Error ? error.message : String(error)}`
      }
      return null
    }
  }

  async function fetchRemote(validator?: CatalogSnapshot): Promise<FetchResult> {
    const started = now()
    let last: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const headers: Record<string, string> = {}
        if (validator?.etag != null) headers['if-none-match'] = validator.etag
        else if (validator?.modified != null) headers['if-modified-since'] = validator.modified
        const response = await fetcher(source, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers,
        })
        if (response.status === 304) {
          if (validator === undefined) throw new Error('the catalog answered "not modified" without a validator')
          return { kind: 'not-modified' }
        }
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        const data = (await response.json()) as unknown
        if (!isRegistry(data)) throw new Error('the catalog came back empty or malformed')
        return {
          kind: 'data',
          snapshot: {
            etag: response.headers.get('etag'),
            modified: response.headers.get('last-modified'),
            fetchedAt: now(),
            data,
          },
        }
      } catch (error) {
        last = error
      }
    }
    throw new Error(describeFetchFailure(last, now() - started))
  }

  async function load(): Promise<Registry> {
    if (cache !== null) return cache.active.data
    if (loading !== null) return await loading
    loading = (async () => {
      const disk = await readCached()
      if (disk !== null) {
        cache = disk
        return disk.active.data
      }

      const remote = await fetchRemote()
      if (remote.kind !== 'data') throw new Error('the first catalog fetch returned no data')
      const timestamp = now()
      cache = {
        schema: 1,
        source,
        checkedAt: timestamp,
        attemptedAt: timestamp,
        active: remote.snapshot,
      }
      lastError = null
      await persist()
      return remote.snapshot.data
    })()
    try {
      return await loading
    } finally {
      loading = null
    }
  }

  function startCheck(force: boolean): Promise<CatalogStatus> {
    if (cache === null) return Promise.resolve(status())
    if (checkPromise !== null) return checkPromise
    const timestamp = now()
    if (!force && timestamp - cache.attemptedAt < interval) return Promise.resolve(status())

    checking = true
    cache.attemptedAt = timestamp
    checkPromise = (async () => {
      try {
        const validator = cache!.pending ?? cache!.active
        const remote = await fetchRemote(validator)
        cache!.checkedAt = now()
        if (remote.kind === 'data') {
          if (sameRegistry(remote.snapshot.data, cache!.active.data)) {
            cache!.active = remote.snapshot
            delete cache!.pending
          } else {
            cache!.pending = remote.snapshot
          }
        }
        lastError = null
        await persist()
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        await persist()
      } finally {
        checking = false
        checkPromise = null
      }
      return status()
    })()
    return checkPromise
  }

  function scheduleCheck(): void {
    if (cache === null) return
    void startCheck(false)
  }

  async function checkForUpdate(force = true): Promise<CatalogStatus> {
    await load()
    return await startCheck(force)
  }

  async function applyUpdate(): Promise<Registry | null> {
    await load()
    // A persisted pending update can be revalidated as soon as the market
    // opens. Let that check finish before promoting it so the two atomic
    // writes cannot race and resurrect an older cache document on disk.
    if (checkPromise !== null) await checkPromise
    if (cache?.pending === undefined) return null
    const before = cache
    cache = {
      ...cache,
      active: cache.pending,
    }
    delete cache.pending
    lastError = null
    try {
      await persist(true)
    } catch (error) {
      cache = before
      throw error
    }
    return cache.active.data
  }

  return { load, scheduleCheck, checkForUpdate, applyUpdate, status }
}

/** Compatibility entry point for consumers that do not own a profile path. */
let defaultStore = createCatalogStore()

export function loadRegistry(): Promise<Registry> {
  return defaultStore.load()
}

/** Reset the compatibility store between tests. */
export function forgetCatalog(): void {
  defaultStore = createCatalogStore()
}

/** Describe a catalog failure with enough network context for exported logs. */
export function describeFetchFailure(error: unknown, elapsedMs: number): string {
  const reason = error instanceof Error ? error.message : String(error)
  const proxy = configuredProxy()
  const parts = [`${reason} (${String(Math.round(elapsedMs / 1000))}s, 2 attempts)`]
  if (proxy !== null) {
    parts.push(`tried through the configured proxy ${proxy.replace(/\/\/[^@]*@/u, '//***@')}`)
  }
  return parts.join(' · ')
}
