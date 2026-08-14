/** Secure zero-port protocol carrier for the Electron renderer. */

import { readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { DSH_DESKTOP_URL } from '@deepseek-ai/dsh-desktop-app'
import { serializeBootManifest, type WebBootGraph } from '@deepseek-ai/dsh-client-modules'

/** Canonical renderer origin. */
export const DESKTOP_URL = DSH_DESKTOP_URL
/** External bootstrap resource loaded before the Vite shell. */
export const DESKTOP_BOOT_PATH = '/desktop/boot.js'

/** Renderer policy: same-origin scripts may use Cordis runtime evaluation; plugin CSS may inject styles. */
export const DESKTOP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "form-action 'none'",
].join('; ')

/** Inputs owned by the booted Host and built Web shell. */
export interface DesktopProtocolSources {
  /** Absolute path to the built Web index. */
  distIndex: string
  /** Pull the current client plugin graph. */
  graph(): WebBootGraph
  /** Resolve one registered client bundle to its absolute path. */
  clientPath(id: string): string | undefined
  /** Dispatch an already-authorized Host request. */
  dispatch(request: Request): Promise<Response>
  /** Test seam for filesystem reads. */
  read?(path: string): Promise<Uint8Array>
}

type ProtocolHandler = (request: Request) => Promise<Response>

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

/**
 * Insert the external boot resource before the shell reads its manifest.
 * @param html - built Vite index.
 * @returns index containing the desktop bootstrap script.
 */
function injectDesktopBoot(html: string): string {
  const script = `<script src="${DESKTOP_BOOT_PATH}"></script>`
  const head = html.indexOf('<head>')
  if (head !== -1) return `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`
  return `${script}${html}`
}

/**
 * Build the `dsh://app` request handler. The application registers it only on
 * Electron's privileged custom scheme, so requests reaching `dispatch` are
 * same-process and already authorized.
 * @param sources - current Host graph, bundles, RPC dispatcher, and Web dist.
 * @returns Electron-compatible protocol handler.
 */
export function createDesktopProtocolHandler(sources: DesktopProtocolSources): ProtocolHandler {
  const distRoot = dirname(sources.distIndex)
  const read = (path: string): Promise<Uint8Array> => sources.read === undefined
    ? readFile(path)
    : sources.read(path)

  const fileResponse = async (
    path: string,
    method: string,
    cacheControl: string,
    headers?: Record<string, string>,
  ): Promise<Response> => {
    let body: Uint8Array
    try {
      body = await read(path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      return new Response(code === 'ENOENT' || code === 'EISDIR' ? 'not found' : 'resource read failed', {
        status: code === 'ENOENT' || code === 'EISDIR' ? 404 : 500,
      })
    }
    const responseBody: BodyInit | null = method === 'HEAD' ? null : Uint8Array.from(body)
    return new Response(responseBody, {
      headers: {
        'content-type': MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': cacheControl,
        'cross-origin-resource-policy': 'same-origin',
        'x-content-type-options': 'nosniff',
        ...headers,
      },
    })
  }

  const indexResponse = async (method: string): Promise<Response> => {
    const response = await fileResponse(sources.distIndex, method, 'no-store', {
      'content-security-policy': DESKTOP_CSP,
      'cross-origin-opener-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
    })
    if (!response.ok || method === 'HEAD') return response
    const html = injectDesktopBoot(await response.text())
    return new Response(html, { status: response.status, headers: response.headers })
  }

  return async (request) => {
    const url = new URL(request.url)
    if (url.protocol !== 'dsh:' || url.hostname !== 'app') {
      return new Response('not found', { status: 404 })
    }
    const method = request.method.toUpperCase()
    let pathname: string
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      return new Response('bad path encoding', { status: 400 })
    }
    if (pathname.includes('\\')) return new Response('forbidden', { status: 403 })

    if (pathname === DESKTOP_BOOT_PATH) {
      if (method !== 'GET' && method !== 'HEAD') return new Response('method not allowed', { status: 405 })
      const body = serializeBootManifest(sources.graph())
      return new Response(method === 'HEAD' ? null : body, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'cross-origin-resource-policy': 'same-origin',
          'x-content-type-options': 'nosniff',
        },
      })
    }

    if (pathname.startsWith('/plugins/')) {
      if (method !== 'GET' && method !== 'HEAD') return new Response('method not allowed', { status: 405 })
      const mapSuffix = '/client.js.map'
      const bundleSuffix = '/client.js'
      const sourceMap = pathname.endsWith(mapSuffix)
      const suffix = sourceMap ? mapSuffix : bundleSuffix
      const id = pathname.endsWith(suffix)
        ? pathname.slice('/plugins/'.length, -suffix.length)
        : ''
      const clientPath = id === '' ? undefined : sources.clientPath(id)
      if (clientPath === undefined) return new Response('not found', { status: 404 })
      return fileResponse(`${clientPath}${sourceMap ? '.map' : ''}`, method, 'no-cache')
    }

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return sources.dispatch(request)
    }
    if (method !== 'GET' && method !== 'HEAD'
      && (pathname.startsWith('/assets/') || extname(pathname) !== '')) {
      return new Response('method not allowed', { status: 405 })
    }
    if (method !== 'GET' && method !== 'HEAD') return sources.dispatch(request)
    if (pathname === '/' || pathname === '/index.html') return indexResponse(method)

    const candidate = resolve(distRoot, `.${pathname}`)
    const fromRoot = relative(distRoot, candidate)
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
      return new Response('forbidden', { status: 403 })
    }
    const staticResponse = await fileResponse(candidate, method, 'public, max-age=31536000, immutable')
    if (staticResponse.status !== 404 || extname(pathname) !== '') return staticResponse
    return indexResponse(method)
  }
}
