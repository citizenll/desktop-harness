import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { patchPath, projectRoot } from './patch-path'

describe('assistant local path links', () => {
  it('links Codex-style path references even when they are not turn deliverables', async () => {
    const patch = await readFile(
      patchPath('@deepseek-ai/dsh-client-ui-deliverables'),
      'utf8'
    )

    expect(patch).toContain('localPathReference(value)')
    expect(patch).toContain('paths ?? []')
    expect(patch).toContain('#L\\d+')
    expect(patch).toContain('[A-Za-z]:[\\\\/]')
    expect(patch).toContain('owner.openFile')
  })
})
