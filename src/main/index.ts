import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { parse } from 'yaml'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
  type IpcMainInvokeEvent
} from 'electron'
import { extractFailureCause, HarnessRuntime } from './runtime/harness-runtime'
import { removeProfilePluginWithDsh } from './runtime/profile-plugin-command'
import {
  detectNodePackageManagers,
  type DetectedPackageManager
} from './runtime/desktop-toolchain'
import { LanMobileBridge } from './mobile/lan-mobile-bridge'
import {
  detectPluginRecovery,
  PLUGIN_RECOVERY_EVIDENCE_TIMEOUT_MS
} from './plugin-recovery-detection'
import { secureWindow } from './security'
import { ensureLaunchRoot } from './state/launch-root'
import { migrateEmbeddedMarketProfile } from './state/embedded-market-migration'
import { migrateDeepSeekVisionSettings } from './state/deepseek-vision-migration'
import {
  resetPluginProfile,
  uninstallPluginFromProfile
} from './state/plugin-recovery'
import {
  desktopHarnessUrl,
  isAbortedNavigationError,
  shouldLoadHarnessUrl
} from './window-navigation'
import {
  checkForUpdates,
  registerUpdateHandlers,
  startUpdateManager,
  stopUpdateManager
} from './update/update-manager'
import type { RuntimeSnapshot } from '../shared/contracts'
import { resolveHarnessLocale } from './application-locale'
import { installContextMenu } from './context-menu'
import {
  WINDOWS_TITLEBAR_HEIGHT,
  isDesktopMenuCommand,
  type DesktopMenuCommand
} from '../shared/desktop-menu'
import { buildPluginRecoveryViewModel } from './plugin-recovery-view'
import { configureNodeWorkerModuleFallback } from './runtime/node-module-fallback'
import { PluginInstallWebBridge } from './plugin-install-web-bridge'
import {
  DSH_DESKTOP_PLUGIN_INSTALL_CHANNEL,
  parseDesktopPluginInstallUrl,
  parseDshDesktopCliLaunchArguments,
  type PluginInstallIntentErrorCode,
  type PluginInstallIntentResult
} from '../shared/plugin-install-intent'
import {
  DSH_DESKTOP_DIALOG_RESPONSE_CHANNEL,
  DSH_DESKTOP_DIALOG_SHOW_CHANNEL,
  type DesktopDialogButton,
  type DesktopDialogRequest,
  type DesktopDialogResponse,
  type DesktopDialogTone
} from '../shared/app-dialog'

type PluginRecoveryAction = 'uninstall' | 'show-log' | 'quit' | 'restart' | 'refresh'

const PLUGIN_RECOVERY_ACTIONS = new Set<PluginRecoveryAction>([
  'uninstall',
  'show-log',
  'quit'
])

let mainWindow: BrowserWindow | undefined
let runtime: HarnessRuntime
let mobileBridge: LanMobileBridge
let pluginInstallWebBridge: PluginInstallWebBridge | undefined
let launchDirectory: string
let quitting = false
let failureRecoveryVisible = false
let harnessLaunchOperation: Promise<void> | undefined
let pluginRecoveryActionResolver: ((action: PluginRecoveryAction) => void) | undefined
let mainWindowNavigationVersion = 0
let rendererPluginFailureLogs: string[] = []
let pluginRecoveryRemovedPlugins: string[] = []
let pluginRecoveryResetTimer: ReturnType<typeof setTimeout> | undefined
let pendingFrontendPluginRecovery = false
let pendingFrontendPluginRecoveryMessage: string | undefined
const pendingPluginInstallSources: string[] = []
const pendingPluginInstallErrors: PluginInstallIntentErrorCode[] = []
let foregroundReleaseTimer: ReturnType<typeof setTimeout> | undefined
let desktopDialogSequence = 0

interface PendingDesktopDialog {
  webContentsId: number
  settle: (response: number) => void
}

const pendingDesktopDialogs = new Map<number, PendingDesktopDialog>()

function appendRendererPluginFailureLog(message: string): void {
  const trimmed = message.trim()
  if (!trimmed) return
  const logLine = `[stderr] ${trimmed}`
  if (rendererPluginFailureLogs.at(-1) === logLine) return
  rendererPluginFailureLogs.push(logLine)
  rendererPluginFailureLogs = rendererPluginFailureLogs.slice(-50)
}

function queuePendingFrontendPluginRecovery(message?: string): void {
  pendingFrontendPluginRecovery = true
  if (message) pendingFrontendPluginRecoveryMessage = message
  resolvePluginRecoveryAction('refresh')
}

function takePendingFrontendPluginRecovery(): {
  pending: boolean
  message?: string
} {
  const pending = pendingFrontendPluginRecovery
  const message = pendingFrontendPluginRecoveryMessage
  pendingFrontendPluginRecovery = false
  pendingFrontendPluginRecoveryMessage = undefined
  return { pending, message }
}

function cancelPluginRecoverySessionReset(): void {
  if (pluginRecoveryResetTimer) clearTimeout(pluginRecoveryResetTimer)
  pluginRecoveryResetTimer = undefined
}

function schedulePluginRecoverySessionReset(): void {
  cancelPluginRecoverySessionReset()
  pluginRecoveryResetTimer = setTimeout(() => {
    pluginRecoveryResetTimer = undefined
    pluginRecoveryRemovedPlugins = []
  // Keep the chain alive long enough for slower Windows machines to finish
  // rendering a frontend plugin failure after the backend reports ready.
  }, 60_000)
}

