import { createHash, createPublicKey, verify } from 'node:crypto'
import {
  coreTargetKey,
  DESKTOP_CORE_ARCHIVE_SCHEMA,
  DESKTOP_CORE_CHANNEL_SCHEMA,
  DESKTOP_CORE_DATA_SCHEMA,
  DESKTOP_CORE_PROTOCOL,
  type CoreArchiveDescriptor,
  type CoreChannelPayload,
  type CoreDescriptor,
  type CoreReleaseArtifact,
  type SignedCoreChannel
} from '../../shared/core-update'

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const CORE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/iu
const ARCHIVE_FILE_PATTERN = /^dsh-core-g[1-9][0-9]*-(?:win32|darwin|linux)-[a-z0-9_-]+\.tar\.gz$/u
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u
const MAX_CHANNEL_BYTES = 512 * 1024

export interface CoreCompatibility {
  platform: NodeJS.Platform
  arch: string
  runnerAbi: string
  desktopProtocol?: number
  dataSchema?: number
}

export interface VerifiedCoreChannel {
  payload: CoreChannelPayload
  artifact?: CoreReleaseArtifact
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(
  value: unknown,
  field: string,
  options: { max?: number; pattern?: RegExp } = {}
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string.`)
  }
  if (value.length > (options.max ?? 4_096)) throw new Error(`${field} is too long.`)
  if (options.pattern && !options.pattern.test(value)) {
    throw new Error(`${field} has an invalid format.`)
  }
  return value
}

function requiredInteger(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${field} must be an integer greater than or equal to ${minimum}.`)
  }
  return value as number
}

