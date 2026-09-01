import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { VerifierProjection, VerifierProjectionState } from './types.js';
export declare const INITIAL_VERIFIER_STATE: VerifierProjectionState;
export declare function parseVerifierTarget(raw: string | undefined): boolean | undefined;
export declare function applyVerifierEvent(state: VerifierProjectionState, event: SessionEvent): VerifierProjectionState;
export declare function foldVerifierState(events: readonly SessionEvent[]): VerifierProjectionState;
export declare function verifierProjection(state: VerifierProjectionState): VerifierProjection;
export declare function foldVerifierMode(events: readonly SessionEvent[]): boolean;
