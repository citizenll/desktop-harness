/** pnpm provider for installed DeepSeek Harness profile extensions. */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_PROFILE_BUNDLES,
  initProfile,
  PROFILE_TEMPLATES,
  readProfileManifest,
  reconcileProfileBundles,
  resolveBundleDir,
  resolveProfileDir,
  resolveProfilePackageDir,
} from '@deepseek-ai/dsh-app-boot'
import {
  ProfilePlugins,
  type ProfilePluginEntry,
  type ProfilePluginMutationReceipt,
  type ProfilePluginsSnapshot,
} from '@deepseek-ai/dsh-profile-plugins'
import type { SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import { deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'

const NAME = 'profile-plugins-pnpm'
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))
const DEFAULT_TIMEOUT_MS = 10 * 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024
const DEFAULT_GRACE_MS = 3_000

/** pnpm profile manager configuration. */
export interface Config {
  /** Active profile name managed by this provider. */
  profile: string
  /** Absolute pnpm CLI entry; defaults to this package's pinned pnpm dependency. */
  pnpmCli?: string
  /** Node or Electron executable used to run the pnpm entry. */
  nodeCommand?: string
  /** Per-command deadline in milliseconds. */
  timeoutMs?: number
  /** Per-stream retained output cap. */
  maxOutputBytes?: number
  /** TERM-to-KILL grace period. */
  graceMs?: number
}

type ResolvedConfig = Required<Config>

interface CommandResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

function bundledPnpmCli(): string {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('pnpm')), 'bin', 'pnpm.mjs')
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${NAME}: ${name} must be a positive finite number`)
  }
}

/**
 * Reject configuration that cannot execute bounded package-manager operations.
 * @param config - provider configuration after schema defaults are applied.
 */
export function assertServiceableProfilePluginsConfig(config: Config): void {
  const resolvedConfig = config as ResolvedConfig
  resolveProfileDir(resolvedConfig.profile)
  if (!isAbsolute(resolvedConfig.pnpmCli)) throw new Error(`${NAME}: pnpmCli must be absolute`)
  if (resolvedConfig.nodeCommand.trim().length === 0) throw new Error(`${NAME}: nodeCommand must not be empty`)
  assertPositiveFinite('timeoutMs', resolvedConfig.timeoutMs)
  assertPositiveFinite('maxOutputBytes', resolvedConfig.maxOutputBytes)
  assertPositiveFinite('graceMs', resolvedConfig.graceMs)
  if (resolvedConfig.timeoutMs > MAX_TIMER_DELAY_MS || resolvedConfig.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${NAME}: timeoutMs and graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

function output(reader: SubprocessOutputReader | undefined): string {
  if (reader === undefined) {
    /* v8 ignore next -- collect disposition guarantees a reader. */
    throw new Error(`${NAME}: subprocess provider omitted collected output`)
  }
  return reader.readFrom(0).text
}

function packageVersion(packageDir: string): string | null {
  const manifest = readProfileManifest(NAME, packageDir)
  return typeof manifest.version === 'string' ? manifest.version : null
}

function assertInstallSpec(spec: string): string {
  const normalized = spec.trim()
  if (normalized.length === 0 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${NAME}: package spec must not be empty or contain control characters`)
  }
  const pathSpec = /^(?:file|link):(?<path>.*)$/.exec(normalized)?.groups?.path ?? normalized
  if (/^\.{1,2}(?:[/\\]|$)/.test(pathSpec)) {
    throw new Error(`${NAME}: filesystem package specs must be absolute`)
  }
  return normalized
}

/** Serialized profile dependency manager backed by a pinned pnpm runtime. */
export class PnpmProfilePlugins extends ProfilePlugins {
  static inject = ['subprocess']

  static Config: z<Config> = z.object({
    profile: z.string().required(),
    pnpmCli: z.string().default(bundledPnpmCli()),
    nodeCommand: z.string().default(process.execPath),
    timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
    maxOutputBytes: z.number().default(DEFAULT_MAX_OUTPUT_BYTES),
    graceMs: z.number().default(DEFAULT_GRACE_MS),
  })

