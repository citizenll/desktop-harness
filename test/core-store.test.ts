import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { create as createTar } from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import { CoreRuntimeStore } from '../src/main/core/core-store'
import type { CoreDescriptor, CoreReleaseArtifact } from '../src/shared/core-update'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function descriptor(generation: number, patchsetCharacter = String(generation)): CoreDescriptor {
  return {
    schemaVersion: 1,
    generation,
    coreId: `dsh-core-g${generation}-${process.platform}-${process.arch}`,
    dshVersion: '0.1.1-rc.1',
    patchsetHash: patchsetCharacter.repeat(64).slice(0, 64),
    desktopProtocol: 1,
    runnerVersion: 'v22.23.2',
    runnerAbi: '127',
    dataSchema: 1,
    platform: process.platform,
    arch: process.arch
  }
}

async function createArtifact(
  root: string,
  generation: number,
  patchsetCharacter?: string,
  contentMarker = '',
  descriptorOverrides: Partial<CoreDescriptor> = {}
): Promise<{
  artifact: CoreReleaseArtifact
  archivePath: string
}> {
  const artifactRoot = join(root, `artifact-${generation}`)
  const runtime = join(artifactRoot, 'runtime')
  const files = [
    ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
    ['node_modules', 'pnpm', 'bin', 'pnpm.cjs'],
    ['node_modules', 'dsh-desktop-market', 'lib', 'index.js'],
    ['node_modules', 'dsh-desktop-market', 'client', 'client.js'],
    ['node_modules', 'dsh-desktop-plugin-runtime', 'index.js'],
    ['node_modules', 'dsh-desktop-verifier', 'lib', 'index.js'],
    ['node_modules', 'dsh-desktop-verifier', 'client', 'client.js'],
    ['resources', 'harness-node-entry.mjs'],
    ['resources', 'runtime-module-fallback.mjs'],
    ['resources', 'dsh-desktop.patch.yml']
  ]
  for (const parts of files) {
    const target = join(runtime, ...parts)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `fixture ${generation} ${contentMarker} ${parts.join('/')}`)
  }
  const core = { ...descriptor(generation, patchsetCharacter), ...descriptorOverrides }
  if (
    descriptorOverrides.coreId === undefined &&
    (descriptorOverrides.platform !== undefined || descriptorOverrides.arch !== undefined)
  ) {
    core.coreId = `dsh-core-g${generation}-${core.platform}-${core.arch}`
  }
  await writeFile(join(artifactRoot, 'core.json'), `${JSON.stringify(core)}\n`)
  const fileName = `dsh-core-g${generation}-${core.platform}-${core.arch}.tar.gz`
  const archivePath = join(root, fileName)
  await createTar(
    { cwd: artifactRoot, file: archivePath, gzip: true, portable: true, noMtime: true },
    ['core.json', 'runtime']
  )
  const bytes = await readFile(archivePath)
  return {
    archivePath,
    artifact: {
      core,
      archive: {
        format: 'tar.gz',
        fileName,
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex')
      }
    }
  }
}

async function fixtureStore() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-core-store-'))
  roots.push(root)
  const baselineDirectory = join(root, 'baseline')
  await mkdir(baselineDirectory, { recursive: true })
  const baseline = await createArtifact(root, 1)
  await writeFile(
    join(baselineDirectory, 'manifest.json'),
    `${JSON.stringify(baseline.artifact)}\n`
  )
  await writeFile(
    join(baselineDirectory, baseline.artifact.archive.fileName),
    await readFile(baseline.archivePath)
  )
  const storeRoot = join(root, 'store-root')
  const compatibility = { platform: process.platform, arch: process.arch, runnerAbi: '127' }
  const store = new CoreRuntimeStore({ root: storeRoot, baselineDirectory, compatibility })
  return { root, store, storeRoot, baselineDirectory, compatibility }
}

