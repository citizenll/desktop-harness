export type RuntimePhase =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'failed'

export type RuntimeFailureKind = 'package-manager'

export interface RuntimeSnapshot {
  phase: RuntimePhase
  message: string
  failureKind?: RuntimeFailureKind
  launchDirectory?: string
  logs: string[]
  url?: string
}

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error'
  | 'unsupported'

export interface UpdateStatus {
  phase: UpdatePhase
  currentVersion: string
  availableVersion?: string
  percent?: number
  message?: string
  manual: boolean
}
