/**
 * dsh-market client: registers a "Market" settings section rendering the
 * plugin market UI, plus the post-install toast in the shell overlay layer.
 * Built by tsdown into the __ModuleLoader__ factory bundle at
 * client/client.js; the only externals are the loader module table's react
 * entries.
 */
import { createElement as h } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { en, zh } from './locales.ts'
import { InstallToast } from './InstallToast.tsx'
import {
  MarketSection,
  type MarketPrimaryView,
  type MarketViewMeta,
} from './MarketSection.tsx'
import { SettingsCard } from './SettingsCard.tsx'
import type { ThemeSnapshot, Translate } from './market-data.ts'

const NS = 'dsh-market'

/**
 * Primitives this bundle relies on that did not exist before rc.6. The
 * primitives module is host-injected (external at build time), so on an
 * older host the module resolves but these named exports are undefined —
 * rendering would throw and blank the whole settings dialog. Returning the
 * gaps lets apply() skip registration for a clean downgrade instead.
 */
export const REQUIRED_PRIMITIVES = ['Menu', 'DisclosureRow', 'Tooltip', 'Toast'] as const

export function missingPrimitives(mod: Record<string, unknown>, required: readonly string[] = REQUIRED_PRIMITIVES): string[] {
  return required.filter(name => mod[name] === undefined)
}

/**
 * The host surface the settings card needs, present only on rc.7+.
 *
 * The card no longer reads or writes settings — it manages the market's own
 * package — but `settingsScope` stays as the INJECTION KEY, because its
 * presence is what distinguishes a host that has the plugin configuration
 * page from one that does not. The market's namespace (registered in
 * settings.ts) is likewise still required: the page dispatches a card keyed
 * by a namespace it serves, so dropping it would take the card with it.
 */
interface SettingsScopeHost {
  slots: {
    inject(name: string, register: () => unknown): void
    register(options: Record<string, unknown>, render: () => unknown): unknown
  }
}

/** The subset of the theme service this plugin touches. */
interface ThemeService {
  getTheme(): ThemeSnapshot | null
  setTheme(id: string): void
}

/** The subset of the locale service this plugin touches. */
interface LocaleService {
  register(namespace: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): unknown
  bind(namespace: string): Translate
  subscribe(callback: () => void): () => void
  getSnapshot(): { active: string }
}

/** The subset of the slots service this plugin touches. */
interface SlotsService {
  inject(slot: string, register: () => unknown): void
  register(meta: Record<string, unknown>, component: (props: Record<string, unknown>) => unknown): unknown
}

interface MarketTabOwnerProps {
  view?: MarketPrimaryView
  selectView?(view: MarketPrimaryView): void
  updateView?(view: MarketPrimaryView, meta: MarketViewMeta): void
}

interface MarketSettingsView {
  id: MarketPrimaryView
  order: number
  label: () => string
}

type MarketTabComponent = ((props?: MarketTabOwnerProps) => unknown) & {
  settingsPluginViews: readonly MarketSettingsView[]
}

/** The client cordis context shape this plugin relies on (structural: the
 * host provides the real Context; typing the touched surface keeps this
 * external package free of monorepo-internal type dependencies). */
interface MarketClientContext {
  effect(callback: () => unknown, label?: string): void
  on(event: string, callback: () => void): () => void
  locale: LocaleService
  slots: SlotsService
  theme: ThemeService
}

export const name = 'dsh-market'
// 'theme' is safe to require: ui-layout (mandatory in every web composition)
// already hard-depends on it. This cordis's object-form inject means
// intercept config, NOT {required,optional} — do not use it here.
export const inject = ['slots', 'locale', 'theme']
export function apply(ctx: MarketClientContext): void {
  // Older hosts resolve the primitives module but lack the rc.6 exports the
  // market renders with. Skip registration (market simply absent from the
  // settings list) rather than throwing mid-render and blanking the dialog.
  const gaps = missingPrimitives(primitives as unknown as Record<string, unknown>)
  if (gaps.length > 0) {
    console.warn('[dsh-market] host ui-primitives missing ' + gaps.join(', ') + ' — market section disabled (dsh web >= 0.1.0-rc.6 required)')
    return
  }

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-market: dictionaries')
  const t = ctx.locale.bind(NS)
  // This package is only shipped by DSH Desktop. Keep one stable placement
  // even if the preload bridge is temporarily unavailable during recovery.
  const embedded = true

  // Kept so the removal flow can retire the market's own nav entry the
  // moment the package is gone: leaving "插件市场" in the left menu after
  // the user removed it is the card claiming something the profile no
  // longer agrees with. `register` hands back its own disposer; calling it
  // twice (here and again when the context unwinds) is harmless, but the
  // reference is dropped after use so the intent stays readable.
  let retireSection: (() => void) | null = null

  const renderMarket = Object.assign(
    (owner: MarketTabOwnerProps = {}) => h(MarketSection, {
        t,
        locale: ctx.locale,
        theme: ctx.theme,
        embedded,
        view: owner.view,
        onViewChange: owner.selectView,
        onViewMetaChange: owner.updateView,
        themeStore: {
          subscribe: (cb: () => void) => ctx.on('theme/change', cb),
          getSnapshot: () => ctx.theme.getTheme(),
        },
    }),
    {
      // SlotCore deliberately keeps only generic list metadata. Grouped view
      // projection is presentation metadata, so it travels with the component
      // that owns those views instead of being smuggled through register options.
      settingsPluginViews: [
        { id: 'discover', order: 20, label: () => t('tabDiscover') },
        { id: 'themes', order: 30, label: () => t('tabThemes') },
        { id: 'installed', order: 40, label: () => t('tabInstalled') },
        { id: 'advanced', order: 50, label: () => t('tabAdvanced') },
      ] satisfies readonly MarketSettingsView[],
    },
  ) satisfies MarketTabComponent

  if (embedded) {
    ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
      name: 'settings.plugins.tab',
      id: 'market',
      order: 20,
      label: () => t('tabDiscover'),
      locale: NS,
      inject: () => ({ t }),
    }, renderMarket as (props: Record<string, unknown>) => unknown))
  } else {
    ctx.slots.inject('settings.section', () => {
      const off = ctx.slots.register({
        name: 'settings.section',
        id: 'market',
        order: 40,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ t }),
      }, renderMarket as (props: Record<string, unknown>) => unknown)
      if (typeof off === 'function') retireSection = off as () => void
      return off
    })
  }

  // The settings card (dsh >= 0.1.0-rc.7). Registered through a NESTED
  // inject on purpose: naming settingsScope in the module-level `inject`
  // would keep this whole plugin unmounted on any host without that
  // service — the market's own page would vanish on rc.6 to gain a card
  // rc.6 cannot render. Nested, the card simply never appears there.
  if (!embedded) {
    const settingsCtx = ctx as unknown as {
      inject(services: string[], callback: (scoped: SettingsScopeHost) => void): void
    }
    settingsCtx.inject(['settingsScope'], (scoped) => {
      scoped.slots.inject('settings.plugin.item', () => scoped.slots.register({
        name: 'settings.plugin.item',
        key: NS,
        locale: NS,
        inject: () => ({ t }),
      }, () => h(SettingsCard, { t, onRemoved: () => { const off = retireSection; retireSection = null; off?.() } })))
    })
  }

  const Toast = () => h(InstallToast, { t })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-market-toast',
    label: () => 'dsh-market',
  }, Toast))
}
