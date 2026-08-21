import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  WINDOWS_TITLEBAR_HEIGHT,
  desktopMenuCommands,
  isDesktopMenuCommand
} from '../src/shared/desktop-menu'
import { captionAreaOverlap } from '../src/preload/windows-titlebar'

describe('Windows titlebar menu', () => {
  it('uses a Windows-only overlay while preserving the macOS frame behavior', async () => {
    const main = await readFile('src/main/index.ts', 'utf8')

    expect(main).toContain("const isWindows = process.platform === 'win32'")
    expect(main).toContain("frame: process.platform !== 'darwin'")
    expect(main).toContain("titleBarStyle: 'hidden' as const")
    expect(main).toContain('titleBarOverlay: windowsTitleBarOverlay')
    expect(main).toContain('autoHideMenuBar: true')
    expect(main).toContain('window.setMenuBarVisibility(false)')
    expect(main).toContain('Menu.setApplicationMenu(Menu.buildFromTemplate(template))')
  })

  it('keeps the entire Windows app full-height without a visible titlebar band', async () => {
    const main = await readFile('src/main/index.ts', 'utf8')
    const preload = await readFile('src/preload/windows-titlebar.ts', 'utf8')

    expect(WINDOWS_TITLEBAR_HEIGHT).toBe(36)
    expect(main).toContain("color: '#00000000'")
    expect(preload).not.toContain(`padding-top: \${WINDOWS_TITLEBAR_HEIGHT}px !important`)
    expect(preload).toContain('padding-top: 0 !important')
    expect(preload).toContain('[data-dsh-sidebar-root][data-dsh-sidebar-wide="true"]')
    expect(preload).toContain('padding-top: 6px !important')
    expect(preload).toContain('trackSidebarLayout(document)')
    expect(preload).toContain("document.documentElement.style.setProperty(SIDEBAR_WIDTH_PROPERTY")
    expect(preload).toContain('background: transparent')
    expect(preload).toContain('.safeArea::before')
    expect(preload).toContain('height: 5px')
    expect(preload).toContain('body.dsh-desktop-windows-titlebar-layout > #root')
    expect(preload).toContain('-webkit-app-region: drag')
    expect(preload).toContain('-webkit-app-region: no-drag')
    expect(preload).toContain('env(titlebar-area-width')
    expect(preload).toContain('installCaptionAreaProtection(document, menuButton)')
    expect(preload).toContain('[class*="_headerUtilities"]')
    expect(preload).toContain('CAPTION_OVERLAP_PROPERTY')
  })

  it('moves Session header actions left only when they enter the native control area', () => {
    expect(captionAreaOverlap({ top: 0, bottom: 64, right: 1380 }, 1196)).toBe(184)
    expect(captionAreaOverlap({ top: 0, bottom: 64, right: 1000 }, 1196)).toBe(0)
    expect(captionAreaOverlap({ top: 80, bottom: 144, right: 1380 }, 1196)).toBe(0)
  })

  it('accepts only the fixed menu command allowlist', async () => {
    const main = await readFile('src/main/index.ts', 'utf8')

    expect(desktopMenuCommands).toContain('connect-phone')
    expect(desktopMenuCommands).toContain('check-for-updates')
    expect(desktopMenuCommands).toContain('toggle-fullscreen')
    expect(isDesktopMenuCommand('copy')).toBe(true)
    expect(isDesktopMenuCommand('run-shell-command')).toBe(false)
    expect(isDesktopMenuCommand({ command: 'quit' })).toBe(false)
    expect(main).toContain("ipcMain.handle('desktop-menu:execute'")
    expect(main).toContain('event.senderFrame !== mainWindow.webContents.mainFrame')
    expect(main).toContain('if (!isDesktopMenuCommand(command))')
  })

  it('synchronizes the native controls with Harness light and dark themes', async () => {
    const main = await readFile('src/main/index.ts', 'utf8')
    const preload = await readFile('src/preload/windows-titlebar.ts', 'utf8')

    expect(main).toContain('window.setTitleBarOverlay(windowsTitleBarOverlay(isDark))')
    expect(main).toContain("ipcMain.handle('desktop-titlebar:set-theme'")
    expect(preload).toContain("attributeFilter: ['data-ds-dark-theme', 'class', 'style']")
    expect(preload).toContain("ipcRenderer.invoke('desktop-titlebar:set-theme', isDark)")
  })
})
