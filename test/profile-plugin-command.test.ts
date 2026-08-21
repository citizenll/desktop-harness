import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeProfilePluginWithDsh } from '../src/main/runtime/profile-plugin-command'

describe('profile-plugin-command', () => {
  const testDir = join(__dirname, '.temp-profile-plugin-command-test')

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('runs the DSH remove command with the bundled pnpm shim on PATH', async () => {
    const profileDirectory = join(testDir, 'profiles', 'web')
    const reportPath = join(testDir, 'report.json')
    const dshEntryPath = join(testDir, 'fake-dsh.mjs')
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(
      dshEntryPath,
      `
        import { spawnSync } from 'node:child_process'
        import { writeFileSync } from 'node:fs'
        const pnpm = spawnSync('pnpm', ['--version'], {
          encoding: 'utf8',
          shell: process.platform === 'win32'
        })
        writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({
          argv: process.argv.slice(2),
          dshHome: process.env.DSH_HOME,
          pnpmVersion: pnpm.stdout?.trim(),
          pnpmStatus: pnpm.status,
          pnpmError: pnpm.error?.message
        }))
        process.exit(pnpm.status ?? 1)
      `,
      'utf8'
    )

    const result = await removeProfilePluginWithDsh(
      {
        dshHome: testDir,
        dshEntryPath,
        nodeExecutablePath: process.execPath,
        pnpmEntryPath: join(process.cwd(), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
        environment: process.env
      },
      '@example/plugin'
    )

    expect(result).toEqual({ ok: true })
    expect(JSON.parse(await readFile(reportPath, 'utf8'))).toEqual({
      argv: ['plugin', '--profile', 'web', 'remove', '@example/plugin'],
      dshHome: testDir,
      pnpmVersion: '10.34.5',
      pnpmStatus: 0
    })
  })
})
