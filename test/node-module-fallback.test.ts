import { spawnSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  configureNodeWorkerModuleFallback,
  prependNodeModuleSearchPath
} from '../src/main/runtime/node-module-fallback'

describe('node module fallback', () => {
  const testDir = join(__dirname, '.temp-node-module-fallback-test')

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('prepends and de-duplicates the packaged module directory', () => {
    expect(
      prependNodeModuleSearchPath(
        'C:\\Program Files\\DSH Desktop\\resources\\app.asar\\node_modules',
        'C:\\existing;C:\\PROGRAM FILES\\DSH Desktop\\resources\\app.asar\\node_modules\\',
        'win32'
      )
    ).toBe(
      'C:\\Program Files\\DSH Desktop\\resources\\app.asar\\node_modules;C:\\existing'
    )
  })

  it('lets createRequire scanners resolve installation packages from a profile anchor', async () => {
    const applicationPath = join(testDir, 'app.asar')
    const packageDirectory = join(applicationPath, 'node_modules', '@example', 'runtime')
    const profileDirectory = join(testDir, 'profile')
    const hookPath = join(testDir, 'fallback-hook.mjs')
    await mkdir(packageDirectory, { recursive: true })
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(
      join(packageDirectory, 'package.json'),
      JSON.stringify({
        name: '@example/runtime',
        version: '1.0.0',
        exports: { './package.json': './package.json' }
      }),
      'utf8'
    )
    await writeFile(join(applicationPath, 'package.json'), '{}\n', 'utf8')
    await writeFile(hookPath, '', 'utf8')

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_OPTIONS: '',
      NODE_PATH: ''
    }
    configureNodeWorkerModuleFallback({
      applicationPath,
      hookPath,
      environment
    })

    const anchor = join(profileDirectory, 'cordis.yml')
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const { createRequire } = require('node:module'); process.stdout.write(createRequire(${JSON.stringify(anchor)}).resolve('@example/runtime/package.json'))`
      ],
      { encoding: 'utf8', env: environment, cwd: profileDirectory }
    )

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe(join(packageDirectory, 'package.json'))
    expect(environment.DSH_DESKTOP_MODULE_FALLBACK_URL).toContain('app.asar/package.json')
    expect(environment.NODE_OPTIONS).toContain('--import=')
  })
})
