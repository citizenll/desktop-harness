/**
 * Bounded, display-safe process output for the direct plugin installer.
 *
 * pnpm's ndjson reporter is ideal for machine progress, but rendering the
 * raw stream would flood the dialog with JSON and can expose credentials
 * embedded in URLs or environment-shaped diagnostics. This module keeps the
 * useful lifecycle/build output, drops high-frequency telemetry, sanitizes
 * every visible line, and caps memory independently of command duration.
 */

import { homedir } from 'node:os'
import type {
  InstallOutputCandidate,
  InstallOutputLine,
  InstallOutputStream,
} from './install-progress-types.ts'
export type {
  InstallOutputCandidate,
  InstallOutputLine,
  InstallOutputStream,
} from './install-progress-types.ts'

const MAX_LINES = 160
const MAX_CHARS = 32 * 1024
const MAX_LINE_CHARS = 720

// CSI/OSC escape sequences plus stray C0 controls. Tabs are normalized to
// spaces below; newlines are split by InstallOutputBuffer before sanitizing.
const ANSI_ESCAPE = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/g

/** Remove terminal control codes and common secret shapes from one line. */
export function sanitizeInstallOutput(text: string, home = homedir()): string {
  let safe = text
    .replace(ANSI_ESCAPE, '')
    .replace(/\t/g, '  ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')

  if (home !== '') {
    safe = safe
      .replaceAll(home, '~')
      .replaceAll(home.replaceAll('\\', '/'), '~')
  }

  return safe
    // Credentials embedded in a registry/repository URL.
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1***@')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/([?&](?:access_token|auth|key|password|token)=)[^&#\s]+/gi, '$1***')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, 'gh*_***')
    .replace(/npm_[A-Za-z0-9]{16,}/g, 'npm_***')
    .replace(/bearer\s+\S+/gi, 'Bearer ***')
    .replace(/(authorization|token|apikey|api-key|password)(["':=\s]+)\S+/gi, '$1$2***')
    .trim()
}

function compactPackageLabel(value: unknown): string {
  if (typeof value !== 'string' || value === '') return 'plugin'
  const normalized = value.replaceAll('\\', '/')
  const storePart = normalized.split('/node_modules/.pnpm/').pop() ?? normalized
  const label = storePart.split('/node_modules/').pop() ?? storePart
  return label.length <= 96 ? label : `…${label.slice(-95)}`
}

function messageFromError(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (typeof value !== 'object' || value === null) return null
  const error = value as Record<string, unknown>
  if (typeof error.message === 'string' && error.message.trim() !== '') return error.message
  return null
}

/**
 * Convert one stdout/stderr line into zero or more terminal lines.
 * High-volume pnpm resolution/fetch ticks return an empty array: their live
 * counters are rendered separately from the structured status snapshot.
 */
export function installOutputCandidates(
  rawLine: string,
  fallbackStream: 'stdout' | 'stderr',
): InstallOutputCandidate[] {
  const trimmed = rawLine.trim()
  if (trimmed === '') return []

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return [{ stream: fallbackStream, text: rawLine }]
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return [{ stream: fallbackStream, text: rawLine }]
  }

  const event = parsed as Record<string, unknown>
  const name = typeof event.name === 'string' ? event.name : ''

  if (name === 'pnpm:lifecycle') {
    const pkg = compactPackageLabel(event.depPath ?? event.wd)
    const stage = typeof event.stage === 'string' && event.stage !== '' ? event.stage : 'build'
    const prefix = `${pkg} · ${stage}`
    const entries: InstallOutputCandidate[] = []
    if (typeof event.script === 'string' && event.script.trim() !== '') {
      entries.push({ stream: 'command', text: `${prefix} > ${event.script}` })
    }
    if (typeof event.line === 'string' && event.line.trim() !== '') {
      entries.push({
        stream: event.stdio === 'stderr' ? 'stderr' : 'stdout',
        text: `${prefix} | ${event.line}`,
      })
    }
    if (typeof event.exitCode === 'number') {
      entries.push({
        stream: event.exitCode === 0 ? 'system' : 'stderr',
        text: `${prefix} · exit ${String(event.exitCode)}`,
      })
    }
    return entries
  }

  if (name === 'pnpm:ignored-scripts') {
    const names = Array.isArray(event.packageNames) ? event.packageNames.map(String).join(', ') : ''
    return names === '' ? [] : [{ stream: 'stderr', text: `pnpm · build scripts blocked: ${names}` }]
  }

  if (name === 'pnpm:stats') {
    const added = typeof event.added === 'number' ? event.added : 0
    const removed = typeof event.removed === 'number' ? event.removed : 0
    if (added === 0 && removed === 0) return []
    return [{ stream: 'system', text: `pnpm · +${String(added)} -${String(removed)}` }]
  }

  if (name === 'pnpm' && event.level === 'error') {
    const message = messageFromError(event.err) ?? messageFromError(event.message)
    return message === null ? [] : [{ stream: 'stderr', text: message }]
  }

  // ndjson progress events update the structured progress bar/current line;
  // rendering them here would add thousands of unreadable JSON rows.
  if (name.startsWith('pnpm:')) return []

  const message = messageFromError(event.err) ?? messageFromError(event.message)
  if (message !== null) return [{ stream: fallbackStream, text: message }]
  return [{ stream: fallbackStream, text: rawLine }]
}

/** Mutable bounded buffer owned by the process layer's current operation. */
export class InstallOutputBuffer {
  private lines: InstallOutputLine[] = []
  private nextId = 1
  private charCount = 0

  clear(): void {
    this.lines = []
    this.nextId = 1
    this.charCount = 0
  }

  push(stream: InstallOutputStream, text: string): void {
    for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
      let safe = sanitizeInstallOutput(rawLine)
      if (safe === '') continue
      if (safe.length > MAX_LINE_CHARS) safe = `${safe.slice(0, MAX_LINE_CHARS - 1)}…`

      const previous = this.lines[this.lines.length - 1]
      if (previous?.stream === stream && previous.text === safe) continue

      this.lines.push({ id: this.nextId, stream, text: safe })
      this.nextId += 1
      this.charCount += safe.length

      while (this.lines.length > MAX_LINES || this.charCount > MAX_CHARS) {
        const removed = this.lines.shift()
        if (removed !== undefined) this.charCount -= removed.text.length
      }
    }
  }

  snapshot(): InstallOutputLine[] {
    return this.lines.map(line => ({ ...line }))
  }
}
