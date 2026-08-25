/**
 * Dedicated external-source installation flow.
 *
 * Protocol, loopback-hash and Desktop CLI requests land here instead of
 * being translated into a market search. The user confirms the exact source,
 * then the host reuses the market's guarded install engine without consulting
 * or navigating the catalog.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  IconCheckOutline16,
  IconLinkOutline14,
  IconLoadingOutline16,
  IconWarningOutline16,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InstallOutputLine, MarketStatus, Translate } from './market-data.ts'
import { InstallTerminal } from './InstallTerminal.tsx'
import {
  normalizePluginInstallSource,
  PLUGIN_INSTALL_EVENT,
  takePendingPluginInstallRequest,
} from './plugin-install-request.ts'
import css from './DirectInstallDialog.module.css'

type Phase = 'confirm' | 'installing' | 'blocked' | 'success' | 'error'

interface InstallResponse {
  ok?: boolean
  cancelled?: boolean
  hot?: boolean
  addedPackages?: unknown
  compatibility?: { code?: unknown }
  prebuiltFallback?: boolean
  ignoredBuilds?: unknown
  error?: unknown
  stderr?: unknown
  stdout?: unknown
  exitCode?: unknown
}

function createInstallRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `install-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`
}

async function readInstallProgress(requestId: string): Promise<MarketStatus | null> {
  const response = await fetch('/dsh-market/install-progress', { cache: 'no-store' })
  if (!response.ok) return null
  const status = await response.json() as MarketStatus
  return status.outputSession === requestId ? status : null
}

function updateTerminalLines(
  current: InstallOutputLine[],
  next: InstallOutputLine[],
): InstallOutputLine[] {
  const currentLast = current[current.length - 1]?.id
  const nextLast = next[next.length - 1]?.id
  return current.length === next.length && currentLast === nextLast ? current : next
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'text' in value && typeof (value as { text?: unknown }).text === 'string') {
    return (value as { text: string }).text
  }
  return value == null ? '' : JSON.stringify(value)
}

function failureText(body: InstallResponse, status: number): string {
  const direct = asText(body.error).trim()
  if (direct !== '') return direct.slice(-800)
  const output = [asText(body.stderr), asText(body.stdout)].filter(Boolean).join('\n').trim()
  if (output !== '') return output.slice(-800)
  return `HTTP ${String(status)}${body.exitCode == null ? '' : ` · exit ${String(body.exitCode)}`}`
}

export function DirectInstallDialog({ t }: { t: Translate }) {
  const [source, setSource] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('confirm')
  const [message, setMessage] = useState('')
  const [builds, setBuilds] = useState<string[]>([])
  const [allowBuildScripts, setAllowBuildScripts] = useState(true)
  const [progressRequestId, setProgressRequestId] = useState<string | null>(null)
  const [installStatus, setInstallStatus] = useState<MarketStatus | null>(null)
  const [terminalLines, setTerminalLines] = useState<InstallOutputLine[]>([])

  const openRequest = useCallback((nextSource: string) => {
    setSource(nextSource)
    setPhase('confirm')
    setMessage('')
    setBuilds([])
    setAllowBuildScripts(true)
    setProgressRequestId(null)
    setInstallStatus(null)
    setTerminalLines([])
  }, [])

  useEffect(() => {
    const pending = takePendingPluginInstallRequest()
    if (pending) openRequest(pending)

    const onRequest = (event: Event): void => {
      const nextSource = normalizePluginInstallSource(
        (event as CustomEvent<{ source?: unknown }>).detail?.source,
      )
      if (!nextSource) return
      // Clear the cold-start fallback now that the live request was consumed.
      takePendingPluginInstallRequest()
      openRequest(nextSource)
    }
    window.addEventListener(PLUGIN_INSTALL_EVENT, onRequest)
    return () => window.removeEventListener(PLUGIN_INSTALL_EVENT, onRequest)
  }, [openRequest])

  const close = useCallback(() => {
    if (phase === 'installing') return
    setSource(null)
  }, [phase])

  useEffect(() => {
    if (phase !== 'installing' || progressRequestId === null) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async (): Promise<void> => {
      try {
        const status = await readInstallProgress(progressRequestId)
        if (!stopped && status !== null) {
          setInstallStatus(status)
          if (Array.isArray(status.output)) {
            setTerminalLines(current => updateTerminalLines(current, status.output!))
          }
        }
      } catch {
        // The POST remains authoritative. A missed local status poll should
        // not turn an otherwise healthy installation into an error state.
      }
      if (!stopped) timer = setTimeout(() => { void poll() }, 300)
    }

    void poll()
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [phase, progressRequestId])

  const install = useCallback(async (requestedSource: string, previouslyApproved: string[] = []) => {
    const requestId = createInstallRequestId()
    setPhase('installing')
    setMessage('')
    setBuilds([])
    setProgressRequestId(requestId)
    setInstallStatus(null)
    setTerminalLines([])
    try {
      const response = await fetch('/dsh-market/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: requestedSource, allowBuildScripts, requestId }),
      })
      const body = await response.json().catch(() => ({})) as InstallResponse
      try {
        const status = await readInstallProgress(requestId)
        if (status !== null) {
          setInstallStatus(status)
          if (Array.isArray(status.output)) {
            setTerminalLines(current => updateTerminalLines(current, status.output!))
          }
        }
      } catch { /* final progress is helpful but not authoritative */ }
      if (body.cancelled === true) {
        setPhase('error')
        setMessage(t('cancelled'))
        return
      }
      if (response.ok && body.ok === true) {
        const packages = Array.isArray(body.addedPackages)
          ? body.addedPackages.filter((name): name is string => typeof name === 'string')
          : []
        const prefix = packages.length > 0 ? `${packages.join(', ')} · ` : ''
        const result = body.hot === true ? t('directInstallReady') : t('directInstallRestart')
        const warning = body.compatibility?.code === 'soft-incompatible'
          ? `\n${t('compatRiskBanner')}`
          : ''
        const prebuilt = body.prebuiltFallback === true
          ? `\n${t('directInstallPrebuiltFallback')}`
          : ''
        setMessage(`${prefix}${result}${prebuilt}${warning}`)
        setPhase('success')
        return
      }
      if (Array.isArray(body.ignoredBuilds) && body.ignoredBuilds.length > 0) {
        const nextBuilds = body.ignoredBuilds.map(String)
        if (previouslyApproved.length > 0 && nextBuilds.every(name => previouslyApproved.includes(name))) {
          const detail = failureText(body, response.status)
          setMessage(`${t('buildApprovalStillBlocked')}${detail === '' ? '' : `\n${detail}`}`)
          setPhase('error')
          return
        }
        setBuilds(nextBuilds)
        setMessage(failureText(body, response.status))
        setPhase('blocked')
        return
      }
      setMessage(failureText(body, response.status))
      setPhase('error')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
      setPhase('error')
    }
  }, [allowBuildScripts, t])

  const approveAndRetry = useCallback(async () => {
    if (source === null || builds.length === 0) return
    setPhase('installing')
    setMessage('')
    setProgressRequestId(null)
    setInstallStatus(null)
    setTerminalLines([])
    try {
      const response = await fetch('/dsh-market/approve-builds', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ packages: builds, source }),
      })
      const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: unknown }
      if (!response.ok || body.ok !== true) {
        setMessage(asText(body.error) || `HTTP ${String(response.status)}`)
        setPhase('error')
        return
      }
      await install(source, builds)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
      setPhase('error')
    }
  }, [builds, install, source])

  const cancelInstall = useCallback(() => {
    void fetch('/dsh-market/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).catch(() => {})
  }, [])

  if (source === null) return null

  const footer = phase === 'confirm'
    ? (
        <>
          <Button variant="ghost" onClick={close}>{t('cancel')}</Button>
          <Button variant="primary" onClick={() => void install(source)}>{t('install')}</Button>
        </>
      )
    : phase === 'installing'
      ? (
          <>
            <Button variant="ghost" onClick={cancelInstall}>{t('cancelOp')}</Button>
            <Button variant="primary" disabled>{t('installing')}</Button>
          </>
        )
      : phase === 'blocked'
        ? (
            <>
              <Button variant="ghost" onClick={close}>{t('cancel')}</Button>
              <Button variant="primary" onClick={() => void approveAndRetry()}>{t('approveBuilds')}</Button>
            </>
          )
        : phase === 'success'
          ? <Button variant="primary" onClick={close}>{t('dismiss')}</Button>
          : (
              <>
                <Button variant="ghost" onClick={close}>{t('cancel')}</Button>
                <Button variant="primary" onClick={() => void install(source)}>{t('opRetry')}</Button>
              </>
            )

  return (
    <Modal
      open
      onClose={close}
      title={t('directInstallTitle')}
      description={t('directInstallIntro')}
      footer={footer}
      className={css.dialog}
      contentClassName={css.modalContent}
    >
      <div className={css.stack}>
        <div className={css.sourceCard}>
          <div className={css.sourceLabel}>
            <IconLinkOutline14 size={14} />
            {t('directInstallSource')}
          </div>
          <code className={css.source}>{source}</code>
        </div>

        {phase === 'confirm' && (
          <>
            <div className={css.buildOption}>
              <div className={css.buildOptionCopy}>
                <b>{t('directInstallBuildScripts')}</b>
                <span>{t('directInstallBuildScriptsHint')}</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={allowBuildScripts}
                aria-label={t('directInstallBuildScripts')}
                className={allowBuildScripts ? `${css.switch} ${css.switchOn}` : css.switch}
                onClick={() => setAllowBuildScripts(value => !value)}
              >
                <span className={css.switchKnob} />
              </button>
            </div>
            <div className={css.notice}>
              <IconWarningOutline16 size={16} className={css.warningIcon} />
              <span className={css.noticeCopy}>
                {allowBuildScripts ? t('directInstallBuildScriptsWarn') : t('confirmWarn')}
              </span>
            </div>
          </>
        )}
        {phase === 'installing' && (
          <div className={css.installProgress}>
            <div className={css.status}>
              <IconLoadingOutline16 size={16} className={css.spinning} />
              <span>{t('directInstallWorking')}</span>
            </div>
            <InstallTerminal
              lines={terminalLines}
              status={installStatus}
              state="active"
              t={t}
            />
          </div>
        )}
        {phase !== 'confirm' && phase !== 'installing' && terminalLines.length > 0 && (
          <InstallTerminal
            lines={terminalLines}
            status={installStatus}
            state={phase === 'success' ? 'complete' : 'stopped'}
            t={t}
          />
        )}
        {phase === 'blocked' && (
          <div className={css.result} data-tone="warning">
            <IconWarningOutline16 size={16} />
            <div>
              <b>{t('buildsSkipped')}</b>
              <div className={css.detail}>{builds.join(', ')}</div>
              {message !== '' && <div className={css.detail}>{message}</div>}
            </div>
          </div>
        )}
        {phase === 'success' && (
          <div className={css.result} data-tone="success">
            <IconCheckOutline16 size={16} />
            <div className={css.detail}>{message}</div>
          </div>
        )}
        {phase === 'error' && (
          <div className={css.result} data-tone="error">
            <IconWarningOutline16 size={16} />
            <div>
              <b>{t('installFail')}</b>
              <div className={css.detail}>{message}</div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
