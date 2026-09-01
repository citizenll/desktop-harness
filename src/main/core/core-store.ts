import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat
} from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'
import { extract } from 'tar'
import type { CoreDescriptor, CoreReleaseArtifact } from '../../shared/core-update'
import { writeJsonAtomic } from '../state/atomic-file'
import {
  assertCoreCompatibility,
  parseCoreDescriptor,
  parseCoreReleaseArtifact,
  sameCoreDescriptor,
  sameCoreReleaseArtifact,
  type CoreCompatibility
} from './core-manifest'

interface ActiveCorePointer {
  schemaVersion: 1
  generation: number
  coreId: string
}

interface HighestSeenPointer {
  schemaVersion: 1
  generation: number
}

export interface CoreRuntimePaths {
  descriptor: CoreDescriptor
  root: string
  runtimeRoot: string
  nodeModulesPath: string
  dshEntryPath: string
  nodeEntryPath: string
  pnpmEntryPath: string
  dshPatchPath: string
  moduleFallbackHookPath: string
}

export interface StagedCoreRuntime extends CoreRuntimePaths {
  staged: true
}

export interface EmbeddedCoreCandidate {
  artifact: CoreReleaseArtifact
  staged?: StagedCoreRuntime
}

export interface CoreRuntimeStoreOptions {
  root: string
  baselineDirectory: string
  compatibility: CoreCompatibility
}

