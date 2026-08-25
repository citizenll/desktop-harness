import { useEffect, useRef } from 'react'
import type { InstallOutputLine, MarketStatus, Translate } from './market-data.ts'
import css from './DirectInstallDialog.module.css'

function phaseLabel(phase: NonNullable<MarketStatus['phase']>, t: Translate): string {
  if (phase === 'resolving') return t('phaseResolving')
  if (phase === 'downloading') return t('phaseDownloading')
  if (phase === 'linking') return t('phaseLinking')
  return t('phaseBuilding')
}

function compactPackage(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  const packageName = normalized.split('/node_modules/').pop() ?? normalized
  return packageName.length <= 84 ? packageName : `…${packageName.slice(-83)}`
}

function liveStatus(status: MarketStatus | null, t: Translate): string {
  if (status?.cancelling === true) return t('cancelling')
  if (status?.active === true && status.phase != null) {
    const count = typeof status.done === 'number' && status.done > 0
      ? ` · ${String(status.done)}`
      : ''
    const percent = typeof status.downloaded === 'number'
      && typeof status.size === 'number'
      && status.size > 0
      ? ` · ${String(Math.max(0, Math.min(100, Math.round(status.downloaded / status.size * 100))))}%`
      : ''
    const current = typeof status.currentPackage === 'string' && status.currentPackage !== ''
      ? ` · ${compactPackage(status.currentPackage)}`
      : ''
    return `${phaseLabel(status.phase, t)}${count}${percent}${current}`
  }
  if (status?.busy === true) return t('directInstallConsoleFinalizing')
  return t('directInstallConsolePreparing')
}

function promptFor(stream: InstallOutputLine['stream']): string {
  if (stream === 'command') return '$'
  if (stream === 'stderr') return '!'
  if (stream === 'system') return '›'
  return '·'
}

export function InstallTerminal({
  lines,
  status,
  state,
  t,
}: {
  lines: InstallOutputLine[]
  status: MarketStatus | null
  state: 'active' | 'complete' | 'stopped'
  t: Translate
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const active = state === 'active'

  useEffect(() => {
    const body = bodyRef.current
    if (body !== null) body.scrollTop = body.scrollHeight
  }, [lines])

  const current = active
    ? liveStatus(status, t)
    : state === 'complete'
      ? t('directInstallConsoleDone')
      : t('directInstallConsoleStopped')
  const stateLabel = active
    ? t('directInstallConsoleLive')
    : state === 'complete'
      ? t('directInstallConsoleDone')
      : t('directInstallConsoleStopped')

  return (
    <section className={css.terminal} aria-label={t('directInstallConsoleTitle')}>
      <div className={css.terminalBar}>
        <span className={css.terminalLights} aria-hidden="true">
          <i data-light="red" />
          <i data-light="yellow" />
          <i data-light="green" />
        </span>
        <span className={css.terminalTitle}>{t('directInstallConsoleTitle')}</span>
        <span className={active ? css.terminalLive : css.terminalIdle}>
          <i aria-hidden="true" />
          {stateLabel}
        </span>
      </div>
      <div ref={bodyRef} className={css.terminalBody} role="log" aria-live="off">
        {lines.length === 0 && (
          <div className={css.terminalEmpty}>{t('directInstallConsoleWaiting')}</div>
        )}
        {lines.map(line => (
          <div key={line.id} className={css.terminalLine} data-stream={line.stream}>
            <span className={css.terminalPrompt} aria-hidden="true">{promptFor(line.stream)}</span>
            <span>{line.text}</span>
          </div>
        ))}
        <div className={css.terminalCurrent}>
          <span className={css.terminalPrompt} aria-hidden="true">›</span>
          <span className={css.terminalCurrentText}>{current}</span>
          {active && <span className={css.terminalCursor} aria-hidden="true" />}
        </div>
      </div>
    </section>
  )
}
