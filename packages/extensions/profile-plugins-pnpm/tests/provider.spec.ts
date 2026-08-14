import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PnpmProfilePlugins, {
  assertServiceableProfilePluginsConfig,
} from '../src/index.ts'

const FAKE_PNPM = fileURLToPath(new URL('./fixtures/fake-pnpm.mjs', import.meta.url))
let tempRoot: string
let profileDir: string
const contexts: Context[] = []

async function writePackage(
  directory: string,
  manifest: Record<string, unknown>,
  patch?: string,
): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
  if (patch !== undefined) await writeFile(join(directory, 'cordis.patch.yml'), patch)
}

async function createProvider(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(PnpmProfilePlugins, {
    profile: 'fixture',
    pnpmCli: FAKE_PNPM,
    nodeCommand: process.execPath,
    timeoutMs: 30_000,
    maxOutputBytes: 128 * 1024,
    graceMs: 1_000,
  })
  return ctx
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-profile-plugins-'))
  vi.stubEnv('DSH_HOME', tempRoot)
  profileDir = join(tempRoot, 'profiles', 'fixture')
  await writePackage(profileDir, {
    name: 'dsh-profile-fixture',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  })
})

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  vi.unstubAllEnvs()
  await rm(tempRoot, { recursive: true, force: true })
})

describe('PnpmProfilePlugins', () => {
  it('classifies packages, reconciles bundle layers, and recomposes after every mutation', async () => {
    const bundleDir = join(tempRoot, 'fixtures', 'bundle')
    const libraryDir = join(tempRoot, 'fixtures', 'library')
    await writePackage(bundleDir, {
      name: '@fixture/theme-bundle',
      version: '1.2.3',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, '[]\n')
    await writePackage(libraryDir, { name: '@fixture/helper', version: '2.0.0' })
    const ctx = await createProvider()
    const changed: string[] = []
    ctx.on('profile-plugins/changed', (profile) => { changed.push(profile) })
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')

    await expect(ctx.profilePlugins.list()).resolves.toEqual({
      profile: 'fixture',
      profileDir,
      entries: [],
    })
    const installedBundle = await ctx.profilePlugins.install(bundleDir)
    expect(installedBundle).toMatchObject({
      activation: 'host-recomposed',
      plugins: {
        entries: [{
          packageName: '@fixture/theme-bundle',
          installedVersion: '1.2.3',
          kind: 'extension-bundle',
          active: true,
          mutable: true,
        }],
      },
    })
    expect(spawn.mock.calls[0]![0]).toMatchObject({
      argv: [process.execPath, FAKE_PNPM, '--reporter=append-only', 'add', '--save-exact', '--', bundleDir],
      cwd: profileDir,
      env: { ELECTRON_RUN_AS_NODE: '1', GIT_TERMINAL_PROMPT: '0' },
    })

    const installedLibrary = await ctx.profilePlugins.install(libraryDir)
    expect(installedLibrary.plugins.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ packageName: '@fixture/helper', kind: 'library', active: false }),
    ]))

    const updated = await ctx.profilePlugins.update('@fixture/theme-bundle')
    expect(updated.plugins.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ packageName: '@fixture/theme-bundle', installedVersion: '9.9.9', active: true }),
    ]))

    const removed = await ctx.profilePlugins.remove('@fixture/theme-bundle')
    expect(removed.plugins.entries).toEqual([
      expect.objectContaining({ packageName: '@fixture/helper', kind: 'library' }),
    ])
    expect(changed).toEqual(['fixture', 'fixture', 'fixture', 'fixture'])
  }, 30_000)

  it('rejects relative paths and unknown dependency mutations before spawning pnpm', async () => {
    const ctx = await createProvider()
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    await expect(ctx.profilePlugins.install('./plugin')).rejects.toThrow('must be absolute')
    await expect(ctx.profilePlugins.update('@fixture/missing')).rejects.toThrow('not a mutable profile dependency')
    await expect(ctx.profilePlugins.remove('@fixture/missing')).rejects.toThrow('not a mutable profile dependency')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('preserves the profile and suppresses recomposition when pnpm fails', async () => {
    const ctx = await createProvider()
    const changed = vi.fn()
    ctx.on('profile-plugins/changed', changed)
    await expect(ctx.profilePlugins.install('fail')).rejects.toThrow('fixture registry denied package')
    await expect(ctx.profilePlugins.list()).resolves.toMatchObject({ entries: [] })
    expect(changed).not.toHaveBeenCalled()
  })

  it('rejects invalid bounded-execution configuration at load', () => {
    expect(() => {
      assertServiceableProfilePluginsConfig({
        profile: 'fixture',
        pnpmCli: join(dirname(FAKE_PNPM), 'relative-does-not-matter'),
        nodeCommand: process.execPath,
        timeoutMs: 0,
        maxOutputBytes: 1,
        graceMs: 1,
      })
    }).toThrow('timeoutMs must be a positive finite number')
  })
})
