import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface NodeWorkerModuleFallbackOptions {
  applicationPath: string
  hookPath: string
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

function pathIdentity(value: string, platform: NodeJS.Platform): string {
  let normalized = value.trim()
  if (normalized.length >= 2 && normalized.startsWith('"') && normalized.endsWith('"')) {
    normalized = normalized.slice(1, -1)
  }
  while (normalized.length > 3 && /[\\/]$/u.test(normalized)) {
    normalized = normalized.slice(0, -1)
  }
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function prependNodeModuleSearchPath(
  nodeModulesPath: string,
  currentNodePath: string | undefined,
  platform: NodeJS.Platform = process.platform
): string {
  const separator = platform === 'win32' ? ';' : ':'
  const candidates = [nodeModulesPath, ...(currentNodePath?.split(separator) ?? [])]
  const seen = new Set<string>()

  return candidates
    .filter((candidate) => {
      if (!candidate) return false
      const identity = pathIdentity(candidate, platform)
      if (!identity || seen.has(identity)) return false
      seen.add(identity)
      return true
    })
    .join(separator)
}

/**
 * Give Harness both ESM and CommonJS access to the packaged runtime.
 *
 * ESM package imports use the synchronous resolve hook. DSH also has package
 * scanners based on createRequire(profile/cordis.yml); those bypass ESM hooks,
 * so NODE_PATH must point directly at app.asar/node_modules. The profile's
 * compatibility junctions cannot be traversed when their Windows target is
 * inside an ASAR archive.
 */
export function configureNodeWorkerModuleFallback(
  options: NodeWorkerModuleFallbackOptions
): void {
  const environment = options.environment ?? process.env
  const platform = options.platform ?? process.platform
  const fallbackUrl = pathToFileURL(join(options.applicationPath, 'package.json')).href
  const hookUrl = pathToFileURL(options.hookPath).href
  const importOption = `--import=${hookUrl}`
  const currentOptions = environment.NODE_OPTIONS?.trim() ?? ''

  environment.DSH_DESKTOP_MODULE_FALLBACK_URL = fallbackUrl
  environment.NODE_PATH = prependNodeModuleSearchPath(
    join(options.applicationPath, 'node_modules'),
    environment.NODE_PATH,
    platform
  )
  if (!currentOptions.includes(importOption)) {
    environment.NODE_OPTIONS = [currentOptions, importOption].filter(Boolean).join(' ')
  }
}
