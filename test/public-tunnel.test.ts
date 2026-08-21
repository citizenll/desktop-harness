import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cloudflaredAssetName,
  cloudflaredTunnelArguments,
  parseCloudflaredStartupOutput,
  resolveCloudflaredExecutable
} from '../src/main/mobile/public-tunnel'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('cloudflared runtime resolver', () => {
  it('binds the edge connector to the preferred physical IPv4 interface', () => {
    expect(cloudflaredTunnelArguments(43127, '192.168.31.203')).toEqual([
      'tunnel',
      '--url',
      'http://127.0.0.1:43127',
      '--protocol',
      'http2',
      '--edge-ip-version',
      '4',
      '--edge-bind-address',
      '192.168.31.203',
      '--no-autoupdate'
    ])
    expect(cloudflaredTunnelArguments(43127, 'not-an-address')).not.toContain(
      '--edge-bind-address'
    )
  })

  it('does not publish the quick-tunnel URL before Cloudflare registers the connector', () => {
    const announced = parseCloudflaredStartupOutput(
      'Your quick Tunnel has been created! Visit it at https://unit-test.trycloudflare.com'
    )
    expect(announced).toEqual({
      url: 'https://unit-test.trycloudflare.com',
      registered: false
    })
    expect(
      parseCloudflaredStartupOutput(
        'https://unit-test.trycloudflare.com\nINF Registered tunnel connection connIndex=0 protocol=http2'
      )
    ).toEqual({
      url: 'https://unit-test.trycloudflare.com',
      registered: true
    })
  })

  it('maps supported desktop platforms to official release assets', () => {
    expect(cloudflaredAssetName('win32', 'x64')).toBe('cloudflared-windows-amd64.exe')
    expect(cloudflaredAssetName('darwin', 'arm64')).toBe('cloudflared-darwin-arm64.tgz')
    expect(cloudflaredAssetName('linux', 'x64')).toBe('cloudflared-linux-amd64')
    expect(() => cloudflaredAssetName('win32', 'ia32')).toThrow('CPU architecture')
  })

  it('downloads from the official release, verifies SHA-256, and reuses the cache', async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), 'dsh-tunnel-test-'))
    temporaryDirectories.push(cacheDirectory)
    const binary = Buffer.alloc(1024 * 1024 + 17, 0x5a)
    const digest = createHash('sha256').update(binary).digest('hex')
    let requests = 0
    const fakeFetch = (async (input: string | URL | Request) => {
      requests += 1
      if (String(input).includes('/releases/latest')) {
        return Response.json({
          tag_name: 'test-version',
          assets: [
            {
              name: 'cloudflared-windows-amd64.exe',
              browser_download_url: 'https://example.invalid/cloudflared.exe',
              size: binary.length,
              digest: `sha256:${digest}`
            }
          ]
        })
      }
      return new Response(binary)
    }) as typeof fetch

    const executable = await resolveCloudflaredExecutable({
      cacheDirectory,
      platform: 'win32',
      arch: 'x64',
      pathValue: '',
      fetchImpl: fakeFetch
    })
    expect(executable).toBe(join(cacheDirectory, 'cloudflared.exe'))
    expect(await readFile(executable)).toEqual(binary)
    expect(requests).toBe(2)

    const cached = await resolveCloudflaredExecutable({
      cacheDirectory,
      platform: 'win32',
      arch: 'x64',
      pathValue: '',
      fetchImpl: (async () => {
        throw new Error('cache should avoid the network')
      }) as typeof fetch
    })
    expect(cached).toBe(executable)
  }, 60_000)

  it('refuses an executable asset without an official digest', async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), 'dsh-tunnel-test-'))
    temporaryDirectories.push(cacheDirectory)
    await expect(
      resolveCloudflaredExecutable({
        cacheDirectory,
        platform: 'win32',
        arch: 'x64',
        pathValue: '',
        fetchImpl: (async () =>
          Response.json({
            assets: [
              {
                name: 'cloudflared-windows-amd64.exe',
                browser_download_url: 'https://example.invalid/cloudflared.exe',
                size: 2 * 1024 * 1024
              }
            ]
          })) as typeof fetch
      })
    ).rejects.toThrow('did not provide a SHA-256 digest')
  })
})
