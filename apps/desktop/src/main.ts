/** Electron main process for the zero-port DeepSeek Harness Desktop app. */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, Menu, protocol, session, shell, type MenuItemConstructorOptions } from 'electron'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-client-modules'
import { parseDesktopOptions, type DesktopOptions } from './args.ts'
import { createDesktopProtocolHandler, DESKTOP_URL } from './protocol.ts'

protocol.registerSchemesAsPrivileged([{
  scheme: 'dsh',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    codeCache: true,
  },
}])
app.enableSandbox()

const require = createRequire(import.meta.url)
const SOURCE_CHECKOUT_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
let revealApplication: (() => void) | undefined
let revealPending = false
const SMOKE_RPC_METHODS = ['llm.providers', 'agentPreset.list'] as const

interface DesktopSmokeRpcResult {
  method: string
  status: number
  rpcId: string
  responseType?: string
  responseRpcId?: string
}

function resolveDistIndex(): string {
  try {
    return require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
  } catch {
    throw new Error('dsh desktop: frontend dist not built; run `pnpm run build` before launch')
  }
}

function isExternalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function isDesktopUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'dsh:' && url.hostname === 'app'
  } catch {
    return false
  }
}

function installMenu(createWindow: () => void): void {
  const template: MenuItemConstructorOptions[] = [
    ...process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : [],
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: createWindow },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function start(options: DesktopOptions): Promise<void> {
  const environment = loadLayeredEnv('dsh desktop')
  if (process.env.DSH_SOURCE_WORKSPACE === undefined) {
    process.env.DSH_SOURCE_WORKSPACE = app.isPackaged
      ? dshHomePath('source', 'deepseek-harness')
      : SOURCE_CHECKOUT_ROOT
  }
  if (app.isPackaged && process.env.DSH_SOURCE_CAPSULE_DIR === undefined) {
    process.env.DSH_SOURCE_CAPSULE_DIR = join(app.getAppPath(), 'source-capsule')
  }
  const hostPromise = runProfile({
    environment,
    profile: options.profile,
    patchFiles: options.patchFiles,
    args: [],
  })
  await app.whenReady()
  if (process.platform === 'win32') app.setAppUserModelId('ai.deepseek.harness.desktop')
  const host = await hostPromise
  const modules = host.ctx.get('clientModules')
  const connection = host.ctx.get('connection')
  if (modules === undefined || connection === undefined) {
    await host.ctx.fiber.dispose()
    throw new Error('dsh desktop: profile must provide clientModules and connection')
  }

  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0
    void host.shutdown.shutdown(exitCode).finally(() => {
      if (protocol.isProtocolHandled('dsh')) protocol.unhandle('dsh')
      app.exit(typeof process.exitCode === 'number' ? process.exitCode : exitCode)
    })
  })

  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
  protocol.handle('dsh', createDesktopProtocolHandler({
    distIndex: resolveDistIndex(),
    graph: () => modules.graph(),
    clientPath: id => modules.clientPath(id),
    dispatch: request => connection.fetch(request),
  }))

  const createWindow = async (): Promise<BrowserWindow> => {
    const window = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 900,
      minHeight: 640,
      show: false,
      backgroundColor: '#f5f5f5',
      title: 'DeepSeek Harness',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
        spellcheck: true,
      },
    })
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isExternalUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    window.webContents.on('will-navigate', (event, url) => {
      if (!isDesktopUrl(url)) event.preventDefault()
    })
    window.webContents.on('will-attach-webview', (event) => { event.preventDefault() })
    window.webContents.on('render-process-gone', (_event, details) => {
      if (details.reason !== 'clean-exit') {
        process.stderr.write(`dsh desktop: renderer exited (${details.reason})\n`)
      }
    })
    window.once('ready-to-show', () => {
      if (!options.smokeTest) window.show()
    })
    await window.loadURL(DESKTOP_URL)
    if (options.devtools) window.webContents.openDevTools({ mode: 'detach' })
    if (options.smokeTest) {
      const state = await window.webContents.executeJavaScript(
        'new Promise((resolve) => { const deadline = Date.now() + 5000; const probe = () => { const state = { boot: Boolean(window.__DSH_BOOT__), modules: Boolean(window.__DSH_MODULES__), root: Boolean(document.getElementById(\'root\')?.firstElementChild) }; if ((state.boot && state.modules && state.root) || Date.now() >= deadline) resolve(state); else setTimeout(probe, 25) }; probe() })',
      ) as { boot?: boolean; modules?: boolean; root?: boolean }
      if (state.boot !== true || state.modules !== true || state.root !== true) {
        throw new Error(`dsh desktop: smoke validation failed: ${JSON.stringify(state)}`)
      }
      const rpcState = await window.webContents.executeJavaScript(`
        Promise.all(${JSON.stringify(SMOKE_RPC_METHODS)}.map(async (method) => {
          const rpcId = 'desktop-smoke-' + method
          const response = await fetch('/api/' + method, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId, method, payload: {} }),
          })
          const envelope = response.headers.get('content-type')?.startsWith('application/json')
            ? await response.json()
            : undefined
          return {
            method,
            status: response.status,
            rpcId,
            responseType: envelope?.type,
            responseRpcId: envelope?.rpcId,
          }
        }))
      `) as DesktopSmokeRpcResult[]
      const failedRpc = SMOKE_RPC_METHODS.find((method) => {
        const result = rpcState.find(candidate => candidate.method === method)
        return result === undefined
          || result.status !== 200
          || result.responseType !== 'server-response'
          || result.responseRpcId !== result.rpcId
      })
      if (failedRpc !== undefined) {
        throw new Error(`dsh desktop: RPC smoke validation failed: ${JSON.stringify(rpcState)}`)
      }
      process.stdout.write('dsh desktop: smoke ok\n')
      app.quit()
    }
    return window
  }

  const requestWindow = (): void => {
    void createWindow().catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exitCode = 1
      app.quit()
    })
  }
  installMenu(requestWindow)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) requestWindow()
  })
  revealApplication = () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window === undefined) requestWindow()
    else {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  }
  if (revealPending) {
    revealPending = false
    revealApplication()
  }
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  await createWindow()
}

let options: DesktopOptions | undefined
try {
  options = parseDesktopOptions(process.argv, app.isPackaged)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  app.exit(1)
}

if (options === undefined) {
  // Argument diagnostics above own the exit code; no application tree started.
} else if (!options.smokeTest && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  if (!options.smokeTest) {
    app.on('second-instance', () => {
      if (revealApplication === undefined) revealPending = true
      else revealApplication()
    })
  }
  void start(options).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    app.exit(1)
  })
}
