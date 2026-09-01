import type {} from '@deepseek-ai/dsh-session-projection/types'

export interface VerifierProjection {
  active: boolean
  pending: boolean
}

export interface VerifierProjectionState {
  active: boolean
  running: {
    commandId: string
    wanted: boolean
  } | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    verifier: VerifierProjection
  }

  interface SessionProjectionStateMap {
    verifier: VerifierProjectionState
  }
}
