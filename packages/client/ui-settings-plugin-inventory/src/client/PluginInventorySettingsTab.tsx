import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import type {
  PluginInventorySnapshot,
  ProfilePluginMutationReceipt,
  ProfilePluginsSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconChevronDownOutline14,
  IconSearchOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginInventoryLocaleKey } from './locales.ts'
import css from './PluginInventorySettingsTab.module.css'

/** Registration-side Remote face used by the plugin center. */
export interface PluginInventorySettingsTabInjected {
  /** Read the active profile package graph. */
  listProfile: () => Promise<ProfilePluginsSnapshot>
  /** Read the current Host Loader inventory. */
  listRuntime: () => Promise<PluginInventorySnapshot>
  /** Install one package spec into the active profile. */
  install: (spec: string) => Promise<ProfilePluginMutationReceipt>
  /** Update one mutable profile dependency. */
  update: (packageName: string) => Promise<ProfilePluginMutationReceipt>
  /** Remove one mutable profile dependency. */
  remove: (packageName: string) => Promise<ProfilePluginMutationReceipt>
  /** Reload the renderer after Host profile recomposition. */
  reloadClient: () => void
}

type PluginInventoryEntry = PluginInventorySnapshot['entries'][number]
type PluginFiberPhase = PluginInventoryEntry['fiberPhase']

/** Full component props assembled by the Settings slot renderer. */
export type PluginInventorySettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginInventory'>
  & InjectFace<PluginInventorySettingsTabInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | {
    readonly status: 'ready'
    readonly profile: ProfilePluginsSnapshot
    readonly runtime: PluginInventorySnapshot
  }

type Mutation = 'install' | `update:${string}` | `remove:${string}`

const PHASE_KEYS = {
  pending: 'pending',
  loading: 'loadingPhase',
  active: 'active',
  failed: 'failed',
  unloading: 'unloading',
} satisfies Record<Exclude<PluginFiberPhase, null>, PluginInventoryLocaleKey>

const KIND_KEYS = {
  'system-bundle': 'systemBundle',
  'extension-bundle': 'extensionBundle',
  library: 'library',
} as const satisfies Record<ProfilePluginsSnapshot['entries'][number]['kind'], PluginInventoryLocaleKey>

/** Localized accessible label for one root Fiber phase. */
function phaseLabel(
  phase: PluginFiberPhase,
  t: PluginInventorySettingsTabProps['t'],
): string {
  return phase === null ? t('unobserved') : t(PHASE_KEYS[phase])
}

/** Compact a module specifier without guessing whether its Loader id was generated. */
function moduleShortName(moduleName: string): string {
  const unscoped = moduleName.startsWith('@') ? moduleName.slice(moduleName.indexOf('/') + 1) : moduleName
  return unscoped
    .replace(/^cordis:/, '')
    .replace(/^cordis-plugin-/, '')
    .replace(/^dsh-(?:host-|client-)?/, '')
}

function matchesRuntime(entry: PluginInventoryEntry, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) return true
  return [entry.moduleName, entry.entryId]
    .some(value => value.toLocaleLowerCase().includes(normalizedQuery))
}

function matchesProfile(entry: ProfilePluginsSnapshot['entries'][number], normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) return true
  return [entry.packageName, entry.requestedSpec ?? '', entry.installedVersion ?? '']
    .some(value => value.toLocaleLowerCase().includes(normalizedQuery))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Render profile package management and the current Loader inventory. */
