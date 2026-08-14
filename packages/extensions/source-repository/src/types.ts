/** Public data vocabulary for managed Harness source repositories. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque Git commit object id exposed across the Host/Client boundary. */
export type SourceCommitId = Branded<'SourceCommitId'>

/** Supported official-history integration strategies. */
export type SourceUpdateStrategy = 'merge' | 'ff-only'

/** A configured Git remote with credentials removed from its display URL. */
export interface SourceRemoteView {
  /** Git remote name. */
  readonly name: string
  /** Display-safe fetch URL. */
  readonly url: string
}

/** Repository operation that prevents a new update or push. */
export type SourceRepositoryOperation =
  | 'merge'
  | 'rebase'
  | 'cherry-pick'
  | 'revert'

/** Source root before a Git repository has been materialized. */
export interface MissingSourceRepositorySnapshot {
  readonly state: 'missing'
  /** Absolute configured workspace path. */
  readonly root: string
  /** Whether the configured packaged source capsule is currently readable. */
  readonly capsuleAvailable: boolean
  /** Official repository settings that initialization will use. */
  readonly official: SourceRemoteView & { readonly branch: string }
}

/** Existing source root that is not a usable Git working tree. */
export interface InvalidSourceRepositorySnapshot {
  readonly state: 'invalid'
  /** Absolute configured workspace path. */
  readonly root: string
  /** Stable reason that blocks initialization and repository operations. */
  readonly reason: 'not-a-git-working-tree'
  /** Official repository settings retained for diagnostics. */
  readonly official: SourceRemoteView & { readonly branch: string }
}

/** Current state of a materialized managed source repository. */
export interface ReadySourceRepositorySnapshot {
  readonly state: 'ready'
  /** Absolute Git working-tree root. */
  readonly root: string
  /** Current branch, or null for detached HEAD. */
  readonly branch: string | null
  /** Current commit. */
  readonly head: SourceCommitId
  /** True only when Git reports no tracked or untracked worktree changes. */
  readonly clean: boolean
  /** In-progress repository operation, when present. */
  readonly operation: SourceRepositoryOperation | null
  /** Configured official remote and branch. */
  readonly official: SourceRemoteView & { readonly branch: string }
  /** Configured user-owned push remote, absent until explicitly set. */
  readonly user: SourceRemoteView | null
  /** Commits reachable only from the current HEAD versus the fetched official branch. */
  readonly ahead: number | null
  /** Commits reachable only from the fetched official branch versus current HEAD. */
  readonly behind: number | null
}

/** Point-in-time managed source repository state. */
export type SourceRepositorySnapshot =
  | MissingSourceRepositorySnapshot
  | InvalidSourceRepositorySnapshot
  | ReadySourceRepositorySnapshot

/** Result of a source mutation before generation build and activation exist. */
export interface SourceRepositoryMutationReceipt {
  readonly repository: ReadySourceRepositorySnapshot
  /** Current implementation updates source only; the active runtime is unchanged. */
  readonly runtime: 'unchanged'
}