function appendRendererPluginRecoveryLog(logs: readonly string[]): void {
  if (logs.length === 0) return

  try {
    const evidence = logs
      .slice(-50)
      .join('\n')
      .slice(-20_000)
      .split(/\r?\n/)
      .map((line) => `[renderer] ${line}`)
      .join('\n')
    appendFileSync(
      join(app.getPath('logs'), 'harness.log'),
      `\n[desktop] frontend plugin recovery ${new Date().toISOString()}\n${evidence}\n`,
      'utf8'
    )
  } catch (error) {
    console.warn('[desktop] failed to persist frontend plugin recovery evidence', error)
  }
}

function appendPluginRecoveryDetectionLog(plugins: readonly string[]): void {
  try {
    const result = plugins.length > 0 ? plugins.join(', ') : 'unresolved'
    appendFileSync(
      join(app.getPath('logs'), 'harness.log'),
      `[desktop] plugin recovery detection: ${result}\n`,
      'utf8'
    )
  } catch (error) {
    console.warn('[desktop] failed to persist plugin recovery detection', error)
  }
}

function isDevelopmentBuild(): boolean {
  if (!app.isPackaged) return true

  try {
    const metadata = JSON.parse(
      readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')
    ) as { dshDesktopChannel?: unknown }
    return metadata.dshDesktopChannel === 'development'
  } catch {
    return false
  }
}

const developmentBuild = isDevelopmentBuild()

function acceptPluginInstallIntent(result: PluginInstallIntentResult): boolean {
  if (result.status === 'ignored') return false
  if (result.status === 'error') {
    pendingPluginInstallErrors.push(result.code)
    return true
  }

  const { source } = result.intent
  if (!pendingPluginInstallSources.includes(source)) pendingPluginInstallSources.push(source)
  return true
}

/**
 * Every external entry point converges here. Main only transports the source;
 * the embedded installer owns the dedicated confirmation UI, source
 * validation and the actual profile mutation.
 */
function acceptExternalLaunchArguments(argv: readonly string[]): boolean {
  let handled = false
  for (const argument of argv) {
    handled = acceptPluginInstallIntent(parseDesktopPluginInstallUrl(argument)) || handled
  }

  handled = acceptPluginInstallIntent(parseDshDesktopCliLaunchArguments(argv)) || handled
  return handled
}

function focusDesktopWindow(forceForeground = false): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()

  if (forceForeground && process.platform === 'darwin') {
    app.focus({ steal: true })
  }
  if (forceForeground) {
    // Windows normally prevents a background process from stealing focus from
    // the browser that submitted the loopback request. A short topmost pulse
    // makes the confirmation dialog visible immediately, then restores the
    // normal z-order so Desktop never remains pinned above other applications.
    if (process.platform === 'win32') {
      if (foregroundReleaseTimer) clearTimeout(foregroundReleaseTimer)
      window.setAlwaysOnTop(true)
    }
    window.moveTop()
  }
  window.show()
  window.focus()

  if (forceForeground && process.platform === 'win32') {
    foregroundReleaseTimer = setTimeout(() => {
      foregroundReleaseTimer = undefined
      if (window.isDestroyed()) return
      window.setAlwaysOnTop(false)
      window.moveTop()
      window.focus()
    }, 500)
  }
}

function registerDesktopDialogHandlers(): void {
  ipcMain.removeAllListeners(DSH_DESKTOP_DIALOG_RESPONSE_CHANNEL)
  ipcMain.on(DSH_DESKTOP_DIALOG_RESPONSE_CHANNEL, (event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) return
    const response = payload as Partial<DesktopDialogResponse>
    if (!Number.isSafeInteger(response.id) || !Number.isInteger(response.response)) return
    const pending = pendingDesktopDialogs.get(response.id!)
    if (!pending || pending.webContentsId !== event.sender.id) return
    pending.settle(response.response!)
  })
}

function showDesktopDialog(window: BrowserWindow, options: {
  tone: DesktopDialogTone
  message: string
  detail?: string
  buttons: DesktopDialogButton[]
  defaultId?: number
  cancelId?: number
}): Promise<{ response: number }> {
  const id = ++desktopDialogSequence
  const defaultId = options.defaultId ?? 0
  const cancelId = options.cancelId ?? Math.max(0, options.buttons.length - 1)
  const request: DesktopDialogRequest = {
    id,
    tone: options.tone,
    message: options.message,
    detail: options.detail,
    buttons: options.buttons,
    defaultId,
    cancelId
  }

  return new Promise((resolve) => {
    const contents = window.webContents
    let settled = false
    const settle = (response: number): void => {
      if (settled) return
      settled = true
      pendingDesktopDialogs.delete(id)
      contents.removeListener('did-finish-load', send)
      contents.removeListener('destroyed', cancel)
      contents.removeListener('render-process-gone', cancel)
      resolve({ response })
    }
    const cancel = (): void => settle(cancelId)
    const send = (): void => {
      if (window.isDestroyed() || contents.isDestroyed()) {
        cancel()
        return
      }
      try {
        contents.send(DSH_DESKTOP_DIALOG_SHOW_CHANNEL, request)
      } catch {
        cancel()
      }
    }

    pendingDesktopDialogs.set(id, { webContentsId: contents.id, settle })
    contents.once('destroyed', cancel)
    contents.once('render-process-gone', cancel)
    if (contents.isLoadingMainFrame()) contents.once('did-finish-load', send)
    else send()
  })
}

function pluginInstallErrorDetail(
  errors: readonly PluginInstallIntentErrorCode[],
  chinese: boolean
): string {
  const messages: Record<PluginInstallIntentErrorCode, [string, string]> = {
    'malformed-link': ['DSH Desktop 插件链接格式无效。', 'The DSH Desktop plugin link is malformed.'],
    'unsupported-route': ['该 DSH Desktop 链接不是插件安装请求。', 'The DSH Desktop link is not a plugin install request.'],
    'invalid-source': ['插件来源无效，请检查仓库地址或包名。', 'The plugin source is invalid. Check the repository URL or package name.'],
    'unsupported-cli-syntax': [
      '支持的命令格式：dsh plugin --profile web add <plugin-source>',
      'Supported syntax: dsh plugin --profile web add <plugin-source>'
    ]
  }
  return [...new Set(errors)].map((code) => messages[code][chinese ? 0 : 1]).join('\n')
}

