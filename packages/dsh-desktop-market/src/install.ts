/**
 * Install orchestration: collection-repo retargeting, post-install
 * validation that keeps broken pieces from bricking the next boot, and
 * update staleness detection. Every function takes the plugin runner as a
 * parameter so tests can substitute a recording fake.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { InstallResult, PluginRunner } from './dsh-cli.ts'
import { classifyPnpmFailure, isTransientPnpmFailure } from './pnpm-compat.ts'
import { conflictingEntryIds, hasDshManifest, hasLoadableEntry, pluginSubdirs, profileDir, readInstalled, readLockCommits, readManifestDeps, readProfileBundles, restoreManifestDeps } from './profile.ts'
import { githubArchiveSpec, parseGitHubDependencySpec } from './sources.ts'
import { logEvent } from './log.ts'
import { cleanOrphanedStore } from './store.ts'

/** One-shot bypass for pnpm's fresh-release hold; scoped to a single command. */
export const RELEASE_AGE_OVERRIDE = '--config.minimumReleaseAge=0'

/**
 * Longer per-request fetch timeout for one retried command. pnpm's default
 * 60-second limit aborts large tarball downloads (github: sources fetch the
 * WHOLE repo even for a `#path:` subdirectory plugin) on slow networks; a
 * plain retry fails again at the same limit, so the recovery re-runs with
 * this override once. Scoped to a single command like RELEASE_AGE_OVERRIDE.
 */
export const FETCH_TIMEOUT_OVERRIDE = '--config.fetchTimeout=600000'

/**
 * Last-resort install mode for a git package whose lifecycle script was
 * allowed and then failed. Git repositories often commit their production
 * `lib/` output even though they also declare `prepare`; in that case the
 * executable install script is not required to use the plugin. pnpm's
 * package-scoped `allowBuilds: false` currently does not suppress git
 * prepare scripts reliably, while this command flag does.
 */
export const IGNORE_SCRIPTS_OVERRIDE = '--ignore-scripts'

export interface ExecutedGitPrepareFailure {
  /** Package whose lifecycle script failed, when pnpm included its name. */
  packageName: string | null
  repo: string
  commit: string
}

/**
 * Evidence identifying the exact Git checkout whose lifecycle script ran
 * and failed. The codeload URL is emitted by pnpm itself, so the repository
 * and immutable commit do not have to be guessed from the install request.
 */