const REQUIRED_RUNTIME_FILES = [
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
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${path} is not valid JSON.`)
  }
}

async function readJsonIfPresent(path: string): Promise<unknown | undefined> {
  try {
    return await readJson(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function parseActivePointer(value: unknown): ActiveCorePointer {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('The active Core pointer has an unsupported schema.')
  }
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 1) {
    throw new Error('The active Core pointer has an invalid generation.')
  }
  if (typeof value.coreId !== 'string' || value.coreId.length === 0) {
    throw new Error('The active Core pointer has an invalid core id.')
  }
  return {
    schemaVersion: 1,
    generation: value.generation as number,
    coreId: value.coreId
  }
}

async function sha256File(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256')
  let size = 0
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk: string | Buffer) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += bytes.length
      hash.update(bytes)
    })
    stream.once('error', reject)
    stream.once('end', resolve)
  })
  return { sha256: hash.digest('hex'), size }
}

function assertArchiveEntryPath(entryPath: string): void {
  const unix = entryPath.replaceAll('\\', '/')
  if (
    !unix ||
    unix.includes('\0') ||
    unix.startsWith('/') ||
    /^[a-zA-Z]:\//u.test(unix) ||
    unix.split('/').some((part) => part === '..')
  ) {
    throw new Error(`Core archive contains an unsafe path: ${entryPath}`)
  }
}

async function assertNoLinks(root: string): Promise<void> {
  const stack = [root]
  while (stack.length > 0) {
    const directory = stack.pop()!
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name)
      const metadata = await lstat(target)
      if (metadata.isSymbolicLink()) {
        throw new Error(`Core archive contains a symbolic link: ${relative(root, target)}`)
      }
      if (metadata.isDirectory()) stack.push(target)
    }
  }
}

function safeStoreDirectory(storeRoot: string, coreId: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(coreId)) {
    throw new Error(`Refusing invalid Core store id ${coreId}.`)
  }
  const target = join(storeRoot, coreId)
  const rel = relative(storeRoot, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes(`${sep}..${sep}`)) {
    throw new Error(`Refusing unsafe Core store path ${target}.`)
  }
  return target
}

export class CoreRuntimeStore {
  private readonly activePath: string
  private readonly highestSeenPath: string
  private readonly storeRoot: string
  private readonly stagingRoot: string
  private baselineArtifact?: CoreReleaseArtifact
  private baselineRuntime?: StagedCoreRuntime
  private currentRuntime?: CoreRuntimePaths

  constructor(private readonly options: CoreRuntimeStoreOptions) {
    this.activePath = join(options.root, 'active.json')
    this.highestSeenPath = join(options.root, 'highest-seen.json')
    this.storeRoot = join(options.root, 'store')
    this.stagingRoot = join(options.root, 'staging')
  }

  current(): CoreRuntimePaths {
    if (!this.currentRuntime) throw new Error('The Core Runtime store has not been initialized.')
    return this.currentRuntime
  }

  async initialize(): Promise<CoreRuntimePaths> {
    await mkdir(this.storeRoot, { recursive: true })
    await mkdir(this.stagingRoot, { recursive: true })
    await this.clearAbandonedStaging()

    const baseline = await this.readBaselineArtifact()
    this.baselineArtifact = baseline
    assertCoreCompatibility(baseline.core, this.options.compatibility)
    try {
      this.baselineRuntime = await this.findInstalled(baseline)
    } catch (error) {
      throw new Error(
        `Embedded Core generation ${baseline.core.generation} conflicts with the installed immutable generation.`,
        { cause: error }
      )
    }
    const activeValue = await readJsonIfPresent(this.activePath)
    if (activeValue === undefined) {
      const staged = await this.installBaseline(baseline)
      await this.commit(staged)
      return this.current()
    }

    const pointer = parseActivePointer(activeValue)
    const active = await this.resolveInstalled(pointer.generation, pointer.coreId)
    if (active.descriptor.coreId !== pointer.coreId) {
      throw new Error('The active Core pointer does not match the installed Core descriptor.')
    }
    try {
      assertCoreCompatibility(active.descriptor, this.options.compatibility)
    } catch (error) {
      if (baseline.core.generation < active.descriptor.generation) throw error
      const staged = await this.installBaseline(baseline)
      await this.commit(staged)
      return this.current()
    }

    this.currentRuntime = active
    await this.recordHighestSeen(Math.max(baseline.core.generation, active.descriptor.generation))
    return this.current()
  }

  embeddedCandidate(): EmbeddedCoreCandidate | undefined {
    const baseline = this.baselineArtifact
    const current = this.currentRuntime
    if (!baseline || !current || baseline.core.generation <= current.descriptor.generation) {
      return undefined
    }
    return {
      artifact: baseline,
      staged: this.baselineRuntime
    }
  }

  async stageEmbeddedCandidate(
    expected: CoreReleaseArtifact
  ): Promise<StagedCoreRuntime> {
    const baseline = this.baselineArtifact ?? await this.readBaselineArtifact()
    if (!sameCoreReleaseArtifact(baseline, expected)) {
      throw new Error('The embedded Core baseline changed after startup.')
    }
    if (baseline.core.generation <= this.current().descriptor.generation) {
      throw new Error('The embedded Core baseline is not newer than the active Core.')
    }
    const staged = await this.installBaseline(baseline)
    this.baselineArtifact = baseline
    this.baselineRuntime = staged
    return staged
  }

  async highestSeenGeneration(): Promise<number> {
    const value = await readJsonIfPresent(this.highestSeenPath)
    if (value === undefined) return this.currentRuntime?.descriptor.generation ?? 0
    if (
      !isRecord(value) ||
      value.schemaVersion !== 1 ||
      !Number.isSafeInteger(value.generation) ||
      (value.generation as number) < 1
    ) {
      throw new Error('The highest-seen Core record is invalid.')
    }
    return value.generation as number
  }

  async recordHighestSeen(generation: number): Promise<void> {
    const current = await this.highestSeenGeneration()
    if (generation <= current) return
    const pointer: HighestSeenPointer = { schemaVersion: 1, generation }
    await writeJsonAtomic(this.highestSeenPath, pointer)
  }

  async stageArchive(
    artifact: CoreReleaseArtifact,
    archivePath: string
  ): Promise<StagedCoreRuntime> {
    assertCoreCompatibility(artifact.core, this.options.compatibility)
    const archive = await sha256File(archivePath)
    if (archive.size !== artifact.archive.size) {
      throw new Error(
        `Core archive size mismatch: expected ${artifact.archive.size}, received ${archive.size}.`
      )
    }
    if (archive.sha256 !== artifact.archive.sha256) {
      throw new Error('Core archive SHA-256 does not match the signed channel.')
    }

    const operationRoot = join(this.stagingRoot, randomUUID())
    const extractedRoot = join(operationRoot, 'extracted')
    await mkdir(extractedRoot, { recursive: true })
    try {
      await extract({
        cwd: extractedRoot,
        file: archivePath,
        gzip: true,
        strict: true,
        preservePaths: false,
        filter: (entryPath, entry) => {
          assertArchiveEntryPath(entryPath)
          const entryType = 'type' in entry ? String(entry.type) : undefined
          if (!entryType || !['File', 'OldFile', 'ContiguousFile', 'Directory'].includes(entryType)) {
            throw new Error(`Core archive contains a forbidden ${entryType ?? 'unknown'} entry: ${entryPath}`)
          }
          return true
        }
      })
      await assertNoLinks(extractedRoot)
      const descriptor = parseCoreDescriptor(await readJson(join(extractedRoot, 'core.json')))
      if (!sameCoreDescriptor(descriptor, artifact.core)) {
        throw new Error('Extracted Core descriptor does not match the signed channel.')
      }
      await this.assertRuntimeLayout(extractedRoot)
      await writeJsonAtomic(join(extractedRoot, 'artifact.json'), installedArtifact(artifact))

      const destination = safeStoreDirectory(this.storeRoot, descriptor.coreId)
      const existing = await stat(destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (existing !== undefined) {
        if (!existing.isDirectory()) {
          throw new Error(`Core generation ${descriptor.generation} is not an installed directory.`)
        }
        const existingArtifact = await this.readInstalledArtifact(destination)
        if (!sameCoreReleaseArtifact(existingArtifact, artifact)) {
          throw new Error(`Core generation ${descriptor.generation} already contains different bytes.`)
        }
        await rm(operationRoot, { recursive: true, force: true })
        return {
          ...(await this.resolveInstalled(descriptor.generation, descriptor.coreId)),
          staged: true
        }
      }

      await rename(extractedRoot, destination)
      await rm(operationRoot, { recursive: true, force: true })
      return {
        ...(await this.resolveInstalled(descriptor.generation, descriptor.coreId)),
        staged: true
      }
    } catch (error) {
      await rm(operationRoot, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async commit(runtime: CoreRuntimePaths): Promise<void> {
    assertCoreCompatibility(runtime.descriptor, this.options.compatibility)
    const resolved = await this.resolveInstalled(
      runtime.descriptor.generation,
      runtime.descriptor.coreId
    )
    if (!sameCoreDescriptor(resolved.descriptor, runtime.descriptor)) {
      throw new Error('Refusing to commit a Core descriptor that is not installed.')
    }
    const pointer: ActiveCorePointer = {
      schemaVersion: 1,
      generation: runtime.descriptor.generation,
      coreId: runtime.descriptor.coreId
    }
    await this.recordHighestSeen(runtime.descriptor.generation)
    await writeJsonAtomic(this.activePath, pointer)
    this.currentRuntime = resolved
  }

  async findInstalled(
    artifact: CoreReleaseArtifact
  ): Promise<StagedCoreRuntime | undefined> {
    assertCoreCompatibility(artifact.core, this.options.compatibility)
    const destination = safeStoreDirectory(this.storeRoot, artifact.core.coreId)
    const metadata = await stat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (metadata === undefined) return undefined
    if (!metadata.isDirectory()) {
      throw new Error(`Core generation ${artifact.core.generation} is not an installed directory.`)
    }
    const existingArtifact = await this.readInstalledArtifact(destination)
    if (!sameCoreReleaseArtifact(existingArtifact, artifact)) {
      throw new Error(`Core generation ${artifact.core.generation} already contains different bytes.`)
    }
    return {
      ...(await this.resolveInstalled(artifact.core.generation, artifact.core.coreId)),
      staged: true
    }
  }

  private async installBaseline(
    artifact: CoreReleaseArtifact
  ): Promise<StagedCoreRuntime> {
    const archivePath = join(this.options.baselineDirectory, artifact.archive.fileName)
    await access(archivePath)
    return this.stageArchive(artifact, archivePath)
  }

  private async readBaselineArtifact(): Promise<CoreReleaseArtifact> {
    const value = await readJson(join(this.options.baselineDirectory, 'manifest.json'))
    const artifact = parseCoreReleaseArtifact(value)
    if (artifact.archive.url !== undefined) {
      throw new Error('The embedded Core baseline must not contain a network URL.')
    }
    return artifact
  }

  private async resolveInstalled(
    generation: number,
    coreId: string
  ): Promise<CoreRuntimePaths> {
    const root = safeStoreDirectory(this.storeRoot, coreId)
    const metadata = await stat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!metadata?.isDirectory()) {
      throw new Error(`Committed Core generation ${generation} is missing from the Core store.`)
    }
    const descriptor = parseCoreDescriptor(await readJson(join(root, 'core.json')))
    if (descriptor.generation !== generation) {
      throw new Error(`Core directory ${generation} contains generation ${descriptor.generation}.`)
    }
    if (descriptor.coreId !== coreId) {
      throw new Error(`Core directory ${coreId} contains ${descriptor.coreId}.`)
    }
    const artifact = await this.readInstalledArtifact(root)
    if (!sameCoreDescriptor(artifact.core, descriptor)) {
      throw new Error(`Core directory ${generation} has inconsistent installed metadata.`)
    }
    await this.assertRuntimeLayout(root)
    const runtimeRoot = join(root, 'runtime')
    return {
      descriptor,
      root,
      runtimeRoot,
      nodeModulesPath: join(runtimeRoot, 'node_modules'),
      dshEntryPath: join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      nodeEntryPath: join(runtimeRoot, 'resources', 'harness-node-entry.mjs'),
      pnpmEntryPath: join(runtimeRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
      dshPatchPath: join(runtimeRoot, 'resources', 'dsh-desktop.patch.yml'),
      moduleFallbackHookPath: join(runtimeRoot, 'resources', 'runtime-module-fallback.mjs')
    }
  }

  private async assertRuntimeLayout(coreRoot: string): Promise<void> {
    const runtimeRoot = join(coreRoot, 'runtime')
    for (const segments of REQUIRED_RUNTIME_FILES) {
      const target = join(runtimeRoot, ...segments)
      const metadata = await stat(target).catch(() => undefined)
      if (!metadata?.isFile()) {
        throw new Error(`Core Runtime is missing ${join('runtime', ...segments)}.`)
      }
    }
  }

  private async readInstalledArtifact(coreRoot: string): Promise<CoreReleaseArtifact> {
    const artifact = parseCoreReleaseArtifact(await readJson(join(coreRoot, 'artifact.json')))
    if (artifact.archive.url !== undefined) {
      throw new Error('Installed Core metadata must not retain a network URL.')
    }
    return artifact
  }

  private async clearAbandonedStaging(): Promise<void> {
    if (!existsSync(this.stagingRoot)) return
    for (const entry of await readdir(this.stagingRoot, { withFileTypes: true })) {
      await rm(join(this.stagingRoot, entry.name), { recursive: true, force: true })
    }
  }
}

function installedArtifact(artifact: CoreReleaseArtifact): CoreReleaseArtifact {
  return {
    core: { ...artifact.core },
    archive: {
      format: artifact.archive.format,
      fileName: artifact.archive.fileName,
      size: artifact.archive.size,
      sha256: artifact.archive.sha256
    }
  }
}

export function createDevelopmentCoreRuntime(options: {
  projectRoot: string
  descriptor: CoreDescriptor
}): CoreRuntimePaths {
  const runtimeRoot = normalize(options.projectRoot)
  return {
    descriptor: options.descriptor,
    root: runtimeRoot,
    runtimeRoot,
    nodeModulesPath: join(runtimeRoot, 'node_modules'),
    dshEntryPath: join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    nodeEntryPath: join(runtimeRoot, 'build', 'harness-node-entry.mjs'),
    pnpmEntryPath: join(runtimeRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    dshPatchPath: join(runtimeRoot, 'build', 'dsh-desktop.patch.yml'),
    moduleFallbackHookPath: join(runtimeRoot, 'build', 'runtime-module-fallback.mjs')
  }
}
