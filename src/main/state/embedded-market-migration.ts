import { lstat, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { parse, stringify } from 'yaml'

const MARKET_PACKAGE = 'dshmarket'

interface ProfileManifest {
  dependencies?: Record<string, string>
  dsh?: {
    profile?: {
      bundles?: string[]
    }
  }
}

interface ProfileLockfile {
  importers?: Record<
    string,
    {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
      optionalDependencies?: Record<string, unknown>
    }
  >
  packages?: Record<string, unknown>
  snapshots?: Record<string, unknown>
}

export interface EmbeddedMarketMigrationResult {
  changed: boolean
  manifestChanged: boolean
  lockfileChanged: boolean
  removedInstalledPackage: boolean
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function parseObject<T extends object>(text: string, label: string): T {
  const value = JSON.parse(text) as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must contain an object.`)
  }
  return value as T
}

function removeDependency(container: Record<string, unknown> | undefined): boolean {
  if (!container || !(MARKET_PACKAGE in container)) return false
  delete container[MARKET_PACKAGE]
  return true
}

function removeLockfilePackageEntries(container: Record<string, unknown> | undefined): boolean {
  if (!container) return false
  let changed = false
  for (const key of Object.keys(container)) {
    if (key === MARKET_PACKAGE || key.startsWith(`${MARKET_PACKAGE}@`)) {
      delete container[key]
      changed = true
    }
  }
  return changed
}

/**
 * Retire the old profile-installed copy now that Desktop composes dsh-market
 * itself. Only the package registration and its direct node_modules link are
 * removed; market preferences, backups, and every plugin installed through
 * the market remain untouched.
 */
export async function migrateEmbeddedMarketProfile(
  dshHome: string
): Promise<EmbeddedMarketMigrationResult> {
  const profile = join(dshHome, 'profiles', 'web')
  const manifestPath = join(profile, 'package.json')
  const lockfilePath = join(profile, 'pnpm-lock.yaml')
  let manifestChanged = false
  let lockfileChanged = false

  const manifestText = await readOptional(manifestPath)
  if (manifestText !== undefined) {
    const manifest = parseObject<ProfileManifest>(manifestText, manifestPath)
    if (removeDependency(manifest.dependencies)) manifestChanged = true
    const bundles = manifest.dsh?.profile?.bundles
    if (Array.isArray(bundles)) {
      const next = bundles.filter((bundle) => bundle !== MARKET_PACKAGE)
      if (next.length !== bundles.length) {
        manifest.dsh!.profile!.bundles = next
        manifestChanged = true
      }
    }
    if (manifestChanged) {
      await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700
      })
    }
  }

  const lockfileText = await readOptional(lockfilePath)
  if (lockfileText !== undefined) {
    const parsed = parse(lockfileText) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${lockfilePath} must contain an object.`)
    }
    const lockfile = parsed as ProfileLockfile
    for (const importer of Object.values(lockfile.importers ?? {})) {
      lockfileChanged = removeDependency(importer.dependencies) || lockfileChanged
      lockfileChanged = removeDependency(importer.devDependencies) || lockfileChanged
      lockfileChanged = removeDependency(importer.optionalDependencies) || lockfileChanged
    }
    lockfileChanged = removeLockfilePackageEntries(lockfile.packages) || lockfileChanged
    lockfileChanged = removeLockfilePackageEntries(lockfile.snapshots) || lockfileChanged
    if (lockfileChanged) {
      await writeFileAtomic(lockfilePath, stringify(lockfile), {
        mode: 0o600,
        dirMode: 0o700
      })
    }
  }

  const modulesRoot = resolve(profile, 'node_modules')
  const installedPackage = resolve(modulesRoot, MARKET_PACKAGE)
  if (dirname(installedPackage) !== modulesRoot) {
    throw new Error(`Refusing to remove an unexpected embedded market path: ${installedPackage}`)
  }
  const installed = await lstat(installedPackage).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (installed !== undefined) {
    await rm(installedPackage, { recursive: true, force: true })
  }

  const removedInstalledPackage = installed !== undefined
  return {
    changed: manifestChanged || lockfileChanged || removedInstalledPackage,
    manifestChanged,
    lockfileChanged,
    removedInstalledPackage
  }
}
