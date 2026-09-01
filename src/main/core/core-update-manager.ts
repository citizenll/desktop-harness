import { randomUUID } from 'node:crypto'
import { BrowserWindow, ipcMain, powerMonitor, type IpcMainInvokeEvent } from 'electron'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  CoreReleaseArtifact,
  CoreUpdateSource,
  CoreUpdateStatus
} from '../../shared/core-update'
import type { CoreRuntimePaths, CoreRuntimeStore, StagedCoreRuntime } from './core-store'
import { verifySignedCoreChannel, type CoreCompatibility } from './core-manifest'
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_STARTUP_DELAY_MS,
  UPDATE_STARTUP_JITTER_MS,
  shouldCheckAfterResume
} from '../update/update-policy'

const MAX_CHANNEL_RESPONSE_BYTES = 512 * 1024
const TRANSIENT_STATUS_MS = 8_000

export const CORE_UPDATE_CHANNEL_URL =
  'https://github.com/citizenll/desktop-harness/releases/download/core-channel-stable/channel.json'

export interface CoreUpdateManagerOptions {
  store: CoreRuntimeStore
  compatibility: CoreCompatibility
  publicKeyPath: string
  downloadDirectory: string
  activate(
    candidate: StagedCoreRuntime,
    previous: CoreRuntimePaths,
    commit: () => Promise<void>
  ): Promise<boolean>
  channelUrl?: string
  fetchImpl?: typeof fetch
  assertTrustedEvent?(event: IpcMainInvokeEvent): void
}

export class CoreUpdateManager {
  private status: CoreUpdateStatus
  private candidate?: CoreReleaseArtifact
  private candidateSource?: CoreUpdateSource
  private staged?: StagedCoreRuntime
  private checkPromise?: Promise<CoreUpdateStatus>
  private operationPromise?: Promise<void>
  private startupTimer?: NodeJS.Timeout
  private intervalTimer?: NodeJS.Timeout
  private resetTimer?: NodeJS.Timeout
  private lastCheckedAt = 0
  private started = false
  private handlersRegistered = false

  constructor(private readonly options: CoreUpdateManagerOptions) {
    const current = options.store.current().descriptor
    const embedded = options.store.embeddedCandidate()
    this.candidate = embedded?.artifact
    this.candidateSource = embedded === undefined ? undefined : 'embedded'
    this.staged = embedded?.staged
    this.status = embedded === undefined ? {
      phase: 'idle',
      currentGeneration: current.generation,
      currentVersion: current.dshVersion,
      manual: false
    } : {
      phase: embedded.staged === undefined ? 'available' : 'staged',
      currentGeneration: current.generation,
      currentVersion: current.dshVersion,
      availableGeneration: embedded.artifact.core.generation,
      availableVersion: embedded.artifact.core.dshVersion,
      downloadSize: embedded.artifact.archive.size,
      percent: embedded.staged === undefined ? undefined : 100,
      source: 'embedded',
      manual: false
    }
  }

  snapshot(): CoreUpdateStatus {
    return { ...this.status }
  }