function dispatchPendingPluginInstallRequests(window: BrowserWindow): void {
  if (window.isDestroyed() || window.webContents.isLoadingMainFrame()) return
  for (const source of pendingPluginInstallSources.splice(0)) {
    window.webContents.send(DSH_DESKTOP_PLUGIN_INSTALL_CHANNEL, { source })
  }
  if (pendingPluginInstallErrors.length > 0) {
    const chinese = harnessLocale() === 'zh'
    const detail = pluginInstallErrorDetail(pendingPluginInstallErrors.splice(0), chinese)
    void showDesktopDialog(window, {
      tone: 'warning',
      message: chinese ? '无法打开插件请求' : 'Unable to open the plugin request',
      detail,
      buttons: [{ label: chinese ? '确定' : 'OK', kind: 'primary' }]
    })
  }
}

async function openPluginInstallRequest(source: string): Promise<void> {
  acceptPluginInstallIntent({ status: 'ok', intent: { source } })
  const snapshot = runtime?.snapshot()
  if (snapshot?.phase === 'ready' && snapshot.url) {
    await openHarness(snapshot.url)
  } else {
    focusDesktopWindow(true)
  }
}

function registerDesktopProtocol(): void {
  if (developmentBuild) return
  if (!app.setAsDefaultProtocolClient('dsh-desktop')) {
    console.warn('[desktop] unable to register the dsh-desktop protocol for this user')
  }
}

function windowsTitleBarOverlay(isDark: boolean): Electron.TitleBarOverlayOptions {
  return {
    color: '#00000000',
    symbolColor: isDark ? '#f3f4f6' : '#202124',
    height: WINDOWS_TITLEBAR_HEIGHT
  }
}

function applyWindowChromeTheme(window: BrowserWindow, isDark: boolean): void {
  if (window.isDestroyed()) return
  window.setBackgroundColor(isDark ? '#141416' : '#ffffff')
  if (process.platform === 'win32') {
    window.setTitleBarOverlay(windowsTitleBarOverlay(isDark))
  }
}

function configureAppIdentity(): void {
  if (developmentBuild) {
    app.setName('DSH Desktop Dev')
    app.setPath('userData', join(app.getPath('appData'), 'dsh-desktop-dev'))
    return
  }

  app.setName('DSH Desktop')
  // Keep the historical lowercase directory stable across product-name and
  // branding changes. Harness stores workspaces, sessions, credentials, and
  // custom presets below userData, so deriving this path from app.getName()
  // would make an ordinary upgrade look like a fresh installation.
  app.setPath('userData', join(app.getPath('appData'), 'dsh-desktop'))
}

async function syncNativeTheme(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed()) return

  // The sidebar already reserves enough room for macOS traffic lights. Read
  // Harness's resolved theme before showing the window so the native surface
  // matches the first rendered frame. The transparent drag strip restores the
  // native window gesture without adding a visual titlebar or covering the
  // traffic lights and right-side header actions.
  const isDark = await window.webContents.executeJavaScript(
    `(() => {
      if (${process.platform === 'darwin'}) {
        let dragRegion = document.getElementById('dsh-desktop-drag-region')
        if (!dragRegion) {
          dragRegion = document.createElement('div')
          dragRegion.id = 'dsh-desktop-drag-region'
          dragRegion.setAttribute('aria-hidden', 'true')
          Object.assign(dragRegion.style, {
            position: 'fixed',
            zIndex: '18',
            top: '0',
            left: '80px',
            right: '220px',
            height: '24px',
            background: 'transparent',
            pointerEvents: 'auto',
            userSelect: 'none'
          })
          dragRegion.style.setProperty('-webkit-app-region', 'drag')
          document.body.appendChild(dragRegion)
        }
      }
      if (document.body.hasAttribute('data-ds-dark-theme')) return true
      const color = getComputedStyle(document.body).backgroundColor
      const channels = color.match(/[\\d.]+/g)?.slice(0, 3).map(Number)
      if (!channels || channels.length < 3) {
        return matchMedia('(prefers-color-scheme: dark)').matches
      }
      const [red, green, blue] = channels
      return red * 0.2126 + green * 0.7152 + blue * 0.0722 < 128
    })()`
  )
  applyWindowChromeTheme(window, isDark)
}

