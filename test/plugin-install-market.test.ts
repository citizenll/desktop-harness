import { describe, expect, it } from 'vitest'
import { entryForDep, visiblePlugins, type RegistryPlugin } from '../packages/dsh-desktop-market/src/client/market-data'
import { directInstallSourceFor, findInstalledAlias, githubArchiveSpec, parseGitHubDependencySpec } from '../packages/dsh-desktop-market/src/sources'
import {
  parsePluginInstallHash,
  PLUGIN_INSTALL_STORAGE_KEY,
  takePendingPluginInstallRequest
} from '../packages/dsh-desktop-market/src/client/plugin-install-request'

const plugin: RegistryPlugin = {
  name: 'open-design',
  owner: 'nexu-io',
  url: 'https://github.com/nexu-io/open-design',
  npm: '@nexu-io/open-design',
  install: 'github:nexu-io/open-design',
  category: 'ui',
  description: { en: 'Design tools' }
}

describe('market plugin install requests', () => {
  it('parses the loopback hash form', () => {
    expect(parsePluginInstallHash('#dsh-plugin-install=nexu-io%2Fopen-design')).toBe(
      'nexu-io/open-design'
    )
    expect(
      parsePluginInstallHash(
        '#dsh-plugin-install=github%3Ale-soleil-se-couche%2Fdsh-skin-claude-code'
      )
    ).toBe('github:le-soleil-se-couche/dsh-skin-claude-code')
    expect(parsePluginInstallHash('#other=value')).toBeUndefined()
    expect(parsePluginInstallHash('#dsh-plugin-install=two+tokens')).toBeUndefined()
  })

  it('consumes a queued request exactly once', () => {
    const values = new Map([[PLUGIN_INSTALL_STORAGE_KEY, JSON.stringify({ source: plugin.url })]])
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key)
    }

    expect(takePendingPluginInstallRequest(storage)).toBe(plugin.url)
    expect(takePendingPluginInstallRequest(storage)).toBeUndefined()
  })

  it('finds catalog entries by repository shorthand, URL and package name', () => {
    const search = (query: string) => visiblePlugins([plugin], {
      category: 'all',
      query,
      lang: 'en',
      sort: 'stars-desc'
    })

    expect(search('nexu-io/open-design')).toEqual([plugin])
    expect(search(plugin.url)).toEqual([plugin])
    expect(search('@nexu-io/open-design')).toEqual([plugin])
  })

  it('resolves direct sources without requiring a catalog lookup', () => {
    expect(
      directInstallSourceFor('github:le-soleil-se-couche/dsh-skin-claude-code')
    ).toMatchObject({
      source: 'github:le-soleil-se-couche/dsh-skin-claude-code',
      kind: 'github',
      target: 'github:le-soleil-se-couche/dsh-skin-claude-code',
      name: 'dsh-skin-claude-code',
      owner: 'le-soleil-se-couche'
    })
    expect(directInstallSourceFor('nexu-io/open-design')).toMatchObject({
      kind: 'github',
      target: 'github:nexu-io/open-design',
      name: 'open-design',
      owner: 'nexu-io'
    })
    expect(
      directInstallSourceFor('https://github.com/le-soleil-se-couche/dsh-skin-claude-code')
    ).toMatchObject({
      kind: 'github',
      target: 'github:le-soleil-se-couche/dsh-skin-claude-code'
    })
    expect(directInstallSourceFor('@scope/plugin')).toMatchObject({
      kind: 'npm',
      target: '@scope/plugin'
    })
  })

  it('rejects executable and local-path package-manager specs', () => {
    expect(directInstallSourceFor('file:C:/plugin')).toBeNull()
    expect(directInstallSourceFor('https://example.com/plugin.tgz')).toBeNull()
    expect(directInstallSourceFor('owner/repo --ignore-scripts=false')).toBeNull()
  })

  it('keeps immutable archive pins identifiable and updateable as GitHub installs', () => {
    const commit = 'd'.repeat(40)
    const archive = githubArchiveSpec('nexu-io/open-design', commit)!
    expect(parseGitHubDependencySpec(archive)).toEqual({
      repo: 'nexu-io/open-design',
      commit,
      subpath: null,
      kind: 'archive',
    })
    expect(findInstalledAlias(plugin, { '@nexu-io/open-design': archive })).toBe('@nexu-io/open-design')
    expect(entryForDep([plugin], '@nexu-io/open-design', archive)).toBe(plugin)
  })
})