function requiredTimestamp(value: unknown, field: string): string {
  const text = requiredString(value, field, { max: 64 })
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${field} must be an ISO timestamp.`)
  return text
}

function requiredPlatform(value: unknown): NodeJS.Platform {
  const platform = requiredString(value, 'core.platform', { max: 32 })
  if (!['win32', 'darwin', 'linux'].includes(platform)) {
    throw new Error(`Unsupported core platform: ${platform}.`)
  }
  return platform as NodeJS.Platform
}

export function parseCoreDescriptor(value: unknown): CoreDescriptor {
  if (!isRecord(value)) throw new Error('Core descriptor must be an object.')
  const schemaVersion = requiredInteger(value.schemaVersion, 'core.schemaVersion', 1)
  if (schemaVersion !== DESKTOP_CORE_ARCHIVE_SCHEMA) {
    throw new Error(`Unsupported core archive schema ${schemaVersion}.`)
  }
  const desktopProtocol = requiredInteger(value.desktopProtocol, 'core.desktopProtocol', 1)
  const dataSchema = requiredInteger(value.dataSchema, 'core.dataSchema', 1)
  const generation = requiredInteger(value.generation, 'core.generation', 1)
  const platform = requiredPlatform(value.platform)
  const arch = requiredString(value.arch, 'core.arch', {
    max: 32,
    pattern: /^[a-z0-9_-]+$/u
  })
  const coreId = requiredString(value.coreId, 'core.coreId', {
    max: 128,
    pattern: CORE_ID_PATTERN
  })
  const expectedCoreId = `dsh-core-g${generation}-${platform}-${arch}`
  if (coreId !== expectedCoreId) {
    throw new Error(`core.coreId must be ${expectedCoreId}.`)
  }

  return {
    schemaVersion: DESKTOP_CORE_ARCHIVE_SCHEMA,
    generation,
    coreId,
    dshVersion: requiredString(value.dshVersion, 'core.dshVersion', { max: 128 }),
    patchsetHash: requiredString(value.patchsetHash, 'core.patchsetHash', {
      max: 64,
      pattern: SHA256_PATTERN
    }),
    desktopProtocol,
    runnerVersion: requiredString(value.runnerVersion, 'core.runnerVersion', { max: 64 }),
    runnerAbi: requiredString(value.runnerAbi, 'core.runnerAbi', { max: 32 }),
    dataSchema,
    platform,
    arch
  }
}

export function parseCoreArchiveDescriptor(value: unknown): CoreArchiveDescriptor {
  if (!isRecord(value)) throw new Error('Core archive descriptor must be an object.')
  const format = requiredString(value.format, 'archive.format', { max: 16 })
  if (format !== 'tar.gz') throw new Error(`Unsupported core archive format ${format}.`)
  const url = value.url === undefined
    ? undefined
    : requiredString(value.url, 'archive.url', { max: 2_048 })
  return {
    format,
    fileName: requiredString(value.fileName, 'archive.fileName', {
      max: 255,
      pattern: ARCHIVE_FILE_PATTERN
    }),
    size: requiredInteger(value.size, 'archive.size', 1),
    sha256: requiredString(value.sha256, 'archive.sha256', {
      max: 64,
      pattern: SHA256_PATTERN
    }),
    ...(url ? { url } : {})
  }
}

export function parseCoreReleaseArtifact(value: unknown): CoreReleaseArtifact {
  if (!isRecord(value)) throw new Error('Core release artifact must be an object.')
  return {
    core: parseCoreDescriptor(value.core),
    archive: parseCoreArchiveDescriptor(value.archive)
  }
}

export function parseCoreChannelPayload(value: unknown): CoreChannelPayload {
  if (!isRecord(value)) throw new Error('Core channel payload must be an object.')
  const schemaVersion = requiredInteger(value.schemaVersion, 'channel.schemaVersion', 1)
  if (schemaVersion !== DESKTOP_CORE_CHANNEL_SCHEMA) {
    throw new Error(`Unsupported core channel schema ${schemaVersion}.`)
  }
  if (value.channel !== 'stable') throw new Error('Only the stable core channel is supported.')
  if (!isRecord(value.artifacts)) throw new Error('channel.artifacts must be an object.')
  const artifacts: Record<string, CoreReleaseArtifact> = {}
  for (const [target, artifact] of Object.entries(value.artifacts)) {
    if (!/^(?:win32|darwin|linux)-[a-z0-9_-]+$/u.test(target)) {
      throw new Error(`Invalid core target key ${target}.`)
    }
    artifacts[target] = parseCoreReleaseArtifact(artifact)
  }

  const generation = requiredInteger(value.generation, 'channel.generation', 1)
  for (const artifact of Object.values(artifacts)) {
    if (artifact.core.generation !== generation) {
      throw new Error('Every core artifact must match channel.generation.')
    }
  }

  return {
    schemaVersion: DESKTOP_CORE_CHANNEL_SCHEMA,
    channel: 'stable',
    generation,
    publishedAt: requiredTimestamp(value.publishedAt, 'channel.publishedAt'),
    expiresAt: requiredTimestamp(value.expiresAt, 'channel.expiresAt'),
    releaseNotes: requiredString(value.releaseNotes, 'channel.releaseNotes', {
      max: 32 * 1024
    }),
    artifacts
  }
}

export function parseSignedCoreChannel(value: unknown): SignedCoreChannel {
  if (!isRecord(value)) throw new Error('Signed core channel must be an object.')
  return {
    keyId: requiredString(value.keyId, 'channel.keyId', { max: 128 }),
    payload: requiredString(value.payload, 'channel.payload', {
      max: MAX_CHANNEL_BYTES,
      pattern: BASE64URL_PATTERN
    }),
    signature: requiredString(value.signature, 'channel.signature', {
      max: 512,
      pattern: BASE64URL_PATTERN
    })
  }
}

export function corePublicKeyId(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Core channel public key must be Ed25519.')
  }
  const der = key.export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(der).digest('hex').slice(0, 32)
}

export function verifySignedCoreChannel(
  raw: unknown,
  publicKeyPem: string,
  compatibility: CoreCompatibility,
  now = Date.now()
): VerifiedCoreChannel {
  const envelope = parseSignedCoreChannel(raw)
  const expectedKeyId = corePublicKeyId(publicKeyPem)
  if (envelope.keyId !== expectedKeyId) {
    throw new Error(`Core channel key ${envelope.keyId} is not trusted.`)
  }
  const payloadBytes = Buffer.from(envelope.payload, 'base64url')
  if (payloadBytes.length === 0 || payloadBytes.length > MAX_CHANNEL_BYTES) {
    throw new Error('Core channel payload size is invalid.')
  }
  const signature = Buffer.from(envelope.signature, 'base64url')
  if (!verify(null, payloadBytes, publicKeyPem, signature)) {
    throw new Error('Core channel signature is invalid.')
  }

  let payloadValue: unknown
  try {
    payloadValue = JSON.parse(payloadBytes.toString('utf8'))
  } catch {
    throw new Error('Core channel payload is not valid JSON.')
  }
  const payload = parseCoreChannelPayload(payloadValue)
  const publishedAt = Date.parse(payload.publishedAt)
  const expiresAt = Date.parse(payload.expiresAt)
  if (publishedAt > now + 5 * 60_000) throw new Error('Core channel publication time is in the future.')
  if (expiresAt <= publishedAt) throw new Error('Core channel expiration precedes publication.')
  if (expiresAt <= now) throw new Error('Core channel has expired.')

  const artifact = payload.artifacts[coreTargetKey(compatibility.platform, compatibility.arch)]
  if (!artifact) return { payload }
  assertCoreCompatibility(artifact.core, compatibility)
  if (!artifact.archive.url) throw new Error('Core update archive URL is missing.')
  assertTrustedCoreArtifactUrl(artifact.archive.url, artifact.core.generation)
  if (new URL(artifact.archive.url).pathname.split('/').at(-1) !== artifact.archive.fileName) {
    throw new Error('Core archive URL does not match the signed file name.')
  }
  return { payload, artifact }
}

export function assertCoreCompatibility(
  core: CoreDescriptor,
  compatibility: CoreCompatibility
): void {
  if (core.platform !== compatibility.platform || core.arch !== compatibility.arch) {
    throw new Error(
      `Core target ${core.platform}-${core.arch} does not match ${compatibility.platform}-${compatibility.arch}.`
    )
  }
  if (core.runnerAbi !== compatibility.runnerAbi) {
    throw new Error(`Core runner ABI ${core.runnerAbi} does not match ${compatibility.runnerAbi}.`)
  }
  if (core.desktopProtocol !== (compatibility.desktopProtocol ?? DESKTOP_CORE_PROTOCOL)) {
    throw new Error('Core Desktop protocol is incompatible with this application.')
  }
  if (core.dataSchema !== (compatibility.dataSchema ?? DESKTOP_CORE_DATA_SCHEMA)) {
    throw new Error('Core data schema is incompatible with this application.')
  }
}

export function assertTrustedCoreArtifactUrl(url: string, generation: number): void {
  const parsed = new URL(url)
  const prefix = `/citizenll/desktop-harness/releases/download/core-g${generation}/`
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || !parsed.pathname.startsWith(prefix)) {
    throw new Error('Core archive URL is outside the trusted release namespace.')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Core archive URL must be immutable and contain no credentials or query data.')
  }
}

export function sameCoreDescriptor(left: CoreDescriptor, right: CoreDescriptor): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.generation === right.generation &&
    left.coreId === right.coreId &&
    left.dshVersion === right.dshVersion &&
    left.patchsetHash === right.patchsetHash &&
    left.desktopProtocol === right.desktopProtocol &&
    left.runnerVersion === right.runnerVersion &&
    left.runnerAbi === right.runnerAbi &&
    left.dataSchema === right.dataSchema &&
    left.platform === right.platform &&
    left.arch === right.arch
  )
}

export function sameCoreReleaseArtifact(
  left: CoreReleaseArtifact,
  right: CoreReleaseArtifact
): boolean {
  return (
    sameCoreDescriptor(left.core, right.core) &&
    left.archive.format === right.archive.format &&
    left.archive.fileName === right.archive.fileName &&
    left.archive.size === right.archive.size &&
    left.archive.sha256 === right.archive.sha256
  )
}
