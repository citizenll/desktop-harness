import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '..')

const releaseAssets = [
  'dsh-desktop-mac-arm64.dmg',
  'dsh-desktop-mac-x64.dmg',
  'dsh-desktop-windows-x64-setup.exe',
  'dsh-desktop-linux-x64.AppImage',
  'dsh-desktop-linux-x64.deb'
]

describe('GitHub release contract', () => {
  it('keeps the package and lockfile versions aligned', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { version: string }
    const packageLock = JSON.parse(
      await readFile(path.join(projectRoot, 'package-lock.json'), 'utf8')
    ) as { version: string; packages: Record<string, { version?: string }> }

    expect(packageLock.version).toBe(packageJson.version)
    expect(packageLock.packages['']?.version).toBe(packageJson.version)
  })

  it('declares required DSH peer packages as production dependencies', async () => {
    const packageLock = JSON.parse(
      await readFile(path.join(projectRoot, 'package-lock.json'), 'utf8')
    ) as {
      packages: Record<string, { dev?: boolean; peer?: boolean }>
    }

    // A lock location is a path, so nested installs read as
    // `node_modules/<host>/node_modules/<name>`. Only the segment after the
    // last `node_modules/` names the package: without that, a third-party peer
    // that npm nested under a DSH package (rc.8 gives ui-trajectory its own
    // React 19) reads as a DSH package and trips this guard.
    const packageNameOf = (location: string): string =>
      location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length)

    const peerOnlyRuntimePackages = Object.entries(packageLock.packages)
      .filter(
        ([location, metadata]) =>
          packageNameOf(location).startsWith('@deepseek-ai/') &&
          metadata.peer === true &&
          metadata.dev !== true
      )
      .map(([location]) => packageNameOf(location))

    expect(peerOnlyRuntimePackages).toEqual([])
  })

  it('uses stable platform-specific artifact names', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as {
      build: {
        artifactName: string
        asar: { smartUnpack: boolean }
        asarUnpack: string[]
        compression: string
        directories: { app: string }
        files: string[]
        win: { target: Array<{ target: string; arch: string[] }> }
        linux: {
          icon: string
          category: string
          syncDesktopName: boolean
          target: Array<{ target: string; arch: string[] }>
        }
        appImage: { artifactName: string }
        deb: { artifactName: string }
        nsis: { artifactName: string; include: string }
        portable?: unknown
      }
    }

    expect(packageJson.build.artifactName).toBe('dsh-desktop-${os}-${arch}.${ext}')
    expect(packageJson.build.asar).toEqual({ smartUnpack: false })
    expect(packageJson.build.compression).toBe('normal')
    expect(packageJson.build.directories.app).toBe('.runtime')
    expect(packageJson.build.files).toEqual([
      'out/**/*',
      'resources/**/*',
      'node_modules/**/*',
      'package.json'
    ])
    expect(packageJson.build.asarUnpack).toContain('node_modules/**/*.node')
    expect(packageJson.build.asarUnpack).toContain('node_modules/**/*.exe')
    expect(packageJson.build.nsis.artifactName).toBe(
      'dsh-desktop-windows-${arch}-setup.${ext}'
    )
    expect(packageJson.build.nsis.include).toBe('build/installer.nsh')
    expect(packageJson.build.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }])
    expect(packageJson.build.linux.icon).toBe('build/icon.png')
    expect(packageJson.build.linux.category).toBe('Development')
    expect(packageJson.build.linux.syncDesktopName).toBe(true)
    expect(packageJson.build.linux.target).toEqual([
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] }
    ])
    expect(packageJson.build.appImage.artifactName).toBe(
      'dsh-desktop-linux-x64.${ext}'
    )
    expect(packageJson.build.deb.artifactName).toBe('dsh-desktop-linux-x64.${ext}')
    expect(packageJson.build.portable).toBeUndefined()
  })

  it('turns a selected Windows drive root into an application directory', async () => {
    const installer = await readFile(
      path.join(projectRoot, 'build', 'installer.nsh'),
      'utf8'
    )

    expect(installer).toContain('!define MUI_PAGE_CUSTOMFUNCTION_SHOW DshDirectoryPageShow')
    expect(installer).toContain('${NSD_OnChange} $DshDirectoryEdit DshDirectoryChanged')
    expect(installer).toContain('StrCpy $3 "$0\\${APP_FILENAME}"')
    expect(installer).toContain('StrCpy $3 "$0${APP_FILENAME}"')
    expect(installer).toContain('${NSD_SetText} $DshDirectoryEdit $3')
  })

  it('shows a packaged startup surface and pins the Electron directory picker surface', async () => {
    const main = await readFile(path.join(projectRoot, 'src', 'main', 'index.ts'), 'utf8')
    const splash = await readFile(path.join(projectRoot, 'build', 'splash.html'), 'utf8')
    const patch = await readFile(
      path.join(projectRoot, 'build', 'dsh-desktop.patch.yml'),
      'utf8'
    )

    expect(main).toContain("desktopResourcePath('splash.html')")
    expect(main).toContain("desktopResourcePath('runtime-module-fallback.mjs')")
    expect(main).toContain('configureNodeWorkerModuleFallback({')
    expect(main).toContain('await showSplash()')
    expect(splash).toContain('正在启动 DSH Desktop')
    expect(splash).toContain('Starting DSH Desktop')
    expect(splash).toContain('src="brand.png"')
    expect(splash).not.toContain('dsh-loader.gif')
    expect(splash).not.toContain('class="track"')
    expect(patch).toMatch(/id: directory-picker\r?\n  disabled: true/)
    expect(patch).not.toContain("name: '@deepseek-ai/dsh-host-directory-picker-native'")
    expect(patch).toContain("name: '@deepseek-ai/dsh-client-ui-directory-picker-native'")
  })

  it('routes manual restarts through the active plugin recovery flow', async () => {
    const main = await readFile(path.join(projectRoot, 'src', 'main', 'index.ts'), 'utf8')

    expect(main).toContain("if (failureRecoveryVisible) resolvePluginRecoveryAction('restart')")
    expect(main).toMatch(/case 'restart-harness':\s+await restartHarness\(\)/)
    expect(main).toContain('click: () => void restartHarness().catch(showUnexpectedError)')
    expect(main).toContain("} else if (action === 'restart') {")
  })

  it('replays frontend plugin failures that arrive during an active recovery', async () => {
    const main = await readFile(path.join(projectRoot, 'src', 'main', 'index.ts'), 'utf8')

    expect(main).toContain("resolvePluginRecoveryAction('refresh')")
    expect(main).toContain('if (applyPendingFrontendEvidence()) continue')
    expect(main).toMatch(
      /if \(failureRecoveryVisible\) \{\s+queuePendingFrontendPluginRecovery\(message\)/
    )
    expect(main).toContain('queueMicrotask(() => {')
    expect(main).toContain('logs: [...rendererPluginFailureLogs]')
  })

  it('publishes update metadata for installed desktop builds', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
      build: {
        publish: Array<{ provider: string; url?: string; owner?: string; repo?: string }>
        win: { verifyUpdateCodeSignature: boolean }
      }
    }
    const workflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'release.yml'),
      'utf8'
    )

    expect(packageJson.dependencies['electron-updater']).toBeUndefined()
    expect(packageJson.dependencies.node).toBeUndefined()
    expect(packageJson.dependencies.qrcode).toBeUndefined()
    expect(packageJson.devDependencies['electron-updater']).toBeTruthy()
    expect(packageJson.devDependencies.qrcode).toBeTruthy()
    expect(packageJson.build.publish).toEqual([
      { provider: 'github', owner: 'citizenll', repo: 'desktop-harness' }
    ])
    expect(packageJson.build.win.verifyUpdateCodeSignature).toBe(false)
    expect(workflow).not.toContain('MODELSCOPE')
    expect(workflow).not.toContain('alexyaojin/dsh-desktop')
    for (const asset of [
      'latest-mac-arm64.yml',
      'latest-mac-x64.yml',
      'latest-mac.yml',
      'latest.yml',
      'latest-linux.yml',
      'dsh-desktop-mac-arm64.zip.blockmap',
      'dsh-desktop-mac-x64.zip.blockmap',
      'dsh-desktop-windows-x64-setup.exe.blockmap'
    ]) {
      expect(workflow).toContain(asset)
    }
    expect(workflow).toContain('merge-mac-update-metadata.mjs')
  })

  it('keeps builder jobs from attempting implicit tag publishing', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { scripts: Record<string, string>; desktopName?: string }
    const runtimeVerifier = await readFile(
      path.join(projectRoot, 'scripts', 'verify-packaged-runtime.mjs'),
      'utf8'
    )
    const runtimeStager = await readFile(
      path.join(projectRoot, 'scripts', 'prepare-runtime.mjs'),
      'utf8'
    )
    for (const script of [
      'package:mac',
      'package:mac:arm64',
      'package:mac:x64',
      'package:win',
      'package:linux'
    ]) {
      expect(packageJson.scripts[script]).toContain('--publish never')
      expect(packageJson.scripts[script]).toContain('build:runtime')
      expect(packageJson.scripts[script]).toContain('runtime:verify')
    }
    expect(packageJson.scripts['runtime:stage']).toContain('prepare-runtime.mjs')
    expect(packageJson.scripts['runtime:verify']).toContain('verify-packaged-runtime.mjs')
    expect(runtimeVerifier).toContain("path.basename(directory).toLowerCase() === 'resources'")
    expect(packageJson.desktopName).toBe('io.dsh.desktop.desktop')
    expect(runtimeStager).toContain('desktopName: sourceManifest.desktopName')
  })

  it('packages an isolated development channel from the current workspace', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> }
    const developmentConfig = await readFile(
      path.join(projectRoot, 'electron-builder.dev.cjs'),
      'utf8'
    )
    const main = await readFile(path.join(projectRoot, 'src', 'main', 'index.ts'), 'utf8')

    expect(packageJson.scripts['package:dev:dir']).toContain('npm run build')
    expect(packageJson.scripts['package:dev:dir']).toContain('electron-builder.dev.cjs')
    expect(packageJson.scripts['package:dev:win']).toContain('verify-target.mjs win32 x64')
    expect(packageJson.scripts['package:dev:win']).toContain('electron-builder.dev.cjs')
    expect(packageJson.scripts['package:dev:win']).toContain('--publish never')
    expect(developmentConfig).toContain("appId: 'io.dsh.desktop.dev'")
    expect(developmentConfig).toContain("productName: 'DSH Desktop Dev'")
    expect(developmentConfig).toContain("output: 'dist-dev'")
    expect(developmentConfig).toContain("dshDesktopChannel: 'development'")
    expect(developmentConfig).toContain(
      "artifactName: 'dsh-desktop-dev-windows-${arch}-setup.${ext}'"
    )
    expect(main).toContain("app.setPath('userData', join(app.getPath('appData'), 'dsh-desktop-dev'))")
    expect(main).toContain("app.setPath('userData', join(app.getPath('appData'), 'dsh-desktop'))")
    expect(main).toContain('if (!developmentBuild)')
  })

  it('builds and publishes every supported platform', async () => {
    const workflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'release.yml'),
      'utf8'
    )

    expect(workflow).toContain('runs-on: macos-15')
    expect(workflow).toContain('runs-on: macos-15-intel')
    expect(workflow).toContain('runs-on: windows-2022')
    expect(workflow).toContain('runs-on: ubuntu-24.04')
    expect(workflow).toContain('npm run package:linux')
    expect(workflow).toContain('name: linux-x64')
    expect(workflow).toContain('Verify Linux release assets')
    expect(workflow).toContain('test -f dist/dsh-desktop-linux-x64.AppImage')
    expect(workflow).toContain('--draft=false')
    expect(workflow).toContain('npm run package:dev:win')
    expect(workflow).toContain('Smoke test packaged Windows Harness')
    expect(workflow).toContain("$executable = 'dist-dev\\win-unpacked\\DSH Desktop Dev.exe'")
    expect(workflow).toContain('Packaged Windows Harness smoke test passed.')
    expect(workflow).toContain(
      'Packaged Harness HTML did not preload the core client module system.'
    )
    expect(workflow).toContain('Packaged Harness HTML did not preload the core client runtime.')
    expect(workflow).toContain("Invoke-HarnessRpc 'workspace.create'")
    expect(workflow).toContain("Invoke-HarnessRpc 'session.create'")
    expect(workflow).toContain('Harness process exited after workspace and session creation.')
    expect(workflow).toContain('windows_prerelease_tag:')
    expect(workflow).toContain('Publish validated Windows development pre-release')
    expect(workflow).toContain('gh release create $env:PRERELEASE_TAG')
    expect(workflow).toContain('--prerelease')
    expect(workflow).toContain('name: windows-x64-dev')
    expect(workflow).toContain('dist-dev/dsh-desktop-dev-windows-x64-setup.exe')
    for (const asset of releaseAssets) expect(workflow).toContain(asset)
    expect(
      workflow.match(
        /npm version --no-git-tag-version --allow-same-version "\$\{\{ github\.ref_name \}\}"/g
      )
    ).toHaveLength(4)
  })

  it('keeps GitHub Actions current and scopes Dependabot to this repository', async () => {
    const [workflow, dependabot] = await Promise.all([
      readFile(path.join(projectRoot, '.github', 'workflows', 'release.yml'), 'utf8'),
      readFile(path.join(projectRoot, '.github', 'dependabot.yml'), 'utf8')
    ])

    expect(workflow.match(/actions\/checkout@v7/g)).toHaveLength(5)
    expect(workflow.match(/actions\/setup-node@v7/g)).toHaveLength(5)
    expect(workflow.match(/actions\/upload-artifact@v7/g)).toHaveLength(5)
    expect(workflow.match(/actions\/download-artifact@v8/g)).toHaveLength(1)
    expect(workflow.match(/retention-days: 1/g)).toHaveLength(4)
    expect(workflow.match(/retention-days: 7/g)).toHaveLength(1)
    expect(workflow).toContain('Remove intermediate release artifacts')
    expect(workflow).toMatch(
      /name: Remove intermediate release artifacts\r?\n        continue-on-error: true/
    )
    expect(workflow).toContain('actions/runs/$GITHUB_RUN_ID/artifacts?per_page=100')
    expect(workflow).toContain('actions/artifacts/$artifact_id')
    expect(workflow).toMatch(
      /publish:\r?\n    name: Publish GitHub Release[\s\S]*?permissions:\r?\n      contents: write\r?\n      actions: write/
    )
    expect(workflow).not.toMatch(/actions\/(checkout|setup-node|upload-artifact)@v4/)
    expect(workflow).not.toContain('actions/download-artifact@v4')
    expect(dependabot).toContain('package-ecosystem: github-actions')
    expect(dependabot).toContain('directory: "/"')
    expect(dependabot).not.toContain('python/sdk')
  })

  it('supports signed releases and an explicit unsigned macOS fallback', async () => {
    const workflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'release.yml'),
      'utf8'
    )

    for (const secret of [
      'DESKTOP_CSC_LINK',
      'DESKTOP_CSC_KEY_PASSWORD',
      'DESKTOP_APPLE_API_KEY',
      'DESKTOP_APPLE_API_KEY_ID',
      'DESKTOP_APPLE_API_ISSUER',
      'DESKTOP_APPLE_TEAM_ID'
    ]) {
      expect(workflow).toContain(`secrets.${secret}`)
    }
    expect(workflow.match(/Prepare macOS signing keychain/g)).toHaveLength(2)
    expect(workflow.match(/xcrun stapler validate/g)).toHaveLength(4)
    expect(workflow.match(/xcrun notarytool submit/g)).toHaveLength(2)
    expect(workflow.match(/CSC_IDENTITY_AUTO_DISCOVERY: 'false'/g)).toHaveLength(2)
    expect(workflow.match(/Detect Apple release signing configuration/g)).toHaveLength(2)
    expect(workflow.match(/apple_signing_enabled:/g)).toHaveLength(2)
    expect(workflow).toContain('publishing an unsigned macOS build')
    expect(workflow).toContain('macOS packages in this release are unsigned')
    expect(workflow).not.toContain("CSC_LINK: ''")
    expect(workflow).toMatch(
      /macos-apple-silicon:\r?\n    name: macOS Apple Silicon\r?\n    runs-on: macos-15\r?\n    outputs:\r?\n      apple_signing_enabled: [^\r\n]+\r?\n    steps:/
    )
    expect(workflow).toMatch(
      /macos-intel:\r?\n    name: macOS Intel\r?\n    if: [^\r\n]+\r?\n    runs-on: macos-15-intel\r?\n    outputs:\r?\n      apple_signing_enabled: [^\r\n]+\r?\n    steps:/
    )
  })

  it('routes downloads and updates through this GitHub repository', async () => {
    const readmes = await Promise.all(
      ['README.md', 'README.en.md'].map((file) =>
        readFile(path.join(projectRoot, file), 'utf8')
      )
    )

    for (const readme of readmes) {
      expect(readme).toContain('https://github.com/citizenll/desktop-harness/releases/latest')
      expect(readme).not.toContain('dshdesktop.com')
      expect(readme).not.toContain('discord.gg')
      expect(readme).not.toContain('wechat-group-')
      expect(readme).not.toContain('| Platform | Package | Download |')
      expect(readme).not.toContain('| 平台 | 安装包 | 下载 |')
      expect(readme).not.toContain('Coming soon')
      expect(readme).not.toContain('即将发布')
      for (const asset of releaseAssets) {
        expect(readme).not.toContain(`releases/latest/download/${asset}`)
      }
    }
  })
})