function dshEntryPath(): string {
  return join(app.getAppPath(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

function bundledNodePath(): string {
  // Electron exposes the same embedded Node runtime used by its utility
  // processes when ELECTRON_RUN_AS_NODE=1. Reusing it avoids shipping a second
  // 80+ MiB Node executable and keeps native addons on Electron's ABI.
  return process.execPath
}

function bundledPnpmEntryPath(): string {
  const root = join(app.getAppPath(), 'node_modules', 'pnpm', 'bin')
  const candidates = [join(root, 'pnpm.cjs'), join(root, 'pnpm.mjs')]
  return candidates.find((candidate) => existsSync(candidate)) ?? join(root, 'pnpm.cjs')
}

function harnessNodeEntryPath(): string {
  return desktopResourcePath('harness-node-entry.mjs')
}

function desktopResourcePath(name: string): string {
  return app.isPackaged
    ? join(app.getAppPath(), 'resources', name)
    : join(app.getAppPath(), 'build', name)
}

function desktopIconPath(): string {
  return app.isPackaged ? desktopResourcePath('icon.png') : desktopResourcePath('app-icon.png')
}

function dshBrandLogoPath(variant: 'light' | 'dark'): string {
  return join(
    app.getAppPath(),
    'node_modules',
    '@deepseek-ai',
    'dsh-web-frontend',
    'dist',
    `dsh-desktop-logo-${variant}.png`
  )
}

function harnessLocale(): 'en' | 'zh' {
  try {
    const settings = parse(
      readFileSync(join(app.getPath('userData'), 'harness', 'settings.yaml'), 'utf8')
    ) as { locale?: { preference?: unknown } }
    return resolveHarnessLocale(
      settings.locale?.preference,
      app.getPreferredSystemLanguages()
    )
  } catch {
    return resolveHarnessLocale(undefined, app.getPreferredSystemLanguages())
  }
}

function configureApplicationLocale(): void {
  app.commandLine.appendSwitch('lang', harnessLocale() === 'zh' ? 'zh-CN' : 'en-US')
}

function harnessThemePreference(): 'light' | 'dark' | 'system' {
  try {
    const settings = parse(
      readFileSync(join(app.getPath('userData'), 'harness', 'settings.yaml'), 'utf8')
    ) as { 'ui-theme'?: { preference?: unknown } }
    const preference = settings['ui-theme']?.preference
    return preference === 'light' || preference === 'dark' || preference === 'system'
      ? preference
      : 'system'
  } catch {
    return 'system'
  }
}

function isPluginRecoveryPage(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'file:' && parsed.pathname.endsWith('/plugin-recovery.html')
  } catch {
    return false
  }
}

function resolvePluginRecoveryAction(action: PluginRecoveryAction): void {
  const resolve = pluginRecoveryActionResolver
  pluginRecoveryActionResolver = undefined
  resolve?.(action)
}

function installPluginRecoveryNavigation(window: BrowserWindow): void {
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!targetUrl.startsWith('dsh-recovery://')) return
    event.preventDefault()
    if (!isPluginRecoveryPage(window.webContents.getURL())) return

    try {
      const action = new URL(targetUrl).hostname as PluginRecoveryAction
      if (PLUGIN_RECOVERY_ACTIONS.has(action)) resolvePluginRecoveryAction(action)
    } catch {
      // Ignore malformed recovery actions and keep the current recovery page visible.
    }
  })
}

function createWindow(): BrowserWindow {
  const isWindows = process.platform === 'win32'
  const window = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: '',
    icon: desktopIconPath(),
    frame: process.platform !== 'darwin',
    ...(isWindows
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: windowsTitleBarOverlay(nativeTheme.shouldUseDarkColors),
          autoHideMenuBar: true
        }
      : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141416' : '#f8f8f6',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      webSecurity: true
    }
  })
  if (process.platform === 'darwin') {
    window.setWindowButtonVisibility(true)
    window.setWindowButtonPosition({ x: 12, y: 9 })
  } else if (isWindows) {
    window.setMenuBarVisibility(false)
  }
  window.on('page-title-updated', (event) => {
    event.preventDefault()
    window.setTitle('')
  })
  window.webContents.on('console-message', (details) => {
    if (details.level !== 'error') return
    const sourceUrl = details.sourceId || window.webContents.getURL()
    if (!sourceUrl.startsWith('http://127.0.0.1:')) return
    appendRendererPluginFailureLog(details.message)
  })
  installPluginRecoveryNavigation(window)
  secureWindow(window)
  installContextMenu(window, harnessLocale)
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
    resolvePluginRecoveryAction('quit')
  })
  mainWindow = window
  return window
}

async function openHarness(url: string): Promise<void> {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
  const rendererUrl = desktopHarnessUrl(url, process.platform)
  if (shouldLoadHarnessUrl(window.webContents.getURL(), url)) {
    const navigationVersion = ++mainWindowNavigationVersion
    rendererPluginFailureLogs = []
    window.webContents.stop()
    try {
      await window.loadURL(rendererUrl)
    } catch (error) {
      if (navigationVersion !== mainWindowNavigationVersion) return
      if (isAbortedNavigationError(error)) return
      const snapshot = runtime.snapshot()
      if (snapshot.phase !== 'ready' || snapshot.url !== url) return
      throw error
    }
    if (navigationVersion !== mainWindowNavigationVersion) return
  }
  if (runtime.snapshot().url !== url || window.isDestroyed()) return
  await syncNativeTheme(window)
  const hasPendingPluginInstall =
    pendingPluginInstallSources.length > 0 || pendingPluginInstallErrors.length > 0
  dispatchPendingPluginInstallRequests(window)
  focusDesktopWindow(hasPendingPluginInstall)
}

async function showSplash(): Promise<void> {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
  const navigationVersion = ++mainWindowNavigationVersion
  window.webContents.stop()
  await window.loadFile(desktopResourcePath('splash.html'))
  if (window.isDestroyed() || navigationVersion !== mainWindowNavigationVersion) return
  window.show()
  window.focus()
}

function launchHarness(): Promise<void> {
  if (harnessLaunchOperation) return harnessLaunchOperation

  harnessLaunchOperation = (async () => {
    await showSplash()
    await runtime.start(launchDirectory)
  })().finally(() => {
    harnessLaunchOperation = undefined
  })
  return harnessLaunchOperation
}

function restartHarness(): Promise<void> {
  if (failureRecoveryVisible) resolvePluginRecoveryAction('restart')
  return launchHarness()
}

