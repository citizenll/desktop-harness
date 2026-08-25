import { PassThrough } from 'node:stream'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  beginInstallOutputSession,
  createDesktopPluginRuntime,
  finishInstallOutputSession,
  progress,
} from '../packages/dsh-desktop-market/src/dsh-cli'
import {
  InstallOutputBuffer,
  installOutputCandidates,
  sanitizeInstallOutput,
} from '../packages/dsh-desktop-market/src/install-progress'

describe('direct plugin install progress', () => {
  it('keeps lifecycle command/output while dropping high-frequency pnpm telemetry', () => {
    expect(installOutputCandidates(JSON.stringify({
      name: 'pnpm:lifecycle',
      depPath: '@scope/plugin@1.0.0',
      stage: 'prepare',
      script: 'pnpm build',
    }), 'stdout')).toEqual([{
      stream: 'command',
      text: '@scope/plugin@1.0.0 · prepare > pnpm build',
    }])

    expect(installOutputCandidates(JSON.stringify({
      name: 'pnpm:lifecycle',
      depPath: '@scope/plugin@1.0.0',
      stage: 'prepare',
      stdio: 'stderr',
      line: 'build warning',
    }), 'stdout')).toEqual([{
      stream: 'stderr',
      text: '@scope/plugin@1.0.0 · prepare | build warning',
    }])

    expect(installOutputCandidates(JSON.stringify({
      name: 'pnpm:fetching-progress',
      packageId: 'react@18.3.1',
      downloaded: 42,
    }), 'stdout')).toEqual([])
  })

  it('removes terminal escapes and masks credentials before output reaches the renderer', () => {
    const text = sanitizeInstallOutput(
      '\u001b[31mC:\\Users\\citizenl npm_abcdefghijklmnopqrstuvwxyz Bearer secret-value\u001b[0m',
      'C:\\Users\\citizenl',
    )
    expect(text).toBe('~ npm_*** Bearer ***')
  })

  it('deduplicates adjacent rows and retains only a bounded tail', () => {
    const output = new InstallOutputBuffer()
    output.push('stdout', 'same')
    output.push('stdout', 'same')
    for (let index = 0; index < 200; index += 1) output.push('stdout', `line-${String(index)}`)

    const snapshot = output.snapshot()
    expect(snapshot).toHaveLength(160)
    expect(snapshot[0]?.text).toBe('line-40')
    expect(snapshot.at(-1)?.text).toBe('line-199')
  })

  it('keeps retries in one route-wide transcript', async () => {
    let run = 0
    const runtime = createDesktopPluginRuntime({
      runPlugin() {
        run += 1
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        const done = new Promise<{ exitCode: number; signal: null }>((resolveDone) => {
          queueMicrotask(() => {
            stdout.end(`${JSON.stringify({
              name: 'pnpm:lifecycle',
              depPath: `plugin@${String(run)}`,
              stage: 'prepare',
              line: `build-${String(run)}`,
              stdio: 'stdout',
            })}\n`)
            stderr.end()
            resolveDone({ exitCode: 0, signal: null })
          })
        })
        return { stdout, stderr, done, cancel() {} }
      },
    }, resolve('.test-profile'), resolve('.'), 5_000)

    beginInstallOutputSession('request-1', 'github:owner/plugin')
    await runtime.runPlugin('web', ['add', 'github:owner/plugin'])
    await runtime.runPlugin('web', ['add', 'github:owner/plugin'])
    finishInstallOutputSession('request-1')

    expect(progress.outputSession).toBe('request-1')
    expect(progress.output.filter(line => line.stream === 'command')).toHaveLength(2)
    expect(progress.output.map(line => line.text)).toEqual(expect.arrayContaining([
      'plugin@1 · prepare | build-1',
      'plugin@2 · prepare | build-2',
    ]))
    await runtime.dispose()
  })
})
