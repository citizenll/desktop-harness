import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { patchPath, projectRoot } from './patch-path'

describe('Desktop plugin install entry points', () => {
  it('registers the primary app protocol and handles warm and cold launches', async () => {
    const manifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
    const main = await readFile(path.join(projectRoot, 'src', 'main', 'index.ts'), 'utf8')
    const webBridge = await readFile(
      path.join(projectRoot, 'src', 'main', 'plugin-install-web-bridge.ts'),
      'utf8'
    )
    const developmentConfig = await readFile(
      path.join(projectRoot, 'electron-builder.dev.cjs'),
      'utf8'
    )

    expect(manifest.build.protocols).toEqual([
      {
        name: 'DSH Desktop Plugin Installer',
        schemes: ['dsh-desktop']
      }
    ])
    expect(main).toContain("app.setAsDefaultProtocolClient('dsh-desktop')")
    expect(main).toContain("app.on('open-url'")
    expect(main).toContain("app.on('second-instance', (_event, commandLine)")
    expect(main).toContain('acceptExternalLaunchArguments(process.argv)')
    expect(main).toContain('dispatchPendingPluginInstallRequests(window)')
    expect(main).toContain('new PluginInstallWebBridge')
    expect(main).toContain('onInstallRequest: openPluginInstallRequest')
    expect(main).toContain('focusDesktopWindow(hasPendingPluginInstall)')
    expect(main).toContain('window.setAlwaysOnTop(true)')
    expect(main).toContain('window.setAlwaysOnTop(false)')
    expect(webBridge).toContain('DEFAULT_PLUGIN_INSTALL_WEB_PORT = 3080')
    expect(webBridge).toContain("params.get('dsh-plugin-install')")
    expect(webBridge).toContain('await this.onInstallRequest(source)')
    expect(developmentConfig).toContain('protocols: []')
    expect(developmentConfig).toContain('extraResources: []')
  })

  it('bridges protocol and CLI requests into a dedicated direct-install dialog', async () => {
    const preload = await readFile(path.join(projectRoot, 'src', 'preload', 'index.ts'), 'utf8')
    const dialog = await readFile(
      path.join(projectRoot, 'src', 'preload', 'app-dialog.ts'),
      'utf8'
    )
    const main = await readFile(path.join(projectRoot, 'src', 'main', 'index.ts'), 'utf8')
    const contract = await readFile(
      path.join(projectRoot, 'src', 'shared', 'plugin-install-intent.ts'),
      'utf8'
    )
    const directDialog = await readFile(
      path.join(projectRoot, 'packages', 'dsh-desktop-market', 'src', 'client', 'DirectInstallDialog.tsx'),
      'utf8'
    )
    const directDialogStyles = await readFile(
      path.join(projectRoot, 'packages', 'dsh-desktop-market', 'src', 'client', 'DirectInstallDialog.module.css'),
      'utf8'
    )
    const routes = await readFile(
      path.join(projectRoot, 'packages', 'dsh-desktop-market', 'src', 'routes.ts'),
      'utf8'
    )
    const marketBundle = await readFile(
      path.join(projectRoot, 'packages', 'dsh-desktop-market', 'client', 'client.js'),
      'utf8'
    )

    for (const marker of [
      'dsh-plugin-install-request',
      'dsh:plugin-install-request'
    ]) {
      expect(contract).toContain(marker)
      expect(marketBundle).toContain(marker)
    }
    expect(preload).toContain('DSH_DESKTOP_PLUGIN_INSTALL_CHANNEL')
    expect(preload).toContain('installAppDialog({ document, ipcRenderer, locale })')
    expect(preload).not.toContain('dsh-settings-section')
    expect(preload).not.toContain('dsh-plugins-tab')
    expect(directDialog).toContain('body: JSON.stringify({ source: requestedSource, allowBuildScripts, requestId })')
    expect(directDialog).toContain('const [allowBuildScripts, setAllowBuildScripts] = useState(true)')
    expect(directDialog).toContain("fetch('/dsh-market/install-progress'")
    expect(directDialog).toContain('<InstallTerminal')
    expect(directDialog).toContain('role="switch"')
    expect(directDialog).toContain('await install(source, builds)')
    expect(directDialog).toContain('takePendingPluginInstallRequest()')
    expect(directDialog).toContain('className={css.dialog}')
    expect(directDialog).toContain('contentClassName={css.modalContent}')
    expect(directDialog).not.toContain('contentClassName={css.content}')
    expect(directDialogStyles).toContain('.dialog{width:min(520px,100%)')
    expect(directDialogStyles).toContain('.switchOn{')
    expect(routes).toContain('MAX_DIRECT_BUILD_APPROVAL_RETRIES')
    expect(routes).toContain('freshApprovals.length === 0')
    expect(routes).toContain('server-observed build selectors')
    expect(routes).toContain('prebuilt-artifact fallback')
    expect(routes).toContain('prebuiltFallback: prebuiltFallback || undefined')
    expect(routes).toContain('beginInstallOutputSession(directProgressSession, target)')
    expect(routes).toContain("path: '/dsh-market/install-progress'")
    expect(routes).toContain('outputSession: progress.outputSession')
    expect(directDialog).toContain("t('directInstallPrebuiltFallback')")
    expect(directDialogStyles).toContain('.stack{display:flex;min-width:0')
    expect(directDialogStyles).not.toContain('min-width:min(440px')
    expect(routes).toContain("body.source === undefined ? null : directInstallSourceFor(body.source)")
    expect(routes).toContain('does not search or depend on the')
    expect(dialog).toContain("panel.setAttribute('role', 'dialog')")
    expect(dialog).toContain('DSH_DESKTOP_DIALOG_RESPONSE_CHANNEL')
    expect(main).not.toContain('dialog.showMessageBox')
  })

  it('ships a user-level dsh launcher without exposing the private runtime toolchain', async () => {
    const manifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
    const installer = await readFile(path.join(projectRoot, 'build', 'installer.nsh'), 'utf8')
    const launcher = await readFile(path.join(projectRoot, 'build', 'dsh-cli', 'dsh.ps1'), 'utf8')
    const pathManager = await readFile(
      path.join(projectRoot, 'build', 'dsh-cli', 'dsh-path.ps1'),
      'utf8'
    )

    expect(manifest.build.win.extraResources).toEqual([
      { from: 'build/dsh-cli', to: 'dsh-cli', filter: ['**/*'] }
    ])
    expect(installer).toContain('!macro customInstall')
    expect(installer).toContain('!macro customUnInstall')
    expect(installer).toContain('dsh-path.ps1')
    expect(launcher).toContain("'dsh-desktop://plugin/install?source='")
    expect(launcher).toContain('[Uri]::EscapeDataString($source)')
    expect(launcher).toContain('Remove-Item Env:NODE_OPTIONS')
    expect(launcher).toContain('Remove-Item Env:ELECTRON_RUN_AS_NODE')
    expect(launcher).toContain("$DshArguments[2] -ceq 'web'")
    expect(launcher).toContain('Confirm the direct plugin installation')
    expect(launcher).not.toContain('built-in plugin market')
    expect(pathManager).toContain("SetEnvironmentVariable('Path', $next, 'User')")
    expect(pathManager).not.toContain('.desktop-bin')
  })

  it('keeps direct installation independent from upstream settings patches', async () => {
    const generalPatch = await readFile(
      patchPath('@deepseek-ai/dsh-client-ui-settings-general'),
      'utf8'
    )
    const pluginsPatch = await readFile(
      patchPath('@deepseek-ai/dsh-client-ui-settings-plugins'),
      'utf8'
    )

    expect(generalPatch).not.toContain('dsh-settings-section')
    expect(generalPatch).not.toContain('dsh:plugin-install-request')
    expect(pluginsPatch).not.toContain('dsh-plugins-tab')
    expect(pluginsPatch).not.toContain('dsh:plugin-install-request')
  })
})
