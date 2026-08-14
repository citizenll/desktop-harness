/** Desktop argument slicing and validation. */

import { describe, expect, it } from 'vitest'
import { parseDesktopOptions } from '../src/args.ts'

describe('desktop options', () => {
  it('uses the desktop profile and no developer switches by default', () => {
    expect(parseDesktopOptions(['electron', 'app'], false)).toEqual({
      profile: 'desktop',
      patchFiles: [],
      devtools: false,
      smokeTest: false,
    })
  })

  it('accepts repeated overlays in both development and packaged argv forms', () => {
    expect(parseDesktopOptions([
      'electron', 'app', '--profile', 'custom', '--patch', 'a.yml', '--patch=b.yml', '--devtools', '--smoke-test',
    ], false)).toEqual({
      profile: 'custom',
      patchFiles: ['a.yml', 'b.yml'],
      devtools: true,
      smokeTest: true,
    })
    expect(parseDesktopOptions(['DeepSeekHarness.exe', '--profile=desktop'], true).profile).toBe('desktop')
  })

  it('rejects positional or unknown application arguments', () => {
    expect(() => parseDesktopOptions(['electron', 'app', 'task'], false)).toThrow('unexpected positional')
    expect(() => parseDesktopOptions(['electron', 'app', '--unknown'], false)).toThrow('Unknown option')
  })
})
