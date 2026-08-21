import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { patchPath, projectRoot } from './patch-path'

const settingsGeneralClient = path.join(
  projectRoot,
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-settings-general',
  'lib',
  'client.js'
)

describe('DSH Desktop settings panel', () => {
  it('uses the desktop-sized panel while retaining the viewport safety margin', async () => {
    const client = await readFile(settingsGeneralClient, 'utf8')

    expect(client).toContain('width:1024px;max-width:calc(100vw - 48px)')
    expect(client).toContain('border-radius:12px;display:flex;position:relative;overflow:hidden')
  })

  it('captures the layout override as a reproducible dependency patch', async () => {
    const patch = await readFile(
      patchPath('@deepseek-ai/dsh-client-ui-settings-general'),
      'utf8'
    )

    expect(patch).toContain('width:1024px')
    expect(patch).toContain('border-radius:12px')
  })
})
