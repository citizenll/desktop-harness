// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import { PluginInventorySettingsTab } from '../src/client/PluginInventorySettingsTab.tsx'
import type { PluginInventorySettingsTabInjected } from '../src/client/PluginInventorySettingsTab.tsx'
import { SourceEvolutionSettingsTab } from '../src/client/SourceEvolutionSettingsTab.tsx'
import type { SourceEvolutionSettingsTabInjected } from '../src/client/SourceEvolutionSettingsTab.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

const EMPTY_RUNTIME = { entries: [] }
const EMPTY_PROFILE = { profile: 'web', profileDir: 'C:\\profile', entries: [] }
const MISSING_SOURCE = {
  state: 'missing' as const,
  root: 'C:\\source',
  capsuleAvailable: true,
  official: { name: 'upstream', url: 'https://github.com/deepseek-ai/deepseek-harness.git', branch: 'master' },
}
type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  const runtimeList = vi.fn<() => Promise<Result<typeof EMPTY_RUNTIME>>>()
    .mockResolvedValue({ ok: true, value: EMPTY_RUNTIME })
  const profileList = vi.fn<() => Promise<Result<typeof EMPTY_PROFILE>>>()
    .mockResolvedValue({ ok: true, value: EMPTY_PROFILE })
  const sourceInspect = vi.fn<() => Promise<Result<typeof MISSING_SOURCE>>>()
    .mockResolvedValue({ ok: true, value: MISSING_SOURCE })
  const mutation = vi.fn().mockResolvedValue({
    ok: false,
    error: { code: 'NOT_CALLED', message: 'fixture mutation was not configured' },
  })
  ctx.provide('remote.pluginInventory', { list: runtimeList })
  ctx.provide('remote.evolution', {
    pluginsList: profileList,
    pluginsInstall: mutation,
    pluginsUpdate: mutation,
    pluginsRemove: mutation,
    sourceInspect,
    sourceInitialize: mutation,
    sourceFetchOfficial: mutation,
    sourceUpdateOfficial: mutation,
    sourceConfigureUserRemote: mutation,
    sourcePushUser: mutation,
  })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, runtimeList, profileList, sourceInspect }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-plugin-inventory browser plugin', () => {
  it('declares the Loader and evolution Remote namespaces it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.pluginInventory', 'remote.evolution'])
  })

  it('registers localized plugin-center and source tabs without eager reads', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entries = b.slots.entries('settings.plugins.tab')
    expect(entries).toHaveLength(2)
    expect(entries[0]!.component).toBe(PluginInventorySettingsTab)
    expect(entries[0]!.options).toMatchObject({ id: 'center', order: 10 })
    expect(entries[1]!.component).toBe(SourceEvolutionSettingsTab)
    expect(entries[1]!.options).toMatchObject({ id: 'source', order: 20 })
    expect(entries.every(entry => entry.locale === NS)).toBe(true)
    expect(entries.map(entry => resolveSlotLabel(entry.options.label))).toEqual(['插件中心', '源码与更新'])
    expect(b.runtimeList).not.toHaveBeenCalled()
    expect(b.profileList).not.toHaveBeenCalled()
    expect(b.sourceInspect).not.toHaveBeenCalled()

    const center = (entries[0]!.inject as unknown as () => PluginInventorySettingsTabInjected)()
    await expect(center.listRuntime()).resolves.toEqual(EMPTY_RUNTIME)
    await expect(center.listProfile()).resolves.toEqual(EMPTY_PROFILE)
    const source = (entries[1]!.inject as unknown as () => SourceEvolutionSettingsTabInjected)()
    await expect(source.inspect()).resolves.toEqual(MISSING_SOURCE)
    b.profileList.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'unavailable' } })
    await expect(center.listProfile()).rejects.toThrow('evolution.pluginsList failed: REMOTE_ERROR: unavailable')
    await b.ctx.fiber.dispose()
  })

  it('follows locale and recovers both tabs across declarer reload', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)

    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.plugins.tab')).toHaveLength(2) })
    b.locale.setLocale('en')
    expect(b.slots.entries('settings.plugins.tab').map(entry => resolveSlotLabel(entry.options.label)))
      .toEqual(['Plugin center', 'Source & updates'])

    stop()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.plugins.tab')).toHaveLength(2) })

    await fiber.dispose()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    expect(() => b.locale.register(NS, 'zh', {})).not.toThrow()
    await b.ctx.fiber.dispose()
  })
})
