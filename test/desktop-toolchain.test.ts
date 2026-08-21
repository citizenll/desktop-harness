import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildDesktopToolchainEnvironment,
  detectNodePackageManagers,
  desktopToolchainDirectory,
  prepareDesktopToolchain
} from '../src/main/runtime/desktop-toolchain'

describe('desktop toolchain', () => {
  const testDir = join(__dirname, '.temp-desktop-toolchain-test')
  const pnpmEntryPath = join(process.cwd(), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('owns the PATH inherited by Harness and enables Electron Node mode', () => {
    const shimDirectory = 'C:\\Users\\tester\\AppData\\Roaming\\dsh-desktop\\harness\\.desktop-bin'
    const nodeExecutablePath = 'C:\\Program Files\\DSH Desktop\\node\\node.exe'
    const environment = buildDesktopToolchainEnvironment({
      dshHome: 'C:\\Users\\tester\\AppData\\Roaming\\dsh-desktop\\harness',
      shimDirectory,
      nodeExecutablePath,
      platform: 'win32',
      environment: {
        ELECTRON_RUN_AS_NODE: '1',
        corepack_enable_strict: '1',
        Path: [
          'C:\\Windows\\System32',
          shimDirectory.toUpperCase(),
          dirname(nodeExecutablePath).toLowerCase()
        ].join(';')
      }
    })

    expect(environment.PATH?.split(';')).toEqual([
      shimDirectory,
      dirname(nodeExecutablePath),
      'C:\\Windows\\System32'
    ])
    expect(environment.Path).toBe(environment.PATH)
    expect(environment.DSH_HOME).toContain('dsh-desktop\\harness')
    expect(environment.COREPACK_ENABLE_STRICT).toBe('0')
    expect(environment).not.toHaveProperty('corepack_enable_strict')
    expect(environment.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('ignores an unrelated ancestor Yarn declaration and verifies packaged pnpm', async () => {
    const ownerDirectory = join(testDir, 'owner')
    const dshHome = join(ownerDirectory, 'AppData', 'Roaming', 'dsh-desktop', 'harness')
    await mkdir(ownerDirectory, { recursive: true })
    await writeFile(
      join(ownerDirectory, 'package.json'),
      JSON.stringify({ private: true, packageManager: 'yarn@1.22.22' }),
      'utf8'
    )
    const options = {
      dshHome,
      nodeExecutablePath: process.execPath,
      pnpmEntryPath,
      environment: {
        ComSpec: process.env.ComSpec,
        SystemRoot: process.env.SystemRoot,
        Path: ''
      }
    }

    const first = await prepareDesktopToolchain(options)
    expect(first.directory).toBe(desktopToolchainDirectory(dshHome))
    expect(first.pnpmVersion).toBe('10.34.5')
    expect(first.environment.PATH?.split(delimiter)[0]).toBe(first.directory)

    const shimPath = join(first.directory, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
    await writeFile(shimPath, 'broken', 'utf8')
    const repaired = await prepareDesktopToolchain(options)
    const shim = await readFile(shimPath, 'utf8')
    expect(repaired.pnpmVersion).toBe('10.34.5')
    expect(shim).toContain(process.execPath)
    expect(shim).toContain('pnpm.cjs')
    expect(shim).toContain('ELECTRON_RUN_AS_NODE=1')
  }, 20_000)

  it('detects common managers from PATH without running them', async () => {
    const binDirectory = join(testDir, 'system-bin')
    await mkdir(binDirectory, { recursive: true })
    await writeFile(join(binDirectory, 'pnpm'), 'must not execute', 'utf8')
    await writeFile(join(binDirectory, 'npm.CMD'), '@exit /b 99', 'utf8')

    const detected = await detectNodePackageManagers(
      { Path: binDirectory, PATHEXT: '.EXE;.CMD' },
      'win32'
    )
    expect(detected).toEqual([
      { name: 'pnpm', available: true },
      { name: 'npm', available: true },
      { name: 'yarn', available: false },
      { name: 'bun', available: false }
    ])
  })
})
