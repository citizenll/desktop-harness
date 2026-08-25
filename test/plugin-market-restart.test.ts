import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectRoot } from './patch-path'

describe('plugin market restart action', () => {
  it('confirms through the shared market modal and delegates Desktop restarts to Electron', async () => {
    const market = await readFile(
      path.join(projectRoot, 'packages', 'dsh-desktop-market', 'src', 'client', 'MarketSection.tsx'),
      'utf8'
    )
    const locales = await readFile(
      path.join(projectRoot, 'packages', 'dsh-desktop-market', 'src', 'client', 'locales.ts'),
      'utf8'
    )
    const globals = await readFile(
      path.join(projectRoot, 'packages', 'dsh-desktop-market', 'src', 'client', 'globals.d.ts'),
      'utf8'
    )
    const marketBundle = await readFile(
      path.join(projectRoot, 'packages', 'dsh-desktop-market', 'client', 'client.js'),
      'utf8'
    )
    const preload = await readFile(path.join(projectRoot, 'src', 'preload', 'index.ts'), 'utf8')

    expect(market).toContain('const desktopRestart = window.dshDesktop?.restartHarness')
    expect(market).toContain('const restartAvailable = restartEnabled || desktopRestartAvailable')
    expect(market).toContain('onClick={() => setRestartConfirmOpen(true)}')
    expect(market).toContain("title={t('restartConfirmTitle')}")
    expect(market).toContain('doRestart()')
    expect(market).not.toContain('onClick={doRestart}')
    expect(locales).toContain("restartConfirmAction: '确认重启'")
    expect(marketBundle).toContain('window.dshDesktop?.restartHarness')
    expect(marketBundle).toContain('restartConfirmTitle')
    expect(globals).toContain('restartHarness?: () => Promise<{ ok: boolean }>')
    expect(preload).toContain("restartHarness: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('harness:restart')")
  })
})
