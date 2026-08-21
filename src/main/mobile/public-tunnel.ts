import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, constants as fsConstants } from 'node:fs'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat
} from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const RELEASE_API = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest'
const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
const MINIMUM_BINARY_SIZE = 1024 * 1024

export type PublicTunnelPhase =
  | 'idle'
  | 'locating'
  | 'downloading'
  | 'starting'
  | 'connecting'
  | 'ready'
  | 'error'

export interface PublicTunnelSnapshot {
  phase: PublicTunnelPhase
  url?: string
  error?: string
}

export interface PublicTunnelHandle {
  url: string
  stop(): Promise<void>
  onExit(listener: (error?: Error) => void): () => void
}

export interface StartPublicTunnelOptions {
  port: number
  cacheDirectory: string
  signal?: AbortSignal
  onPhase?: (phase: PublicTunnelPhase) => void
  fetchImpl?: typeof fetch
  platform?: NodeJS.Platform
  arch?: string
  pathValue?: string
  edgeBindAddress?: string
}

export interface CloudflaredStartupState {
  url?: string
  registered: boolean
}

interface GitHubReleaseAsset {
  name: string
  browser_download_url: string
  size: number
  digest?: string | null
}

interface GitHubRelease {
  tag_name?: string
  assets?: GitHubReleaseAsset[]
}

type TunnelChild = ChildProcessByStdio<null, Readable, Readable>

export function cloudflaredAssetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  const normalizedArch = arch === 'x64' ? 'amd64' : arch
  if (normalizedArch !== 'amd64' && normalizedArch !== 'arm64') {
    throw new Error(`Cloudflare Tunnel does not support this CPU architecture: ${arch}.`)
  }
  if (platform === 'win32') return `cloudflared-windows-${normalizedArch}.exe`
  if (platform === 'darwin') return `cloudflared-darwin-${normalizedArch}.tgz`
  if (platform === 'linux') return `cloudflared-linux-${normalizedArch}`
  throw new Error(`Cloudflare Tunnel is not supported on ${platform}.`)
}

