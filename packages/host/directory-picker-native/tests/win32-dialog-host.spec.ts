/** Win32 dialog worker host environment behavior. */

import { describe, expect, it } from 'vitest'
import { dialogWorkerEnvironment } from '../src/win32-dialog-host.ts'

describe('dialogWorkerEnvironment', () => {
  it('preserves a plain Node environment and adds the dialog title', () => {
    expect(dialogWorkerEnvironment({ title: 'Choose' }, { KEEP: 'yes' }, undefined)).toEqual({
      KEEP: 'yes',
      DSH_DIALOG_TITLE: 'Choose',
    })
  })

  it('runs the child Electron executable in Node mode', () => {
    expect(dialogWorkerEnvironment(
      { title: 'Choose' },
      { ELECTRON_RUN_AS_NODE: '0', KEEP: 'yes' },
      '43.4.0',
    )).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      KEEP: 'yes',
      DSH_DIALOG_TITLE: 'Choose',
    })
  })
})
