/** Materialize the production workspace closure, then package the Electron application. */

import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packager } from '@electron/packager'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(appDir, '../..')
const stagingParent = join(repositoryRoot, 'node_modules')
const configuredOutputDir = process.env.DSH_DESKTOP_PACKAGE_OUTPUT
if (configuredOutputDir !== undefined && configuredOutputDir.trim() === '') {
  throw new Error('dsh desktop package: DSH_DESKTOP_PACKAGE_OUTPUT must not be empty')
}
const outputDir = configuredOutputDir === undefined
  ? join(repositoryRoot, '.artifacts', 'desktop')
  : resolve(repositoryRoot, configuredOutputDir)
const pnpmCli = process.env.npm_execpath
const manifest = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))
const electronVersion = manifest.devDependencies?.electron
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024

if (pnpmCli === undefined || pnpmCli === '') {
  throw new Error('dsh desktop package: npm_execpath is unavailable; run through `pnpm run package:desktop`')
}
if (typeof electronVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(electronVersion)) {
  throw new Error('dsh desktop package: devDependencies.electron must be an exact version')
}

mkdirSync(stagingParent, { recursive: true })
const stagingDir = mkdtempSync(join(stagingParent, '.dsh-desktop-package-'))

function git(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: options.encoding ?? 'utf8',
    input: options.input,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: options.stdio,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      ...options.env,
    },
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : ''
    throw new Error(`dsh desktop package: git ${args[0] ?? ''} failed: ${stderr || String(result.status)}`)
  }
  return result
}

function materializeSourceCapsule() {
  const capsuleDir = join(stagingDir, 'source-capsule')
  const capsuleWork = join(stagingParent, `.dsh-source-capsule-${process.pid}-${Date.now()}`)
  const expectedIndex = `${capsuleWork}.index`
  const hooksDir = join(capsuleWork, '.empty-hooks')
  const capsuleBranch = 'dsh-capsule'
  try {
    git(['clone', '--local', '--no-hardlinks', '--no-checkout', repositoryRoot, capsuleWork], { stdio: 'inherit' })
    git(['checkout', '--detach', 'HEAD'], { cwd: capsuleWork, stdio: 'inherit' })
    const diff = git(['diff', '--binary', '--no-ext-diff', 'HEAD'], { encoding: 'buffer' }).stdout
    if (diff.length > 0) git(['apply', '--binary', '-'], { cwd: capsuleWork, input: diff })

    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'buffer' }).stdout
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
    for (const relativePath of untracked) {
      const target = join(capsuleWork, relativePath)
      mkdirSync(dirname(target), { recursive: true })
      cpSync(join(repositoryRoot, relativePath), target, { recursive: true, dereference: false })
    }

    git(['add', '--all'], { cwd: capsuleWork })
    git(['read-tree', 'HEAD'], {
      env: { GIT_INDEX_FILE: expectedIndex },
    })
    git(['add', '--all'], {
      env: { GIT_INDEX_FILE: expectedIndex },
    })
    const expectedTree = git(['write-tree'], {
      env: { GIT_INDEX_FILE: expectedIndex },
    }).stdout.trim()
    const capsuleTree = git(['write-tree'], { cwd: capsuleWork }).stdout.trim()
    if (capsuleTree !== expectedTree) {
      throw new Error(`dsh desktop package: source capsule tree ${capsuleTree} does not match workspace tree ${expectedTree}`)
    }
    const changed = git(['status', '--porcelain=v1'], { cwd: capsuleWork }).stdout.trim().length > 0
    if (changed) {
      mkdirSync(hooksDir, { recursive: true })
      git([
        '-c', `core.hooksPath=${hooksDir}`,
        '-c', 'user.name=DeepSeek Harness Desktop',
        '-c', 'user.email=desktop@localhost',
        'commit', '-m', 'chore: capture desktop source capsule',
      ], { cwd: capsuleWork, stdio: 'inherit' })
    }
    git(['branch', '--force', capsuleBranch, 'HEAD'], { cwd: capsuleWork })
    const commit = git(['rev-parse', 'HEAD'], { cwd: capsuleWork }).stdout.trim()
    mkdirSync(capsuleDir, { recursive: true })
    git(['bundle', 'create', join(capsuleDir, 'repository.bundle'), `refs/heads/${capsuleBranch}`], {
      cwd: capsuleWork,
      stdio: 'inherit',
    })
    writeFileSync(join(capsuleDir, 'manifest.json'), JSON.stringify({
      formatVersion: 1,
      branch: capsuleBranch,
      commit,
    }, undefined, 2) + '\n')
  } finally {
    rmSync(expectedIndex, { force: true })
    rmSync(`${expectedIndex}.lock`, { force: true })
    rmSync(capsuleWork, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

try {
  const deploy = spawnSync(process.execPath, [
    pnpmCli,
    '--ignore-scripts',
    '--config.inject-workspace-packages=true',
    '--config.node-linker=hoisted',
    '--filter',
    '@deepseek-ai/dsh-desktop',
    'deploy',
    '--prod',
    stagingDir,
  ], {
    cwd: repositoryRoot,
    stdio: 'inherit',
  })
  if (deploy.error !== undefined) throw deploy.error
  if (deploy.status !== 0) {
    throw new Error(`dsh desktop package: pnpm deploy exited ${String(deploy.status)}`)
  }

  materializeSourceCapsule()

  const outputs = await packager({
    dir: stagingDir,
    name: 'DeepSeekHarness',
    out: outputDir,
    overwrite: true,
    prune: false,
    asar: false,
    electronVersion,
    icon: process.platform === 'win32' ? join(appDir, 'assets', 'icon.ico') : undefined,
    ignore: [
      /^\/(?:scripts|src|tests|tsconfig\.json|tsdown\.config\.ts|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/,
      /^\/node_modules\/(?:\.pnpm|\.bin)(?:\/|$)/,
    ],
  })
  for (const output of outputs) process.stdout.write(`dsh desktop package: ${output}\n`)
} finally {
  rmSync(stagingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
