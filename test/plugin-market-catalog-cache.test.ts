import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCatalogStore,
  type Registry,
} from '../packages/dsh-desktop-market/src/registry'

const directories: string[] = []

function registry(updated: string, name: string): Registry {
  return {
    updated,
    count: 1,
    categories: { tools: { en: 'Tools', zh: '工具' } },
    plugins: [{
      name,
      owner: 'example',
      url: `https://github.com/example/${name}`,
      category: 'tools',
      description: { en: name },
      install: `github:example/${name}`,
      added: updated,
    }],
  }
}

function response(data: Registry, etag: string): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json', etag },
  })
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('plugin market catalog cache', () => {
  it('downloads once, then starts from the profile cache without touching the network', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-catalog-'))
    directories.push(directory)
    const cachePath = join(directory, 'catalog.json')
    const active = registry('2026-08-21', 'first-plugin')
    const firstFetch = vi.fn(async () => response(active, '"v1"'))

    const first = createCatalogStore(undefined, {
      sourceUrl: 'https://catalog.test/plugins.json',
      cachePath,
      fetcher: firstFetch,
      now: () => 1_000,
    })
    expect(await first.load()).toEqual(active)
    expect(firstFetch).toHaveBeenCalledTimes(1)

    const offlineFetch = vi.fn(async () => { throw new Error('offline') })
    const reopened = createCatalogStore(undefined, {
      sourceUrl: 'https://catalog.test/plugins.json',
      cachePath,
      fetcher: offlineFetch,
      now: () => 2_000,
    })
    expect(await reopened.load()).toEqual(active)
    reopened.scheduleCheck()
    await Promise.resolve()
    expect(offlineFetch).not.toHaveBeenCalled()
  })

  it('stages a remote change until the user applies it', async () => {
    const active = registry('2026-08-21', 'first-plugin')
    const next = registry('2026-08-22', 'second-plugin')
    let timestamp = 1_000
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(active, '"v1"'))
      .mockResolvedValueOnce(response(next, '"v2"'))
    const store = createCatalogStore(undefined, {
      sourceUrl: 'https://catalog.test/plugins.json',
      cachePath: null,
      checkIntervalMs: 1,
      fetcher,
      now: () => timestamp,
    })

    expect(await store.load()).toEqual(active)
    timestamp = 2_000
    store.scheduleCheck()
    expect(store.status().checking).toBe(true)
    expect(await store.load()).toEqual(active)
    expect(await store.checkForUpdate(false)).toMatchObject({
      checking: false,
      updateAvailable: true,
      activeUpdated: '2026-08-21',
      pendingUpdated: '2026-08-22',
    })
    expect(await store.load()).toEqual(active)
    expect(await store.applyUpdate()).toEqual(next)
    expect(store.status()).toMatchObject({
      updateAvailable: false,
      activeUpdated: '2026-08-22',
      pendingUpdated: null,
    })
    expect(fetcher.mock.calls[1]?.[1]?.headers).toEqual({ 'if-none-match': '"v1"' })
  })
})
