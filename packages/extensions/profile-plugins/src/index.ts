/** Service Definition for installed DeepSeek Harness profile extensions. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { ProfilePluginMutationReceipt, ProfilePluginsSnapshot } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    profilePlugins: ProfilePlugins
  }
}

/**
 * Profile dependency manager. Providers own package-manager execution,
 * manifest reconciliation, limits, and mutation serialization.
 */
export abstract class ProfilePlugins extends Service {
  constructor(ctx: Context) {
    super(ctx, 'profilePlugins')
  }

  /**
   * Inspect the current profile package composition.
   * @returns current system layers and installed user dependencies.
   */
  abstract list(): Promise<ProfilePluginsSnapshot>

  /**
   * Install one npm, Git, tarball, or absolute filesystem package spec.
   * @param spec - exact package-manager dependency spec.
   * @returns the reconciled profile state.
   */
  abstract install(spec: string): Promise<ProfilePluginMutationReceipt>

  /**
   * Update one user-managed profile dependency to its latest available version.
   * @param packageName - dependency name from the profile manifest.
   * @returns the reconciled profile state.
   */
  abstract update(packageName: string): Promise<ProfilePluginMutationReceipt>

  /**
   * Remove one user-managed profile dependency.
   * @param packageName - dependency name from the profile manifest.
   * @returns the reconciled profile state.
   */
  abstract remove(packageName: string): Promise<ProfilePluginMutationReceipt>
}

export default ProfilePlugins
