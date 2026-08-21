import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply as applyDesktopMarket } from '../packages/dsh-desktop-market/lib/index.js'
import {
  buildPnpmEnvironment,
  createDesktopPnpmService,
  createDesktopProfilesService,
  ensurePnpmShim,
  resolvePnpmEntry
} from '../packages/dsh-desktop-plugin-runtime/index.js'

describe('desktop plugin runtime', () => {
  it('does not mount the built-in market without the Desktop host contract', () => {
    const context = {
      get: () => undefined,
      inject: (_services, callback) => callback({})
    }

    expect(() => applyDesktopMarket(context)).toThrow(
      'dsh-desktop-market requires the Desktop profile service.'
    )
  })

  it('ships a resolvable pnpm binary instead of relying on the user PATH', () => {
    expect(resolvePnpmEntry()).toMatch(/node_modules[/\\]pnpm[/\\]bin[/\\]pnpm\.(c|m)js$/u)
  })

  it('generates packaged node and pnpm shims in desktop-bin', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-plugin-runtime-shim-'))
    const binDir = await ensurePnpmShim(home)
    expect(binDir).toBe(join(home, '.desktop-bin'))

    if (process.platform === 'win32') {
      const pnpmCmd = await readFile(join(binDir, 'pnpm.cmd'), 'utf8')
      const nodeCmd = await readFile(join(binDir, 'node.cmd'), 'utf8')
      expect(pnpmCmd).toContain(process.execPath)
      expect(pnpmCmd).toContain('pnpm')
      expect(pnpmCmd).toContain('ELECTRON_RUN_AS_NODE=1')
      expect(nodeCmd).toContain(process.execPath)
    } else {
      const pnpmScript = await readFile(join(binDir, 'pnpm'), 'utf8')
      const nodeScript = await readFile(join(binDir, 'node'), 'utf8')
      expect(pnpmScript).toContain(process.execPath)
      expect(pnpmScript).toContain('pnpm')
      expect(pnpmScript).toContain('ELECTRON_RUN_AS_NODE=1')
      expect(nodeScript).toContain(process.execPath)
    }
  })

  it('exposes one explicit Desktop profile without inferring it from argv', async () => {
    const home = join('C:\\Users\\tester', 'AppData', 'Roaming', 'dsh-desktop', 'harness')
    const profiles = createDesktopProfilesService(home)

    expect(profiles.current).toEqual({
      name: 'web',
      dir: join(home, 'profiles', 'web')
    })
    expect(profiles.list()).toEqual([profiles.current])
    await expect(profiles.select('web')).resolves.toBeUndefined()
    await expect(profiles.select('other')).rejects.toThrow('only exposes the web profile')
  })

  it('serializes plugin mutations through the packaged pnpm boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-pnpm-service-'))
    const binDirectory = join(root, '.desktop-bin')
    const fakeDshEntry = join(root, 'fake-dsh.mjs')
    await mkdir(binDirectory, { recursive: true })
    await writeFile(
      fakeDshEntry,
      [
        "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), path: process.env.PATH }))",
        "await new Promise((resolve) => setTimeout(resolve, Number(process.env.DSH_DESKTOP_TEST_DELAY_MS ?? '0')))"
      ].join('\n'),
      'utf8'
    )

    const environment = {
      ...process.env,
      DSH_DESKTOP_TEST_DELAY_MS: '80',
      ELECTRON_RUN_AS_NODE: '1'
    }
    const service = createDesktopPnpmService({
      binDirectory,
      dshEntryPath: fakeDshEntry,
      executablePath: process.execPath,
      environment
    })
    const handle = service.runPlugin(['remove', 'example-plugin'], root)
    expect(() => service.runPlugin(['install'], root)).toThrow(
      'Another desktop pnpm operation is already running.'
    )

    let stdout = ''
    handle.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    const invocation = JSON.parse(stdout)
    expect(invocation.args).toEqual([
      'plugin',
      '--profile',
      'web',
      'remove',
      'example-plugin'
    ])
    expect(await realpath(invocation.cwd)).toBe(await realpath(root))
    expect(invocation.path.split(process.platform === 'win32' ? ';' : ':')[0]).toBe(
      binDirectory
    )
    expect(buildPnpmEnvironment(binDirectory, environment).ELECTRON_RUN_AS_NODE).toBe('1')

    const next = service.runPlugin(['install'], root)
    await expect(next.done).resolves.toEqual({ exitCode: 0, signal: null })
    await service.dispose()
    expect(() => service.runPlugin(['install'], root)).toThrow('has been disposed')
  })

  it('rejects an operation that was already aborted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-pnpm-abort-'))
    const controller = new AbortController()
    controller.abort(new Error('cancelled before start'))
    const service = createDesktopPnpmService({
      binDirectory: join(root, '.desktop-bin'),
      dshEntryPath: join(root, 'unused-dsh-entry.mjs'),
      executablePath: process.execPath
    })

    expect(() => service.runPlugin(['install'], root, controller.signal)).toThrow(
      'cancelled before start'
    )
    await service.dispose()
  })

  it('composes the market as a first-party Plugins surface', async () => {
    const projectRoot = process.cwd()
    const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
    const lockfile = JSON.parse(await readFile(join(projectRoot, 'package-lock.json'), 'utf8'))
    const dshVersion = manifest.dependencies['@deepseek-ai/dsh']
    const marketRoot = join(projectRoot, 'packages', 'dsh-desktop-market')
    const marketManifest = JSON.parse(
      await readFile(join(marketRoot, 'package.json'), 'utf8')
    )
    const desktopPatch = await readFile(join(projectRoot, 'build', 'dsh-desktop.patch.yml'), 'utf8')
    const dshPatch = await readFile(
      join(projectRoot, 'patches', `@deepseek-ai+dsh+${dshVersion}.patch`),
      'utf8'
    )
    const hostPatch = await readFile(
      join(
        projectRoot,
        'patches',
        `@deepseek-ai+dsh-client-ui-settings-plugins+${dshVersion}.patch`
      ),
      'utf8'
    )
    const marketClient = await readFile(
      join(marketRoot, 'client', 'client.js'),
      'utf8'
    )
    const marketHost = await readFile(join(marketRoot, 'src', 'index.ts'), 'utf8')
    const hostClient = await readFile(
      join(
        projectRoot,
        'node_modules',
        '@deepseek-ai',
        'dsh-client-ui-settings-plugins',
        'lib',
        'client.js'
      ),
      'utf8'
    )

    expect(manifest.dependencies['dsh-desktop-market']).toBe(
      'file:packages/dsh-desktop-market'
    )
    expect(manifest.dependencies['dsh-desktop-plugin-runtime']).toBe(
      'file:packages/dsh-desktop-plugin-runtime'
    )
    expect(manifest.dependencies.dshmarket).toBeUndefined()
    expect(marketManifest).toMatchObject({
      name: 'dsh-desktop-market',
      version: '0.1.0',
      private: true
    })
    expect(marketManifest.peerDependencies).toEqual({ '@deepseek-ai/cordis': '^4.0.1' })
    expect(lockfile.packages['packages/dsh-desktop-market']?.version).toBe('0.1.0')
    expect(lockfile.packages['node_modules/dsh-desktop-market']?.link).toBe(true)
    expect(lockfile.packages['node_modules/dshmarket']).toBeUndefined()
    expect(existsSync(join(projectRoot, 'patches', 'dshmarket+1.17.0.patch'))).toBe(false)
    expect(manifest.dependencies['dsh-desktop-market-installer']).toBeUndefined()
    expect(lockfile.packages['packages/dsh-desktop-market-installer']).toBeUndefined()
    expect(
      existsSync(join(projectRoot, 'packages', 'dsh-desktop-market-installer', 'package.json'))
    ).toBe(false)

    expect(desktopPatch).toContain('name: dsh-desktop-plugin-runtime')
    expect(desktopPatch).toContain('name: dsh-desktop-market')
    expect(desktopPatch).toContain('inject: [desktopProfiles]')
    expect(desktopPatch).not.toContain('market-installer')
    expect(dshPatch).toContain('+    "dsh-desktop-market": "0.1.0",')
    expect(marketClient).toContain('id: "dsh-desktop-market"')
    expect(marketClient).toContain('const embedded = true')
    expect(marketClient).not.toContain('marketPlacement === "plugins"')
    expect(marketClient).toContain('settings.plugins.tab')
    expect(marketClient).toContain('settingsPluginViews')
    expect(marketHost).toContain('requires the Desktop profile service')
    expect(marketHost).not.toContain('installMarketSettings')
    expect(hostPatch).toContain('entries("settings.plugins.tab").flatMap')
    expect(hostPatch).toContain('entry.component?.settingsPluginViews')
    expect(hostPatch).toContain('ownerId')
    expect(hostPatch).toContain('selectView: (view) =>')
    expect(hostPatch).toContain('updateView: (view, meta) =>')

    // SlotCore intentionally discards unknown registration options. Grouped
    // tabs therefore live on the retained component, not on a `views` option
    // that silently disappears before the Plugins page reads the ledger.
    expect(hostClient).toContain('entry.component?.settingsPluginViews')
    expect(hostClient).not.toContain('entry.options.views')
    expect(marketClient).toContain('settingsPluginViews')

    // Embedded layout has no empty header spacer and no scroll-triggered
    // category collapse; both keep the sticky search region geometrically stable.
    expect(marketClient).toContain('showEmbeddedHead')
    expect(marketClient).toContain('paddingTop: 0')
    expect(marketClient).toContain('scrollbarGutter: "stable"')
    expect(marketClient).not.toContain('catsStuck')
    expect(marketClient).not.toContain('visibleCatsOneRow')
  })
})
