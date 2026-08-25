export const DSH_DESKTOP_PROTOCOL = 'dsh-desktop:'
export const DSH_DESKTOP_PLUGIN_INSTALL_EVENT = 'dsh:plugin-install-request'
export const DSH_DESKTOP_PLUGIN_INSTALL_CHANNEL = 'plugin-install:request'
export const DSH_DESKTOP_PLUGIN_INSTALL_STORAGE_KEY = 'dsh-plugin-install-request'

export interface PluginInstallIntent {
  source: string
}

export type PluginInstallIntentErrorCode =
  | 'malformed-link'
  | 'unsupported-route'
  | 'invalid-source'
  | 'unsupported-cli-syntax'

export type PluginInstallIntentResult =
  | { status: 'ok'; intent: PluginInstallIntent }
  | { status: 'ignored' }
  | { status: 'error'; code: PluginInstallIntentErrorCode; message: string }

const MAX_PLUGIN_SOURCE_LENGTH = 2_048

/**
 * Plugin entry points carry a direct-install request to the renderer. The
 * host-side installer applies the narrower executable-source allowlist; this
 * transport layer only rejects values that cannot be one command-line token.
 */
export function normalizePluginInstallSource(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  const source = input.trim()
  if (source.length === 0 || source.length > MAX_PLUGIN_SOURCE_LENGTH) return undefined
  if (/\s|["\u0000-\u001f\u007f]/u.test(source)) return undefined
  return source
}

/** Parse the canonical `dsh-desktop://plugin/install?source=…` deep link. */
export function parseDesktopPluginInstallUrl(raw: string): PluginInstallIntentResult {
  if (!raw.toLowerCase().startsWith(DSH_DESKTOP_PROTOCOL)) return { status: 'ignored' }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return {
      status: 'error',
      code: 'malformed-link',
      message: 'The DSH Desktop link is malformed.'
    }
  }

  const host = url.hostname.toLowerCase()
  const path = url.pathname.replace(/\/+$/u, '').toLowerCase()
  const canonicalRoute = host === 'plugin' && path === '/install'
  const hostlessRoute = host === '' && path === '/plugin/install'
  if (!canonicalRoute && !hostlessRoute) {
    return {
      status: 'error',
      code: 'unsupported-route',
      message: 'The DSH Desktop link does not name a plugin install request.'
    }
  }

  const source = normalizePluginInstallSource(url.searchParams.get('source'))
  if (!source) {
    return {
      status: 'error',
      code: 'invalid-source',
      message: 'The DSH Desktop plugin link has no valid source.'
    }
  }
  return { status: 'ok', intent: { source } }
}

export function buildDesktopPluginInstallUrl(source: string): string {
  const normalized = normalizePluginInstallSource(source)
  if (!normalized) throw new Error('A valid plugin source is required.')
  const url = new URL('dsh-desktop://plugin/install')
  url.searchParams.set('source', normalized)
  return url.href
}

/**
 * Parse the deliberately small Desktop CLI surface. Arbitrary upstream DSH
 * commands are not forwarded: this shim only turns a web-profile add request
 * into the same direct-install intent as a deep link.
 */
export function parseDshDesktopCliPluginInstall(argv: readonly string[]): PluginInstallIntentResult {
  let sourceCandidate: string | undefined

  if (
    argv.length === 5 &&
    argv[0] === 'plugin' &&
    argv[1] === '--profile' &&
    argv[2] === 'web' &&
    argv[3] === 'add'
  ) {
    sourceCandidate = argv[4]
  } else if (
    argv.length === 4 &&
    argv[0] === 'plugin' &&
    argv[1] === '--profile=web' &&
    argv[2] === 'add'
  ) {
    sourceCandidate = argv[3]
  } else {
    return {
      status: 'error',
      code: 'unsupported-cli-syntax',
      message: 'Supported syntax: dsh plugin --profile web add <plugin-source>'
    }
  }

  const source = normalizePluginInstallSource(sourceCandidate)
  if (!source) {
    return {
      status: 'error',
      code: 'invalid-source',
      message: 'The plugin source must be one non-empty command-line token.'
    }
  }
  return { status: 'ok', intent: { source } }
}

/**
 * Parse the legacy internal `--dsh-cli` launch form. Electron/Chromium can
 * append process switches to a second-instance command line, so isolate only
 * the supported command before applying the strict CLI grammar.
 */
export function parseDshDesktopCliLaunchArguments(
  argv: readonly string[]
): PluginInstallIntentResult {
  const marker = argv.indexOf('--dsh-cli')
  if (marker < 0) return { status: 'ignored' }
  const cliArguments = argv.slice(marker + 1)
  const expectedLength = cliArguments[1] === '--profile=web' ? 4 : 5
  return parseDshDesktopCliPluginInstall(cliArguments.slice(0, expectedLength))
}
