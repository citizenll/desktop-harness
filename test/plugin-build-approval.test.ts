import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  gitPrebuiltFallbackArgs,
  isExecutedGitPrepareFailure,
  parseBuildApprovalEvidence,
  parseExecutedGitPrepareFailure,
  withHoistRecovery,
} from '../packages/dsh-desktop-market/src/install'
import { setAllowBuilds } from '../packages/dsh-desktop-market/src/profile'

const exactKey = '@deepseek-ai/dsh-client-ui-skin-claude-code@https://codeload.github.com/le-soleil-se-couche/dsh-skin-claude-code/tar.gz/8590170e1c37eca3176469ade61998fd3d5088d4'
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('plugin build approval', () => {
  it('extracts pnpm 10 exact git prepare evidence from ndjson output', () => {
    const stderr = JSON.stringify({
      level: 'error',
      message: `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED The git-hosted package "@deepseek-ai/dsh-client-ui-skin-claude-code@0.0.1" needs to execute build scripts but is not in the "onlyBuiltDependencies" allowlist.\nFor example:\nonlyBuiltDependencies:\n  - "${exactKey}"`,
    })

    expect(parseBuildApprovalEvidence('', stderr)).toEqual({
      packages: ['@deepseek-ai/dsh-client-ui-skin-claude-code'],
      exactKeys: [exactKey],
    })
  })

  it('persists exact commit selectors in allowBuilds without duplicating the YAML block', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-build-approval-'))
    temporaryDirectories.push(directory)
    const workspace = join(directory, 'pnpm-workspace.yaml')
    writeFileSync(workspace, [
      'packages:',
      '  - .',
      '',
      'allowBuilds:',
      '  existing-package: false',
      '',
    ].join('\r\n'))

    setAllowBuilds('web', [
      '@deepseek-ai/dsh-client-ui-skin-claude-code',
      exactKey,
    ], directory)
    const once = readFileSync(workspace, 'utf8')
    setAllowBuilds('web', [exactKey], directory)
    const twice = readFileSync(workspace, 'utf8')

    expect(twice).toBe(once)
    expect(twice.match(/^allowBuilds:/gm)).toHaveLength(1)
    expect(twice).toContain("  '@deepseek-ai/dsh-client-ui-skin-claude-code': true")
    expect(twice).toContain(`  '${exactKey}': true`)
    expect(twice).toContain('  existing-package: false')
    expect(twice).toContain('\r\n')
  })

  it('distinguishes a failed executed prepare script from an approval block', () => {
    const base = { exitCode: 1, timedOut: false, cancelled: false, stdout: '', busy: false }
    expect(isExecutedGitPrepareFailure({
      ...base,
      stderr: `ERR_PNPM_PREPARE_PACKAGE Failed to prepare git-hosted package fetched from "https://codeload.github.com/owner/repo/tar.gz/${'a'.repeat(40)}": pkg npm-install: npm install\nExit status 1`,
    })).toBe(true)
    expect(isExecutedGitPrepareFailure({
      ...base,
      stderr: 'ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED The git-hosted package needs to execute build scripts',
    })).toBe(false)
    expect(parseExecutedGitPrepareFailure({
      ...base,
      stderr: `ERR_PNPM_PREPARE_PACKAGE Failed to prepare git-hosted package fetched from "https://codeload.github.com/le-soleil-se-couche/dsh-skin-claude-code/tar.gz/${'a'.repeat(40)}": @deepseek-ai/dsh-client-ui-skin-claude-code@0.0.1 npm-install: npm install\nExit status 1`,
    })).toEqual({
      packageName: '@deepseek-ai/dsh-client-ui-skin-claude-code',
      repo: 'le-soleil-se-couche/dsh-skin-claude-code',
      commit: 'a'.repeat(40),
    })
  })

  it('constructs a one-shot no-script fallback only for git add targets', () => {
    expect(gitPrebuiltFallbackArgs([
      'add',
      '--config.minimumReleaseAge=0',
      'github:le-soleil-se-couche/dsh-skin-claude-code',
    ])).toEqual([
      'add',
      '--ignore-scripts',
      '--config.minimumReleaseAge=0',
      'github:le-soleil-se-couche/dsh-skin-claude-code',
    ])
    expect(gitPrebuiltFallbackArgs(['add', '@scope/plugin'])).toBeNull()
    expect(gitPrebuiltFallbackArgs(['remove', 'github:owner/repo'])).toBeNull()
    expect(gitPrebuiltFallbackArgs(['add', '--ignore-scripts', 'github:owner/repo'])).toBeNull()
  })

  it('repairs an existing git dependency that poisons an unrelated add', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-git-repair-'))
    temporaryDirectories.push(directory)
    const name = '@deepseek-ai/dsh-client-ui-skin-claude-code'
    const commit = 'b'.repeat(40)
    writeFileSync(join(directory, 'package.json'), JSON.stringify({
      dependencies: { [name]: 'github:le-soleil-se-couche/dsh-skin-claude-code' },
    }))
    const packageDir = join(directory, 'node_modules', name)
    mkdirSync(join(packageDir, 'lib'), { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version: '0.0.1', main: 'lib/index.js', dsh: {} }))
    writeFileSync(join(packageDir, 'lib', 'index.js'), 'export {}')

    const calls: string[][] = []
    const result = await withHoistRecovery(async (_profile, args) => {
      calls.push(args)
      if (calls.length === 1) {
        return {
          exitCode: 1,
          timedOut: false,
          cancelled: false,
          stdout: '',
          stderr: `ERR_PNPM_PREPARE_PACKAGE Failed to prepare git-hosted package fetched from "https://codeload.github.com/le-soleil-se-couche/dsh-skin-claude-code/tar.gz/${commit}": ${name}@0.0.1 npm-install: npm install\nExit status 1`,
        }
      }
      return { exitCode: 0, timedOut: false, cancelled: false, stdout: '', stderr: '' }
    }, 'web', ['add', '@deepseek-harness-tui/dsh-tui'], directory)

    const archive = `https://github.com/le-soleil-se-couche/dsh-skin-claude-code/archive/${commit}.tar.gz`
    expect(calls).toEqual([
      ['add', '@deepseek-harness-tui/dsh-tui'],
      ['install', '--no-frozen-lockfile', '--ignore-scripts'],
      ['add', '@deepseek-harness-tui/dsh-tui'],
    ])
    expect(result.exitCode).toBe(0)
    expect(result.repairedDependencies).toEqual({ [name]: archive })
    expect(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).dependencies[name]).toBe(archive)
  })

  it('pins a successful no-script git fallback before a later mutation can replay prepare', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-git-fallback-'))
    temporaryDirectories.push(directory)
    const name = '@scope/plugin'
    const repo = 'owner/repo'
    const commit = 'c'.repeat(40)
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ dependencies: {} }))

    const calls: string[][] = []
    const result = await withHoistRecovery(async (_profile, args) => {
      calls.push(args)
      if (calls.length === 1) {
        writeFileSync(join(directory, 'package.json'), JSON.stringify({ dependencies: { [name]: `github:${repo}` } }))
        writeFileSync(join(directory, 'pnpm-lock.yaml'), `resolution: https://codeload.github.com/${repo}/tar.gz/${commit}\n`)
        const packageDir = join(directory, 'node_modules', name)
        mkdirSync(join(packageDir, 'lib'), { recursive: true })
        writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'lib/index.js', dsh: {} }))
        writeFileSync(join(packageDir, 'lib', 'index.js'), 'export {}')
      }
      return { exitCode: 0, timedOut: false, cancelled: false, stdout: '', stderr: '' }
    }, 'web', ['add', '--ignore-scripts', `github:${repo}`], directory)

    const archive = `https://github.com/${repo}/archive/${commit}.tar.gz`
    expect(calls).toEqual([
      ['add', '--ignore-scripts', `github:${repo}`],
      ['install', '--no-frozen-lockfile', '--ignore-scripts'],
    ])
    expect(result.repairedDependencies).toEqual({ [name]: archive })
    expect(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).dependencies[name]).toBe(archive)
  })
})
