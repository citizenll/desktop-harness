import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const TOOLCHAIN_DIRECTORY = '.desktop-bin'
const PROBE_TIMEOUT_MS = 10_000

export const NODE_PACKAGE_MANAGERS = ['pnpm', 'npm', 'yarn', 'bun'] as const

export type NodePackageManager = (typeof NODE_PACKAGE_MANAGERS)[number]

export interface DesktopToolchainOptions {
  dshHome: string
  nodeExecutablePath: string
  pnpmEntryPath: string
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

export interface PreparedDesktopToolchain {
  directory: string
  environment: NodeJS.ProcessEnv
  pnpmVersion: string
}

export interface DetectedPackageManager {
  name: NodePackageManager
  available: boolean
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function pathIdentity(value: string, platform: NodeJS.Platform): string {
  let normalized = unquotePath(value)
  while (normalized.length > 3 && /[\\/]$/u.test(normalized)) {
    normalized = normalized.slice(0, -1)
  }
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function unquotePath(value: string): string {
  let normalized = value.trim()
  if (normalized.length >= 2 && normalized.startsWith('"') && normalized.endsWith('"')) {
    normalized = normalized.slice(1, -1)
  }
  return normalized
}

function withoutElectronNodeMode(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment }
  for (const key of Object.keys(result)) {
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete result[key]
  }
  return result
}

function processPath(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const exact = platform === 'win32'
    ? [environment.Path, environment.PATH]
    : [environment.PATH, environment.Path]
  const alternate = Object.entries(environment)
    .filter(([key]) => key.toUpperCase() === 'PATH')
    .map(([, value]) => value)
  const candidates = [...exact, ...alternate]
  return candidates.find((value) => typeof value === 'string' && value.length > 0) ??
    candidates.find((value) => value !== undefined) ??
    ''
}

export function desktopToolchainDirectory(dshHome: string): string {
  return join(dshHome, TOOLCHAIN_DIRECTORY)
}

export async function ensureDesktopToolchainShims(
  options: DesktopToolchainOptions
): Promise<string> {
  const platform = options.platform ?? process.platform
  const directory = desktopToolchainDirectory(options.dshHome)
  await mkdir(directory, { recursive: true })

  if (platform === 'win32') {
    await writeFile(
      join(directory, 'pnpm.cmd'),
      `@chcp 65001 >nul\r\n@echo off\r\n@set "ELECTRON_RUN_AS_NODE=1"\r\n"${options.nodeExecutablePath}" "${options.pnpmEntryPath}" %*\r\n`,
      'utf8'
    )
    await writeFile(
      join(directory, 'node.cmd'),
      `@chcp 65001 >nul\r\n@echo off\r\n@set "ELECTRON_RUN_AS_NODE=1"\r\n"${options.nodeExecutablePath}" %*\r\n`,
      'utf8'
    )
  } else {
    const pnpmPath = join(directory, 'pnpm')
    await writeFile(
      pnpmPath,
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(options.nodeExecutablePath)} ${shellQuote(options.pnpmEntryPath)} "$@"\n`,
      { encoding: 'utf8', mode: 0o755 }
    )
    await chmod(pnpmPath, 0o755)

    const nodePath = join(directory, 'node')
    await writeFile(
      nodePath,
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(options.nodeExecutablePath)} "$@"\n`,
      { encoding: 'utf8', mode: 0o755 }
    )
    await chmod(nodePath, 0o755)
  }

  return directory
}

export function buildDesktopToolchainEnvironment(options: {
  dshHome: string
  shimDirectory: string
  nodeExecutablePath: string
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  ci?: boolean
}): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform
  const source = options.environment ?? process.env
  const result = withoutElectronNodeMode(source)
  const pathDelimiter = platform === 'win32' ? ';' : ':'
  const currentPath = processPath(source, platform)
  const candidates = [
    options.shimDirectory,
    dirname(options.nodeExecutablePath),
    ...currentPath.split(pathDelimiter)
  ]
  const seen = new Set<string>()
  const pathParts = candidates.filter((candidate) => {
    if (!candidate) return false
    const identity = pathIdentity(candidate, platform)
    if (!identity || seen.has(identity)) return false
    seen.add(identity)
    return true
  })
  const nextPath = pathParts.join(pathDelimiter)

  result.DSH_HOME = options.dshHome
  result.ELECTRON_RUN_AS_NODE = '1'
  result.NO_COLOR = '1'
  // DSH Desktop invokes its pinned pnpm directly. An unrelated package.json in
  // an ancestor directory (for example C:\Users\name\package.json declaring
  // Yarn) must not make that private runtime reject every command. Keep this
  // override scoped to Harness and its children; the user's environment is not
  // changed.
  for (const key of Object.keys(result)) {
    if (key.toUpperCase() === 'COREPACK_ENABLE_STRICT') delete result[key]
  }
  result.COREPACK_ENABLE_STRICT = '0'
  if (options.ci) result.CI = 'true'
  result.PATH = nextPath
  if (platform === 'win32') result.Path = nextPath
  return result
}

