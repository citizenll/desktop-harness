import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import GitSourceRepository, {
  assertServiceableSourceRepositoryConfig,
} from '../src/index.ts'

const execFileAsync = promisify(execFile)
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Harness Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Harness Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
}

let tempRoot: string
const contexts: Context[] = []

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, env: GIT_ENV })
  return result.stdout.trim()
}

async function createOfficialRepository(): Promise<{
  readonly bare: string
  readonly seed: string
  readonly head: string
}> {
  const bare = join(tempRoot, 'official.git')
  const seed = join(tempRoot, 'official-seed')
  await git(tempRoot, 'init', '--bare', bare)
  await mkdir(seed)
  await git(seed, 'init', '--initial-branch=master')
  await writeFile(join(seed, 'README.md'), 'foundation\n')
  await git(seed, 'add', 'README.md')
  await git(seed, 'commit', '-m', 'foundation')
  await git(seed, 'remote', 'add', 'origin', bare)
  await git(seed, 'push', '-u', 'origin', 'master')
  return { bare, seed, head: await git(seed, 'rev-parse', 'HEAD') }
}

async function createCapsule(seed: string, head: string): Promise<string> {
  const capsule = join(tempRoot, 'capsule')
  await mkdir(capsule)
  await git(seed, 'bundle', 'create', join(capsule, 'repository.bundle'), 'master')
  await writeFile(join(capsule, 'manifest.json'), JSON.stringify({
    formatVersion: 1,
    branch: 'master',
    commit: head,
  }) + '\n')
  return capsule
}

async function provider(root: string, officialUrl: string, capsuleDir?: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(GitSourceRepository, {
    root,
    ...(capsuleDir === undefined ? {} : { capsuleDir }),
    officialUrl,
    officialRemote: 'upstream',
    officialBranch: 'master',
    userRemote: 'origin',
    gitCommand: 'git',
    allowOfficialClone: true,
    timeoutMs: 30_000,
    maxOutputBytes: 256 * 1024,
    graceMs: 1_000,
  })
  return ctx
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-source-repository-'))
})

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await rm(tempRoot, { recursive: true, force: true })
})