  /** Validated provider configuration. */
  readonly config: ResolvedConfig
  /** Absolute directory of the managed profile. */
  readonly profileDir: string
  private readonly nodeExecutable: Promise<string>
  private mutationTail: Promise<void> = Promise.resolve()
  private closing = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const resolvedConfig = config as ResolvedConfig
    assertServiceableProfilePluginsConfig(resolvedConfig)
    this.config = { ...resolvedConfig, pnpmCli: resolve(resolvedConfig.pnpmCli) }
    this.profileDir = resolveProfileDir(resolvedConfig.profile)
    if (!existsSync(join(this.profileDir, 'package.json'))) {
      initProfile(this.profileDir, PROFILE_TEMPLATES[resolvedConfig.profile] ?? DEFAULT_PROFILE_BUNDLES)
    }
    this.nodeExecutable = ctx.subprocess.resolveExecutable(resolvedConfig.nodeCommand)
    ctx.effect(() => async () => {
      this.closing = true
      await this.mutationTail
    }, `${NAME}: drain mutations`)
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error(`${NAME}: service is closing`))
    const task = this.mutationTail.then(operation)
    this.mutationTail = task.then(() => {}, () => {})
    return task
  }

  private async runPnpm(args: readonly string[]): Promise<CommandResult> {
    const executable = await this.nodeExecutable
    using d = deadline(undefined, this.config.timeoutMs, 'PROFILE_PLUGINS_PNPM_TIMEOUT')
    const handle = this.ctx.subprocess.spawn({
      argv: [executable, this.config.pnpmCli, '--reporter=append-only', ...args],
      cwd: this.profileDir,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.config.maxOutputBytes },
        stderr: { maxBytes: this.config.maxOutputBytes },
      },
      graceMs: this.config.graceMs,
      signal: d.signal,
      env: {
        CI: '1',
        ELECTRON_RUN_AS_NODE: '1',
        GIT_TERMINAL_PROMPT: '0',
        npm_config_update_notifier: 'false',
      },
    })
    const outcome = await handle.done
    const result: CommandResult = {
      ...outcome,
      stdout: output(handle.collected.stdout),
      stderr: output(handle.collected.stderr),
    }
    if (timeoutOf(d.signal, 'PROFILE_PLUGINS_PNPM_TIMEOUT') !== undefined) {
      throw new Error(`${NAME}: pnpm timed out after ${String(this.config.timeoutMs)}ms`)
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `signal ${String(result.signal)}`
      throw new Error(`${NAME}: pnpm failed: ${detail}`)
    }
    return result
  }

  private dependencyEntry(
    packageName: string,
    requestedSpec: string,
    active: boolean,
  ): ProfilePluginEntry {
    const packageDir = resolveProfilePackageDir(packageName, this.profileDir)
    if (packageDir === undefined) {
      throw new Error(`${NAME}: dependency ${JSON.stringify(packageName)} is not installed in ${this.profileDir}`)
    }
    return {
      packageName,
      requestedSpec,
      installedVersion: packageVersion(packageDir),
      kind: active ? 'extension-bundle' : 'library',
      active,
      mutable: true,
    }
  }

  private listNow(): ProfilePluginsSnapshot {
    const manifest = readProfileManifest(NAME, this.profileDir)
    const dependencies = manifest.dependencies ?? {}
    const bundleNames = manifest.dsh?.profile?.bundles ?? []
    const entries: ProfilePluginEntry[] = []
    for (const packageName of bundleNames) {
      const requestedSpec = dependencies[packageName]
      if (requestedSpec !== undefined) {
        entries.push(this.dependencyEntry(packageName, requestedSpec, true))
        continue
      }
      const packageDir = resolveBundleDir(NAME, packageName, INSTALL_ANCHOR, this.profileDir)
      entries.push({
        packageName,
        requestedSpec: null,
        installedVersion: packageVersion(packageDir),
        kind: 'system-bundle',
        active: true,
        mutable: false,
      })
    }
    const active = new Set(bundleNames)
    for (const [packageName, requestedSpec] of Object.entries(dependencies)) {
      if (!active.has(packageName)) entries.push(this.dependencyEntry(packageName, requestedSpec, false))
    }
    return { profile: this.config.profile, profileDir: this.profileDir, entries }
  }

  private async mutate(args: readonly string[]): Promise<ProfilePluginMutationReceipt> {
    const before = readProfileManifest(NAME, this.profileDir)
    await this.runPnpm(args)
    reconcileProfileBundles(NAME, before, this.profileDir, INSTALL_ANCHOR)
    await this.ctx.parallel('profile-plugins/changed', this.config.profile)
    return { plugins: this.listNow(), activation: 'host-recomposed' }
  }

  async list(): Promise<ProfilePluginsSnapshot> {
    await this.mutationTail
    return this.listNow()
  }

  install(spec: string): Promise<ProfilePluginMutationReceipt> {
    return this.serialize(async () => this.mutate(['add', '--save-exact', '--', assertInstallSpec(spec)]))
  }

  update(packageName: string): Promise<ProfilePluginMutationReceipt> {
    return this.serialize(async () => {
      const dependencies = readProfileManifest(NAME, this.profileDir).dependencies ?? {}
      if (!Object.hasOwn(dependencies, packageName)) {
        throw new Error(`${NAME}: ${JSON.stringify(packageName)} is not a mutable profile dependency`)
      }
      return this.mutate(['update', '--latest', '--', packageName])
    })
  }

  remove(packageName: string): Promise<ProfilePluginMutationReceipt> {
    return this.serialize(async () => {
      const dependencies = readProfileManifest(NAME, this.profileDir).dependencies ?? {}
      if (!Object.hasOwn(dependencies, packageName)) {
        throw new Error(`${NAME}: ${JSON.stringify(packageName)} is not a mutable profile dependency`)
      }
      return this.mutate(['remove', '--', packageName])
    })
  }
}

export default PnpmProfilePlugins