export function PluginInventorySettingsTab({
  listProfile,
  listRuntime,
  install,
  update,
  remove,
  reloadClient,
  t,
}: PluginInventorySettingsTabProps): ReactNode {
  const catalogId = useId()
  const [request, setRequest] = useState(0)
  const [query, setQuery] = useState('')
  const [installSpec, setInstallSpec] = useState('')
  const [expanded, setExpanded] = useState<PluginInventoryEntry['entryId'] | null>(null)
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null)
  const [mutation, setMutation] = useState<Mutation | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [state, setState] = useState<ViewState>({ status: 'loading' })

  useEffect(() => {
    let current = true
    void Promise.resolve().then(async () => Promise.all([listProfile(), listRuntime()])).then(
      ([profile, runtime]) => { if (current) setState({ status: 'ready', profile, runtime }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [listProfile, listRuntime, request])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredRuntime = useMemo(
    () => state.status === 'ready'
      ? state.runtime.entries.filter(entry => matchesRuntime(entry, normalizedQuery))
      : [],
    [normalizedQuery, state],
  )
  const filteredProfile = useMemo(
    () => state.status === 'ready'
      ? state.profile.entries.filter(entry => matchesProfile(entry, normalizedQuery))
      : [],
    [normalizedQuery, state],
  )

  useEffect(() => {
    if (expanded !== null && !filteredRuntime.some(entry => entry.entryId === expanded)) {
      setExpanded(null)
    }
  }, [expanded, filteredRuntime])

  const retry = (): void => {
    setState({ status: 'loading' })
    setRequest(value => value + 1)
  }

  const mutate = async (
    kind: Mutation,
    operation: () => Promise<ProfilePluginMutationReceipt>,
  ): Promise<void> => {
    setMutation(kind)
    setMutationError(null)
    setNotice(null)
    try {
      const receipt = await operation()
      setState(current => current.status === 'ready'
        ? { ...current, profile: receipt.plugins }
        : current)
      setNotice(t('reloading'))
      reloadClient()
    } catch (error) {
      setMutationError(errorMessage(error))
    } finally {
      setMutation(null)
    }
  }

  const submitInstall = (event: FormEvent): void => {
    event.preventDefault()
    const spec = installSpec.trim()
    if (spec.length === 0 || mutation !== null) return
    void mutate('install', async () => install(spec))
  }

  return (
    <div className={css.section} data-plugin-center aria-busy={state.status === 'loading' || mutation !== null}>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <>
          <section className={css.panel} aria-labelledby={`${catalogId}-install`}>
            <div className={css.panelHeading}>
              <div>
                <h3 id={`${catalogId}-install`}>{t('installTitle')}</h3>
                <p>{t('installDescription')}</p>
              </div>
            </div>
            <form className={css.inlineForm} onSubmit={submitInstall}>
              <label className={css.fieldGrow}>
                <span>{t('installSpec')}</span>
                <input
                  value={installSpec}
                  placeholder={t('installPlaceholder')}
                  disabled={mutation !== null}
                  onChange={(event) => { setInstallSpec(event.currentTarget.value) }}
                />
              </label>
              <button className={css.primaryButton} type="submit" disabled={mutation !== null || installSpec.trim().length === 0}>
                {mutation === 'install' ? t('installing') : t('install')}
              </button>
            </form>
            {mutationError !== null ? <p className={css.inlineError} role="alert">{mutationError}</p> : null}
            {notice !== null ? <p className={css.notice} role="status">{notice}</p> : null}
          </section>

          <section className={css.panel} aria-labelledby={`${catalogId}-profile`}>
            <div className={css.panelHeading}>
              <div>
                <h3 id={`${catalogId}-profile`}>{t('profileTitle')}</h3>
                <p><strong>{t('profile')}:</strong> {state.profile.profile}</p>
              </div>
              <code title={state.profile.profileDir}>{state.profile.profileDir}</code>
            </div>
            {state.profile.entries.length === 0 ? <p className={css.status}>{t('extensionEmpty')}</p> : (
              <div className={css.tableFrame}>
                <table className={css.packageTable}>
                  <thead>
                    <tr>
                      <th>{t('packageName')}</th>
                      <th>{t('packageRole')}</th>
                      <th>{t('packageVersion')}</th>
                      <th>{t('packageRequest')}</th>
                      <th className={css.actionHeading}>{t('packageActions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredProfile.map(entry => (
                      <tr key={entry.packageName} data-package={entry.packageName}>
                        <td>
                          <strong>{entry.packageName}</strong>
                          <span className={css.rowTags}>
                            <span data-active={entry.active ? 'true' : 'false'}>{t(entry.active ? 'activeTag' : 'inactiveTag')}</span>
                            <span>{t(entry.mutable ? 'managedTag' : 'protectedTag')}</span>
                          </span>
                        </td>
                        <td>{t(KIND_KEYS[entry.kind])}</td>
                        <td><code>{entry.installedVersion ?? '—'}</code></td>
                        <td><code className={css.specValue}>{entry.requestedSpec ?? '—'}</code></td>
                        <td>
                          {entry.mutable ? (
                            <div className={css.rowActions}>
                              <button
                                type="button"
                                disabled={mutation !== null}
                                onClick={() => { void mutate(`update:${entry.packageName}`, async () => update(entry.packageName)) }}
                              >
                                {mutation === `update:${entry.packageName}` ? t('updating') : t('update')}
                              </button>
                              {confirmingRemove === entry.packageName ? (
                                <>
                                  <button
                                    className={css.dangerButton}
                                    type="button"
                                    disabled={mutation !== null}
                                    onClick={() => { void mutate(`remove:${entry.packageName}`, async () => remove(entry.packageName)) }}
                                  >
                                    {mutation === `remove:${entry.packageName}` ? t('removing') : t('confirmRemove')}
                                  </button>
                                  <button type="button" disabled={mutation !== null} onClick={() => { setConfirmingRemove(null) }}>
                                    {t('cancel')}
                                  </button>
                                </>
                              ) : (
                                <button type="button" disabled={mutation !== null} onClick={() => { setConfirmingRemove(entry.packageName) }}>
                                  {t('remove')}
                                </button>
                              )}
                            </div>
                          ) : <span className={css.muted}>—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className={css.panel} aria-labelledby={`${catalogId}-runtime`}>
            <div className={css.panelHeading}>
              <div>
                <h3 id={`${catalogId}-runtime`}>{t('runtimeTitle')}</h3>
                <p>{t('runtimeDescription')}</p>
              </div>
              <span className={css.count} data-plugin-count={filteredRuntime.length}>{filteredRuntime.length}</span>
            </div>
            <label className={css.search}>
              <IconSearchOutline16 aria-hidden="true" />
              <span className={css.visuallyHidden}>{t('search')}</span>
              <input
                type="search"
                value={query}
                placeholder={t('search')}
                aria-label={t('search')}
                onChange={(event) => { setQuery(event.currentTarget.value) }}
              />
            </label>
            {state.runtime.entries.length === 0 ? <p className={css.status}>{t('runtimeEmpty')}</p> : null}
            {state.runtime.entries.length > 0 && filteredRuntime.length === 0
              ? <p className={css.status}>{t('emptySearch')}</p>
              : null}
            {filteredRuntime.length > 0 ? (
              <ul className={css.cards}>
                {filteredRuntime.map((entry) => {
                  const status = phaseLabel(entry.fiberPhase, t)
                  const title = moduleShortName(entry.moduleName)
                  const configuration = t(entry.enabled ? 'enabledTag' : 'disabledTag')
                  const open = expanded === entry.entryId
                  const detailId = `${catalogId}-details-${encodeURIComponent(entry.entryId)}`
                  return (
                    <li
                      className={css.card}
                      key={entry.entryId}
                      data-plugin-entry={entry.entryId}
                      data-open={open ? 'true' : undefined}
                    >
                      <button
                        className={css.cardContent}
                        type="button"
                        aria-expanded={open}
                        aria-controls={detailId}
                        aria-label={entry.enabled ? `${title}, ${status}, ${configuration}` : `${title}, ${configuration}`}
                        onClick={() => { setExpanded(current => current === entry.entryId ? null : entry.entryId) }}
                      >
                        <strong className={css.cardTitle} title={entry.moduleName}>{title}</strong>
                        <span className={css.cardTrailing}>
                          {entry.enabled ? (
                            <span
                              className={css.statusDot}
                              data-phase={entry.fiberPhase ?? 'unobserved'}
                              role="img"
                              aria-label={status}
                              title={status}
                            />
                          ) : null}
                          <span className={css.configTag} data-enabled={entry.enabled ? 'true' : 'false'}>{configuration}</span>
                          <IconChevronDownOutline14 className={css.chevron} size={12} aria-hidden="true" />
                        </span>
                      </button>
                      {open ? (
                        <div className={css.cardDetails} id={detailId}>
                          <code className={css.entryValue} data-loader-entry>{entry.entryId}</code>
                          <dl className={css.details}>
                            <div><dt>{t('configuration')}</dt><dd>{configuration}</dd></div>
                            {entry.enabled ? <div><dt>{t('cordis')}</dt><dd>{status}</dd></div> : null}
                          </dl>
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  )
}
