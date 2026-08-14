/** Local Git provider for the managed Harness source repository seam. */

import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  SourceRepository,
  type ReadySourceRepositorySnapshot,
  type SourceCommitId,
  type SourceRemoteView,
  type SourceRepositoryMutationReceipt,
  type SourceRepositoryOperation,
  type SourceRepositorySnapshot,
  type SourceUpdateStrategy,
} from '@deepseek-ai/dsh-source-repository'
import type { SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import { deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'

/** Default official DeepSeek Harness Git repository. */
export const DEFAULT_OFFICIAL_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'

const CAPSULE_MANIFEST = 'manifest.json'
const CAPSULE_BUNDLE = 'repository.bundle'
const DEFAULT_TIMEOUT_MS = 5 * 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_GRACE_MS = 3_000

/** Git provider configuration. */
export interface Config {
  /** Managed Git working-tree root. */
  root: string
  /** Directory containing `manifest.json` and `repository.bundle`. */
  capsuleDir?: string
  /** Official fetch URL. */
  officialUrl?: string
  /** Fetch-only official remote name. */
  officialRemote?: string
  /** Official branch fetched and integrated by update operations. */
  officialBranch?: string
  /** User-owned push remote name. */
  userRemote?: string
  /** Git executable path or PATH name. */
  gitCommand?: string
  /** Allow network clone from the official repository when no capsule is available. */
  allowOfficialClone?: boolean
  /** Per-command deadline in milliseconds. */
  timeoutMs?: number
  /** Per-stream retained output cap. */
  maxOutputBytes?: number
  /** SIGTERM-to-SIGKILL grace period. */
  graceMs?: number
}

type ResolvedConfig = Required<Omit<Config, 'capsuleDir'>> & Pick<Config, 'capsuleDir'>

/** Validated source capsule metadata. */
interface SourceCapsuleManifest {
  readonly formatVersion: 1
  readonly branch: string
  readonly commit: string
}

interface GitResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`source-repository-git: ${name} must be a positive finite number`)
  }
}

function assertRemoteName(name: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`source-repository-git: ${name} is not a valid Git remote name`)
  }
}

function assertBranchName(name: string, value: string): void {
  if (value.length === 0
    || value.startsWith('.')
    || value.endsWith('.')
    || value.endsWith('/')
    || value.endsWith('.lock')
    || value.includes('..')
    || value.includes('@{')
    || /[\s~^:?*\[\\\]]/.test(value)
    || value.split('/').some(part => part.length === 0 || part.startsWith('.') || part.endsWith('.'))) {
    throw new Error(`source-repository-git: ${name} is not a valid Git branch name`)
  }
}

/**
 * Reject provider configuration that cannot safely construct Git operations.
 * @param config - provider configuration after schema defaults are applied.
 */