describe('Core Runtime store transaction', () => {
  it('installs the governed baseline and commits a candidate only after activation', async () => {
    const { root, store } = await fixtureStore()
    const active = await store.initialize()
    expect(active.descriptor.generation).toBe(1)

    const next = await createArtifact(root, 2)
    const staged = await store.stageArchive(next.artifact, next.archivePath)
    expect(store.current().descriptor.generation).toBe(1)
    expect(await store.findInstalled(next.artifact)).toMatchObject({
      descriptor: { generation: 2 },
      staged: true
    })
    await store.commit(staged)
    expect(store.current().descriptor.generation).toBe(2)

    const pointer = JSON.parse(
      await readFile(join(root, 'store-root', 'active.json'), 'utf8')
    )
    expect(pointer).toMatchObject({ generation: 2, coreId: staged.descriptor.coreId })
  }, 15_000)

  it('rejects corrupted bytes without changing the active pointer', async () => {
    const { root, store } = await fixtureStore()
    await store.initialize()
    const next = await createArtifact(root, 2)
    await writeFile(next.archivePath, Buffer.from('not the signed archive'))

    await expect(store.stageArchive(next.artifact, next.archivePath)).rejects.toThrow(
      'size mismatch'
    )
    expect(store.current().descriptor.generation).toBe(1)
  })

  it('fails closed when rollback-protection metadata is corrupted', async () => {
    const { root, store } = await fixtureStore()
    await store.initialize()
    const highestSeenPath = join(root, 'store-root', 'highest-seen.json')
    await writeFile(highestSeenPath, '{"schemaVersion":1,"generation":"broken"}\n')

    await expect(store.recordHighestSeen(2)).rejects.toThrow(
      'highest-seen Core record is invalid'
    )
    expect(JSON.parse(await readFile(highestSeenPath, 'utf8'))).toMatchObject({
      generation: 'broken'
    })
  })

  it('keeps a compatible active Core until the user activates a newer embedded baseline', async () => {
    const { root, store, storeRoot, baselineDirectory, compatibility } = await fixtureStore()
    await store.initialize()
    const newerBaseline = await createArtifact(root, 2)
    await writeFile(
      join(baselineDirectory, 'manifest.json'),
      `${JSON.stringify(newerBaseline.artifact)}\n`
    )
    await writeFile(
      join(baselineDirectory, newerBaseline.artifact.archive.fileName),
      await readFile(newerBaseline.archivePath)
    )

    const restarted = new CoreRuntimeStore({ root: storeRoot, baselineDirectory, compatibility })
    expect((await restarted.initialize()).descriptor.generation).toBe(1)
    expect(await restarted.highestSeenGeneration()).toBe(2)
    const candidate = restarted.embeddedCandidate()
    expect(candidate?.artifact.core.generation).toBe(2)
    expect(candidate?.staged).toBeUndefined()
    const staged = await restarted.stageEmbeddedCandidate(candidate!.artifact)
    expect(staged.descriptor.generation).toBe(2)
    expect(restarted.current().descriptor.generation).toBe(1)
  })

  it('rejects two different immutable artifacts with the same generation', async () => {
    const { root, store, storeRoot, baselineDirectory, compatibility } = await fixtureStore()
    await store.initialize()
    const conflicting = await createArtifact(root, 1, 'a')
    await writeFile(
      join(baselineDirectory, 'manifest.json'),
      `${JSON.stringify(conflicting.artifact)}\n`
    )
    await writeFile(
      join(baselineDirectory, conflicting.artifact.archive.fileName),
      await readFile(conflicting.archivePath)
    )

    const restarted = new CoreRuntimeStore({ root: storeRoot, baselineDirectory, compatibility })
    await expect(restarted.initialize()).rejects.toThrow('conflicts with the installed immutable generation')
  })

  it('rejects an embedded baseline that conflicts with an unactivated staged generation', async () => {
    const { root, store, storeRoot, baselineDirectory, compatibility } = await fixtureStore()
    await store.initialize()
    const staged = await createArtifact(root, 2, '2', 'downloaded')
    await store.stageArchive(staged.artifact, staged.archivePath)
    const conflictingBaseline = await createArtifact(root, 2, '2', 'embedded')
    await writeFile(
      join(baselineDirectory, 'manifest.json'),
      `${JSON.stringify(conflictingBaseline.artifact)}\n`
    )
    await writeFile(
      join(baselineDirectory, conflictingBaseline.artifact.archive.fileName),
      await readFile(conflictingBaseline.archivePath)
    )

    const restarted = new CoreRuntimeStore({ root: storeRoot, baselineDirectory, compatibility })
    await expect(restarted.initialize()).rejects.toThrow('conflicts with the installed immutable generation')
  })

  it('rejects repacked bytes even when the Core descriptor is unchanged', async () => {
    const { root, store } = await fixtureStore()
    await store.initialize()
    const first = await createArtifact(root, 2, '2', 'first')
    await store.stageArchive(first.artifact, first.archivePath)
    const repacked = await createArtifact(root, 2, '2', 'repacked')

    await expect(store.stageArchive(repacked.artifact, repacked.archivePath)).rejects.toThrow(
      'already contains different bytes'
    )
    expect(store.current().descriptor.generation).toBe(1)
  })

  it('switches to a newer embedded baseline only when the active protocol is incompatible', async () => {
    const { root, store, storeRoot, baselineDirectory } = await fixtureStore()
    await store.initialize()
    const protocolTwo = await createArtifact(root, 2, undefined, '', { desktopProtocol: 2 })
    const protocolTwoBytes = await readFile(protocolTwo.archivePath)
    await writeFile(
      join(baselineDirectory, 'manifest.json'),
      `${JSON.stringify(protocolTwo.artifact)}\n`
    )
    await writeFile(
      join(baselineDirectory, protocolTwo.artifact.archive.fileName),
      protocolTwoBytes
    )

    const restarted = new CoreRuntimeStore({
      root: storeRoot,
      baselineDirectory,
      compatibility: {
        platform: process.platform,
        arch: process.arch,
        runnerAbi: '127',
        desktopProtocol: 2
      }
    })
    expect((await restarted.initialize()).descriptor.generation).toBe(2)
  })

  it('keeps same-generation artifacts isolated when the Desktop architecture changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-core-target-switch-'))
    roots.push(root)
    const storeRoot = join(root, 'store-root')
    const oldPlatform = process.platform === 'darwin' ? 'win32' : 'darwin'
    const oldArch = 'x64'
    const oldBaselineDirectory = join(root, 'old-baseline')
    await mkdir(oldBaselineDirectory, { recursive: true })
    const oldBaseline = await createArtifact(root, 1, undefined, 'old-target', {
      platform: oldPlatform,
      arch: oldArch
    })
    await writeFile(
      join(oldBaselineDirectory, 'manifest.json'),
      `${JSON.stringify(oldBaseline.artifact)}\n`
    )
    await writeFile(
      join(oldBaselineDirectory, oldBaseline.artifact.archive.fileName),
      await readFile(oldBaseline.archivePath)
    )
    const oldStore = new CoreRuntimeStore({
      root: storeRoot,
      baselineDirectory: oldBaselineDirectory,
      compatibility: { platform: oldPlatform, arch: oldArch, runnerAbi: '127' }
    })
    expect((await oldStore.initialize()).descriptor.coreId).toBe(oldBaseline.artifact.core.coreId)

    const currentBaselineDirectory = join(root, 'current-baseline')
    await mkdir(currentBaselineDirectory, { recursive: true })
    const currentBaseline = await createArtifact(root, 1, undefined, 'current-target')
    await writeFile(
      join(currentBaselineDirectory, 'manifest.json'),
      `${JSON.stringify(currentBaseline.artifact)}\n`
    )
    await writeFile(
      join(currentBaselineDirectory, currentBaseline.artifact.archive.fileName),
      await readFile(currentBaseline.archivePath)
    )
    const currentStore = new CoreRuntimeStore({
      root: storeRoot,
      baselineDirectory: currentBaselineDirectory,
      compatibility: { platform: process.platform, arch: process.arch, runnerAbi: '127' }
    })

    expect((await currentStore.initialize()).descriptor.coreId).toBe(
      currentBaseline.artifact.core.coreId
    )
    await expect(
      readFile(join(storeRoot, 'store', oldBaseline.artifact.core.coreId, 'core.json'), 'utf8')
    ).resolves.toBeTruthy()
    await expect(
      readFile(join(storeRoot, 'store', currentBaseline.artifact.core.coreId, 'core.json'), 'utf8')
    ).resolves.toBeTruthy()
  })
})
