import { afterEach, describe, expect, it } from 'vitest'
import {
  PluginInstallWebBridge,
  pluginInstallBridgePage,
} from '../src/main/plugin-install-web-bridge'

const activeBridges: PluginInstallWebBridge[] = []

afterEach(async () => {
  await Promise.all(activeBridges.splice(0).map((bridge) => bridge.stop()))
})

async function pageToken(origin: string): Promise<string> {
  const response = await fetch(`${origin}/`)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const html = await response.text()
  const match = html.match(/const token = ("[A-Za-z0-9_-]+");/)
  if (!match?.[1]) throw new Error('The bridge page did not contain a request token.')
  return JSON.parse(match[1]) as string
}

describe('plugin install web bridge', () => {
  it('serves a fragment reader for the stable browser install form', () => {
    const html = pluginInstallBridgePage('test-token')
    expect(html).toContain("params.get('dsh-plugin-install')")
    expect(html).toContain("fetch('/plugin/install'")
    expect(html).toContain('JSON.stringify({source, token})')
    expect(html).toContain('请返回应用并确认安装')
  })

  it('forwards one validated same-origin request to Desktop', async () => {
    const sources: string[] = []
    const bridge = new PluginInstallWebBridge({
      port: 0,
      onInstallRequest: (source) => {
        sources.push(source)
      },
    })
    activeBridges.push(bridge)
    const origin = await bridge.start()
    const token = await pageToken(origin)

    const rejected = await fetch(`${origin}/plugin/install`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://example.com',
      },
      body: JSON.stringify({ source: 'nexu-io/open-design', token }),
    })
    expect(rejected.status).toBe(403)
    expect(sources).toEqual([])

    const accepted = await fetch(`${origin}/plugin/install`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
      },
      body: JSON.stringify({ source: 'le-soleil-se-couche/dsh-skin-claude-code', token }),
    })
    expect(accepted.status).toBe(202)
    await expect(accepted.json()).resolves.toEqual({ ok: true })
    expect(sources).toEqual(['le-soleil-se-couche/dsh-skin-claude-code'])

    const replay = await fetch(`${origin}/plugin/install`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
      },
      body: JSON.stringify({ source: 'nexu-io/open-design', token }),
    })
    expect(replay.status).toBe(403)
    expect(sources).toHaveLength(1)
  })

  it('rejects malformed plugin sources before dispatch', async () => {
    const sources: string[] = []
    const bridge = new PluginInstallWebBridge({
      port: 0,
      onInstallRequest: (source) => {
        sources.push(source)
      },
    })
    activeBridges.push(bridge)
    const origin = await bridge.start()
    const token = await pageToken(origin)

    const response = await fetch(`${origin}/plugin/install`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
      },
      body: JSON.stringify({ source: 'owner/repo --ignore-scripts=false', token }),
    })
    expect(response.status).toBe(400)
    expect(sources).toEqual([])
  })
})
