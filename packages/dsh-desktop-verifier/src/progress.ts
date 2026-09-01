import type { UsageTotal } from './usage.js'
import { emptyUsage } from './usage.js'

export type VerifierProgressStatus =
  | 'idle'
  | 'generating'
  | 'scoring-ring'
  | 'scoring-pivots'
  | 'replaying'
  | 'complete'
  | 'error'
  | 'cancelled'

export interface CandidateTiming {
  index: number
  startedAt: number
  firstTokenAt?: number
  endedAt?: number
  usage?: UsageTotal
}

export interface ComparisonTiming {
  index: number
  stage: 'scoring-ring' | 'scoring-pivots'
  pair: [number, number]
  startedAt: number
  responseAt?: number
  endedAt?: number
  usage?: UsageTotal
}

export interface VerifierRunTiming {
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

export interface VerifierProgressState {
  runId: string | null
  status: VerifierProgressStatus
  candidateCount: 3
  candidatesCompleted: number
  comparisonsTotal: 5
  comparisonsCompleted: number
  winner?: number
  error?: {
    code: string
    message: string
  }
  usage: {
    candidates: UsageTotal
    verifier: UsageTotal
  }
  timing: VerifierRunTiming
  updatedAt: number
}

export function idleProgress(now = Date.now()): VerifierProgressState {
  return {
    runId: null,
    status: 'idle',
    candidateCount: 3,
    candidatesCompleted: 0,
    comparisonsTotal: 5,
    comparisonsCompleted: 0,
    usage: {
      candidates: emptyUsage(),
      verifier: emptyUsage(),
    },
    timing: {
      startedAt: null,
      candidates: [],
      comparisons: [],
    },
    updatedAt: now,
  }
}

export class VerifierProgressStore {
  private readonly states = new Map<string, VerifierProgressState>()
  private sequence = 0

  constructor(private readonly now: () => number = Date.now) {}

  start(sessionId: string): VerifierProgressState {
    const startedAt = this.now()
    const state: VerifierProgressState = {
      ...idleProgress(startedAt),
      runId: `${startedAt.toString(36)}-${(++this.sequence).toString(36)}`,
      status: 'generating',
      timing: {
        startedAt,
        candidates: [],
        comparisons: [],
      },
    }
    this.states.set(sessionId, state)
    return state
  }

  read(sessionId: string): VerifierProgressState {
    return this.states.get(sessionId) ?? idleProgress(this.now())
  }

  update(
    sessionId: string,
    runId: string,
    update: (current: VerifierProgressState) => VerifierProgressState,
  ): void {
    const current = this.states.get(sessionId)
    if (current?.runId !== runId) return
    this.states.set(sessionId, { ...update(current), updatedAt: this.now() })
  }

  clear(sessionId: string): void {
    this.states.delete(sessionId)
  }
}
