import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildPnpmEnvironment,
  createDesktopPnpmService,
  createDesktopProfilesService,
  ensurePnpmShim,
  resolvePnpmEntry
} from '../packages/dsh-desktop-plugin-runtime/index.js'

describe('desktop plugin runtime', () => {
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
    const marketVersion = manifest.dependencies.dshmarket
    const desktopPatch = await readFile(join(projectRoot, 'build', 'dsh-desktop.patch.yml'), 'utf8')
    const preload = await readFile(join(projectRoot, 'src', 'preload', 'index.ts'), 'utf8')
    const dshPatch = await readFile(
      join(projectRoot, 'patches', '@deepseek-ai+dsh+0.1.0-rc.8.patch'),
      'utf8'
    )
    const marketPatch = await readFile(
      join(projectRoot, 'patches', `dshmarket+${marketVersion}.patch`),
      'utf8'
    )
    const hostPatch = await readFile(
      join(projectRoot, 'patches', '@deepseek-ai+dsh-client-ui-settings-plugins+0.1.0-rc.8.patch'),
      'utf8'
    )
    const marketClient = await readFile(
      join(projectRoot, 'node_modules', 'dshmarket', 'client', 'client.js'),
      'utf8'
    )
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

    expect(marketVersion).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
    expect(lockfile.packages['node_modules/dshmarket']?.version).toBe(marketVersion)
    expect(manifest.dependencies['dsh-desktop-plugin-runtime']).toBe(
      'file:packages/dsh-desktop-plugin-runtime'
    )
    expect(manifest.dependencies['dsh-desktop-market-installer']).toBeUndefined()
    expect(lockfile.packages['packages/dsh-desktop-market-installer']).toBeUndefined()
    expect(
      existsSync(join(projectRoot, 'packages', 'dsh-desktop-market-installer', 'package.json'))
    ).toBe(false)

    expect(desktopPatch).toContain('name: dsh-desktop-plugin-runtime')
    expect(desktopPatch).toContain('name: dshmarket')
    expect(desktopPatch).toContain('inject: [desktopProfiles]')
    expect(desktopPatch).not.toContain('market-installer')
    expect(dshPatch).toContain(`+    "dshmarket": "${marketVersion}",`)
    expect(preload).toContain("marketPlacement: 'plugins' as const")

    expect(marketPatch).toContain("const embedded = window.dshDesktop?.marketPlacement === 'plugins'")
    expect(marketPatch).toContain("ctx.slots.inject('settings.plugins.tab'")
    expect(marketPatch).toContain('settingsPluginViews')
    expect(marketPatch).toContain("{ id: 'discover', order: 20")
    expect(marketPatch).toContain("{ id: 'advanced', order: 50")
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
