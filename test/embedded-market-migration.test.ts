import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { migrateEmbeddedMarketProfile } from '../src/main/state/embedded-market-migration'

describe('embedded dsh-market migration', () => {
  it('removes only the old profile package registration and keeps user plugins and state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-desktop-market-migration-'))
    const profile = join(home, 'profiles', 'web')
    const installedMarket = join(profile, 'node_modules', 'dshmarket')
    const marketState = join(profile, '.dsh-market', 'preferences.json')
    await mkdir(installedMarket, { recursive: true })
    await mkdir(join(profile, '.dsh-market'), { recursive: true })
    await writeFile(join(installedMarket, 'package.json'), '{"name":"dshmarket"}\n', 'utf8')
    await writeFile(marketState, '{"channel":"stable"}\n', 'utf8')
    await writeFile(
      join(profile, 'package.json'),
      `${JSON.stringify(
        {
          private: true,
          dependencies: { dshmarket: '1.16.6', 'example-plugin': '2.0.0' },
          dsh: {
            profile: {
              bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket', 'example-plugin']
            }
          }
        },
        null,
        2
      )}\n`,
      'utf8'
    )
    await writeFile(
      join(profile, 'pnpm-lock.yaml'),
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        '      dshmarket:',
        '        specifier: 1.16.6',
        '        version: 1.16.6',
        '      example-plugin:',
        '        specifier: 2.0.0',
        '        version: 2.0.0',
        'packages:',
        '  dshmarket@1.16.6: {}',
        '  example-plugin@2.0.0: {}',
        'snapshots:',
        '  dshmarket@1.16.6:',
        '    dependencies:',
        '      shared-helper: 1.0.0',
        '  example-plugin@2.0.0: {}',
        ''
      ].join('\n'),
      'utf8'
    )

    await expect(migrateEmbeddedMarketProfile(home)).resolves.toEqual({
      changed: true,
      manifestChanged: true,
      lockfileChanged: true,
      removedInstalledPackage: true
    })

    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    expect(manifest.dependencies).toEqual({ 'example-plugin': '2.0.0' })
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'example-plugin'
    ])
    const lockfile = parse(await readFile(join(profile, 'pnpm-lock.yaml'), 'utf8')) as {
      importers: Record<string, { dependencies: Record<string, unknown> }>
      packages: Record<string, unknown>
      snapshots: Record<string, unknown>
    }
    expect(lockfile.importers['.']?.dependencies).toEqual({
      'example-plugin': { specifier: '2.0.0', version: '2.0.0' }
    })
    expect(lockfile.packages).toEqual({ 'example-plugin@2.0.0': {} })
    expect(lockfile.snapshots).toEqual({ 'example-plugin@2.0.0': {} })
    await expect(access(installedMarket)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(marketState, 'utf8')).resolves.toContain('stable')

    await expect(migrateEmbeddedMarketProfile(home)).resolves.toEqual({
      changed: false,
      manifestChanged: false,
      lockfileChanged: false,
      removedInstalledPackage: false
    })
  })
})
