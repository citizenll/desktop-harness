import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CoreDescriptor } from '../../shared/core-update'
import {
  DESKTOP_CORE_ARCHIVE_SCHEMA,
  DESKTOP_CORE_DATA_SCHEMA,
  DESKTOP_CORE_PROTOCOL
} from '../../shared/core-update'

const execFileAsync = promisify(execFile)

export interface CoreRunnerMetadata {
  schemaVersion: 1
  version: string
  abi: string
  platform: NodeJS.Platform
  arch: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseCoreRunnerMetadata(value: unknown): CoreRunnerMetadata {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('The Core Runner metadata has an unsupported schema.')
  }
  if (typeof value.version !== 'string' || !/^v\d+\.\d+\.\d+/u.test(value.version)) {
    throw new Error('The Core Runner version is invalid.')
  }
  if (typeof value.abi !== 'string' || !/^\d+$/u.test(value.abi)) {
    throw new Error('The Core Runner ABI is invalid.')
  }
  if (!['win32', 'darwin', 'linux'].includes(String(value.platform))) {
    throw new Error('The Core Runner platform is invalid.')
  }
  if (typeof value.arch !== 'string' || value.arch.length === 0) {
    throw new Error('The Core Runner architecture is invalid.')
  }
  return {
    schemaVersion: 1,
    version: value.version,
    abi: value.abi,
    platform: value.platform as NodeJS.Platform,
    arch: value.arch
  }
}

export async function readCoreRunnerMetadata(path: string): Promise<CoreRunnerMetadata> {
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown
  return parseCoreRunnerMetadata(value)
}

export async function queryCoreRunnerMetadata(
  nodeExecutablePath: string
): Promise<CoreRunnerMetadata> {
  await access(nodeExecutablePath)
  const expression =
    'JSON.stringify({schemaVersion:1,version:process.version,abi:process.versions.modules,platform:process.platform,arch:process.arch})'
  const { stdout } = await execFileAsync(
    nodeExecutablePath,
    ['-p', expression],
    { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 }
  )
  return parseCoreRunnerMetadata(JSON.parse(stdout.trim()) as unknown)
}

export function assertRunnerTarget(metadata: CoreRunnerMetadata): void {
  if (metadata.platform !== process.platform || metadata.arch !== process.arch) {
    throw new Error(
      `Core Runner target ${metadata.platform}-${metadata.arch} does not match ${process.platform}-${process.arch}.`
    )
  }
}

export async function createDevelopmentCoreDescriptor(options: {
  projectRoot: string
  runner: CoreRunnerMetadata
}): Promise<CoreDescriptor> {
  const packageManifest = JSON.parse(
    await readFile(join(options.projectRoot, 'package.json'), 'utf8')
  ) as { dependencies?: Record<string, string> }
  const release = JSON.parse(
    await readFile(join(options.projectRoot, 'core', 'core-release.json'), 'utf8')
  ) as { generation?: unknown }
  if (!Number.isSafeInteger(release.generation) || Number(release.generation) < 1) {
    throw new Error('core/core-release.json must declare a positive generation.')
  }
  const dshVersion = packageManifest.dependencies?.['@deepseek-ai/dsh']
  if (!dshVersion) throw new Error('package.json does not declare the DSH Core version.')
  const patchset = await readFile(join(options.projectRoot, 'patches', 'manifest.json'))
  const patchsetHash = createHash('sha256').update(patchset).digest('hex')
  const generation = Number(release.generation)
  return {
    schemaVersion: DESKTOP_CORE_ARCHIVE_SCHEMA,
    generation,
    coreId: `dsh-core-dev-g${generation}-${options.runner.platform}-${options.runner.arch}`,
    dshVersion,
    patchsetHash,
    desktopProtocol: DESKTOP_CORE_PROTOCOL,
    runnerVersion: options.runner.version,
    runnerAbi: options.runner.abi,
    dataSchema: DESKTOP_CORE_DATA_SCHEMA,
    platform: options.runner.platform,
    arch: options.runner.arch
  }
}