export async function resolveCloudflaredExecutable(
  options: Omit<StartPublicTunnelOptions, 'port'>
): Promise<string> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const executableName = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  options.onPhase?.('locating')

  const fromPath = await findExecutableOnPath(
    executableName,
    options.pathValue ?? process.env.PATH ?? '',
    platform
  )
  if (fromPath) return fromPath

  await mkdir(options.cacheDirectory, { recursive: true })
  const cachedPath = join(options.cacheDirectory, executableName)
  if (await isUsableBinary(cachedPath)) return cachedPath
  await rm(cachedPath, { force: true }).catch(() => undefined)

  options.onPhase?.('downloading')
  const fetchImpl = options.fetchImpl ?? fetch
  const releaseResponse = await fetchImpl(RELEASE_API, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'DSH-Desktop'
    },
    signal: options.signal
  })
  if (!releaseResponse.ok) {
    throw new Error(
      `Could not query the official cloudflared release (HTTP ${releaseResponse.status}). ` +
        manualInstallHint(platform, options.cacheDirectory)
    )
  }
  const release = (await releaseResponse.json()) as GitHubRelease
  const assetName = cloudflaredAssetName(platform, arch)
  const asset = release.assets?.find((candidate) => candidate.name === assetName)
  if (!asset?.browser_download_url || !Number.isFinite(asset.size)) {
    throw new Error(
      `The cloudflared ${release.tag_name ?? 'latest'} release has no ${assetName} asset. ` +
        manualInstallHint(platform, options.cacheDirectory)
    )
  }
  const expectedDigest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest ?? '')?.[1]?.toLowerCase()
  if (!expectedDigest) {
    throw new Error('The official cloudflared release did not provide a SHA-256 digest; download was stopped for safety.')
  }

  const downloadPath = join(options.cacheDirectory, `cloudflared-${randomUUID()}.download`)
  const extractDirectory = await mkdtemp(join(options.cacheDirectory, '.extract-'))
  try {
    const assetResponse = await fetchImpl(asset.browser_download_url, { signal: options.signal })
    if (!assetResponse.ok || !assetResponse.body) {
      throw new Error(`cloudflared download failed with HTTP ${assetResponse.status}.`)
    }
    await pipeline(
      Readable.fromWeb(assetResponse.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(downloadPath, { flags: 'wx' })
    )
    const downloaded = await stat(downloadPath)
    if (downloaded.size !== asset.size) {
      throw new Error(`cloudflared download was incomplete (${downloaded.size}/${asset.size} bytes).`)
    }
    const digest = await sha256File(downloadPath)
    if (digest !== expectedDigest) throw new Error('cloudflared SHA-256 verification failed.')

    let preparedPath = downloadPath
    if (platform === 'darwin') {
      await extractTarGz(downloadPath, extractDirectory, options.signal)
      const extracted = await findFileNamed(extractDirectory, 'cloudflared')
      if (!extracted) throw new Error('cloudflared archive was valid but did not contain the executable.')
      preparedPath = extracted
    }
    if (platform !== 'win32') await chmod(preparedPath, 0o755)
    await installAtomically(preparedPath, cachedPath)
    if (!(await isUsableBinary(cachedPath))) throw new Error('The installed cloudflared executable is invalid.')
    return cachedPath
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message} ${manualInstallHint(platform, options.cacheDirectory)}`)
  } finally {
    await rm(downloadPath, { force: true }).catch(() => undefined)
    await rm(extractDirectory, { force: true, recursive: true }).catch(() => undefined)
  }
}

export async function startCloudflareQuickTunnel(
  options: StartPublicTunnelOptions
): Promise<PublicTunnelHandle> {
  const executable = await resolveCloudflaredExecutable(options)
  throwIfAborted(options.signal)
  options.onPhase?.('starting')
  const child = spawn(
    executable,
    cloudflaredTunnelArguments(options.port, options.edgeBindAddress),
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  options.onPhase?.('connecting')
  const handle = await waitForTunnelReady(child, options.signal)
  options.onPhase?.('ready')
  return handle
}

export function cloudflaredTunnelArguments(port: number, edgeBindAddress?: string): string[] {
  const arguments_ = [
    'tunnel',
    '--url',
    `http://127.0.0.1:${port}`,
    '--protocol',
    'http2'
  ]
  if (edgeBindAddress && isIP(edgeBindAddress) === 4) {
    arguments_.push('--edge-ip-version', '4', '--edge-bind-address', edgeBindAddress)
  }
  arguments_.push('--no-autoupdate')
  return arguments_
}

export function parseCloudflaredStartupOutput(output: string): CloudflaredStartupState {
  return {
    url: QUICK_TUNNEL_URL.exec(output)?.[0],
    registered: /Registered tunnel connection/i.test(output)
  }
}

