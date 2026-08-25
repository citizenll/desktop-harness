/** Serializable process-output contract shared by the host and browser UI. */
export type InstallOutputStream = 'command' | 'stdout' | 'stderr' | 'system'

export interface InstallOutputLine {
  id: number
  stream: InstallOutputStream
  text: string
}

export interface InstallOutputCandidate {
  stream: InstallOutputStream
  text: string
}
