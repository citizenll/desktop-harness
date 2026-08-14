/** Desktop custom-protocol routing, security policy, and Host forwarding. */

import { dirname, join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDesktopProtocolHandler, DESKTOP_BOOT_PATH, DESKTOP_CSP } from '../src/protocol.ts'

const indexPath = resolve('desktop-protocol-fixture', 'app', 'dist', 'index.html')
const bundlePath = resolve('desktop-protocol-fixture', 'plugins', 'conversation', 'client.js')

function handler() {
  const files = new Map<string, Uint8Array>([
    [indexPath, new TextEncoder().encode('<html><head><title>DSH</title></head><body><script type="module" src="/assets/index.js"></script></body></html>')],
    [join(dirname(indexPath), 'assets', 'index.js'), new TextEncoder().encode('console.log("shell")')],
    [bundlePath, new TextEncoder().encode('register("conversation")')],
    [`${bundlePath}.map`, new TextEncoder().encode('{}')],
  ])
  const dispatch = vi.fn(async () => new Response('host-response', { status: 202 }))
  return {
    dispatch,
    handle: createDesktopProtocolHandler({
      distIndex: indexPath,
      graph: () => ({
        rev: 'graph-1',
        entries: [{ id: '@dsh/<conversation', url: '/plugins/@dsh/<conversation/client.js', rev: 'bundle-1' }],
      }),
      clientPath: id => id === '@dsh/conversation' ? bundlePath : undefined,
      dispatch,
      read: async (path) => {
        const body = files.get(path)
        if (body === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return body
      },
    }),
  }
}

describe('desktop protocol', () => {
  it('injects an external boot script and a restrictive document policy', async () => {
    const { handle } = handler()
    const response = await handle(new Request('dsh://app/'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toBe(DESKTOP_CSP)
    expect(DESKTOP_CSP.split('; ')).toContain("script-src 'self' 'unsafe-eval'")
    const html = await response.text()
    expect(html.indexOf(`<script src="${DESKTOP_BOOT_PATH}"></script>`)).toBeLessThan(html.indexOf('/assets/index.js'))
    expect(html).not.toContain('window.__DSH_BOOT__ =')
  })

  it('serves the current graph as script data and escapes markup-capable ids', async () => {
    const { handle } = handler()
    const response = await handle(new Request(`dsh://app${DESKTOP_BOOT_PATH}`))
    expect(response.headers.get('cache-control')).toBe('no-store')
    const script = await response.text()
    expect(script).toContain('window.__DSH_BOOT__ =')
    expect(script).not.toContain('<')
    expect(script).toContain('graph-1')
  })

  it('serves scoped client bundles and source maps without exposing arbitrary files', async () => {
    const { handle } = handler()
    const bundle = await handle(new Request('dsh://app/plugins/@dsh/conversation/client.js?rev=bundle-1'))
    expect(await bundle.text()).toBe('register("conversation")')
    expect(bundle.headers.get('cache-control')).toBe('no-cache')
    const map = await handle(new Request('dsh://app/plugins/@dsh/conversation/client.js.map'))
    expect(await map.text()).toBe('{}')
    expect((await handle(new Request('dsh://app/plugins/@dsh/unknown/client.js'))).status).toBe(404)
  })

  it('forwards API streams and dedicated POST channels through the trusted Host dispatcher', async () => {
    const { handle, dispatch } = handler()
    const stream = await handle(new Request('dsh://app/api/events.mux'))
    const providers = await handle(new Request('dsh://app/api/llm.providers', { method: 'POST', body: '{}' }))
    const presets = await handle(new Request('dsh://app/api/agentPreset.list', { method: 'POST', body: '{}' }))
    const rpc = await handle(new Request('dsh://app/rpc/goals/create', { method: 'POST', body: '{}' }))
    expect(stream.status).toBe(202)
    expect(providers.status).toBe(202)
    expect(presets.status).toBe(202)
    expect(rpc.status).toBe(202)
    expect(dispatch).toHaveBeenCalledTimes(4)
  })

  it('rejects foreign authorities, traversal, and write attempts to static resources', async () => {
    const { handle } = handler()
    expect((await handle(new Request('dsh://other/'))).status).toBe(404)
    expect((await handle(new Request('dsh://app/%5c..%5csecret.txt'))).status).toBe(403)
    expect((await handle(new Request('dsh://app/assets/index.js', { method: 'PUT', body: 'x' }))).status).toBe(405)
    expect((await handle(new Request(`dsh://app${DESKTOP_BOOT_PATH}`, { method: 'POST', body: 'x' }))).status).toBe(405)
  })
})