function registerHarnessHandlers(): void {
  ipcMain.removeHandler('harness:restart')
  ipcMain.handle('harness:restart', async (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      throw new Error('Harness restart is only available from the DSH Desktop window.')
    }
    if (runtime.snapshot().phase !== 'ready') {
      throw new Error('Harness is not ready to restart.')
    }

    await restartHarness()
    return { ok: runtime.snapshot().phase === 'ready' }
  })

  ipcMain.removeHandler('desktop-menu:execute')
  ipcMain.handle('desktop-menu:execute', async (event, command: unknown) => {
    assertTrustedMainWindowEvent(event)
    if (!isDesktopMenuCommand(command)) {
      throw new Error('Unknown DSH Desktop menu command.')
    }
    await executeDesktopMenuCommand(command)
    return { ok: true }
  })

  ipcMain.removeHandler('desktop-titlebar:set-theme')
  ipcMain.handle('desktop-titlebar:set-theme', (event, isDark: unknown) => {
    assertTrustedMainWindowEvent(event)
    if (typeof isDark !== 'boolean') {
      throw new Error('The DSH Desktop titlebar theme must be a boolean.')
    }
    if (process.platform === 'win32' && mainWindow) {
      applyWindowChromeTheme(mainWindow, isDark)
    }
    return { ok: true }
  })
}

function assertTrustedMainWindowEvent(event: IpcMainInvokeEvent): void {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error('This action is only available from the main DSH Desktop window.')
  }
}

async function executeDesktopMenuCommand(command: DesktopMenuCommand): Promise<void> {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  const contents = window.webContents

  switch (command) {
    case 'connect-phone':
      await showMobilePairing()
      break
    case 'restart-harness':
      await restartHarness()
      break
    case 'show-harness-log':
      shell.showItemInFolder(join(app.getPath('logs'), 'harness.log'))
      break
    case 'check-for-updates':
      await checkForUpdates(true)
      break
    case 'undo':
      contents.undo()
      break
    case 'redo':
      contents.redo()
      break
    case 'cut':
      contents.cut()
      break
    case 'copy':
      contents.copy()
      break
    case 'paste':
      contents.paste()
      break
    case 'select-all':
      contents.selectAll()
      break
    case 'reload':
      contents.reload()
      break
    case 'toggle-devtools':
      contents.toggleDevTools()
      break
    case 'zoom-reset':
      contents.setZoomLevel(0)
      break
    case 'zoom-in':
      contents.setZoomLevel(Math.min(3, contents.getZoomLevel() + 0.5))
      break
    case 'zoom-out':
      contents.setZoomLevel(Math.max(-3, contents.getZoomLevel() - 0.5))
      break
    case 'toggle-fullscreen':
      window.setFullScreen(!window.isFullScreen())
      break
    case 'about': {
      const chinese = harnessLocale() === 'zh'
      await showDesktopDialog(window, {
        tone: 'info',
        message: `DSH Desktop ${app.getVersion()}`,
        detail: chinese
          ? '面向 DeepSeek Harness 的开箱即用桌面客户端。'
          : 'A ready-to-use desktop application for DeepSeek Harness.',
        buttons: [{ label: chinese ? '确定' : 'OK', kind: 'primary' }]
      })
      break
    }
    case 'quit':
      app.quit()
      break
  }
}

async function waitForPluginRecoveryAction(options: {
  snapshot: RuntimeSnapshot
  plugins: readonly string[]
  removedPlugins: readonly string[]
  notice?: string
}): Promise<PluginRecoveryAction> {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
  const state = buildPluginRecoveryViewModel({
    ...options,
    locale: harnessLocale()
  })
  const actionPromise = new Promise<PluginRecoveryAction>((resolve) => {
    pluginRecoveryActionResolver = resolve
  })
  const navigationVersion = ++mainWindowNavigationVersion
  window.webContents.stop()

  try {
    await window.loadFile(desktopResourcePath('plugin-recovery.html'), {
      query: {
        state: JSON.stringify(state),
        icon: app.isPackaged ? 'icon.png' : 'app-icon.png',
        theme: harnessThemePreference()
      }
    })
  } catch (error) {
    pluginRecoveryActionResolver = undefined
    throw error
  }

  if (window.isDestroyed() || navigationVersion !== mainWindowNavigationVersion) return 'quit'
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  return actionPromise
}

function showUnexpectedError(error: unknown): void {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
  if (window) {
    const chinese = harnessLocale() === 'zh'
    void showDesktopDialog(window, {
      tone: 'error',
      message: chinese ? 'DSH Desktop 遇到错误' : 'DSH Desktop encountered an error',
      detail: message,
      buttons: [{ label: chinese ? '确定' : 'OK', kind: 'primary' }]
    })
    return
  }
  // No renderer exists during a catastrophic pre-window bootstrap failure.
  // This is the only situation where an in-app dialog cannot be rendered.
  dialog.showErrorBox('DSH Desktop encountered an error', message)
}

