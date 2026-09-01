import { useEffect, useRef, useState } from 'react'
import {
  IconLoadingOutline16,
  IconSparkle16,
  IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './locales.ts'
import styles from './VerifierControl.module.css'

interface VerifierProjection {
  active: boolean
  pending: boolean
}

interface UsageTotal {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  complete: boolean
}

type ProgressStatus =
  | 'idle'
  | 'generating'
  | 'scoring-ring'
  | 'scoring-pivots'
  | 'replaying'
  | 'complete'
  | 'error'
  | 'cancelled'

interface CandidateTiming {
  index: number
  startedAt: number
  firstTokenAt?: number
  endedAt?: number
  usage?: UsageTotal
}

interface ComparisonTiming {
  index: number
  stage: 'scoring-ring' | 'scoring-pivots'
  pair: [number, number]
  startedAt: number
  responseAt?: number
  endedAt?: number
  usage?: UsageTotal
}

interface RunTiming {
  startedAt: number | null
  generationEndedAt?: number
  scoringStartedAt?: number
  scoringEndedAt?: number
  replayStartedAt?: number
  replayFirstTokenAt?: number
  replayEndedAt?: number
  endedAt?: number
  candidates: CandidateTiming[]
  comparisons: ComparisonTiming[]
}

interface VerifierProgress {
  runId: string | null
  status: ProgressStatus
  candidateCount: 3
  candidatesCompleted: number
  comparisonsTotal: 5
  comparisonsCompleted: number
  winner?: number
  error?: { code: string; message: string }
  usage: { candidates: UsageTotal; verifier: UsageTotal }
  timing: RunTiming
}

interface CommonProps {
  sessionId: string
  useProjection(key: 'verifier'): VerifierProjection | undefined
  t: Translate
}

interface ToggleProps extends CommonProps {
  setEnabled(enabled: boolean): Promise<string | null>
}

function effectiveMode(projection: VerifierProjection | undefined): boolean {
  return projection === undefined
    ? false
    : projection.pending ? !projection.active : projection.active
}

export function VerifierToggle({ useProjection, setEnabled, t }: ToggleProps) {
  const projection = useProjection('verifier')
  const active = effectiveMode(projection)
  const [requesting, setRequesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  if (projection === undefined) return null

  const toggle = () => {
    setRequesting(true)
    setError(null)
    setEnabled(!active).then(failure => {
      if (!alive.current) return
      setRequesting(false)
      setError(failure)
    }, reason => {
      if (!alive.current) return
      setRequesting(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  const title = error ?? (active ? t('toggleOn') : t('toggleOff'))
  return (
    <span className={styles.toggleWrap}>
      <button
        type="button"
        className={`${styles.toggle} ${error === null ? '' : styles.toggleError}`}
        data-active={active}
        aria-pressed={active}
        aria-label={title}
        title={title}
        disabled={projection.pending || requesting}
        onClick={toggle}
      >
        {projection.pending || requesting
          ? <span className={styles.spin} aria-hidden="true"><IconLoadingOutline16 size={14} /></span>
          : <IconSparkle16 size={14} />}
        <span>{t('toggle')}</span>
      </button>
    </span>
  )
}

function totalTokens(usage: UsageTotal): number {
  return usage.inputTokens
    + usage.outputTokens
    + usage.cacheReadTokens
    + usage.cacheWriteTokens
}

function progressLabel(status: ProgressStatus, t: Translate): string {
  if (status === 'generating') return t('generating')
  if (status === 'scoring-ring') return t('scoringRing')
  if (status === 'scoring-pivots') return t('scoringPivots')
  if (status === 'replaying') return t('replaying')
  if (status === 'complete') return t('complete')
  if (status === 'cancelled') return t('cancelled')
  return t('failed')
}

function elapsed(startedAt: number | null | undefined, endedAt: number | undefined): number | null {
  if (startedAt === null || startedAt === undefined || endedAt === undefined) return null
  return Math.max(0, endedAt - startedAt)
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`
  const seconds = durationMs / 1_000
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  const wholeSeconds = Math.round(seconds)
  const minutes = Math.floor(wholeSeconds / 60)
  const remainder = wholeSeconds % 60
  return `${minutes}m${remainder.toString().padStart(2, '0')}s`
}

function averageCandidateTtft(candidates: readonly CandidateTiming[]): number | null {
  const durations = candidates
    .map(candidate => elapsed(candidate.startedAt, candidate.firstTokenAt))
    .filter((duration): duration is number => duration !== null)
  if (durations.length === 0) return null
  return durations.reduce((sum, duration) => sum + duration, 0) / durations.length
}

function candidateThroughput(candidates: readonly CandidateTiming[]): number | null {
  let outputTokens = 0
  let decodeMs = 0
  for (const candidate of candidates) {
    const duration = elapsed(candidate.firstTokenAt, candidate.endedAt)
    if (duration === null || duration === 0 || candidate.usage === undefined) continue
    outputTokens += candidate.usage.outputTokens
    decodeMs += duration
  }
  return decodeMs > 0 ? outputTokens / (decodeMs / 1_000) : null
}

function formatThroughput(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1)
}

export function VerifierProgress({ sessionId, useProjection, t }: CommonProps) {
  const projection = useProjection('verifier')
  const active = effectiveMode(projection)
  const [progress, setProgress] = useState<VerifierProgress | null>(null)
  const [transportError, setTransportError] = useState(false)

  useEffect(() => {
    if (!active) {
      setProgress(null)
      setTransportError(false)
      return
    }
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const poll = async () => {
      try {
        const response = await fetch(`/dsh-desktop-verifier/state?sessionId=${encodeURIComponent(sessionId)}`, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const next = await response.json() as VerifierProgress
        if (!stopped) {
          setProgress(next)
          setTransportError(false)
        }
      } catch (error) {
        if (!stopped && !(error instanceof DOMException && error.name === 'AbortError')) {
          setTransportError(true)
        }
      } finally {
        if (!stopped) timer = setTimeout(poll, 750)
      }
    }
    void poll()
    return () => {
      stopped = true
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [active, sessionId])

  if (!active) return null
  if (transportError && (progress === null || progress.status === 'idle')) {
    return (
      <div className={styles.dock} data-tone="error" role="status">
        <span className={styles.dockIcon} aria-hidden="true"><IconWarningOutline16 size={15} /></span>
        <span className={styles.stage}>{t('progressUnavailable')}</span>
      </div>
    )
  }
  if (progress === null || progress.status === 'idle') return null

  const running = progress.status === 'generating'
    || progress.status === 'scoring-ring'
    || progress.status === 'scoring-pivots'
    || progress.status === 'replaying'
  const failed = progress.status === 'error' || progress.status === 'cancelled'
  const candidateTokens = totalTokens(progress.usage.candidates)
  const verifierTokens = totalTokens(progress.usage.verifier)
  const usageComplete = progress.usage.candidates.complete && progress.usage.verifier.complete
  const now = progress.timing.endedAt ?? Date.now()
  const totalMs = elapsed(progress.timing.startedAt, now)
  const generationEnd = progress.timing.generationEndedAt
    ?? (progress.status === 'generating' ? now : undefined)
  const generationMs = elapsed(progress.timing.startedAt, generationEnd)
  const scoringEnd = progress.timing.scoringEndedAt
    ?? (progress.timing.scoringStartedAt !== undefined && (progress.status === 'scoring-ring' || progress.status === 'scoring-pivots') ? now : undefined)
  const scoringMs = elapsed(progress.timing.scoringStartedAt, scoringEnd)
  const replayEnd = progress.timing.replayEndedAt
    ?? (progress.status === 'replaying' ? now : undefined)
  const replayMs = elapsed(progress.timing.replayStartedAt, replayEnd)
  const candidateTtftMs = averageCandidateTtft(progress.timing.candidates)
  const candidateTokensPerSecond = candidateThroughput(progress.timing.candidates)
  return (
    <div
      className={styles.dock}
      data-tone={failed ? 'error' : progress.status === 'complete' ? 'success' : 'neutral'}
      role="status"
      aria-live="polite"
      title={progress.error === undefined ? undefined : `${progress.error.code}: ${progress.error.message}`}
    >
      <span className={`${styles.dockIcon} ${running ? styles.spin : ''}`} aria-hidden="true">
        {failed ? <IconWarningOutline16 size={15} /> : running ? <IconLoadingOutline16 size={15} /> : <IconSparkle16 size={15} />}
      </span>
      <span className={styles.dockCopy}>
        <span className={styles.stage}>{progressLabel(progress.status, t)}</span>
        <span className={styles.metric}>{t('candidateProgress')} {progress.candidatesCompleted}/{progress.candidateCount}</span>
        <span className={styles.metric}>{t('comparisonProgress')} {progress.comparisonsCompleted}/{progress.comparisonsTotal}</span>
        {totalMs !== null && <span className={styles.metric}>{t('totalDuration')} {formatDuration(totalMs)}</span>}
        {generationMs !== null && <span className={styles.metric}>{t('generationDuration')} {formatDuration(generationMs)}</span>}
        {scoringMs !== null && <span className={styles.metric}>{t('scoringDuration')} {formatDuration(scoringMs)}</span>}
        {replayMs !== null && <span className={styles.metric}>{t('replayDuration')} {formatDuration(replayMs)}</span>}
        {candidateTtftMs !== null && <span className={styles.metric}>{t('candidateTtft')} {formatDuration(candidateTtftMs)}</span>}
        {candidateTokensPerSecond !== null && <span className={styles.metric}>{t('candidateThroughput')} {formatThroughput(candidateTokensPerSecond)} tok/s</span>}
        <span className={styles.metric}>{t('extraUsage')} {candidateTokens + verifierTokens} {t('tokens')}</span>
        {!usageComplete && <span className={styles.detail}>{t('usageIncomplete')}</span>}
        {progress.error !== undefined && <span className={styles.detail}>{progress.error.message}</span>}
        {(progress.status === 'replaying' || progress.status === 'complete') && (
          <span className={styles.note}>{t('sessionStatsReplayNote')}</span>
        )}
      </span>
    </div>
  )
}