interface CommandOutcome {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

function stopProbe(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    }).unref()
    return
  }
  child.kill('SIGKILL')
}

function runCommand(
  file: string,
  args: readonly string[],
  options: {
    cwd?: string
    environment: NodeJS.ProcessEnv
    timeoutMs?: number
  }
): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(file, [...args], {
        cwd: options.cwd,
        env: options.environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      })
    } catch (error) {
      resolve({
        code: 127,
        signal: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error)
      })
      return
    }

    let settled = false
    let stdout = ''
    let stderr = ''
    let timer: NodeJS.Timeout | undefined
    const finish = (outcome: CommandOutcome): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(outcome)
    }
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout = `${stdout}${chunk.toString()}`.slice(-8 * 1024)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-8 * 1024)
    })
    child.once('error', (error) => {
      finish({ code: 127, signal: null, stdout, stderr: `${stderr}${error.message}` })
    })
    child.once('exit', (code, signal) => finish({ code, signal, stdout, stderr }))

    timer = setTimeout(() => {
      stopProbe(child)
      finish({
        code: 124,
        signal: null,
        stdout,
        stderr: `${stderr}${stderr ? '\n' : ''}Command timed out.`
      })
    }, options.timeoutMs ?? PROBE_TIMEOUT_MS)
    timer.unref?.()
  })
}

function packageManagerCommand(
  manager: NodePackageManager,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv
): { file: string; args: string[] } {
  if (platform !== 'win32') return { file: manager, args: ['--version'] }
  return {
    file: environment.ComSpec ?? environment.COMSPEC ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `${manager} --version`]
  }
}

function parseVersion(outcome: CommandOutcome): string | undefined {
  const lines = `${outcome.stdout}\n${outcome.stderr}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.find((line) => /\d/u.test(line))?.slice(0, 120)
}

export async function verifyDesktopToolchain(
  options: DesktopToolchainOptions,
  environment: NodeJS.ProcessEnv
): Promise<string> {
  const direct = await runCommand(
    options.nodeExecutablePath,
    [options.pnpmEntryPath, '--version'],
    { cwd: options.dshHome, environment }
  )
  const directVersion = parseVersion(direct)
  if (direct.code !== 0 || !directVersion) {
    const detail = (direct.stderr || direct.stdout).trim().slice(-800)
    throw new Error(
      `The bundled pnpm runtime could not start${detail ? `: ${detail}` : ` (exit ${String(direct.code)})`}.`
    )
  }

  const platform = options.platform ?? process.platform
  const command = packageManagerCommand('pnpm', platform, environment)
  const viaPath = await runCommand(command.file, command.args, {
    cwd: options.dshHome,
    environment
  })
  const pathVersion = parseVersion(viaPath)
  if (viaPath.code !== 0 || !pathVersion) {
    const detail = (viaPath.stderr || viaPath.stdout).trim().slice(-800)
    throw new Error(
      `The private pnpm command could not be resolved on PATH${detail ? `: ${detail}` : ` (exit ${String(viaPath.code)})`}.`
    )
  }
  if (pathVersion !== directVersion) {
    throw new Error(
      `The private pnpm command resolved to ${pathVersion}, but DSH Desktop ships ${directVersion}.`
    )
  }
  return directVersion
}

export async function prepareDesktopToolchain(
  options: DesktopToolchainOptions
): Promise<PreparedDesktopToolchain> {
  const directory = await ensureDesktopToolchainShims(options)
  const environment = buildDesktopToolchainEnvironment({
    dshHome: options.dshHome,
    shimDirectory: directory,
    nodeExecutablePath: options.nodeExecutablePath,
    environment: options.environment,
    platform: options.platform
  })
  const pnpmVersion = await verifyDesktopToolchain(options, environment)
  return { directory, environment, pnpmVersion }
}

// `dsh plugin` is deliberately a pnpm forwarder because the profile owns a
// pnpm lockfile/workspace. Other managers are detected for diagnosis only;
// substituting one would change the profile format rather than repair it.
async function commandExistsOnPath(
  name: NodePackageManager,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): Promise<boolean> {
  const separator = platform === 'win32' ? ';' : ':'
  const suffixes = platform === 'win32'
    ? [
        '',
        ...(environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
      ]
    : ['']
  const accessMode = platform === 'win32' ? constants.F_OK : constants.X_OK

  for (const rawDirectory of processPath(environment, platform).split(separator)) {
    const directory = unquotePath(rawDirectory)
    if (!directory) continue
    for (const suffix of suffixes) {
      try {
        await access(join(directory, `${name}${suffix}`), accessMode)
        return true
      } catch {
        // Continue searching the remaining PATH entries and executable suffixes.
      }
    }
  }
  return false
}

export async function detectNodePackageManagers(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<DetectedPackageManager[]> {
  const cleanEnvironment = withoutElectronNodeMode(environment)
  return Promise.all(
    NODE_PACKAGE_MANAGERS.map(async (name): Promise<DetectedPackageManager> => {
      const available = await commandExistsOnPath(name, cleanEnvironment, platform)
      return { name, available }
    })
  )
}
