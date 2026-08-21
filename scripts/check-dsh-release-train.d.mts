export interface DshReleaseTrainResult {
  version: string
  directPackages: number
  resolvedPackages: number
  patches: number
}

export function checkDshReleaseTrain(root?: string): Promise<DshReleaseTrainResult>