export function assertServiceableSourceRepositoryConfig(config: Config): void {
  const resolvedConfig = config as ResolvedConfig
  if (resolvedConfig.root.trim().length === 0) {
    throw new Error('source-repository-git: root must not be empty')
  }
  if (resolvedConfig.officialUrl.trim().length === 0) {
    throw new Error('source-repository-git: officialUrl must not be empty')
  }
  assertRemoteName('officialRemote', resolvedConfig.officialRemote)
  assertRemoteName('userRemote', resolvedConfig.userRemote)
  if (resolvedConfig.officialRemote === resolvedConfig.userRemote) {
    throw new Error('source-repository-git: officialRemote and userRemote must differ')
  }
  assertBranchName('officialBranch', resolvedConfig.officialBranch)
  if (resolvedConfig.gitCommand.trim().length === 0) {
    throw new Error('source-repository-git: gitCommand must not be empty')
  }
  assertPositiveFinite('timeoutMs', resolvedConfig.timeoutMs)
  assertPositiveFinite('maxOutputBytes', resolvedConfig.maxOutputBytes)
  assertPositiveFinite('graceMs', resolvedConfig.graceMs)
  if (resolvedConfig.timeoutMs > MAX_TIMER_DELAY_MS || resolvedConfig.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`source-repository-git: timeoutMs and graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

function output(reader: SubprocessOutputReader | undefined): string {
  if (reader === undefined) {
    /* v8 ignore next -- collect disposition guarantees a reader. */
    throw new Error('source-repository-git: subprocess provider omitted collected output')
  }
  return reader.readFrom(0).text
}

function sourceCommitId(value: string): SourceCommitId {
  return value as SourceCommitId
}

function safeRemoteUrl(value: string): string {
  if (isAbsolute(value) || /^\\\\/.test(value)) return value
  try {
    const parsed = new URL(value)
    if (parsed.username !== '' || parsed.password !== '') {
      parsed.username = 'redacted'
      parsed.password = ''
    }
    return parsed.toString()
  } catch {
    return value
  }
}

function repositoryIdentity(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '').replace(/\.git$/i, '')
  if (isAbsolute(trimmed) || /^\\\\/.test(trimmed)) {
    const path = normalize(resolve(trimmed))
    return `file:${process.platform === 'win32' ? path.toLocaleLowerCase() : path}`
  }
  try {
    const parsed = new URL(trimmed)
    return `${parsed.hostname.toLocaleLowerCase()}/${parsed.pathname.replace(/^\/+/, '').toLocaleLowerCase()}`
  } catch {
    const scp = /^(?:[^@]+@)?(?<host>[^:]+):(?<path>.+)$/.exec(trimmed)
    if (scp?.groups?.host !== undefined && scp.groups.path !== undefined) {
      return `${scp.groups.host.toLocaleLowerCase()}/${scp.groups.path.replace(/^\/+/, '').toLocaleLowerCase()}`
    }
    return trimmed.toLocaleLowerCase()
  }
}

function assertUserRemoteUrl(value: string, officialUrl: string): void {
  if (value.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('source-repository-git: user remote URL must not be empty or contain control characters')
  }
  try {
    const parsed = new URL(value)
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && (parsed.username !== '' || parsed.password !== '')) {
      throw new Error('source-repository-git: HTTP user remote URLs must not contain credentials')
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('source-repository-git:')) throw error
    // SCP-style SSH and local filesystem remotes are valid Git syntax.
  }
  if (repositoryIdentity(value) === repositoryIdentity(officialUrl)) {
    throw new Error('source-repository-git: the user remote must not be the official repository')
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Local Git implementation with serialized mutations and bounded subprocesses. */
export class GitSourceRepository extends SourceRepository {
  static inject = ['subprocess']

  static Config: z<Config> = z.object({
    root: z.string().required(),
    capsuleDir: z.string(),
    officialUrl: z.string().default(DEFAULT_OFFICIAL_URL),
    officialRemote: z.string().default('upstream'),
    officialBranch: z.string().default('master'),
    userRemote: z.string().default('origin'),
    gitCommand: z.string().default('git'),
    allowOfficialClone: z.boolean().default(true),
    timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
    maxOutputBytes: z.number().default(DEFAULT_MAX_OUTPUT_BYTES),
    graceMs: z.number().default(DEFAULT_GRACE_MS),
  })

  /** Validated provider configuration. */
  readonly config: ResolvedConfig
  /** Absolute managed Git working-tree root. */
  readonly root: string
  private readonly gitExecutable: Promise<string>
  private mutationTail: Promise<void> = Promise.resolve()
  private closing = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const resolvedConfig = config as ResolvedConfig
    assertServiceableSourceRepositoryConfig(resolvedConfig)
    this.config = resolvedConfig
    this.root = resolve(resolvedConfig.root)
    this.gitExecutable = ctx.subprocess.resolveExecutable(resolvedConfig.gitCommand)
    ctx.effect(() => async () => {
      this.closing = true
      await this.mutationTail
    }, 'source-repository-git: drain mutations')
  }

  private receipt(repository: ReadySourceRepositorySnapshot): SourceRepositoryMutationReceipt {
    return { repository, runtime: 'unchanged' }
  }

  private async runGit(
    args: readonly string[],
    options: { readonly cwd?: string; readonly allowFailure?: boolean } = {},
  ): Promise<GitResult> {
    const executable = await this.gitExecutable
    using d = deadline(undefined, this.config.timeoutMs, 'SOURCE_REPOSITORY_GIT_TIMEOUT')
    const handle = this.ctx.subprocess.spawn({
      argv: [executable, ...args],
      cwd: options.cwd ?? this.root,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.config.maxOutputBytes },
        stderr: { maxBytes: this.config.maxOutputBytes },
      },
      graceMs: this.config.graceMs,
      signal: d.signal,
      env: {
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        GIT_CONFIG_NOSYSTEM: '0',
      },
    })
    const outcome = await handle.done
    const result: GitResult = {
      ...outcome,
      stdout: output(handle.collected.stdout),
      stderr: output(handle.collected.stderr),
    }
    if (timeoutOf(d.signal, 'SOURCE_REPOSITORY_GIT_TIMEOUT') !== undefined) {
      throw new Error(`source-repository-git: Git operation timed out after ${String(this.config.timeoutMs)}ms`)
    }
    if (!options.allowFailure && result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `signal ${String(result.signal)}`
      throw new Error(`source-repository-git: Git operation failed: ${detail}`)
    }
    return result
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('source-repository-git: service is closing'))
    const task = this.mutationTail.then(operation)
    this.mutationTail = task.then(() => {}, () => {})
    return task
  }

  private async capsuleAvailable(): Promise<boolean> {
    const dir = this.config.capsuleDir
    return dir !== undefined
      && await pathExists(join(resolve(dir), CAPSULE_MANIFEST))
      && await pathExists(join(resolve(dir), CAPSULE_BUNDLE))
  }

  private officialView(url = this.config.officialUrl): SourceRemoteView & { readonly branch: string } {
    return {
      name: this.config.officialRemote,
      url: safeRemoteUrl(url),
      branch: this.config.officialBranch,
    }
  }

  private async rootState(): Promise<'missing' | 'invalid' | 'candidate'> {
    let rootStat
    try {
      rootStat = await stat(this.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      throw error
    }
    if (!rootStat.isDirectory()) return 'invalid'
    const entries = await readdir(this.root)
    if (entries.length === 0) return 'missing'
    return 'candidate'
  }

  private async remoteUrl(name: string, cwd = this.root): Promise<string | undefined> {
    const result = await this.runGit(['remote', 'get-url', name], { allowFailure: true, cwd })
    return result.exitCode === 0 ? result.stdout.trim() : undefined
  }

  private async operation(): Promise<SourceRepositoryOperation | null> {
    for (const [name, ref] of [
      ['merge', 'MERGE_HEAD'],
      ['cherry-pick', 'CHERRY_PICK_HEAD'],
      ['revert', 'REVERT_HEAD'],
    ] as const) {
      const result = await this.runGit(['rev-parse', '--verify', '-q', ref], { allowFailure: true })
      if (result.exitCode === 0) return name
    }
    for (const pathName of ['rebase-merge', 'rebase-apply']) {
      const pathResult = await this.runGit(['rev-parse', '--git-path', pathName])
      const path = resolve(this.root, pathResult.stdout.trim())
      if (await pathExists(path)) return 'rebase'
    }
    return null
  }

  private async divergence(): Promise<{ readonly ahead: number | null; readonly behind: number | null }> {
    const ref = `refs/remotes/${this.config.officialRemote}/${this.config.officialBranch}`
    const exists = await this.runGit(['show-ref', '--verify', '--quiet', ref], { allowFailure: true })
    if (exists.exitCode !== 0) return { ahead: null, behind: null }
    const result = await this.runGit(['rev-list', '--left-right', '--count', `HEAD...${ref}`])
    const match = /^(?<ahead>\d+)\s+(?<behind>\d+)$/.exec(result.stdout.trim())
    if (match?.groups === undefined) {
      /* v8 ignore next -- Git owns this stable two-integer output. */
      throw new Error(`source-repository-git: unexpected rev-list output: ${result.stdout}`)
    }
    return { ahead: Number(match.groups.ahead), behind: Number(match.groups.behind) }
  }

  private async inspectNow(): Promise<SourceRepositorySnapshot> {
    const rootState = await this.rootState()
    if (rootState === 'missing') {
      return {
        state: 'missing',
        root: this.root,
        capsuleAvailable: await this.capsuleAvailable(),
        official: this.officialView(),
      }
    }
    if (rootState === 'invalid') {
      return {
        state: 'invalid',
        root: this.root,
        reason: 'not-a-git-working-tree',
        official: this.officialView(),
      }
    }
    const workTree = await this.runGit(['rev-parse', '--is-inside-work-tree'], { allowFailure: true })
    if (workTree.exitCode !== 0 || workTree.stdout.trim() !== 'true') {
      return {
        state: 'invalid',
        root: this.root,
        reason: 'not-a-git-working-tree',
        official: this.officialView(),
      }
    }
    const [head, branch, status, currentOperation, officialUrl, userUrl, counts] = await Promise.all([
      this.runGit(['rev-parse', 'HEAD']),
      this.runGit(['symbolic-ref', '--short', '-q', 'HEAD'], { allowFailure: true }),
      this.runGit(['status', '--porcelain=v1', '--untracked-files=normal']),
      this.operation(),
      this.remoteUrl(this.config.officialRemote),
      this.remoteUrl(this.config.userRemote),
      this.divergence(),
    ])
    const user = userUrl === undefined || repositoryIdentity(userUrl) === repositoryIdentity(this.config.officialUrl)
      ? null
      : { name: this.config.userRemote, url: safeRemoteUrl(userUrl) }
    return {
      state: 'ready',
      root: this.root,
      branch: branch.exitCode === 0 ? branch.stdout.trim() : null,
      head: sourceCommitId(head.stdout.trim()),
      clean: status.stdout.length === 0,
      operation: currentOperation,
      official: this.officialView(officialUrl ?? this.config.officialUrl),
      user,
      ...counts,
    }
  }

  async inspect(): Promise<SourceRepositorySnapshot> {
    await this.mutationTail
    return this.inspectNow()
  }

  private async ready(options: { readonly clean: boolean; readonly branch: boolean }): Promise<ReadySourceRepositorySnapshot> {
    const snapshot = await this.inspectNow()
    if (snapshot.state !== 'ready') {
      throw new Error(`source-repository-git: source workspace is ${snapshot.state}`)
    }
    if (snapshot.operation !== null) {
      throw new Error(`source-repository-git: ${snapshot.operation} is already in progress`)
    }
    if (options.clean && !snapshot.clean) {
      throw new Error('source-repository-git: commit or discard working-tree changes before this operation')
    }
    if (options.branch && snapshot.branch === null) {
      throw new Error('source-repository-git: a named current branch is required')
    }
    return snapshot
  }

  private async ensureOfficialRemote(cwd = this.root): Promise<void> {
    const current = await this.remoteUrl(this.config.officialRemote, cwd)
    if (current === undefined) {
      await this.runGit(['remote', 'add', this.config.officialRemote, this.config.officialUrl], { cwd })
    } else if (current !== this.config.officialUrl) {
      await this.runGit(['remote', 'set-url', this.config.officialRemote, this.config.officialUrl], { cwd })
    }
  }

  private async abortMergeIfPresent(originalFailure: string): Promise<void> {
    const mergeHead = await this.runGit(['rev-parse', '--verify', '-q', 'MERGE_HEAD'], { allowFailure: true })
    if (mergeHead.exitCode !== 0) return
    const aborted = await this.runGit(['merge', '--abort'], { allowFailure: true })
    if (aborted.exitCode !== 0) {
      const abortDetail = aborted.stderr.trim() || aborted.stdout.trim() || `signal ${String(aborted.signal)}`
      throw new Error(`source-repository-git: ${originalFailure}; merge abort also failed: ${abortDetail}`)
    }
  }

  private async readCapsule(): Promise<{ readonly manifest: SourceCapsuleManifest; readonly bundle: string }> {
    const capsuleDir = this.config.capsuleDir
    if (capsuleDir === undefined) throw new Error('source-repository-git: no source capsule is configured')
    const absolute = resolve(capsuleDir)
    const manifestPath = join(absolute, CAPSULE_MANIFEST)
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (error) {
      throw new Error(`source-repository-git: invalid source capsule manifest: ${String(error)}`)
    }
    if (typeof parsed !== 'object' || parsed === null
      || (parsed as { formatVersion?: unknown }).formatVersion !== 1
      || typeof (parsed as { branch?: unknown }).branch !== 'string'
      || typeof (parsed as { commit?: unknown }).commit !== 'string') {
      throw new Error('source-repository-git: invalid source capsule manifest fields')
    }
    const manifest = parsed as SourceCapsuleManifest
    assertBranchName('capsule branch', manifest.branch)
    if (!/^[0-9a-f]{40,64}$/i.test(manifest.commit)) {
      throw new Error('source-repository-git: invalid source capsule commit')
    }
    const bundle = join(absolute, CAPSULE_BUNDLE)
    await access(bundle)
    return { manifest, bundle }
  }

  initialize(): Promise<SourceRepositoryMutationReceipt> {
    return this.serialize(async () => {
      const current = await this.inspectNow()
      if (current.state === 'ready') return this.receipt(current)
      if (current.state === 'invalid') {
        throw new Error(`source-repository-git: ${this.root} is not an empty directory or Git working tree`)
      }
      const parent = dirname(this.root)
      await mkdir(parent, { recursive: true })
      const stagingDir = await mkdtemp(join(parent, '.dsh-source-init-'))
      const stagedRoot = join(stagingDir, 'workspace')
      try {
        if (await this.capsuleAvailable()) {
          const capsule = await this.readCapsule()
          await this.runGit(['clone', '--branch', capsule.manifest.branch, capsule.bundle, stagedRoot], { cwd: parent })
          const clonedHead = await this.runGit(['rev-parse', 'HEAD'], { cwd: stagedRoot })
          if (clonedHead.stdout.trim().toLocaleLowerCase() !== capsule.manifest.commit.toLocaleLowerCase()) {
            throw new Error('source-repository-git: source capsule commit does not match the cloned branch head')
          }
          const capsuleOrigin = await this.remoteUrl('origin', stagedRoot)
          if (capsuleOrigin !== undefined && this.config.officialRemote !== 'origin') {
            await this.runGit(['remote', 'remove', 'origin'], { cwd: stagedRoot })
          }
          await this.runGit(['branch', '--unset-upstream'], { allowFailure: true, cwd: stagedRoot })
          await this.ensureOfficialRemote(stagedRoot)
        } else if (this.config.allowOfficialClone) {
          await this.runGit([
            'clone',
            '--origin', this.config.officialRemote,
            '--branch', this.config.officialBranch,
            this.config.officialUrl,
            stagedRoot,
          ], { cwd: parent })
        } else {
          throw new Error('source-repository-git: source capsule is unavailable and official clone is disabled')
        }
        if (await pathExists(this.root)) await rmdir(this.root)
        await rename(stagedRoot, this.root)
      } finally {
        await rm(stagingDir, { recursive: true, force: true })
      }
      const repository = await this.ready({ clean: true, branch: true })
      return this.receipt(repository)
    })
  }

  fetchOfficial(): Promise<SourceRepositoryMutationReceipt> {
    return this.serialize(async () => {
      await this.ready({ clean: false, branch: false })
      await this.ensureOfficialRemote()
      await this.runGit(['fetch', '--prune', this.config.officialRemote, this.config.officialBranch])
      return this.receipt(await this.ready({ clean: false, branch: false }))
    })
  }

  updateOfficial(strategy: SourceUpdateStrategy): Promise<SourceRepositoryMutationReceipt> {
    return this.serialize(async () => {
      await this.ready({ clean: true, branch: true })
      await this.ensureOfficialRemote()
      await this.runGit(['fetch', '--prune', this.config.officialRemote, this.config.officialBranch])
      const target = `refs/remotes/${this.config.officialRemote}/${this.config.officialBranch}`
      const args = strategy === 'ff-only'
        ? ['merge', '--ff-only', target]
        : ['merge', '--no-edit', target]
      let merged: GitResult
      try {
        merged = await this.runGit(args, { allowFailure: true })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        await this.abortMergeIfPresent(detail)
        throw error
      }
      if (merged.exitCode !== 0) {
        const detail = merged.stderr.trim() || merged.stdout.trim()
        await this.abortMergeIfPresent(`official update failed: ${detail}`)
        throw new Error(`source-repository-git: official update failed: ${detail}`)
      }
      return this.receipt(await this.ready({ clean: true, branch: true }))
    })
  }

  configureUserRemote(url: string): Promise<SourceRepositoryMutationReceipt> {
    return this.serialize(async () => {
      await this.ready({ clean: false, branch: false })
      assertUserRemoteUrl(url, this.config.officialUrl)
      const current = await this.remoteUrl(this.config.userRemote)
      if (current === undefined) {
        await this.runGit(['remote', 'add', this.config.userRemote, url])
      } else {
        await this.runGit(['remote', 'set-url', this.config.userRemote, url])
      }
      return this.receipt(await this.ready({ clean: false, branch: false }))
    })
  }

  pushUser(branch?: string): Promise<SourceRepositoryMutationReceipt> {
    return this.serialize(async () => {
      const snapshot = await this.ready({ clean: true, branch: true })
      if (snapshot.user === null) {
        throw new Error('source-repository-git: configure a user-owned remote before pushing')
      }
      const target = branch ?? snapshot.branch
      /* v8 ignore next -- ready(branch:true) guarantees a branch when no override is supplied. */
      if (target === null) throw new Error('source-repository-git: a destination branch is required')
      assertBranchName('push branch', target)
      await this.runGit([
        'push',
        '--set-upstream',
        this.config.userRemote,
        `HEAD:refs/heads/${target}`,
      ])
      return this.receipt(await this.ready({ clean: true, branch: true }))
    })
  }
}

export default GitSourceRepository