async function showPluginRecovery(options?: {
  message?: string
  logs?: readonly string[]
  followRendererLogs?: boolean
}): Promise<void> {
  if (failureRecoveryVisible || quitting) return
  failureRecoveryVisible = true

  const dshHome = join(app.getPath('userData'), 'harness')
  const isChinese = harnessLocale() === 'zh'
  cancelPluginRecoverySessionReset()
  const removedPlugins = pluginRecoveryRemovedPlugins
  let notice: string | undefined
  let recoveryMessage = options?.message
  let recoveryLogs = options?.logs
  let followRendererLogs = options?.followRendererLogs === true
  let waitForRendererEvidence = followRendererLogs

  const applyPendingFrontendEvidence = (): boolean => {
    const pending = takePendingFrontendPluginRecovery()
    if (!pending.pending) return false
    recoveryMessage = pending.message ?? recoveryMessage
    recoveryLogs = [...rendererPluginFailureLogs]
    followRendererLogs = true
    waitForRendererEvidence = false
    return true
  }

  try {
    while (!quitting) {
      const snapshot = runtime.snapshot()
      const message = recoveryMessage ?? snapshot.message
      const detection = await detectPluginRecovery({
        dshHome,
        initialLogs: recoveryLogs ?? snapshot.logs,
        readLatestLogs: followRendererLogs ? () => rendererPluginFailureLogs : undefined,
        excludedPlugins: removedPlugins,
        slotProviderNodeModulesPaths: [join(app.getAppPath(), 'node_modules')],
        timeoutMs: waitForRendererEvidence ? PLUGIN_RECOVERY_EVIDENCE_TIMEOUT_MS : 0
      })
      appendPluginRecoveryDetectionLog(detection.plugins)
      waitForRendererEvidence = false
      if (applyPendingFrontendEvidence()) continue
      const action = await waitForPluginRecoveryAction({
        snapshot: {
          ...snapshot,
          message: message || snapshot.message,
          logs: detection.logs
        },
        plugins: detection.plugins,
        removedPlugins,
        notice
      })
      notice = undefined

      if (action === 'refresh') {
        applyPendingFrontendEvidence()
        continue
      } else if (action === 'uninstall' && detection.plugins.length > 0) {
        const failedPlugins: string[] = []
        for (const plugin of detection.plugins) {
          const removed = await uninstallPluginFromProfile(dshHome, plugin, async (pluginName) => {
            const result = await removeProfilePluginWithDsh(
              {
                dshHome,
                dshEntryPath: dshEntryPath(),
                nodeExecutablePath: bundledNodePath(),
                pnpmEntryPath: bundledPnpmEntryPath(),
                environment: process.env
              },
              pluginName
            )
            if (!result.ok) {
              console.warn(
                `[plugin-recovery] Failed to remove ${pluginName}: ${result.detail ?? 'unknown error'}`
              )
            }
            return result.ok
          })
          if (removed) {
            if (!removedPlugins.includes(plugin)) removedPlugins.push(plugin)
          } else {
            failedPlugins.push(plugin)
          }
        }

        if (failedPlugins.length === detection.plugins.length) {
          notice = isChinese
            ? '未能修改插件配置。请打开 Harness 日志查看详情，或选择其他恢复方式。'
            : 'The plugin profile could not be updated. Open the Harness log for details or choose another recovery option.'
          continue
        }
        if (failedPlugins.length > 0) {
          notice = isChinese
            ? `以下插件未能移除：${failedPlugins.join('、')}`
            : `These plugins could not be removed: ${failedPlugins.join(', ')}`
        }
        await launchHarness()
        if (applyPendingFrontendEvidence()) continue
        if (runtime.snapshot().phase === 'ready') {
          schedulePluginRecoverySessionReset()
          return
        }
        continue
      } else if (action === 'restart') {
        await launchHarness()
        if (applyPendingFrontendEvidence()) continue
        if (runtime.snapshot().phase === 'ready') {
          schedulePluginRecoverySessionReset()
          return
        }
        continue
      } else if (action === 'show-log') {
        shell.showItemInFolder(join(app.getPath('logs'), 'harness.log'))
        continue
      } else {
        app.quit()
        return
      }
    }
  } catch (error) {
    showUnexpectedError(error)
  } finally {
    failureRecoveryVisible = false
    const pending = takePendingFrontendPluginRecovery()
    if (pending.pending && !quitting) {
      queueMicrotask(() => {
        void showPluginRecovery({
          message: pending.message,
          logs: [...rendererPluginFailureLogs],
          followRendererLogs: true
        })
      })
    }
  }
}

async function showRuntimeFailure(snapshot: RuntimeSnapshot): Promise<void> {
  if (snapshot.failureKind === 'package-manager') {
    await showPackageManagerRecovery(snapshot)
    return
  }
  await showPluginRecovery({ message: snapshot.message, logs: snapshot.logs })
}

function formatDetectedPackageManagers(
  managers: readonly DetectedPackageManager[],
  isChinese: boolean
): string {
  return managers
    .map((manager) =>
      manager.available
        ? manager.name
        : `${manager.name} ${isChinese ? '未检测到' : 'not found'}`
    )
    .join(' · ')
}

async function showPackageManagerRecovery(initialSnapshot: RuntimeSnapshot): Promise<void> {
  if (failureRecoveryVisible || quitting) return
  failureRecoveryVisible = true
  let handoffSnapshot: RuntimeSnapshot | undefined

  try {
    const isChinese = harnessLocale() === 'zh'
    const logPath = join(app.getPath('logs'), 'harness.log')
    const managers = await detectNodePackageManagers(process.env).catch(() => [])
    let snapshot = initialSnapshot
    while (!quitting && snapshot.failureKind === 'package-manager') {
      const detected = formatDetectedPackageManagers(managers, isChinese)
      const detail = isChinese
        ? [
            'DSH 插件 profile 是 pnpm workspace，npm、yarn、bun 不能安全替代 pnpm。桌面端会修复自己的私有 pnpm，不修改系统环境变量。',
            '',
            `失败原因：${snapshot.message}`,
            '',
            `系统工具（仅诊断）：${detected || '未完成检测'}`
          ].join('\n')
        : [
            'DSH plugin profiles are pnpm workspaces; npm, yarn, and bun are not safe substitutes. Desktop repairs its private pnpm without changing the system environment.',
            '',
            `Failure: ${snapshot.message}`,
            '',
            `System tools (diagnostics only): ${detected || 'detection unavailable'}`
          ].join('\n')
      const dialogWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
      const result = await showDesktopDialog(dialogWindow, {
        tone: 'warning',
        message: isChinese ? '插件安装环境不可用' : 'The plugin install environment is unavailable',
        detail,
        buttons: isChinese
          ? [
              { label: '自动修复并重试', kind: 'primary' },
              { label: '查看日志', kind: 'secondary' },
              { label: '退出', kind: 'danger' }
            ]
          : [
              { label: 'Repair and Retry', kind: 'primary' },
              { label: 'Show Log', kind: 'secondary' },
              { label: 'Quit', kind: 'danger' }
            ],
        defaultId: 0,
        cancelId: 2
      })

      if (result.response === 1) {
        shell.showItemInFolder(logPath)
        continue
      }
      if (result.response === 2) {
        app.quit()
        return
      }

      await launchHarness()
      snapshot = runtime.snapshot()
      if (snapshot.phase === 'ready') return
      if (snapshot.failureKind !== 'package-manager') {
        handoffSnapshot = snapshot
        return
      }
    }
  } catch (error) {
    showUnexpectedError(error)
  } finally {
    failureRecoveryVisible = false
    const nextSnapshot = handoffSnapshot
    if (nextSnapshot && !quitting) {
      queueMicrotask(() => void showRuntimeFailure(nextSnapshot))
    }
  }
}

