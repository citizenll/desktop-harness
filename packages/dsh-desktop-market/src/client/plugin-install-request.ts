export const PLUGIN_INSTALL_HASH_KEY = 'dsh-plugin-install'
export const PLUGIN_INSTALL_EVENT = 'dsh:plugin-install-request'
export const PLUGIN_INSTALL_STORAGE_KEY = 'dsh-plugin-install-request'

const MAX_SOURCE_LENGTH = 2_048

export function normalizePluginInstallSource(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const source = value.trim()
  if (source.length === 0 || source.length > MAX_SOURCE_LENGTH) return undefined
  if (/\s|["\u0000-\u001f\u007f]/u.test(source)) return undefined
  return source
}

/** Read the browser form: `#dsh-plugin-install=owner%2Frepository`. */
export function parsePluginInstallHash(hash: string): string | undefined {
  const body = hash.startsWith('#') ? hash.slice(1) : hash
  if (body.length === 0) return undefined
  return normalizePluginInstallSource(new URLSearchParams(body).get(PLUGIN_INSTALL_HASH_KEY))
}

export function takePendingPluginInstallRequest(
  storage: Pick<Storage, 'getItem' | 'removeItem'> = sessionStorage,
): string | undefined {
  let raw: string | null
  try {
    raw = storage.getItem(PLUGIN_INSTALL_STORAGE_KEY)
  } catch {
    return undefined
  }
  if (raw === null) return undefined
  try {
    storage.removeItem(PLUGIN_INSTALL_STORAGE_KEY)
  } catch {
    // Parsing the value remains useful even when storage cannot be mutated.
  }
  try {
    const parsed = JSON.parse(raw) as { source?: unknown }
    return normalizePluginInstallSource(parsed?.source)
  } catch {
    return normalizePluginInstallSource(raw)
  }
}

export function publishPluginInstallRequest(source: string, target: Window): void {
  try {
    target.sessionStorage.setItem(PLUGIN_INSTALL_STORAGE_KEY, JSON.stringify({ source }))
  } catch {
    // An already-mounted direct-install dialog can still receive the event.
  }
  target.dispatchEvent(new CustomEvent(PLUGIN_INSTALL_EVENT, { detail: { source } }))
}

function removeInstallHash(target: Window): void {
  const params = new URLSearchParams(target.location.hash.slice(1))
  if (!params.has(PLUGIN_INSTALL_HASH_KEY)) return
  params.delete(PLUGIN_INSTALL_HASH_KEY)
  const suffix = params.toString()
  const cleanUrl = `${target.location.pathname}${target.location.search}${suffix ? `#${suffix}` : ''}`
  target.history.replaceState(target.history.state, '', cleanUrl)
}

/**
 * Bridge the loopback HTTP form into the same direct-install request used by
 * Desktop deep links. This lives in the market bundle so it also works when
 * the Harness loopback page is opened in a normal browser.
 */
export function installPluginInstallHashBridge(target: Window = window): () => void {
  const consume = (): void => {
    const source = parsePluginInstallHash(target.location.hash)
    if (new URLSearchParams(target.location.hash.slice(1)).has(PLUGIN_INSTALL_HASH_KEY)) {
      removeInstallHash(target)
    }
    if (source) publishPluginInstallRequest(source, target)
  }

  target.addEventListener('hashchange', consume)
  consume()
  return () => target.removeEventListener('hashchange', consume)
}
