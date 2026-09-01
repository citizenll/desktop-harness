export const DESKTOP_CORE_PROTOCOL = 1
export const DESKTOP_CORE_DATA_SCHEMA = 1
export const DESKTOP_CORE_CHANNEL_SCHEMA = 1
export const DESKTOP_CORE_ARCHIVE_SCHEMA = 1

export type CoreArchiveFormat = 'tar.gz'

export interface CoreDescriptor {
  schemaVersion: typeof DESKTOP_CORE_ARCHIVE_SCHEMA
  generation: number
  coreId: string
  dshVersion: string
  patchsetHash: string
  desktopProtocol: number
  runnerVersion: string
  runnerAbi: string
  dataSchema: number
  platform: NodeJS.Platform
  arch: string
}

export interface CoreArchiveDescriptor {
  format: CoreArchiveFormat
  fileName: string
  size: number
  sha256: string
  url?: string
}

export interface CoreReleaseArtifact {
  core: CoreDescriptor
  archive: CoreArchiveDescriptor
}

export interface CoreChannelPayload {
  schemaVersion: typeof DESKTOP_CORE_CHANNEL_SCHEMA
  channel: 'stable'
  generation: number
  publishedAt: string
  expiresAt: string
  releaseNotes: string
  artifacts: Record<string, CoreReleaseArtifact>
}

export interface SignedCoreChannel {
  keyId: string
  payload: string
  signature: string
}

export type CoreUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'staged'
  | 'activating'
  | 'up-to-date'
  | 'error'
  | 'unsupported'

export type CoreUpdateSource = 'embedded' | 'remote'

export interface CoreUpdateStatus {
  phase: CoreUpdatePhase
  currentGeneration: number
  currentVersion: string
  availableGeneration?: number
  availableVersion?: string
  releaseNotes?: string
  downloadSize?: number
  percent?: number
  message?: string
  source?: CoreUpdateSource
  manual: boolean
}

export function coreTargetKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  return `${platform}-${arch}`
}
