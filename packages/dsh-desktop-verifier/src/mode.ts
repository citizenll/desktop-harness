import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-commands'
import type { VerifierProjection, VerifierProjectionState } from './types.js'

export const INITIAL_VERIFIER_STATE: VerifierProjectionState = Object.freeze({
  active: false,
  running: null,
})

export function parseVerifierTarget(raw: string | undefined): boolean | undefined {
  const value = raw?.trim()
  if (value === 'on') return true
  if (value === 'off') return false
  return undefined
}

export function applyVerifierEvent(
  state: VerifierProjectionState,
  event: SessionEvent,
): VerifierProjectionState {
  if (event.type === 'command/run' && event.data.name === 'verify') {
    const wanted = parseVerifierTarget(event.data.args)
    if (wanted === undefined) return state
    return {
      ...state,
      running: {
        commandId: event.data.commandId,
        wanted,
      },
    }
  }

  if (event.type === 'command/done' && event.data.commandId === state.running?.commandId) {
    return {
      active: event.data.kind === 'success' ? state.running.wanted : state.active,
      running: null,
    }
  }

  return state
}

export function foldVerifierState(events: readonly SessionEvent[]): VerifierProjectionState {
  let state = INITIAL_VERIFIER_STATE
  for (const event of events) state = applyVerifierEvent(state, event)
  return state
}

export function verifierProjection(state: VerifierProjectionState): VerifierProjection {
  return {
    active: state.active,
    pending: state.running !== null && state.running.wanted !== state.active,
  }
}

export function foldVerifierMode(events: readonly SessionEvent[]): boolean {
  return foldVerifierState(events).active
}
