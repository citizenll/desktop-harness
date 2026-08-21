import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

export const DESKTOP_PROFILE = 'web'
export const name = 'dsh-desktop-plugin-runtime'
export const inject = []

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function profileDirectory(home = dshHome()) {
  return join(home, 'profiles', DESKTOP_PROFILE)
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

export function resolvePnpmEntry(requireFrom = import.meta.url) {
  const require = createRequire(requireFrom)
  const manifest = require.resolve('pnpm')
  const root = dirname(manifest)
  const candidates = [join(root, 'bin', 'pnpm.cjs'), join(root, 'bin', 'pnpm.mjs')]
  const entry = candidates.find((candidate) => existsSync(candidate))
  if (!entry) throw new Error('The packaged pnpm entry was not found.')
  return entry
}

export async function ensurePnpmShim(home = dshHome()) {
  const directory = join(home, '.desktop-bin')
  await mkdir(directory, { recursive: true })
  const pnpmEntry = resolvePnpmEntry()
  const executable = process.execPath

  if (process.platform === 'win32') {
    await writeFile(
      join(directory, 'pnpm.cmd'),
      `@chcp 65001 >nul\r\n@echo off\r\n@set "ELECTRON_RUN_AS_NODE=1"\r\n"${executable}" "${pnpmEntry}" %*\r\n`,
      'utf8'
    )
    await writeFile(
      join(directory, 'node.cmd'),
      `@chcp 65001 >nul\r\n@echo off\r\n@set "ELECTRON_RUN_AS_NODE=1"\r\n"${executable}" %*\r\n`,
      'utf8'
    )
  } else {
    const pnpmPath = join(directory, 'pnpm')
    await writeFile(
      pnpmPath,
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(executable)} ${shellQuote(pnpmEntry)} "$@"\n`,
      { encoding: 'utf8', mode: 0o755 }
    )
    await chmod(pnpmPath, 0o755)
    const nodePath = join(directory, 'node')
    await writeFile(
      nodePath,
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(executable)} "$@"\n`,
      { encoding: 'utf8', mode: 0o755 }
    )
    await chmod(nodePath, 0o755)
  }

  const nodeDir = dirname(executable)
  const current = process.env.PATH ?? process.env.Path ?? ''
  const seen = new Set()
  const value = [directory, nodeDir, ...current.split(delimiter)]
    .filter(Boolean)
    .filter((entry) => {
      const identity = process.platform === 'win32' ? entry.toLowerCase() : entry
      if (seen.has(identity)) return false
      seen.add(identity)
      return true
    })
    .join(delimiter)
  process.env.PATH = value
  if (process.platform === 'win32') process.env.Path = value
  return directory
}

function processPath(environment) {
  return (
    (process.platform === 'win32' ? environment.Path : environment.PATH) ??
    environment.PATH ??
    environment.Path ??
    ''
  )
}

export function buildPnpmEnvironment(
  binDirectory,
  environment = process.env,
  executablePath = process.execPath
) {
  const result = { ...environment }
  for (const key of Object.keys(result)) {
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete result[key]
  }
  result.ELECTRON_RUN_AS_NODE = '1'

  const seen = new Set()
  const paths = [binDirectory, dirname(executablePath), ...processPath(environment).split(delimiter)]
    .map((entry) => entry.trim())
    .filter((entry) => {
      if (!entry) return false
      const identity = process.platform === 'win32' ? entry.toLowerCase() : entry
      if (seen.has(identity)) return false
      seen.add(identity)
      return true
    })
  const value = paths.join(delimiter)
  result.PATH = value
  if (process.platform === 'win32') result.Path = value
  result.CI = 'true'
  result.NO_COLOR = '1'
  return result
}

export function createDesktopProfilesService(home = dshHome()) {
  const current = Object.freeze({
    name: DESKTOP_PROFILE,
    dir: profileDirectory(home)
  })
  return Object.freeze({
    current,
    list: () => [current],
    select: async (profile) => {
      if (profile !== DESKTOP_PROFILE) {
        throw new Error(`DSH Desktop only exposes the ${DESKTOP_PROFILE} profile.`)
      }
    }
  })
}

function validatePluginOperation(args, invokingDir) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error('Desktop pnpm requires at least one plugin argument.')
  }
  if (args.some((argument) => typeof argument !== 'string' || !argument || argument.includes('\0'))) {
    throw new Error('Desktop pnpm arguments must be non-empty strings without NUL.')
  }
  if (typeof invokingDir !== 'string' || !isAbsolute(invokingDir) || invokingDir.includes('\0')) {
    throw new Error('Desktop pnpm requires an absolute invoking directory without NUL.')
  }
}

function killProcessTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore'
    }).unref()
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

export function resolveDshEntry(argv = process.argv) {
  const entry = argv[1]
  if (!entry || !/[/\\]bin\.js$/u.test(entry)) {
    throw new Error('The running DSH entry could not be identified.')
  }
  return resolve(entry)
}

export function createDesktopPnpmService(options) {
  const {
    binDirectory,
    dshEntryPath = resolveDshEntry(),
    executablePath = process.execPath,
    environment = process.env,
    spawnProcess = spawn
  } = options
  let active
  let closed = false

  const runPlugin = (args, invokingDir, signal) => {
    validatePluginOperation(args, invokingDir)
    if (closed) throw new Error('The DSH Desktop pnpm service has been disposed.')
    if (signal?.aborted) throw signal.reason ?? new Error('The package operation was aborted.')
    if (active) throw new Error('Another desktop pnpm operation is already running.')

    const child = spawnProcess(
      executablePath,
      [dshEntryPath, 'plugin', '--profile', DESKTOP_PROFILE, ...args],
      {
        cwd: invokingDir,
        env: buildPnpmEnvironment(binDirectory, environment, executablePath),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32'
      }
    )
    const cancel = () => killProcessTree(child)
    const done = new Promise((resolveDone, rejectDone) => {
      child.once('error', rejectDone)
      child.once('close', (exitCode, exitSignal) => {
        resolveDone({ exitCode, signal: exitSignal })
      })
    })
    const handle = { stdout: child.stdout, stderr: child.stderr, done, cancel }
    active = handle

    const abort = () => cancel()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const release = () => {
      signal?.removeEventListener('abort', abort)
      if (active === handle) active = undefined
    }
    void done.then(release, release)
    return handle
  }

  return Object.freeze({
    runPlugin,
    async dispose() {
      closed = true
      const operation = active
      if (!operation) return
      operation.cancel()
      await operation.done.catch(() => undefined)
    }
  })
}

export async function apply(ctx) {
  const home = dshHome()
  const binDirectory = await ensurePnpmShim(home)
  const desktopProfiles = createDesktopProfilesService(home)
  const desktopPnpm = createDesktopPnpmService({ binDirectory })
  ctx.provide('desktopProfiles', desktopProfiles)
  ctx.provide('desktopPnpm', desktopPnpm)
  ctx.effect(() => () => desktopPnpm.dispose(), 'dsh-desktop-plugin-runtime: packaged pnpm')
}
