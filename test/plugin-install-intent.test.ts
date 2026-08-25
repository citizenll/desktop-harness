import { describe, expect, it } from 'vitest'
import {
  buildDesktopPluginInstallUrl,
  normalizePluginInstallSource,
  parseDesktopPluginInstallUrl,
  parseDshDesktopCliLaunchArguments,
  parseDshDesktopCliPluginInstall
} from '../src/shared/plugin-install-intent'

describe('plugin install intents', () => {
  it('round-trips the canonical desktop protocol into a direct-install intent', () => {
    const link = buildDesktopPluginInstallUrl('nexu-io/open-design')

    expect(link).toBe(
      'dsh-desktop://plugin/install?source=nexu-io%2Fopen-design'
    )
    expect(parseDesktopPluginInstallUrl(link)).toEqual({
      status: 'ok',
      intent: { source: 'nexu-io/open-design' }
    })
  })

  it('accepts the hostless protocol spelling and ignores normal web URLs', () => {
    expect(
      parseDesktopPluginInstallUrl(
        'dsh-desktop:///plugin/install?source=https%3A%2F%2Fgithub.com%2Facme%2Ftool'
      )
    ).toEqual({
      status: 'ok',
      intent: { source: 'https://github.com/acme/tool' }
    })
    expect(
      parseDesktopPluginInstallUrl(
        'http://127.0.0.1:3080/#dsh-plugin-install=acme%2Ftool'
      )
    ).toEqual({ status: 'ignored' })
  })

  it('rejects malformed routes and sources', () => {
    expect(parseDesktopPluginInstallUrl('dsh-desktop://plugin/remove?source=a/b')).toMatchObject({
      status: 'error'
    })
    expect(
      parseDesktopPluginInstallUrl('dsh-desktop://plugin/install?source=two%20tokens')
    ).toMatchObject({ status: 'error' })
    expect(normalizePluginInstallSource('')).toBeUndefined()
  })

  it('maps only the Desktop web-profile add grammar into an intent', () => {
    expect(
      parseDshDesktopCliPluginInstall([
        'plugin',
        '--profile',
        'web',
        'add',
        'github:le-soleil-se-couche/dsh-skin-claude-code'
      ])
    ).toEqual({
      status: 'ok',
      intent: {
        source: 'github:le-soleil-se-couche/dsh-skin-claude-code'
      }
    })
    expect(
      parseDshDesktopCliPluginInstall([
        'plugin',
        '--profile',
        'web',
        'add',
        'https://github.com/le-soleil-se-couche/dsh-skin-claude-code'
      ])
    ).toEqual({
      status: 'ok',
      intent: {
        source: 'https://github.com/le-soleil-se-couche/dsh-skin-claude-code'
      }
    })
    expect(
      parseDshDesktopCliPluginInstall([
        'plugin',
        '--profile=web',
        'add',
        'nexu-io/open-design'
      ])
    ).toMatchObject({ status: 'ok' })
    expect(
      parseDshDesktopCliPluginInstall(['plugin', '--profile', 'other', 'add', 'a/b'])
    ).toMatchObject({ status: 'error' })
    expect(parseDshDesktopCliPluginInstall(['agent', 'list'])).toMatchObject({
      status: 'error'
    })
  })

  it('isolates a legacy Desktop CLI request from Electron process switches', () => {
    expect(
      parseDshDesktopCliLaunchArguments([
        'DSH Desktop.exe',
        '--dsh-cli',
        'plugin',
        '--profile',
        'web',
        'add',
        'nexu-io/open-design',
        '--original-process-start-time=12345'
      ])
    ).toEqual({
      status: 'ok',
      intent: { source: 'nexu-io/open-design' }
    })
    expect(parseDshDesktopCliLaunchArguments(['DSH Desktop.exe'])).toEqual({
      status: 'ignored'
    })
  })
})
