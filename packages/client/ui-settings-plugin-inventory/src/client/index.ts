/** Profile plugin center and managed Harness source Settings contributions. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { PluginInventorySettingsTab, type PluginInventorySettingsTabInjected } from './PluginInventorySettingsTab.tsx'
import { SourceEvolutionSettingsTab, type SourceEvolutionSettingsTabInjected } from './SourceEvolutionSettingsTab.tsx'
import { en, zh, type PluginInventoryLocaleKey } from './locales.ts'

export type { PluginInventorySettingsTabInjected, PluginInventorySettingsTabProps } from './PluginInventorySettingsTab.tsx'
export type { SourceEvolutionSettingsTabInjected, SourceEvolutionSettingsTabProps } from './SourceEvolutionSettingsTab.tsx'
export type { PluginInventoryLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Plugin center and managed source copy. */
    'settings.pluginInventory': PluginInventoryLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.pluginInventory'

/** Services required by the Settings registrations and generated Remote faces. */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginInventory', 'remote.evolution']

type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

async function unwrap<T>(operation: string, pending: Promise<RemoteResult<T>>): Promise<T> {
  const result = await pending
  if (!result.ok) throw new Error(`${operation} failed: ${result.error.code}: ${result.error.message}`)
  return result.value
}

/** Contribute the plugin center and source-management tabs to Plugins settings. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-plugin-inventory: dictionaries')

  const t = ctx.locale.bind(NS)
  const centerInjected = (): PluginInventorySettingsTabInjected => ({
    listProfile: async () => unwrap('evolution.pluginsList', ctx.remote.evolution.pluginsList()),
    listRuntime: async () => unwrap('pluginInventory.list', ctx.remote.pluginInventory.list()),
    install: async spec => unwrap('evolution.pluginsInstall', ctx.remote.evolution.pluginsInstall(spec)),
    update: async packageName => unwrap('evolution.pluginsUpdate', ctx.remote.evolution.pluginsUpdate(packageName)),
    remove: async packageName => unwrap('evolution.pluginsRemove', ctx.remote.evolution.pluginsRemove(packageName)),
    reloadClient: () => { globalThis.location.reload() },
  })
  const sourceInjected = (): SourceEvolutionSettingsTabInjected => ({
    inspect: async () => unwrap('evolution.sourceInspect', ctx.remote.evolution.sourceInspect()),
    initialize: async () => unwrap('evolution.sourceInitialize', ctx.remote.evolution.sourceInitialize()),
    fetchOfficial: async () => unwrap('evolution.sourceFetchOfficial', ctx.remote.evolution.sourceFetchOfficial()),
    updateOfficial: async strategy => unwrap('evolution.sourceUpdateOfficial', ctx.remote.evolution.sourceUpdateOfficial(strategy)),
    configureUserRemote: async url => unwrap('evolution.sourceConfigureUserRemote', ctx.remote.evolution.sourceConfigureUserRemote(url)),
    pushUser: async branch => unwrap('evolution.sourcePushUser', ctx.remote.evolution.sourcePushUser(branch)),
  })

  ctx.slots.inject('settings.plugins.tab', () => {
    const stopCenter = ctx.slots.register({
      name: 'settings.plugins.tab',
      id: 'center',
      order: 10,
      label: () => t('centerTab'),
      locale: NS,
      inject: centerInjected,
    }, PluginInventorySettingsTab)
    const stopSource = ctx.slots.register({
      name: 'settings.plugins.tab',
      id: 'source',
      order: 20,
      label: () => t('sourceTab'),
      locale: NS,
      inject: sourceInjected,
    }, SourceEvolutionSettingsTab)
    return () => {
      stopSource()
      stopCenter()
    }
  })
}