describe('GitSourceRepository', () => {
  it('materializes the capsule, updates from upstream, and pushes only to the user remote', async () => {
    const official = await createOfficialRepository()
    const capsule = await createCapsule(official.seed, official.head)
    const managed = join(tempRoot, 'managed', 'deepseek-harness')
    const userBare = join(tempRoot, 'user.git')
    await git(tempRoot, 'init', '--bare', userBare)
    const ctx = await provider(managed, official.bare, capsule)

    await expect(ctx.sourceRepository.inspect()).resolves.toMatchObject({
      state: 'missing',
      root: managed,
      capsuleAvailable: true,
    })
    const initialized = await ctx.sourceRepository.initialize()
    expect(initialized.runtime).toBe('unchanged')
    expect(initialized.repository).toMatchObject({
      state: 'ready',
      branch: 'master',
      head: official.head,
      clean: true,
      user: null,
      official: { name: 'upstream', url: official.bare, branch: 'master' },
    })
    await expect(git(managed, 'remote')).resolves.toBe('upstream')

    await writeFile(join(official.seed, 'official.txt'), 'official update\n')
    await git(official.seed, 'add', 'official.txt')
    await git(official.seed, 'commit', '-m', 'official update')
    await git(official.seed, 'push', 'origin', 'master')
    const officialHead = await git(official.seed, 'rev-parse', 'HEAD')

    const fetched = await ctx.sourceRepository.fetchOfficial()
    expect(fetched.repository).toMatchObject({ ahead: 0, behind: 1 })
    const updated = await ctx.sourceRepository.updateOfficial('ff-only')
    expect(updated.repository).toMatchObject({ head: officialHead, ahead: 0, behind: 0 })

    await writeFile(join(managed, 'custom.txt'), 'user customization\n')
    await git(managed, 'add', 'custom.txt')
    await git(managed, 'commit', '-m', 'user customization')
    await ctx.sourceRepository.configureUserRemote(userBare)
    const pushed = await ctx.sourceRepository.pushUser('customized')
    const customHead = await git(managed, 'rev-parse', 'HEAD')
    expect(pushed.repository.user).toMatchObject({ name: 'origin', url: userBare })
    await expect(git(userBare, 'rev-parse', 'refs/heads/customized')).resolves.toBe(customHead)
    await expect(git(official.bare, 'rev-parse', 'refs/heads/customized')).rejects.toThrow()
  }, 30_000)

  it('refuses unsafe remotes and repository mutations while the worktree is dirty', async () => {
    const official = await createOfficialRepository()
    const capsule = await createCapsule(official.seed, official.head)
    const managed = join(tempRoot, 'managed')
    const userBare = join(tempRoot, 'user.git')
    await git(tempRoot, 'init', '--bare', userBare)
    const ctx = await provider(managed, official.bare, capsule)
    await ctx.sourceRepository.initialize()

    await expect(ctx.sourceRepository.configureUserRemote(official.bare)).rejects.toThrow('must not be the official repository')
    await expect(ctx.sourceRepository.configureUserRemote('https://token@example.com/user/repo.git'))
      .rejects.toThrow('must not contain credentials')
    await ctx.sourceRepository.configureUserRemote(userBare)
    await writeFile(join(managed, 'dirty.txt'), 'dirty\n')
    await expect(ctx.sourceRepository.updateOfficial('merge')).rejects.toThrow('commit or discard')
    await expect(ctx.sourceRepository.pushUser()).rejects.toThrow('commit or discard')
    await expect(ctx.sourceRepository.fetchOfficial()).resolves.toMatchObject({ runtime: 'unchanged' })
  }, 30_000)

  it('aborts conflicted official merges and preserves the pre-update working tree', async () => {
    const official = await createOfficialRepository()
    const capsule = await createCapsule(official.seed, official.head)
    const managed = join(tempRoot, 'managed')
    const ctx = await provider(managed, official.bare, capsule)
    await ctx.sourceRepository.initialize()

    await writeFile(join(managed, 'README.md'), 'user version\n')
    await git(managed, 'add', 'README.md')
    await git(managed, 'commit', '-m', 'customize readme')
    const userHead = await git(managed, 'rev-parse', 'HEAD')

    await writeFile(join(official.seed, 'README.md'), 'official version\n')
    await git(official.seed, 'add', 'README.md')
    await git(official.seed, 'commit', '-m', 'update readme upstream')
    await git(official.seed, 'push', 'origin', 'master')

    await expect(ctx.sourceRepository.updateOfficial('merge')).rejects.toThrow('official update failed')
    await expect(git(managed, 'rev-parse', 'HEAD')).resolves.toBe(userHead)
    await expect(git(managed, 'rev-parse', '--verify', '-q', 'MERGE_HEAD')).rejects.toThrow()
    await expect(git(managed, 'status', '--porcelain=v1')).resolves.toBe('')
    await expect(readFile(join(managed, 'README.md'), 'utf8')).resolves.toBe('user version\n')
  }, 30_000)

  it('rejects a non-fast-forward user publication instead of forcing remote history', async () => {
    const official = await createOfficialRepository()
    const capsule = await createCapsule(official.seed, official.head)
    const managed = join(tempRoot, 'managed')
    const userBare = join(tempRoot, 'user.git')
    const collaborator = join(tempRoot, 'collaborator')
    await git(tempRoot, 'init', '--bare', userBare)
    const ctx = await provider(managed, official.bare, capsule)
    await ctx.sourceRepository.initialize()
    await ctx.sourceRepository.configureUserRemote(userBare)
    await ctx.sourceRepository.pushUser('customized')

    await git(tempRoot, 'clone', '--branch', 'customized', userBare, collaborator)
    await writeFile(join(collaborator, 'collaborator.txt'), 'remote advance\n')
    await git(collaborator, 'add', 'collaborator.txt')
    await git(collaborator, 'commit', '-m', 'advance remote')
    await git(collaborator, 'push', 'origin', 'customized')
    const remoteHead = await git(userBare, 'rev-parse', 'refs/heads/customized')

    await writeFile(join(managed, 'local.txt'), 'divergent local work\n')
    await git(managed, 'add', 'local.txt')
    await git(managed, 'commit', '-m', 'diverge locally')
    await expect(ctx.sourceRepository.pushUser('customized')).rejects.toThrow('Git operation failed')
    await expect(git(userBare, 'rev-parse', 'refs/heads/customized')).resolves.toBe(remoteHead)
  }, 30_000)

  it('stages initialization and leaves the configured root untouched when capsule verification fails', async () => {
    const official = await createOfficialRepository()
    const capsule = await createCapsule(official.seed, official.head)
    const manifestPath = join(capsule, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { commit: string }
    manifest.commit = '0'.repeat(40)
    await writeFile(manifestPath, JSON.stringify(manifest) + '\n')
    const managed = join(tempRoot, 'managed')
    await mkdir(managed)
    const ctx = await provider(managed, official.bare, capsule)

    await expect(ctx.sourceRepository.initialize()).rejects.toThrow('does not match')
    await expect(ctx.sourceRepository.inspect()).resolves.toMatchObject({ state: 'missing', root: managed })
  }, 30_000)

  it('rejects occupied roots and invalid configuration before invoking Git', async () => {
    const official = await createOfficialRepository()
    const occupied = join(tempRoot, 'occupied')
    await mkdir(occupied)
    await writeFile(join(occupied, 'unrelated.txt'), 'preserve me\n')
    const ctx = await provider(occupied, official.bare)
    await expect(ctx.sourceRepository.inspect()).resolves.toMatchObject({
      state: 'invalid',
      reason: 'not-a-git-working-tree',
    })
    await expect(ctx.sourceRepository.initialize()).rejects.toThrow('not an empty directory')
    await expect(readFile(join(occupied, 'unrelated.txt'), 'utf8')).resolves.toBe('preserve me\n')

    expect(() => {
      assertServiceableSourceRepositoryConfig({
        root: occupied,
        officialUrl: official.bare,
        officialRemote: 'same',
        officialBranch: 'master',
        userRemote: 'same',
        gitCommand: 'git',
        allowOfficialClone: false,
        timeoutMs: 1,
        maxOutputBytes: 1,
        graceMs: 1,
      })
    }).toThrow('must differ')
  }, 30_000)
})
