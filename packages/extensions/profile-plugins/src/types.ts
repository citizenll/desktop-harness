/** Public data vocabulary for installed profile extensions. */

/** Origin and activation role of one profile package. */
export type ProfilePluginKind = 'system-bundle' | 'extension-bundle' | 'library'

/** One package visible in the profile plugin center. */
export interface ProfilePluginEntry {
  /** Installed package name. */
  readonly packageName: string
  /** Profile dependency spec, or null for installation-owned system layers. */
  readonly requestedSpec: string | null
  /** Installed package version when declared by its manifest. */
  readonly installedVersion: string | null
  /** Package role derived from profile and package manifests. */
  readonly kind: ProfilePluginKind
  /** Whether the package currently contributes an active profile layer. */
  readonly active: boolean
  /** Whether update and removal are available from this profile. */
  readonly mutable: boolean
}

/** Point-in-time profile dependency and bundle-layer state. */
export interface ProfilePluginsSnapshot {
  readonly profile: string
  /** Absolute profile directory; exposed only through the privileged control plane. */
  readonly profileDir: string
  readonly entries: readonly ProfilePluginEntry[]
}

/** Result of one successful profile package mutation. */
export interface ProfilePluginMutationReceipt {
  readonly plugins: ProfilePluginsSnapshot
  /** Host profile recomposition completed before the mutation returned. */
  readonly activation: 'host-recomposed'
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One profile's package graph and reconciled bundle list changed.
     * @param profile - profile name whose inputs are ready to recompose.
     * @mode parallel
     */
    'profile-plugins/changed'(profile: string): Promise<void> | void
  }
}
