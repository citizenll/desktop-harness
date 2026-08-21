import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildDesktopToolchainEnvironment,
  ensureDesktopToolchainShims
} from './desktop-toolchain'

const PROFILE = 'web'
const OPERATION_TIMEOUT_MS = 15 * 60 * 1000
const MAX_OUTPUT_BYTES = 32 * 1024

export interface ProfilePluginCommandOptions {
  dshHome: string
  dshEntryPath: string
  nodeExecutablePath: string
  pnpmEntryPath: string
  environment?: NodeJS.ProcessEnv
}

export interface ProfilePluginCommandResult {
  ok: boolean
  detail?: string
}

export function buildProfilePluginRemoveArguments(
  dshEntryPath: string,
  pluginName: string
): string[] {
  return [dshEntryPath, 'plugin', '--profile', PROFILE, 'remove', pluginName]
}

export async function ensureProfilePnpmShim(options: ProfilePluginCommandOptions): Promise<string> {
  return ensureDesktopToolchainShims(options)
}

export function buildProfilePluginCommandEnvironment(
  environment: NodeJS.ProcessEnv,
  shimDirectory: string,
  nodeExecutablePath: string,
  dshHome = environment.DSH_HOME ?? ''
): NodeJS.ProcessEnv {
  return buildDesktopToolchainEnvironment({
    dshHome,
    shimDirectory,
    nodeExecutablePath,
    environment,
    ci: true
  })
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || !child.pid) return
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

export async function removeProfilePluginWithDsh(
  options: ProfilePluginCommandOptions,
  pluginName: string
): Promise<ProfilePluginCommandResult> {
  const requiredPaths = [
    options.dshEntryPath,
    options.nodeExecutablePath,
    options.pnpmEntryPath
  ]
  if (requiredPaths.some((path) => !existsSync(path))) {
    return { ok: false, detail: 'The bundled DSH, Node.js, or pnpm runtime was not found.' }
  }

  const profileDirectory = join(options.dshHome, 'profiles', PROFILE)
  if (!existsSync(profileDirectory)) {
    return { ok: false, detail: 'The web profile directory was not found.' }
  }

  try {
    const shimDirectory = await ensureProfilePnpmShim(options)
    const environment = buildProfilePluginCommandEnvironment(
      options.environment ?? process.env,
      shimDirectory,
      options.nodeExecutablePath,
      options.dshHome
    )

    const child = spawn(
      options.nodeExecutablePath,
      buildProfilePluginRemoveArguments(options.dshEntryPath, pluginName),
      {
        cwd: profileDirectory,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32'
      }
    )

    let output = ''
    const append = (chunk: Buffer | string): void => {
      output = `${output}${chunk.toString()}`.slice(-MAX_OUTPUT_BYTES)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, OPERATION_TIMEOUT_MS)

    try {
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once('error', reject)
          child.once('exit', (code, signal) => resolve({ code, signal }))
        }
      )
      if (timedOut) {
        return { ok: false, detail: 'Plugin removal timed out after 15 minutes.' }
      }
      if (exit.code !== 0) {
        const detail = output.trim().split(/\r?\n/u).at(-1)?.slice(0, 800)
        return {
          ok: false,
          detail:
            detail ||
            `Plugin removal exited with ${exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`}.`
        }
      }
      return { ok: true }
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}
