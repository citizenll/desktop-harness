import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { patchPath, projectRoot } from './patch-path'

async function source(...segments: string[]): Promise<string> {
  return readFile(path.join(projectRoot, ...segments), 'utf8').then(value =>
    value.replaceAll('\r\n', '\n')
  )
}

describe('Windows child-process visibility', () => {
  it('keeps every Desktop-owned runtime command hidden', async () => {
    const [harness, toolchain, recovery, tunnel, pluginRuntime, marketCli, marketRestart] =
      await Promise.all([
        source('src', 'main', 'runtime', 'harness-runtime.ts'),
        source('src', 'main', 'runtime', 'desktop-toolchain.ts'),
        source('src', 'main', 'runtime', 'profile-plugin-command.ts'),
        source('src', 'main', 'mobile', 'public-tunnel.ts'),
        source('packages', 'dsh-desktop-plugin-runtime', 'index.js'),
        source('packages', 'dsh-desktop-market', 'src', 'dsh-cli.ts'),
        source('packages', 'dsh-desktop-market', 'src', 'restart.ts')
      ])

    expect(harness).toContain('windowsHide: true')
    expect(toolchain.match(/windowsHide: true/g)?.length).toBeGreaterThanOrEqual(2)
    expect(recovery.match(/windowsHide: true/g)?.length).toBeGreaterThanOrEqual(2)
    expect(tunnel.match(/windowsHide: true/g)?.length).toBeGreaterThanOrEqual(2)
    expect(pluginRuntime.match(/windowsHide: true/g)?.length).toBeGreaterThanOrEqual(2)

    // All plugin-market command execution funnels through spawnShim; the two
    // direct taskkill calls are separately hidden as well.
    expect(marketCli.match(/windowsHide: true/g)?.length).toBeGreaterThanOrEqual(5)
    expect(marketRestart).toContain('shell: viaShell, windowsHide: true')
    expect(marketRestart).toContain("env: process.env,\n    windowsHide: true")
  })

  it('patches the two upstream command paths that bypass Desktop wrappers', async () => {
    const [dshPatch, subprocessPatch] = await Promise.all([
      readFile(patchPath('@deepseek-ai/dsh'), 'utf8'),
      readFile(patchPath('@deepseek-ai/dsh-subprocess-local'), 'utf8')
    ])

    // `dsh plugin` invokes pnpm directly instead of using the subprocess seam.
    expect(dshPatch).toContain('windowsHide: true')

    // Agent shell commands, process inspection and process-tree cleanup all
    // live in subprocess-local, so the invariant must be applied at that seam.
    expect(subprocessPatch.match(/windowsHide: true/g)?.length).toBeGreaterThanOrEqual(4)
    expect(subprocessPatch).toContain('detached: platform !== "win32"')
  })
})
