/** Privileged Remote gateway for live source and profile extension management. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-profile-plugins'
import type {
  ProfilePluginMutationReceipt,
  ProfilePluginsSnapshot,
} from '@deepseek-ai/dsh-profile-plugins/types'
import type {} from '@deepseek-ai/dsh-source-repository'
import type {
  SourceRepositoryMutationReceipt,
  SourceRepositorySnapshot,
  SourceUpdateStrategy,
} from '@deepseek-ai/dsh-source-repository/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export type * from './types.ts'

/** Remote-only facade over the source repository and profile package seams. */
export class EvolutionControlGateway extends TypertRemoteService {
  static inject = ['sourceRepository', 'profilePlugins']

  constructor(ctx: Context) {
    super(ctx, 'evolution')
  }

  /**
   * Inspect the current managed source workspace.
   * @returns the current managed source workspace state.
   */
  @Remote('sourceInspect')
  sourceInspect(): Promise<SourceRepositorySnapshot> {
    return this.ctx.sourceRepository.inspect()
  }

  /**
   * Initialize the managed source workspace.
   * @returns the initialized source workspace and unchanged-runtime receipt.
   */
  @Remote('sourceInitialize')
  sourceInitialize(): Promise<SourceRepositoryMutationReceipt> {
    return this.ctx.sourceRepository.initialize()
  }

  /**
   * Fetch the configured official branch without integrating it.
   * @returns the source workspace after fetching the official branch.
   */
  @Remote('sourceFetchOfficial')
  sourceFetchOfficial(): Promise<SourceRepositoryMutationReceipt> {
    return this.ctx.sourceRepository.fetchOfficial()
  }

  /**
   * Integrate the fetched official branch into the current branch.
   * @param strategy - merge policy selected by the user.
   * @returns the updated source workspace.
   */
  @Remote('sourceUpdateOfficial')
  sourceUpdateOfficial(strategy: SourceUpdateStrategy): Promise<SourceRepositoryMutationReceipt> {
    return this.ctx.sourceRepository.updateOfficial(strategy)
  }

  /**
   * Configure the user-owned push remote.
   * @param url - Git remote URL without embedded HTTP credentials.
   * @returns the source workspace with the configured remote.
   */
  @Remote('sourceConfigureUserRemote')
  sourceConfigureUserRemote(url: string): Promise<SourceRepositoryMutationReceipt> {
    return this.ctx.sourceRepository.configureUserRemote(url)
  }

  /**
   * Push the current commit to the user-owned remote without force.
   * @param branch - destination branch, or null to use the current branch.
   * @returns the source workspace after a successful push.
   */
  @Remote('sourcePushUser')
  sourcePushUser(branch: string | null): Promise<SourceRepositoryMutationReceipt> {
    return this.ctx.sourceRepository.pushUser(branch ?? undefined)
  }

  /**
   * List current system layers and profile-managed packages.
   * @returns current system layers and profile-managed packages.
   */
  @Remote('pluginsList')
  pluginsList(): Promise<ProfilePluginsSnapshot> {
    return this.ctx.profilePlugins.list()
  }

  /**
   * Install one package spec into the active profile.
   * @param spec - npm, Git, tarball, or absolute filesystem package spec.
   * @returns the recomposed profile package state.
   */
  @Remote('pluginsInstall')
  pluginsInstall(spec: string): Promise<ProfilePluginMutationReceipt> {
    return this.ctx.profilePlugins.install(spec)
  }

  /**
   * Update one profile-managed dependency.
   * @param packageName - dependency key from the active profile manifest.
   * @returns the recomposed profile package state.
   */
  @Remote('pluginsUpdate')
  pluginsUpdate(packageName: string): Promise<ProfilePluginMutationReceipt> {
    return this.ctx.profilePlugins.update(packageName)
  }

  /**
   * Remove one profile-managed dependency.
   * @param packageName - dependency key from the active profile manifest.
   * @returns the recomposed profile package state.
   */
  @Remote('pluginsRemove')
  pluginsRemove(packageName: string): Promise<ProfilePluginMutationReceipt> {
    return this.ctx.profilePlugins.remove(packageName)
  }
}

export default EvolutionControlGateway
