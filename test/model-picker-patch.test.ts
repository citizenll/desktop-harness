import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasPatch, patchPath, projectRoot } from './patch-path'

const settingsModelsClient = path.join(
  projectRoot,
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-settings-models',
  'lib',
  'client.js'
)

/**
 * Harness took the select-all toggle upstream in 0.1.0-rc.8, so the desktop
 * patch no longer carries it. Assert against the composed package instead: the
 * behavior still has to be there, and the patch still has to stay out of it.
 */
describe('DSH Desktop available-model picker', () => {
  it('ships one state-driven select-all toggle', async () => {
    const client = await readFile(settingsModelsClient, 'utf8')

    expect(client).toContain('const allCandidatesPicked =')
    expect(client).toContain('activeCandidates.every((candidate) => picked.has(candidate.id))')
    expect(client).toContain(
      'children: t(allCandidatesPicked ? "fetchDeselectAll" : "fetchSelectAll")'
    )
    expect(client).toContain('const toggleAllCandidates =')
  })

  it('includes English and Chinese copy for both toggle states', async () => {
    const client = await readFile(settingsModelsClient, 'utf8')

    expect(client).toContain('fetchSelectAll: "Select all"')
    expect(client).toContain('fetchDeselectAll: "Deselect all"')
    expect(client).toContain('fetchSelectAll: "全选"')
    expect(client).toContain('fetchDeselectAll: "取消全选"')
  })

  it('leaves the toggle to Harness rather than re-patching it', async () => {
    expect(hasPatch('@deepseek-ai/dsh-client-ui-settings-models')).toBe(true)
    const patch = await readFile(
      patchPath('@deepseek-ai/dsh-client-ui-settings-models'),
      'utf8'
    )

    expect(patch).not.toContain('const allCandidatesPicked =')
    expect(patch).not.toContain('fetchSelectAll: "Select all"')
  })
})