function installMenu(): void {
  const isChinese = app.getLocale().toLowerCase().startsWith('zh')
  const checkForUpdatesLabel = isChinese
    ? '检查更新…'
    : 'Check for Updates…'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              {
                label: checkForUpdatesLabel,
                accelerator: 'CmdOrCtrl+U',
                click: () => void checkForUpdates(true).catch(showUnexpectedError)
              },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'Harness',
      submenu: [
        {
          label: isChinese ? '连接手机…' : 'Connect Phone…',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => void showMobilePairing().catch(showUnexpectedError)
        },
        { type: 'separator' },
        {
          label: isChinese ? '重启 Harness' : 'Restart Harness',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => void restartHarness().catch(showUnexpectedError)
        },
        {
          label: isChinese ? '查看 Harness 日志' : 'Show Harness Log',
          click: () => shell.showItemInFolder(join(app.getPath('logs'), 'harness.log'))
        },
        ...(process.platform === 'darwin'
          ? []
          : [
              { type: 'separator' as const },
              {
                label: checkForUpdatesLabel,
                accelerator: 'CmdOrCtrl+U',
                click: () => void checkForUpdates(true).catch(showUnexpectedError)
              }
            ]),
        ...(process.platform === 'darwin'
          ? []
          : [{ type: 'separator' as const }, { role: 'quit' as const }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  if (process.platform === 'win32' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setMenuBarVisibility(false)
  }
}

async function showMobilePairing(): Promise<void> {
  const runtimeSnapshot = runtime.snapshot()
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
  if (!window) return
  const chinese = harnessLocale() === 'zh'
  if (runtimeSnapshot.phase !== 'ready' || !runtimeSnapshot.url) {
    await showDesktopDialog(window, {
      tone: 'info',
      message: chinese ? 'Harness 仍在启动' : 'Harness is still starting',
      detail: chinese
        ? '请等待 DSH Desktop 准备完成后，再次连接手机。'
        : 'Wait until DSH Desktop is ready, then connect your phone again.',
      buttons: [{ label: chinese ? '确定' : 'OK', kind: 'primary' }]
    })
    return
  }

  const snapshot = await mobileBridge.start()
  if (!snapshot.desktopUrl) {
    await mobileBridge.stop()
    await showDesktopDialog(window, {
      tone: 'warning',
      message: chinese ? '手机访问服务无法启动' : 'The phone access service could not start',
      detail: chinese ? '请重启 DSH Desktop 后重试。' : 'Restart DSH Desktop and try again.',
      buttons: [{ label: chinese ? '确定' : 'OK', kind: 'primary' }]
    })
    return
  }

  nativeTheme.themeSource = harnessThemePreference()
  await openHarness(runtimeSnapshot.url)
  if (window.isDestroyed()) return
  const panelUrl = new URL(snapshot.desktopUrl)
  panelUrl.searchParams.set('embedded', '1')
  window.webContents.send('mobile:show-panel', { url: panelUrl.href })
}

async function bootstrap(): Promise<void> {
  if (process.platform === 'darwin') app.dock?.setIcon(desktopIconPath())
  registerDesktopProtocol()
  registerDesktopDialogHandlers()
  configureNodeWorkerModuleFallback({
    applicationPath: app.getAppPath(),
    hookPath: desktopResourcePath('runtime-module-fallback.mjs')
  })
  launchDirectory = await ensureLaunchRoot(app.getPath('userData'))
  const dshHome = join(app.getPath('userData'), 'harness')
  try {
    const marketMigration = await migrateEmbeddedMarketProfile(dshHome)
    if (marketMigration.changed) {
      console.info(
        '[desktop] retired the profile-installed dshmarket copy; Desktop now provides the market'
      )
    }
  } catch (error) {
    // A stale or hand-edited profile must not prevent Desktop from opening.
    // The existing plugin-recovery flow can still diagnose it after startup.
    console.warn('[desktop] could not retire the old profile-installed dshmarket copy', error)
  }
  try {
    const visionMigration = await migrateDeepSeekVisionSettings(dshHome)
    if (visionMigration.changed) {
      console.info(
        `[desktop] repaired image capability metadata for ${visionMigration.repairedModels} DeepSeek Vision model(s)`
      )
    }
  } catch (error) {
    // A hand-edited settings document must remain user-owned. Report the
    // migration failure and let Harness surface its normal configuration error.
    console.warn('[desktop] could not migrate DeepSeek Vision model metadata', error)
  }
  registerUpdateHandlers()
  createWindow()
  runtime = new HarnessRuntime({
    dshEntryPath: dshEntryPath(),
    nodeExecutablePath: bundledNodePath(),
    nodeEntryPath: harnessNodeEntryPath(),
    pnpmEntryPath: bundledPnpmEntryPath(),
    dshPatchPath: desktopResourcePath('dsh-desktop.patch.yml'),
    dshHome,
    logPath: join(app.getPath('logs'), 'harness.log'),
    launchProcess: (executablePath, args, options) => spawn(executablePath, args, options),
    onChanged: (snapshot) => {
      if (snapshot.phase === 'ready' && snapshot.url) {
        void openHarness(snapshot.url).catch(showUnexpectedError)
      } else if (snapshot.phase === 'failed') {
        void showRuntimeFailure(snapshot)
      }
    }
  })
  registerHarnessHandlers()
  pluginInstallWebBridge = new PluginInstallWebBridge({
    onInstallRequest: openPluginInstallRequest
  })
  try {
    const webInstallUrl = await pluginInstallWebBridge.start()
    console.info(`[desktop] plugin install web bridge listening at ${webInstallUrl}`)
  } catch (error) {
    pluginInstallWebBridge = undefined
    console.warn('[desktop] could not start the plugin install web bridge on port 3080', error)
  }
  mobileBridge = new LanMobileBridge({
    harnessUrl: () => runtime.snapshot().url,
    locale: harnessLocale,
    brandLogoPaths: {
      light: dshBrandLogoPath('light'),
      dark: dshBrandLogoPath('dark')
    },
    appIconPath: desktopIconPath(),
    port: developmentBuild ? 43128 : 43127,
    tunnelCacheDirectory: join(app.getPath('userData'), 'mobile', 'cloudflared'),
    onReconnectRequested: () => {
      void showMobilePairing().catch(showUnexpectedError)
    }
  })
  void mobileBridge.start().catch(showUnexpectedError)
  ipcMain.handle('directory-picker:open', async (event) => {
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame
    ) {
      throw new Error('Directory picker requests are only allowed from the main Harness window')
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      title: harnessLocale() === 'zh' ? '选择工作区目录' : 'Select Workspace Directory',
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  ipcMain.handle('mobile:open-pairing', (event) => {
    assertTrustedMainWindowEvent(event)
    return showMobilePairing()
  })
  ipcMain.handle('mobile:status', (event) => {
    assertTrustedMainWindowEvent(event)
    return { connected: mobileBridge.snapshot().connected }
  })
  ipcMain.handle('harness:show-log', () => {
    shell.showItemInFolder(join(app.getPath('logs'), 'harness.log'))
  })
  ipcMain.removeHandler('harness:open-recovery')
  ipcMain.handle('harness:open-recovery', async (event, frontendErrorMessage?: unknown) => {
    assertTrustedMainWindowEvent(event)
    const message = typeof frontendErrorMessage === 'string' ? frontendErrorMessage : undefined
    if (message) appendRendererPluginFailureLog(message)
    const logs = [...rendererPluginFailureLogs]
    appendRendererPluginRecoveryLog(logs)
    if (failureRecoveryVisible) {
      queuePendingFrontendPluginRecovery(message)
      return { ok: true }
    }
    void showPluginRecovery({ message, logs, followRendererLogs: true })
    return { ok: true }
  })
  ipcMain.removeHandler('recovery:action')
  ipcMain.handle('recovery:action', (event, action: unknown) => {
    assertTrustedMainWindowEvent(event)
    if (typeof action === 'string' && PLUGIN_RECOVERY_ACTIONS.has(action as PluginRecoveryAction)) {
      resolvePluginRecoveryAction(action as PluginRecoveryAction)
      return { ok: true }
    }
    return { ok: false }
  })
  ipcMain.removeHandler('harness:reset-plugins')
  ipcMain.handle('harness:reset-plugins', async (event, pluginName?: unknown) => {
    assertTrustedMainWindowEvent(event)
    if (pluginName !== undefined && typeof pluginName !== 'string') {
      throw new Error('The failing plugin name must be a string.')
    }
    const dshHome = join(app.getPath('userData'), 'harness')
    await resetPluginProfile(dshHome, pluginName)
    await launchHarness()
    return { ok: runtime.snapshot().phase === 'ready' }
  })
  installMenu()
  await launchHarness()
  if (!developmentBuild) {
    startUpdateManager({
      prepareToInstall: async () => {
        await Promise.all([runtime.stop(), pluginInstallWebBridge?.stop()])
        quitting = true
        stopUpdateManager()
      }
    })
  }
}

configureAppIdentity()
configureApplicationLocale()
acceptExternalLaunchArguments(process.argv)
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (!acceptExternalLaunchArguments([url])) return
  const snapshot = runtime?.snapshot()
  if (snapshot?.phase === 'ready' && snapshot.url) {
    void openHarness(snapshot.url).catch(showUnexpectedError)
  } else {
    focusDesktopWindow()
  }
})
const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    acceptExternalLaunchArguments(commandLine)
    const snapshot = runtime?.snapshot()
    if (snapshot?.phase === 'ready' && snapshot.url) {
      void openHarness(snapshot.url).catch(showUnexpectedError)
    } else {
      focusDesktopWindow()
    }
  })
  app.whenReady().then(bootstrap).catch((error: unknown) => {
    showUnexpectedError(error)
    app.quit()
  })
  app.on('activate', () => {
    const snapshot = runtime?.snapshot()
    if (snapshot?.phase === 'ready' && snapshot.url) {
      void openHarness(snapshot.url).catch(showUnexpectedError)
    } else if (snapshot?.phase === 'idle') {
      void launchHarness().catch(showUnexpectedError)
    }
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', (event) => {
    if (quitting || !runtime) return
    event.preventDefault()
    quitting = true
    stopUpdateManager()
    void Promise.all([
      runtime.stop(),
      mobileBridge?.stop(),
      pluginInstallWebBridge?.stop()
    ]).finally(() => app.quit())
  })
}
