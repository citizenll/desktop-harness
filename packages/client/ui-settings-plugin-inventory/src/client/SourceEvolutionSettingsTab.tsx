import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import type {
  SourceRepositoryMutationReceipt,
  SourceRepositorySnapshot,
  SourceUpdateStrategy,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './PluginInventorySettingsTab.module.css'

/** Registration-side Remote face used by managed source controls. */
export interface SourceEvolutionSettingsTabInjected {
  inspect: () => Promise<SourceRepositorySnapshot>
  initialize: () => Promise<SourceRepositoryMutationReceipt>
  fetchOfficial: () => Promise<SourceRepositoryMutationReceipt>
  updateOfficial: (strategy: SourceUpdateStrategy) => Promise<SourceRepositoryMutationReceipt>
  configureUserRemote: (url: string) => Promise<SourceRepositoryMutationReceipt>
  pushUser: (branch: string | null) => Promise<SourceRepositoryMutationReceipt>
}

/** Full component props assembled by the Settings slot renderer. */
export type SourceEvolutionSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginInventory'>
  & InjectFace<SourceEvolutionSettingsTabInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly detail: string }
  | { readonly status: 'ready'; readonly snapshot: SourceRepositorySnapshot }

type Action = 'initialize' | 'fetch' | 'update' | 'remote' | 'push'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Render official update and user-repository publishing controls. */
export function SourceEvolutionSettingsTab({
  inspect,
  initialize,
  fetchOfficial,
  updateOfficial,
  configureUserRemote,
  pushUser,
  t,
}: SourceEvolutionSettingsTabProps): ReactNode {
  const sectionId = useId()
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [action, setAction] = useState<Action | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [strategy, setStrategy] = useState<SourceUpdateStrategy>('merge')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [destinationBranch, setDestinationBranch] = useState('')

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => inspect()).then(
      (snapshot) => {
        if (!current) return
        setState({ status: 'ready', snapshot })
        if (snapshot.state === 'ready' && snapshot.user !== null) setRemoteUrl(snapshot.user.url)
      },
      (error: unknown) => { if (current) setState({ status: 'error', detail: errorMessage(error) }) },
    )
    return () => { current = false }
  }, [inspect, request])

  const retry = (): void => {
    setState({ status: 'loading' })
    setRequest(value => value + 1)
  }

  const mutate = async (
    kind: Action,
    operation: () => Promise<SourceRepositoryMutationReceipt>,
  ): Promise<void> => {
    setAction(kind)
    setActionError(null)
    setNotice(null)
    try {
      const receipt = await operation()
      setState({ status: 'ready', snapshot: receipt.repository })
      setNotice(t('actionComplete'))
    } catch (error) {
      setActionError(errorMessage(error))
    } finally {
      setAction(null)
    }
  }

  const submitRemote = (event: FormEvent): void => {
    event.preventDefault()
    const url = remoteUrl.trim()
    if (url.length === 0 || action !== null) return
    void mutate('remote', async () => configureUserRemote(url))
  }

  const submitPush = (event: FormEvent): void => {
    event.preventDefault()
    if (action !== null) return
    const branch = destinationBranch.trim()
    void mutate('push', async () => pushUser(branch.length === 0 ? null : branch))
  }

  return (
    <div className={css.section} data-source-evolution aria-busy={state.status === 'loading' || action !== null}>
      <p className={css.lede}>{t('sourceIntro')}</p>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.errorPanel}>
          <p role="alert">{t('error')}</p>
          <code>{state.detail}</code>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {state.status === 'ready' && state.snapshot.state === 'missing' ? (
        <section className={css.panel}>
          <div className={css.panelHeading}>
            <div>
              <h3>{t('sourceMissingTitle')}</h3>
              <p>{t(state.snapshot.capsuleAvailable ? 'sourceMissingCapsule' : 'sourceMissingClone')}</p>
            </div>
          </div>
          <dl className={css.sourceLedger}>
            <div><dt>{t('workspace')}</dt><dd><code>{state.snapshot.root}</code></dd></div>
            <div><dt>{t('officialRemote')}</dt><dd><code>{state.snapshot.official.url}</code></dd></div>
          </dl>
          <button className={css.primaryButton} type="button" disabled={action !== null} onClick={() => { void mutate('initialize', initialize) }}>
            {action === 'initialize' ? t('initializing') : t('initialize')}
          </button>
        </section>
      ) : null}
      {state.status === 'ready' && state.snapshot.state === 'invalid' ? (
        <section className={`${css.panel} ${css.blockedPanel}`}>
          <div className={css.panelHeading}>
            <div>
              <h3>{t('sourceInvalidTitle')}</h3>
              <p>{t('sourceInvalidDescription')}</p>
            </div>
          </div>
          <code>{state.snapshot.root}</code>
        </section>
      ) : null}
      {state.status === 'ready' && state.snapshot.state === 'ready' ? (() => {
        const snapshot = state.snapshot
        const blocked = !snapshot.clean || snapshot.operation !== null || snapshot.branch === null
        const divergence = snapshot.ahead === null || snapshot.behind === null
          ? t('unknown')
          : `${String(snapshot.ahead)} ${t('ahead')} / ${String(snapshot.behind)} ${t('behind')}`
        return (
          <>
            <section className={css.panel} aria-labelledby={`${sectionId}-workspace`}>
              <div className={css.panelHeading}>
                <div>
                  <h3 id={`${sectionId}-workspace`}>{t('workspace')}</h3>
                  <p><code>{snapshot.root}</code></p>
                </div>
                <span className={css.stateBadge} data-clean={snapshot.clean ? 'true' : 'false'}>{t(snapshot.clean ? 'clean' : 'dirty')}</span>
              </div>
              <dl className={css.sourceLedger}>
                <div><dt>{t('branch')}</dt><dd><code>{snapshot.branch ?? t('detached')}</code></dd></div>
                <div><dt>{t('commit')}</dt><dd><code title={snapshot.head}>{snapshot.head.slice(0, 12)}</code></dd></div>
                <div><dt>{t('operation')}</dt><dd>{snapshot.operation ?? t('noOperation')}</dd></div>
                <div><dt>{t('divergence')}</dt><dd>{divergence}</dd></div>
                <div><dt>{t('officialRemote')}</dt><dd><code>{snapshot.official.url}</code></dd></div>
                <div><dt>{t('userRemote')}</dt><dd><code>{snapshot.user?.url ?? t('notConfigured')}</code></dd></div>
              </dl>
              <div className={css.updateBar}>
                <button type="button" disabled={action !== null} onClick={() => { void mutate('fetch', fetchOfficial) }}>
                  {action === 'fetch' ? t('fetching') : t('fetch')}
                </button>
                <label>
                  <span>{t('strategy')}</span>
                  <select
                    value={strategy}
                    disabled={action !== null}
                    onChange={(event) => { setStrategy(event.currentTarget.value as SourceUpdateStrategy) }}
                  >
                    <option value="ff-only">{t('fastForwardOnly')}</option>
                    <option value="merge">{t('mergeCommit')}</option>
                  </select>
                </label>
                <button className={css.primaryButton} type="button" disabled={action !== null || blocked} onClick={() => { void mutate('update', async () => updateOfficial(strategy)) }}>
                  {action === 'update' ? t('updatingSource') : t('updateSource')}
                </button>
              </div>
              {blocked ? <p className={css.caution}>{t('sourceBlocked')}</p> : null}
            </section>

            <section className={css.panel} aria-labelledby={`${sectionId}-remote`}>
              <div className={css.panelHeading}>
                <div>
                  <h3 id={`${sectionId}-remote`}>{t('configureRemoteTitle')}</h3>
                  <p>{t('configureRemoteDescription')}</p>
                </div>
              </div>
              <form className={css.inlineForm} onSubmit={submitRemote}>
                <label className={css.fieldGrow}>
                  <span>{t('remoteUrl')}</span>
                  <input value={remoteUrl} placeholder={t('remotePlaceholder')} disabled={action !== null} onChange={(event) => { setRemoteUrl(event.currentTarget.value) }} />
                </label>
                <button type="submit" disabled={action !== null || remoteUrl.trim().length === 0}>
                  {action === 'remote' ? t('savingRemote') : t('saveRemote')}
                </button>
              </form>
            </section>

            <section className={css.panel} aria-labelledby={`${sectionId}-push`}>
              <div className={css.panelHeading}>
                <div>
                  <h3 id={`${sectionId}-push`}>{t('pushTitle')}</h3>
                  <p>{t('pushDescription')}</p>
                </div>
              </div>
              <form className={css.inlineForm} onSubmit={submitPush}>
                <label className={css.fieldGrow}>
                  <span>{t('destinationBranch')}</span>
                  <input value={destinationBranch} placeholder={t('destinationPlaceholder')} disabled={action !== null} onChange={(event) => { setDestinationBranch(event.currentTarget.value) }} />
                </label>
                <button className={css.primaryButton} type="submit" disabled={action !== null || blocked || snapshot.user === null}>
                  {action === 'push' ? t('pushing') : t('push')}
                </button>
              </form>
            </section>

            {actionError !== null ? <p className={css.inlineError} role="alert">{actionError}</p> : null}
            {notice !== null ? <p className={css.notice} role="status">{notice}</p> : null}
            <p className={css.runtimeNote}>{t('runtimeUnchanged')}</p>
          </>
        )
      })() : null}
    </div>
  )
}
