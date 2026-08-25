import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectRoot } from './patch-path'

describe('plugin market notices', () => {
  it('aligns the two global notices with search and keeps environment repair in a modal', async () => {
    const [market, styles, locales, bundle] = await Promise.all([
      readFile(path.join(projectRoot, 'packages', 'dsh-desktop-market', 'src', 'client', 'MarketSection.tsx'), 'utf8'),
      readFile(path.join(projectRoot, 'packages', 'dsh-desktop-market', 'src', 'client', 'Market.module.css'), 'utf8'),
      readFile(path.join(projectRoot, 'packages', 'dsh-desktop-market', 'src', 'client', 'locales.ts'), 'utf8'),
      readFile(path.join(projectRoot, 'packages', 'dsh-desktop-market', 'client', 'client.js'), 'utf8'),
    ])

    expect(market).toContain('className={css.topNotices}')
    expect(market).toContain("t('catalogUpdateAvailable')")
    expect(market).toContain("t('restartBanner')")
    expect(styles).toContain('.topNotices{display:flex;flex-direction:column;gap:8px;padding:0 4px 6px}')
    expect(styles).toContain('.tabSearchRow{display:flex;padding:0 4px 6px}')
    expect(market).toContain("title={t('envDialogTitle')}")
    expect(market).toContain('setEnvDialogOpen(true)')
    expect(market).not.toContain('envFailed')
    expect(locales).toContain("catalogUpdateAvailable: '插件商店数据发现有更新'")
    expect(locales).toContain("envDialogTitle: '修复插件安装环境'")
    expect(bundle).toContain('/dsh-market/registry/status')
    expect(bundle).toContain('/dsh-market/registry/update')
    expect(bundle).toContain('envDialogTitle')
  })
})
