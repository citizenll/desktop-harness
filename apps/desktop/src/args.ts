/** Desktop command-line parsing independent of Electron lifecycle. */

import { parseArgs } from 'node:util'

/** Resolved Electron application options. */
export interface DesktopOptions {
  /** Profile composed into the main-process Host. */
  profile: string
  /** Ordered user overlay patch files. */
  patchFiles: string[]
  /** Open Chromium developer tools after the first page load. */
  devtools: boolean
  /** Load one hidden window, validate boot, then exit. */
  smokeTest: boolean
}

/**
 * Parse arguments after the Electron executable and development app path.
 * @param argv - complete process argv.
 * @param packaged - whether Electron is running a packaged application.
 * @returns resolved desktop options.
 */
export function parseDesktopOptions(argv: readonly string[], packaged: boolean): DesktopOptions {
  const args = argv.slice(packaged ? 1 : 2)
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      profile: { type: 'string', default: 'desktop' },
      patch: { type: 'string', multiple: true },
      devtools: { type: 'boolean', default: false },
      'smoke-test': { type: 'boolean', default: false },
    },
  })
  if (positionals.length > 0) {
    throw new Error(`dsh desktop: unexpected positional arguments: ${positionals.join(' ')}`)
  }
  return {
    profile: values.profile,
    patchFiles: values.patch ?? [],
    devtools: values.devtools,
    smokeTest: values['smoke-test'],
  }
}