async function waitForTunnelReady(
  child: TunnelChild,
  signal?: AbortSignal
): Promise<PublicTunnelHandle> {
  const exitListeners = new Set<(error?: Error) => void>()
  let exitState: { error?: Error } | undefined
  let settled = false
  let requestedStop = false
  let lastOutput = ''
  let tunnelUrl: string | undefined
  let resolveStart: ((handle: PublicTunnelHandle) => void) | undefined
  let rejectStart: ((error: Error) => void) | undefined

  const started = new Promise<PublicTunnelHandle>((resolve, reject) => {
    resolveStart = resolve
    rejectStart = reject
  })
  const rememberOutput = (chunk: Buffer | string): void => {
    const text = String(chunk)
    lastOutput = `${lastOutput}${text}`.slice(-4000)
    if (settled) return
    const startup = parseCloudflaredStartupOutput(lastOutput)
    tunnelUrl ??= startup.url
    if (!tunnelUrl || !startup.registered) return
    settled = true
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
    const handle: PublicTunnelHandle = {
      url: tunnelUrl,
      stop: async () => {
        requestedStop = true
        await stopChild(child)
      },
      onExit: (listener) => {
        if (exitState) {
          queueMicrotask(() => listener(exitState?.error))
          return () => undefined
        }
        exitListeners.add(listener)
        return () => exitListeners.delete(listener)
      }
    }
    resolveStart?.(handle)
  }
  const fail = (error: Error): void => {
    if (settled) {
      exitState = { error: requestedStop ? undefined : error }
      for (const listener of exitListeners) listener(exitState.error)
      exitListeners.clear()
      return
    }
    settled = true
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
    rejectStart?.(error)
  }
  const abort = (): void => {
    requestedStop = true
    void stopChild(child)
    fail(abortError())
  }
  const timeout = setTimeout(() => {
    requestedStop = true
    void stopChild(child)
    const detail = compactCloudflaredOutput(lastOutput)
    fail(
      new Error(
        `Cloudflare Tunnel did not become ready within 60 seconds${detail ? `: ${detail}` : '.'} ` +
          'A proxy, VPN, or TUN mode may be blocking the connector. Allow direct access to ' +
          'argotunnel.com and trycloudflare.com, then retry.'
      )
    )
  }, 60_000)

  child.stdout.on('data', rememberOutput)
  child.stderr.on('data', rememberOutput)
  child.once('error', (error) => fail(new Error(`cloudflared could not start: ${error.message}`)))
  child.once('exit', (code, exitSignal) => {
    const detail = compactCloudflaredOutput(lastOutput)
    fail(
      new Error(
        `cloudflared exited${code === null ? '' : ` with code ${code}`}${exitSignal ? ` (${exitSignal})` : ''}${detail ? `: ${detail}` : '.'}`
      )
    )
  })
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  return await started
}

async function findExecutableOnPath(
  executableName: string,
  pathValue: string,
  platform: NodeJS.Platform
): Promise<string | undefined> {
  const mode = platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(directory.replace(/^"|"$/g, ''), executableName)
    try {
      await access(candidate, mode)
      return candidate
    } catch {
      // Keep searching the remaining PATH entries.
    }
  }
  return undefined
}

async function isUsableBinary(path: string): Promise<boolean> {
  try {
    const details = await stat(path)
    return details.isFile() && details.size >= MINIMUM_BINARY_SIZE
  } catch {
    return false
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function extractTarGz(archive: string, directory: string, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archive, '-C', directory], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-2000)
    })
    const abort = (): void => {
      child.kill()
      reject(abortError())
    }
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort, { once: true })
    child.once('error', reject)
    child.once('exit', (code) => {
      signal?.removeEventListener('abort', abort)
      if (code === 0) resolve()
      else reject(new Error(`Could not extract cloudflared (${code ?? 'unknown'}): ${stderr.trim()}`))
    })
  })
}

async function findFileNamed(directory: string, name: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isFile() && entry.name === name) return path
    if (entry.isDirectory()) {
      const nested = await findFileNamed(path, name)
      if (nested) return nested
    }
  }
  return undefined
}

async function installAtomically(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination)
  } catch (error) {
    if (await isUsableBinary(destination)) return
    throw error
  }
}

async function stopChild(child: TunnelChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => child.kill('SIGKILL'), 2000)
    child.once('exit', () => {
      clearTimeout(force)
      resolve()
    })
    child.kill()
  })
}

function compactCloudflaredOutput(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' | ')
    .slice(0, 800)
}

function manualInstallHint(platform: NodeJS.Platform, cacheDirectory: string): string {
  if (platform === 'win32') {
    return `Install it with “winget install Cloudflare.cloudflared”, or place cloudflared.exe in ${cacheDirectory}, then retry.`
  }
  if (platform === 'darwin') return 'Install it with “brew install cloudflared”, then retry.'
  return 'Install cloudflared with your system package manager, then retry.'
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function abortError(): Error {
  const error = new Error('Public access startup was cancelled.')
  error.name = 'AbortError'
  return error
}
