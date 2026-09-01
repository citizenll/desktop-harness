import { describe, expect, it } from 'vitest'
import type { CoreUpdateStatus } from '../src/shared/core-update'
import {
  coreUpdateMessage,
  isCoreUpdateDismissed,
  shouldShowCoreUpdate
} from '../src/preload/core-update-view'

const available: CoreUpdateStatus = {
  phase: 'available',
  currentGeneration: 1,
  currentVersion: '0.1.1-rc.1',
  availableGeneration: 2,
  availableVersion: '0.1.2',
  manual: false
}

describe('Core update confirmation UI', () => {
  it('shows discovered updates without exposing automatic check failures', () => {
    expect(shouldShowCoreUpdate(available)).toBe(true)
    expect(
      shouldShowCoreUpdate({
        phase: 'error',
        currentGeneration: 1,
        currentVersion: '0.1.1-rc.1',
        manual: false
      })
    ).toBe(false)
  })

  it('keeps download and activation as two explicit states', () => {
    expect(coreUpdateMessage(available, 'zh')).toContain('可升级')
    expect(coreUpdateMessage({ ...available, phase: 'staged' }, 'zh')).toContain('已准备好')
    expect(
      coreUpdateMessage({ ...available, phase: 'verifying', source: 'embedded' }, 'zh')
    ).toContain('安装包内置')
  })

  it('dismisses only the generation the user postponed', () => {
    expect(isCoreUpdateDismissed(available, 2, null)).toBe(true)
    expect(isCoreUpdateDismissed({ ...available, availableGeneration: 3 }, 2, null)).toBe(false)
  })
})
