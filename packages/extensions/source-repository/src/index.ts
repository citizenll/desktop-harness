/** Service Definition for managed DeepSeek Harness source repository operations. */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  SourceRepositoryMutationReceipt,
  SourceRepositorySnapshot,
  SourceUpdateStrategy,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sourceRepository: SourceRepository
  }
}

/**
 * Managed source repository capability. Providers own Git mechanics, command
 * limits, source-capsule materialization, and mutation serialization.
 */
export abstract class SourceRepository extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sourceRepository')
  }

  /**
   * Inspect the configured source root without materializing or fetching it.
   * @returns current repository state.
   */
  abstract inspect(): Promise<SourceRepositorySnapshot>

  /**
   * Materialize the configured source capsule or official repository.
   * @returns the ready repository and unchanged-runtime receipt.
   */
  abstract initialize(): Promise<SourceRepositoryMutationReceipt>

  /**
   * Fetch the configured official branch without integrating it.
   * @returns the refreshed repository and unchanged-runtime receipt.
   */
  abstract fetchOfficial(): Promise<SourceRepositoryMutationReceipt>

  /**
   * Fetch and integrate the configured official branch.
   * @param strategy - normal merge or fast-forward-only integration.
   * @returns the updated repository and unchanged-runtime receipt.
   */
  abstract updateOfficial(strategy: SourceUpdateStrategy): Promise<SourceRepositoryMutationReceipt>

  /**
   * Configure the user-owned push remote.
   * @param url - credential-free Git remote URL.
   * @returns the repository with the configured user remote.
   */
  abstract configureUserRemote(url: string): Promise<SourceRepositoryMutationReceipt>

  /**
   * Push committed customization to the configured user remote without force.
   * @param branch - destination branch; absent uses the current branch.
   * @returns the repository after the push.
   */
  abstract pushUser(branch?: string): Promise<SourceRepositoryMutationReceipt>
}

export default SourceRepository