  registerHandlers(): void {
    if (this.handlersRegistered) return
    this.handlersRegistered = true
    for (const channel of [
      'core-updates:status',
      'core-updates:check',
      'core-updates:download',
      'core-updates:activate'
    ]) {
      ipcMain.removeHandler(channel)
    }
    ipcMain.handle('core-updates:status', (event) => {
      this.options.assertTrustedEvent?.(event)
      return this.snapshot()
    })
    ipcMain.handle('core-updates:check', (event) => {
      this.options.assertTrustedEvent?.(event)
      return this.check(true)
    })
    ipcMain.handle('core-updates:download', (event) => {
      this.options.assertTrustedEvent?.(event)
      return this.download()
    })
    ipcMain.handle('core-updates:activate', (event) => {
      this.options.assertTrustedEvent?.(event)
      return this.activate()
    })
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.startupTimer = setTimeout(
      () => void this.check(false),
      UPDATE_STARTUP_DELAY_MS + Math.random() * UPDATE_STARTUP_JITTER_MS
    )
    this.intervalTimer = setInterval(
      () => void this.check(false),
      UPDATE_CHECK_INTERVAL_MS
    )
    powerMonitor.on('resume', this.checkAfterResume)
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer)
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    if (this.resetTimer) clearTimeout(this.resetTimer)
    this.startupTimer = undefined
    this.intervalTimer = undefined
    this.resetTimer = undefined
    if (this.started) powerMonitor.removeListener('resume', this.checkAfterResume)
    this.started = false
  }

  async check(manual: boolean): Promise<CoreUpdateStatus> {
    if (this.checkPromise) return this.checkPromise
    if (this.candidateSource === 'embedded' && ['available', 'staged'].includes(this.status.phase)) {
      return this.snapshot()
    }
    if (['downloading', 'verifying', 'staged', 'activating'].includes(this.status.phase)) {
      return this.snapshot()
    }

    this.checkPromise = this.performCheck(manual).finally(() => {
      this.checkPromise = undefined
    })
    return this.checkPromise
  }

  async download(): Promise<void> {
    if (this.operationPromise) return this.operationPromise
    if (this.status.phase !== 'available' || !this.candidate) return
    const candidate = this.candidate
    const source = this.candidateSource
    if (!source) throw new Error('The Core update source is missing.')
    this.status = { ...this.status, manual: true }
    this.operationPromise = (source === 'embedded'
      ? this.performEmbeddedPreparation(candidate)
      : this.performDownload(candidate)).finally(() => {
      this.operationPromise = undefined
    })
    return this.operationPromise
  }

  async activate(): Promise<void> {
    if (this.operationPromise) return this.operationPromise
    if (this.status.phase !== 'staged' || !this.staged) return
    const staged = this.staged
    this.status = { ...this.status, manual: true }
    this.operationPromise = this.performActivation(staged).finally(() => {
      this.operationPromise = undefined
    })
    return this.operationPromise
  }

  private async performCheck(manual: boolean): Promise<CoreUpdateStatus> {
    const embedded = this.options.store.embeddedCandidate()
    if (embedded !== undefined) {
      this.candidate = embedded.artifact
      this.candidateSource = 'embedded'
      this.staged = embedded.staged
      this.transition({
        phase: embedded.staged === undefined ? 'available' : 'staged',
        manual,
        availableGeneration: embedded.artifact.core.generation,
        availableVersion: embedded.artifact.core.dshVersion,
        downloadSize: embedded.artifact.archive.size,
        percent: embedded.staged === undefined ? undefined : 100,
        source: 'embedded'
      })
      return this.snapshot()
    }
    this.transition({ phase: 'checking', manual })
    this.lastCheckedAt = Date.now()
    try {
      const publicKeyPem = await readFile(this.options.publicKeyPath, 'utf8')
      const response = await (this.options.fetchImpl ?? fetch)(
        this.options.channelUrl ?? CORE_UPDATE_CHANNEL_URL,
        {
          redirect: 'follow',
          cache: 'no-store',
          signal: AbortSignal.timeout(30_000),
          headers: { Accept: 'application/json' }
        }
      )
      if (!response.ok) throw new Error(`Core channel returned HTTP ${response.status}.`)
      const text = await readLimitedResponse(response, MAX_CHANNEL_RESPONSE_BYTES)
      const verified = verifySignedCoreChannel(
        JSON.parse(text) as unknown,
        publicKeyPem,
        this.options.compatibility
      )
      const artifact = verified.artifact
      if (!artifact) {
        this.transition({
          phase: 'unsupported',
          manual,
          message: 'The stable Core channel has no artifact for this platform.'
        })
        if (manual) this.scheduleReset()
        return this.snapshot()
      }

      const highestSeen = await this.options.store.highestSeenGeneration()
      if (artifact.core.generation < highestSeen) {
        throw new Error(
          `Core channel rollback rejected: generation ${artifact.core.generation} is below ${highestSeen}.`
        )
      }
      await this.options.store.recordHighestSeen(artifact.core.generation)
      const current = this.options.store.current().descriptor
      const installed = await this.options.store.findInstalled(artifact)
      if (artifact.core.generation <= current.generation) {
        this.candidate = undefined
        this.candidateSource = undefined
        this.staged = undefined
        this.transition({ phase: 'up-to-date', manual })
        if (manual) this.scheduleReset()
        return this.snapshot()
      }

      this.candidate = artifact
      this.candidateSource = 'remote'
      if (installed) {
        this.staged = installed
        this.transition({
          phase: 'staged',
          manual,
          availableGeneration: artifact.core.generation,
          availableVersion: artifact.core.dshVersion,
          releaseNotes: verified.payload.releaseNotes,
          downloadSize: artifact.archive.size,
          percent: 100,
          source: 'remote'
        })
        return this.snapshot()
      }
      this.staged = undefined
      this.transition({
        phase: 'available',
        manual,
        availableGeneration: artifact.core.generation,
        availableVersion: artifact.core.dshVersion,
        releaseNotes: verified.payload.releaseNotes,
        downloadSize: artifact.archive.size,
        source: 'remote'
      })
    } catch (error) {
      this.transition({ phase: 'error', manual, message: errorMessage(error) })
      if (manual) this.scheduleReset()
      else console.warn('[core-updater] automatic check failed', error)
    }
    return this.snapshot()
  }

  private async performDownload(candidate: CoreReleaseArtifact): Promise<void> {
    const archiveUrl = candidate.archive.url
    if (!archiveUrl) throw new Error('The Core update archive URL is missing.')
    await mkdir(this.options.downloadDirectory, { recursive: true })
    const downloadRoot = join(this.options.downloadDirectory, randomUUID())
    const archivePath = join(downloadRoot, candidate.archive.fileName)
    await mkdir(downloadRoot, { recursive: true })
    try {
      this.transition({
        phase: 'downloading',
        manual: this.status.manual,
        availableGeneration: candidate.core.generation,
        availableVersion: candidate.core.dshVersion,
        releaseNotes: this.status.releaseNotes,
        downloadSize: candidate.archive.size,
        percent: 0
      })
      const response = await (this.options.fetchImpl ?? fetch)(archiveUrl, {
        redirect: 'follow',
        cache: 'no-store',
        signal: AbortSignal.timeout(30 * 60_000),
        headers: { Accept: 'application/octet-stream' }
      })
      if (!response.ok || !response.body) {
        throw new Error(`Core archive returned HTTP ${response.status}.`)
      }
      const handle = await open(archivePath, 'wx', 0o600)
      let received = 0
      try {
        const reader = response.body.getReader()
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          received += chunk.value.byteLength
          if (received > candidate.archive.size) {
            throw new Error('Core archive exceeds the signed byte size.')
          }
          await writeChunkFully(handle, chunk.value)
          const percent = received / candidate.archive.size * 100
          if (Math.floor(percent) !== Math.floor(this.status.percent ?? -1)) {
            this.transition({ ...this.status, percent })
          }
        }
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (received !== candidate.archive.size) {
        throw new Error(
          `Core archive download ended at ${received} bytes; expected ${candidate.archive.size}.`
        )
      }

      this.transition({ ...this.status, phase: 'verifying', percent: 100 })
      this.staged = await this.options.store.stageArchive(candidate, archivePath)
      this.transition({ ...this.status, phase: 'staged', percent: 100 })
    } catch (error) {
      this.staged = undefined
      this.transition({ ...this.status, phase: 'error', message: errorMessage(error) })
      throw error
    } finally {
      await rm(downloadRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async performEmbeddedPreparation(candidate: CoreReleaseArtifact): Promise<void> {
    try {
      this.transition({ ...this.status, phase: 'verifying', source: 'embedded' })
      this.staged = await this.options.store.stageEmbeddedCandidate(candidate)
      this.transition({ ...this.status, phase: 'staged', percent: 100, source: 'embedded' })
    } catch (error) {
      this.staged = undefined
      this.transition({ ...this.status, phase: 'error', message: errorMessage(error) })
      throw error
    }
  }

  private async performActivation(candidate: StagedCoreRuntime): Promise<void> {
    const previous = this.options.store.current()
    this.transition({ ...this.status, phase: 'activating' })
    try {
      const activated = await this.options.activate(candidate, previous, () =>
        this.options.store.commit(candidate)
      )
      if (!activated) throw new Error('The candidate Core did not become ready.')
      const current = this.options.store.current().descriptor
      this.candidate = undefined
      this.candidateSource = undefined
      this.staged = undefined
      this.status = {
        phase: 'up-to-date',
        currentGeneration: current.generation,
        currentVersion: current.dshVersion,
        manual: true
      }
      this.broadcast()
      this.scheduleReset()
    } catch (error) {
      this.transition({ ...this.status, phase: 'error', message: errorMessage(error) })
      throw error
    }
  }

  private transition(next: Partial<CoreUpdateStatus> & Pick<CoreUpdateStatus, 'phase'>): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer)
      this.resetTimer = undefined
    }
    const current = this.options.store.current().descriptor
    this.status = {
      currentGeneration: current.generation,
      currentVersion: current.dshVersion,
      manual: this.status.manual,
      ...next
    }
    console.info('[core-updater] status', this.status.phase, this.status.percent ?? '')
    this.broadcast()
  }

  private broadcast(): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('core-updates:status-changed', this.snapshot())
      }
    }
  }

  private scheduleReset(): void {
    if (!this.status.manual) return
    if (this.resetTimer) clearTimeout(this.resetTimer)
    this.resetTimer = setTimeout(() => {
      const current = this.options.store.current().descriptor
      this.status = {
        phase: 'idle',
        currentGeneration: current.generation,
        currentVersion: current.dshVersion,
        manual: false
      }
      this.broadcast()
    }, TRANSIENT_STATUS_MS)
  }

  private readonly checkAfterResume = (): void => {
    if (shouldCheckAfterResume(this.lastCheckedAt)) void this.check(false)
  }
}

async function writeChunkFully(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array
): Promise<void> {
  let offset = 0
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset
    )
    if (bytesWritten <= 0) throw new Error('Core archive download could not be written to disk.')
    offset += bytesWritten
  }
}

async function readLimitedResponse(response: Response, maximum: number): Promise<string> {
  if (!response.body) throw new Error('Core channel response is empty.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.byteLength
    if (size > maximum) throw new Error('Core channel response is too large.')
    chunks.push(chunk.value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
