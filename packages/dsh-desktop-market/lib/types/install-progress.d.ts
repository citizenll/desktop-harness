/**
 * Bounded, display-safe process output for the direct plugin installer.
 *
 * pnpm's ndjson reporter is ideal for machine progress, but rendering the
 * raw stream would flood the dialog with JSON and can expose credentials
 * embedded in URLs or environment-shaped diagnostics. This module keeps the
 * useful lifecycle/build output, drops high-frequency telemetry, sanitizes
 * every visible line, and caps memory independently of command duration.
 */
import type { InstallOutputCandidate, InstallOutputLine, InstallOutputStream } from './install-progress-types.ts';
export type { InstallOutputCandidate, InstallOutputLine, InstallOutputStream, } from './install-progress-types.ts';
/** Remove terminal control codes and common secret shapes from one line. */
export declare function sanitizeInstallOutput(text: string, home?: string): string;
/**
 * Convert one stdout/stderr line into zero or more terminal lines.
 * High-volume pnpm resolution/fetch ticks return an empty array: their live
 * counters are rendered separately from the structured status snapshot.
 */
export declare function installOutputCandidates(rawLine: string, fallbackStream: 'stdout' | 'stderr'): InstallOutputCandidate[];
/** Mutable bounded buffer owned by the process layer's current operation. */
export declare class InstallOutputBuffer {
    private lines;
    private nextId;
    private charCount;
    clear(): void;
    push(stream: InstallOutputStream, text: string): void;
    snapshot(): InstallOutputLine[];
}
