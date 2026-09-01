import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() }
}))

vi.mock('electron', () => electron)

import { CoreUpdateManager } from '../src/main/core/core-update-manager'
import { corePublicKeyId } from '../src/main/core/core-manifest'
import type {
  CoreRuntimePaths,
  CoreRuntimeStore,
  StagedCoreRuntime
} from '../src/main/core/core-store'
import type { CoreChannelPayload, CoreDescriptor } from '../src/shared/core-update'

const roots: string[] = []

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function descriptor(generation: number): CoreDescriptor {
  return {
    schemaVersion: 1,
    generation,
    coreId: `dsh-core-g${generation}-win32-x64`,
    dshVersion: `0.1.${generation}`,
    patchsetHash: String(generation).repeat(64).slice(0, 64),
    desktopProtocol: 1,
    runnerVersion: 'v22.23.2',
    runnerAbi: '127',
    dataSchema: 1,
    platform: 'win32',
    arch: 'x64'
  }
}

function runtime(core: CoreDescriptor): CoreRuntimePaths {
  const root = `C:\\core\\${core.generation}`
  return {
    descriptor: core,
    root,
    runtimeRoot: `${root}\\runtime`,
    nodeModulesPath: `${root}\\runtime\\node_modules`,
    dshEntryPath: `${root}\\runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`,
    nodeEntryPath: `${root}\\runtime\\resources\\harness-node-entry.mjs`,
    pnpmEntryPath: `${root}\\runtime\\node_modules\\pnpm\\bin\\pnpm.cjs`,
    dshPatchPath: `${root}\\runtime\\resources\\dsh-desktop.patch.yml`,
    moduleFallbackHookPath: `${root}\\runtime\\resources\\runtime-module-fallback.mjs`
  }
}

async function fixture(installed: StagedCoreRuntime | undefined, embedded = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-core-manager-'))
  roots.push(root)
  const pair = generateKeyPairSync('ed25519')
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const publicKeyPath = join(root, 'public.pem')
  await writeFile(publicKeyPath, publicPem)
  const next = descriptor(2)
  const fileName = 'dsh-core-g2-win32-x64.tar.gz'
  const payload: CoreChannelPayload = {
    schemaVersion: 1,
    channel: 'stable',
    generation: 2,
    publishedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    releaseNotes: 'A governed Core update.',
    artifacts: {
      'win32-x64': {
        core: next,
        archive: {
          format: 'tar.gz',
          fileName,
          size: 1024,
          sha256: 'a'.repeat(64),
          url: `https://github.com/citizenll/desktop-harness/releases/download/core-g2/${fileName}`
        }
      }
    }
  }
  const payloadBytes = Buffer.from(JSON.stringify(payload))
  const response = JSON.stringify({
    keyId: corePublicKeyId(publicPem),
    payload: payloadBytes.toString('base64url'),
    signature: sign(null, payloadBytes, pair.privateKey).toString('base64url')
  })
  const current = runtime(descriptor(1))
  const recordHighestSeen = vi.fn(async () => undefined)
  const findInstalled = vi.fn(async () => installed)
  const artifact = payload.artifacts['win32-x64']!
  const stageEmbeddedCandidate = vi.fn(async () => ({
    ...runtime(next),
    staged: true as const
  }))
  const fetchImpl = vi.fn(async () => new Response(response, { status: 200 }))
  const store = {
    current: () => current,
    highestSeenGeneration: async () => 1,
    recordHighestSeen,
    findInstalled,
    embeddedCandidate: () => embedded ? { artifact, staged: installed } : undefined,
    stageEmbeddedCandidate
  } as unknown as CoreRuntimeStore
  const manager = new CoreUpdateManager({
    store,
    compatibility: { platform: 'win32', arch: 'x64', runnerAbi: '127' },
    publicKeyPath,
    downloadDirectory: join(root, 'downloads'),
    fetchImpl,
    activate: vi.fn(async () => true)
  })
  return {
    manager,
    next,
    current,
    recordHighestSeen,
    findInstalled,
    fetchImpl,
    stageEmbeddedCandidate
  }
}

describe('Core update manager', () => {
  it('automatically checks and prompts without downloading', async () => {
    const { manager, recordHighestSeen, findInstalled } = await fixture(undefined)

    await expect(manager.check(false)).resolves.toMatchObject({
      phase: 'available',
      currentGeneration: 1,
      availableGeneration: 2,
      manual: false
    })
    expect(recordHighestSeen).toHaveBeenCalledWith(2)
    expect(findInstalled).toHaveBeenCalledOnce()
  })

  it('reuses a verified staged Core after Desktop restarts', async () => {
    const next = descriptor(2)
    const staged = { ...runtime(next), staged: true as const }
    const { manager } = await fixture(staged)

    await expect(manager.check(false)).resolves.toMatchObject({
      phase: 'staged',
      currentGeneration: 1,
      availableGeneration: 2,
      percent: 100
    })
  })

  it('offers and prepares a newer embedded Core without a network request', async () => {
    const { manager, fetchImpl, stageEmbeddedCandidate } = await fixture(undefined, true)

    expect(manager.snapshot()).toMatchObject({
      phase: 'available',
      currentGeneration: 1,
      availableGeneration: 2,
      source: 'embedded'
    })
    await expect(manager.check(false)).resolves.toMatchObject({
      phase: 'available',
      source: 'embedded'
    })
    expect(fetchImpl).not.toHaveBeenCalled()

    await manager.download()
    expect(stageEmbeddedCandidate).toHaveBeenCalledOnce()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(manager.snapshot()).toMatchObject({
      phase: 'staged',
      availableGeneration: 2,
      percent: 100,
      source: 'embedded'
    })
  })
})
