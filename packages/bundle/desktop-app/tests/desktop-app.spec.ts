/** Desktop layer composition over the shared GUI roster. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

const webPatch = fileURLToPath(new URL('../../web-app/cordis.patch.yml', import.meta.url))
const desktopPatch = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

function rows(): Map<string, EntryOptions> {
  const composed = composeEntries([
    loadOverlayPatches('desktop-app-test', webPatch),
    loadOverlayPatches('desktop-app-test', desktopPatch),
  ])
  return new Map(composed.flatMap(row => typeof row.id === 'string' ? [[row.id, row]] : []))
}

describe('dsh-desktop-app bundle', () => {
  it('declares the desktop patch through its bundle manifest', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })

  it('keeps the GUI roster while removing every listening-server row', () => {
    const composition = rows()
    for (const id of ['web-startup', 'webserver', 'web-runtime', 'client-hmr', 'directory-picker']) {
      expect(composition.get(id)?.disabled, id).toBe(true)
    }
    expect(composition.get('connection')).toMatchObject({ inject: [], config: { trustedHosts: [] } })
    expect(composition.get('connection')?.disabled).not.toBe(true)
    expect(composition.get('modules')?.disabled).not.toBe(true)
    expect(composition.get('client-runtime')?.disabled).not.toBe(true)
    expect(composition.get('ui-conversation')?.disabled).not.toBe(true)
    expect(composition.get('desktop-runtime')?.name).toBe('@deepseek-ai/dsh-desktop-app')
  })

  it('pins the local native directory interaction on both Host and Client faces', () => {
    const composition = rows()
    expect(composition.get('directory-picker-native')?.name)
      .toBe('@deepseek-ai/dsh-host-directory-picker-native')
    expect(composition.get('directory-picker-native-ui')?.name)
      .toBe('@deepseek-ai/dsh-client-ui-directory-picker-native')
  })
})