export function parseExecutedGitPrepareFailure(
  result: Pick<InstallResult, 'exitCode' | 'timedOut' | 'cancelled' | 'busy' | 'stdout' | 'stderr'>,
): ExecutedGitPrepareFailure | null {
  if (result.exitCode === 0 || result.timedOut || result.cancelled || result.busy === true) return null
  const output = `${result.stderr}\n${result.stdout}`.replace(/\\"/g, '"')
  if (output.includes('ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED')) return null
  if (!/(?:ERR_PNPM_PREPARE_PACKAGE|Failed to prepare git-hosted package fetched from)/i.test(output)) return null
  if (!/(?:npm-install|pnpm-install|\bprepare\b|\bprepack\b)/i.test(output)
    || !/(?:Exit status\s+\d+|command failed|ELIFECYCLE)/i.test(output)) return null

  const fetched = /Failed to prepare git-hosted package fetched from\s+"https:\/\/codeload\.github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/tar\.gz\/([0-9a-f]{40,64})"/i.exec(output)
  if (fetched === null) return null
  const tail = output.slice((fetched.index ?? 0) + fetched[0].length)
  const packageToken = /^\s*:\s*(\S+)\s+(?:npm-install|pnpm-install|prepare|prepack):/i.exec(tail)?.[1]
  return {
    packageName: packageToken === undefined ? null : barePackageName(packageToken),
    repo: `${fetched[1]!}/${fetched[2]!}`,
    commit: fetched[3]!.toLowerCase(),
  }
}

/**
 * True only when pnpm actually executed a git package's prepare/prepack
 * pipeline and that pipeline failed. The separate NOT_ALLOWED error means
 * the script never ran and must continue through the explicit approval flow.
 */
export function isExecutedGitPrepareFailure(
  result: Pick<InstallResult, 'exitCode' | 'timedOut' | 'cancelled' | 'busy' | 'stdout' | 'stderr'>,
): boolean {
  if (parseExecutedGitPrepareFailure(result) !== null) return true
  if (result.exitCode === 0 || result.timedOut || result.cancelled || result.busy === true) return false
  const output = `${result.stderr}\n${result.stdout}`
  if (output.includes('ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED')) return false
  if (output.includes('ERR_PNPM_PREPARE_PACKAGE')) return true
  return /Failed to prepare git-hosted package fetched from/i.test(output)
    && /(?:npm-install|pnpm-install|\bprepare\b|\bprepack\b)/i.test(output)
    && /(?:Exit status\s+\d+|command failed|ELIFECYCLE)/i.test(output)
}

interface GitArchiveRepair {
  name: string
  spec: string
}

interface StabilizeGitResult {
  repair: GitArchiveRepair | null
  failure: InstallResult | null
}

const installSucceeded = (result: InstallResult): boolean =>
  result.exitCode === 0 && !result.timedOut && !result.cancelled && result.busy !== true

/**
 * Replace one root Git dependency with an immutable GitHub archive at the
 * exact commit pnpm resolved, then reconcile the lockfile without scripts.
 *
 * This is the durable half of the committed-artifact fallback. Merely using
 * `--ignore-scripts` once leaves `github:owner/repo` in package.json; pnpm
 * replays that repository's broken `prepare` on every unrelated add/remove.
 * An archive URL retains source identity and updateability while becoming a
 * normal integrity-pinned tarball, so later profile mutations stay isolated.
 */
async function stabilizeGitDependency(
  run: PluginRunner,
  profile: string,
  snapshot: Record<string, string>,
  repo: string,
  commit: string,
  packageName: string | null,
  explicitDir?: string,
): Promise<StabilizeGitResult> {
  const root = profileDir(profile, explicitDir)
  const candidates = Object.entries(snapshot).filter(([name, spec]) => {
    if (packageName !== null && name !== packageName) return false
    const source = parseGitHubDependencySpec(spec)
    return source !== null
      && source.kind === 'git'
      && source.subpath === null
      && source.repo.toLowerCase() === repo.toLowerCase()
      && hasLoadableEntry(root, name)
  })
  if (candidates.length !== 1) return { repair: null, failure: null }

  const [name] = candidates[0]!
  const archive = githubArchiveSpec(repo, commit)
  if (archive === null) return { repair: null, failure: null }
  const pinned = { ...snapshot, [name]: archive }
  restoreManifestDeps(profile, pinned, explicitDir)
  const reconcile = await run(profile, ['install', '--no-frozen-lockfile', IGNORE_SCRIPTS_OVERRIDE])
  if (installSucceeded(reconcile)) {
    logEvent('info', 'install-repair', `${name}: pinned committed artifacts to immutable archive ${archive}`)
    return { repair: { name, spec: archive }, failure: null }
  }

  restoreManifestDeps(profile, snapshot, explicitDir)
  const detail = (reconcile.stderr || reconcile.stdout).trim().slice(-1200)
  logEvent('error', 'install-repair', `${name}: immutable archive reconciliation failed — ${detail}`)
  return {
    repair: null,
    failure: {
      ...reconcile,
      stderr: `${reconcile.stderr}${reconcile.stderr ? '\n\n' : ''}The plugin's committed artifacts were usable, but its dependency could not be pinned to an immutable GitHub archive. The original manifest was restored. / 插件的已提交产物可用，但无法将依赖固定到不可变的 GitHub 归档，已恢复原始配置。`,
    },
  }
}

/** Pin a successful root-Git `--ignore-scripts` add before it can poison later mutations. */
async function stabilizeNoScriptGitAdd(
  run: PluginRunner,
  profile: string,
  pluginArgs: readonly string[],
  before: Record<string, string>,
  explicitDir?: string,
): Promise<StabilizeGitResult> {
  if (pluginArgs[0] !== 'add' || !pluginArgs.includes(IGNORE_SCRIPTS_OVERRIDE)) {
    return { repair: null, failure: null }
  }
  const target = pluginArgs.at(-1)
  if (target === undefined) return { repair: null, failure: null }
  const source = parseGitHubDependencySpec(target)
  if (source === null || source.kind !== 'git' || source.subpath !== null) {
    return { repair: null, failure: null }
  }

  const current = readManifestDeps(profile, explicitDir)
  const matching = Object.entries(current).filter(([name, spec]) => {
    const installedSource = parseGitHubDependencySpec(spec)
    return installedSource !== null
      && installedSource.kind === 'git'
      && installedSource.subpath === null
      && installedSource.repo.toLowerCase() === source.repo.toLowerCase()
      && hasLoadableEntry(profileDir(profile, explicitDir), name)
  })
  const added = matching.filter(([name]) => before[name] === undefined)
  const candidates = added.length === 1 ? added : matching
  if (candidates.length !== 1) return { repair: null, failure: null }
  const commit = readLockCommits(profile, explicitDir).get(source.repo.toLowerCase()) ?? null
  if (commit === null) return { repair: null, failure: null }
  return stabilizeGitDependency(run, profile, current, source.repo, commit, candidates[0]![0], explicitDir)
}

/**
 * Build the one-shot retry argv that installs a git dependency's committed
 * artifacts without lifecycle scripts. Null keeps the fallback constrained
 * to `add` and to an explicit git target; arbitrary npm specs never enter it.
 */
export function gitPrebuiltFallbackArgs(pluginArgs: readonly string[]): string[] | null {
  if (pluginArgs[0] !== 'add' || pluginArgs.includes(IGNORE_SCRIPTS_OVERRIDE)) return null
  const target = pluginArgs.at(-1)
  if (target === undefined || !/^(?:github:|git\+|git:|https?:\/\/(?:www\.)?github\.com\/)/i.test(target)) {
    return null
  }
  return ['add', IGNORE_SCRIPTS_OVERRIDE, ...pluginArgs.slice(1)]
}

/**
 * Run one plugin command with automatic recovery from three known pnpm traps:
 *
 * - pnpm-major drift (#20 bug 2): a modules directory built by a different
 *   pnpm major fails mutation; pnpm's documented remedy is one `install` to
 *   recreate it — do that silently and retry the original command once.
 * - release-age lockfile lock (#39): once a too-young release is in the
 *   lockfile, pnpm 11 rejects EVERY later add/remove during verification —
 *   retry once with the one-shot minimumReleaseAge bypass (safe: the young
 *   package is already installed; the bypass only lets pnpm touch the
 *   lockfile again).
 * - per-request fetch timeout: large tarballs (github: sources fetch the
 *   whole repo even for a `#path:` subdirectory) on slow networks blow
 *   pnpm's default 60-second limit; a plain retry fails again at the same
 *   limit, so retry once with a longer fetchTimeout.
 *
 * Any recognized failure that survives gets its bilingual explanation
 * appended to stderr so the UI shows an actionable message instead of a
 * wall of text (#20 bug 3). Cancelled runs are never recovered.
 */
export async function withHoistRecovery(
  run: PluginRunner,
  profile: string,
  pluginArgs: string[],
  explicitDir?: string,
): Promise<InstallResult> {
  const manifestBefore = readManifestDeps(profile, explicitDir)
  const repairedDependencies: Record<string, string> = {}
  let result = await run(profile, pluginArgs)
  const ok = installSucceeded
  if (!ok(result) && !result.cancelled && (pluginArgs[0] === 'add' || pluginArgs[0] === 'remove')) {
    const evidence = parseExecutedGitPrepareFailure(result)
    const requestedSource = pluginArgs[0] === 'add'
      ? parseGitHubDependencySpec(pluginArgs.at(-1) ?? '')
      : null
    // A Git add failing its OWN prepare belongs to the install route's
    // committed-artifact fallback. This recovery is for an unrelated,
    // already-installed Git dependency that pnpm replayed while processing
    // the requested mutation.
    const requestedGitFailed = evidence !== null
      && requestedSource !== null
      && requestedSource.kind === 'git'
      && requestedSource.repo.toLowerCase() === evidence.repo.toLowerCase()
    if (evidence !== null && !requestedGitFailed) {
      const stabilized = await stabilizeGitDependency(
        run,
        profile,
        manifestBefore,
        evidence.repo,
        evidence.commit,
        evidence.packageName,
        explicitDir,
      )
      if (stabilized.repair !== null) {
        repairedDependencies[stabilized.repair.name] = stabilized.repair.spec
        logEvent('warn', 'install-repair', `${stabilized.repair.name}: an existing Git dependency replayed a broken lifecycle script; profile repaired, retrying requested command once`)
        result = await run(profile, pluginArgs)
      } else if (stabilized.failure !== null) {
        result = stabilized.failure
      }
    }
  }
  if (!ok(result) && !result.cancelled) {
    const failure = classifyPnpmFailure(`${result.stderr}\n${result.stdout}`)
    if (failure?.code === 'hoist-pattern-diff') {
      logEvent('warn', 'install', `modules dir was built by a different pnpm major — rebuilding (pnpm install) and retrying once`)
      // --no-frozen-lockfile: the market runs pnpm with CI=true (TTY hangs),
      // where a lockfile written by the old major would otherwise be refused.
      const rebuild = await run(profile, ['install', '--no-frozen-lockfile'])
      if (ok(rebuild)) result = await run(profile, pluginArgs)
    } else if (
      failure?.code === 'release-age-violation'
      && (pluginArgs[0] === 'add' || pluginArgs[0] === 'remove')
      && !pluginArgs.includes(RELEASE_AGE_OVERRIDE)
    ) {
      logEvent('warn', 'install', `a too-young release blocks pnpm's lockfile verification (#39) — retrying once with ${RELEASE_AGE_OVERRIDE}`)
      result = await run(profile, [pluginArgs[0], RELEASE_AGE_OVERRIDE, ...pluginArgs.slice(1)])
    } else if (
      failure?.code === 'transient-network'
      && (pluginArgs[0] === 'add' || pluginArgs[0] === 'remove')
    ) {
      // #83: pnpm replays the whole tree, so any existing dependency's
      // momentary network hiccup fails the run — and a plain retry succeeds.
      // Do that retry ourselves instead of reporting a false failure.
      logEvent('warn', 'install', `transient network failure while pnpm replayed the dependency tree (#83) — retrying once`)
      result = await run(profile, pluginArgs)
    } else if (
      failure?.code === 'fetch-timeout'
      && (pluginArgs[0] === 'add' || pluginArgs[0] === 'remove')
      && !pluginArgs.includes(FETCH_TIMEOUT_OVERRIDE)
    ) {
      // Large tarball / slow network: pnpm's default 60s per-request limit
      // aborted the download. A plain retry fails again at the same limit,
      // so retry once with a longer fetchTimeout.
      logEvent('warn', 'install', `pnpm's per-request fetch timeout aborted a large download — retrying once with ${FETCH_TIMEOUT_OVERRIDE}`)
      result = await run(profile, [pluginArgs[0], FETCH_TIMEOUT_OVERRIDE, ...pluginArgs.slice(1)])
    }
  }
  if (ok(result)) {
    const stabilized = await stabilizeNoScriptGitAdd(run, profile, pluginArgs, manifestBefore, explicitDir)
    if (stabilized.repair !== null) {
      repairedDependencies[stabilized.repair.name] = stabilized.repair.spec
    } else if (stabilized.failure !== null) {
      result = stabilized.failure
    }
  }
  if (Object.keys(repairedDependencies).length > 0) {
    result = { ...result, repairedDependencies }
  }
  if (!ok(result) && !result.cancelled) {
    // A failed, timed-out, or killed run never finishes pnpm's staging, so
    // its store tmp dirs (the WHOLE repo tarball for github: sources) are
    // orphaned — reclaim them now that no pnpm is running. Safe by
    // construction: directories are only removed when their owning pid is
    // gone (the name carries it), so a live download is never touched.
    await cleanOrphanedStore(run, profile)
    const failure = classifyPnpmFailure(`${result.stderr}\n${result.stdout}`)
    if (failure !== null) result = { ...result, stderr: `${result.stderr}\n\n${failure.message}` }
  }
  return result
}

/**
 * Some registry entries point at collection repos whose actual plugin lives
 * in a subdirectory — the root has no package.json (or a workspace root with
 * no dsh surface), and pnpm installs the bare fileset with exit 0. Detect
 * that junk install, drop it, and re-add each plugin subdirectory through
 * pnpm's `#path:` selector (#18).
 * @returns overall success (true when nothing needed retargeting).
 */
export async function retargetCollections(
  run: PluginRunner, profile: string, before: Set<string>, target: string, explicitDir?: string,
): Promise<boolean> {
  if (!target.startsWith('github:')) return true
  const dir = profileDir(profile, explicitDir)
  const junk = Object.keys(readInstalled(profile, dir)).filter((name) => {
    if (before.has(name)) return false
    const root = join(dir, 'node_modules', name)
    if (!existsSync(join(root, 'package.json'))) return true
    return !hasDshManifest(root)
  })
  let allOk = true
  for (const name of junk) {
    const root = join(dir, 'node_modules', name)
    const candidates = pluginSubdirs(root)
    logEvent('info', 'install', `${name}: collection repo (root declares no dsh manifest); plugins inside: ${candidates.join(', ') || 'none'}`)
    await run(profile, ['remove', name])
    if (candidates.length === 0) {
      allOk = false
      continue
    }
    for (const sub of candidates) {
      const result = await run(profile, ['add', `${target}#path:/${sub}`])
      if (result.exitCode !== 0 || result.timedOut) {
        allOk = false
        logEvent('error', 'install',
          `${target}#path:/${sub}: exit=${String(result.exitCode)}${result.timedOut ? ' TIMEOUT' : ''} — ${(result.stderr || result.stdout).slice(-220)}`)
      }
    }
  }
  return allOk
}

/**
 * Fake-success guard (#18): validate every package the install added. A
 * piece without a dsh manifest or without its declared entry artifact
 * (source-only checkout, build blocked by pnpm allowBuilds) would brick the
 * next boot, so it is removed on the spot.
 *
 * Since #122 this also covers duplicate loader entry ids: cordis refuses to
 * load a tree containing two entries with one id, so a TUI bundle landing in
 * a web profile (both declare `id: storage`) leaves DSH unable to START —
 * an error naming neither plugin, from which the market's own page is
 * unreachable. Such a package is removed like any other bricking piece.
 * @returns names kept, names removed as broken, and the id conflicts found.
 */
export async function validateAddedPlugins(
  run: PluginRunner, profile: string, before: Set<string>, explicitDir?: string,
): Promise<{ keep: string[]; removedBroken: string[]; conflicts: { name: string; id: string; owner: string }[] }> {
  const dir = profileDir(profile, explicitDir)
  const addedNow = Object.keys(readInstalled(profile, dir)).filter(n => !before.has(n))
  const keep: string[] = []
  const removedBroken: string[] = []
  const conflicts: { name: string; id: string; owner: string }[] = []
  // Compare against what the profile already loads, minus this install's own
  // additions — two pieces of one plugin are not "already installed".
  const existingBundles = readProfileBundles(dir).filter(name => !addedNow.includes(name))
  for (const n of addedNow) {
    const packageDir = join(dir, 'node_modules', n)
    // hasLoadableEntry, not entryArtifactExists: carrier bundles legitimately
    // ship no entry of their own (#103) and must not be uninstalled here.
    if (!hasDshManifest(packageDir) || !hasLoadableEntry(dir, n)) {
      removedBroken.push(n)
      await run(profile, ['remove', n])
      continue
    }
    const clash = conflictingEntryIds(dir, n, existingBundles)
    if (clash.length > 0) {
      // Keeping it would make the NEXT BOOT fail outright (#122).
      conflicts.push(...clash.map(hit => ({ name: n, ...hit })))
      removedBroken.push(n)
      logEvent('error', 'install',
        `${n}: loader entry id conflict with ${clash[0].owner} (${clash.map(hit => hit.id).join(', ')}) — removing, it would break the next boot`)
      await run(profile, ['remove', n])
      continue
    }
    keep.push(n)
  }
  return { keep, removedBroken, conflicts }
}

/**
 * Group flat `{id, owner}` conflict hits by the installed plugin that owns
 * them. What the user has to decide is which PLUGINS to uninstall, not which
 * ids to resolve, so one row per owner is the unit the market renders and
 * acts on. Flattening the other way (one row per id) also misattributes when
 * a candidate clashes with several installed plugins at once.
 * @param conflicts flat hits as returned by {@link validateAddedPlugins}.
 * @returns one entry per owner, owners and ids both in first-seen order.
 */
export function groupConflictsByOwner(
  conflicts: readonly { id: string; owner: string }[],
): { owner: string; ids: string[] }[] {
  const byOwner = new Map<string, string[]>()
  for (const hit of conflicts) {
    const ids = byOwner.get(hit.owner)
    if (ids === undefined) byOwner.set(hit.owner, [hit.id])
    else if (!ids.includes(hit.id)) ids.push(hit.id)
  }
  return [...byOwner].map(([owner, ids]) => ({ owner, ids }))
}

/**
 * Whether a clean-exit update actually changed nothing — pnpm's
 * minimumReleaseAge silently keeps the old version and exits 0 when the new
 * release is "too young" (#13, #22), so a clean exit alone does not mean the
 * update happened.
 */
export function isStaleUpdate(check: {
  isGit: boolean
  beforeVersion: string | null
  afterVersion: string | null
  beforeCommit: string | null
  afterCommit: string | null
}): boolean {
  return check.isGit
    ? check.beforeCommit !== null && check.afterCommit === check.beforeCommit
    : check.beforeVersion !== null && check.afterVersion === check.beforeVersion
}

const PACKAGE_NAME_RE = /^(@[A-Za-z0-9-~][A-Za-z0-9._~-]*\/)?[A-Za-z0-9-~][A-Za-z0-9._~-]*$/
const PACKAGE_NAME_SOURCE = String.raw`(?:@[A-Za-z0-9-~][A-Za-z0-9._~-]*\/)?[A-Za-z0-9-~][A-Za-z0-9._~-]*`
const EXACT_GITHUB_BUILD_KEY_RE = new RegExp(
  String.raw`(${PACKAGE_NAME_SOURCE}@https:\/\/codeload\.github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/tar\.gz\/[0-9a-f]{40,64}(?:#path:\/[A-Za-z0-9_./-]+)?)`,
  'gi',
)

export interface BuildApprovalEvidence {
  /** Bare package names suitable for the UI and ordinary npm approvals. */
  packages: string[]
  /** Exact commit-pinned selectors emitted by pnpm's git prepare guard. */
  exactKeys: string[]
}

function barePackageName(value: string): string | null {
  const raw = value.trim()
  const at = raw.lastIndexOf('@')
  const name = at > 0 ? raw.slice(0, at) : raw
  return PACKAGE_NAME_RE.test(name) ? name : null
}

function validExactBuildKey(value: string): boolean {
  const pathMarker = value.indexOf('#path:/')
  if (pathMarker < 0) return true
  const subpath = value.slice(pathMarker + '#path:/'.length)
  return subpath !== '' && !subpath.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
}

/**
 * Trusted build-approval evidence from pnpm output.
 *
 * pnpm 10's git fetcher does not accept a bare package name (nor the stable
 * `name@git+https://…` selector) for a source package that needs `prepare`.
 * Its error contains the exact commit-pinned codeload selector that the
 * allowlist matcher consumes. Preserve that server-observed value instead of
 * trying to reconstruct it from user input; the commit changes over time.
 */
export function parseBuildApprovalEvidence(stdout: string, stderr: string): BuildApprovalEvidence {
  const text = `${stdout}\n${stderr}`.replace(/\\"/g, '"')
  const packages = new Set(parseIgnoredBuilds(stdout, stderr))
  const exactKeys = new Set<string>()

  for (const match of text.matchAll(/git-hosted package "([^"]+)" needs to execute build scripts/g)) {
    const name = barePackageName(match[1] ?? '')
    if (name !== null) packages.add(name)
  }

  for (const match of text.matchAll(EXACT_GITHUB_BUILD_KEY_RE)) {
    const key = match[1]
    if (key === undefined || !validExactBuildKey(key)) continue
    const split = key.indexOf('@https://')
    const name = split > 0 ? key.slice(0, split) : ''
    if (!PACKAGE_NAME_RE.test(name)) continue
    exactKeys.add(key)
    packages.add(name)
  }

  return { packages: [...packages], exactKeys: [...exactKeys] }
}

/**
 * The package pnpm's fetcher refused to prepare because its build script is
 * not allowlisted. Null when the output is not this failure. Unlike ordinary
 * ignored builds, the package is not in node_modules yet (the fetcher rejects
 * before materialization).
 */
export function parsePrepareNotAllowed(stdout: string, stderr: string): string | null {
  const text = `${stdout}\n${stderr}`.replace(/\\"/g, '"')
  const match = /git-hosted package "([^"]+)" needs to execute build scripts/.exec(text)
  return match === null ? null : barePackageName(match[1] ?? '')
}

/**
 * Package names pnpm reported as having their build scripts ignored
 * ("Ignored build scripts: esbuild, koffi."). Empty when none.
 * (#6 by @qichuang321.)
 */
export function parseIgnoredBuilds(stdout: string, stderr: string): string[] {
  const m = /Ignored build scripts:?\s*([^\n]+)/i.exec(`${stdout}\n${stderr}`)
  if (m === null) return []
  const found: string[] = []
  for (const chunk of m[1].split(',')) {
    // Entries may carry a version suffix and the sentence's final period.
    const trimmed = chunk.trim().replace(/\.$/, '')
    if (trimmed === '') continue
    const at = trimmed.lastIndexOf('@')
    const name = at > 0 ? trimmed.slice(0, at) : trimmed
    if (name !== '' && !found.includes(name)) found.push(name)
  }
  return found
}
