import { describe, expect, it } from 'vitest'
import { checkDshReleaseTrain } from '../scripts/check-dsh-release-train.mjs'

describe('DSH release train', () => {
  it('keeps dependencies and governed patches on one upstream release', async () => {
    await expect(checkDshReleaseTrain()).resolves.toMatchObject({
      version: '0.1.1-rc.1',
      patches: 15
    })
  })
})
