import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { create as createTar } from 'tar'
import { installBrandAssets } from './install-brand-assets.mjs'

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const coreWorkspaceRoot = path.join(projectRoot, '.core-runtime')
export const coreDistributionRoot = path.join(coreWorkspaceRoot, 'distribution')
export const coreTarget = `${process.platform}-${process.arch}`
export const coreWorkRoot = path.join(coreWorkspaceRoot, 'work', coreTarget)
export const coreArtifactRoot = path.join(coreWorkRoot, 'artifact')
export const coreRuntimeRoot = path.join(coreArtifactRoot, 'runtime')
const runtimeModules = path.join(coreRuntimeRoot, 'node_modules')

const removableDirectories = new Set(['.github', '.storybook', '.vscode', 'coverage'])
const governedHashExcludedDirectories = new Set(['.git', '.unrun', 'node_modules'])

const removableFile = (name) => {
  const lower = name.toLowerCase()
  return (
    lower.endsWith('.d.ts') ||
    lower.endsWith('.d.mts') ||
    lower.endsWith('.d.cts') ||
    lower.endsWith('.map') ||
    lower.endsWith('.pdb') ||
    lower.endsWith('.tsbuildinfo') ||
    /^(?:readme|changelog|history|contributing|security|code_of_conduct|governance|news|release-notes)(?:\..+)?\.md$/iu.test(
      name
    )
  )
}

function assertOwnedTarget(target, expectedRelative) {
  const relative = path.relative(projectRoot, path.resolve(target)).replaceAll('\\', '/')
  if (relative !== expectedRelative) {
    throw new Error(`Refusing to replace unexpected build directory: ${target}`)
  }
}

async function pathExists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function run(command, args, options = {}) {
  let stdout = ''
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? projectRoot,
      env: options.env ?? process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      windowsHide: true,
      shell: false
    })
    if (options.capture) {
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString('utf8')
      })
    }
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else {
        reject(
          new Error(
            `${path.basename(command)} failed (${signal ? `signal ${signal}` : `exit ${String(code)}`}).`
          )
        )
      }
    })
  })
  return stdout
}

async function installProductionDependencies() {
  const args = [
    'ci',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--prefer-offline',
    '--install-links=true'
  ]
  const npmCli = process.env.npm_execpath
  if (npmCli && (await pathExists(npmCli))) {
    await run(process.execPath, [npmCli, ...args], { cwd: coreRuntimeRoot })
    return
  }
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: coreRuntimeRoot
  })
}

async function applyRuntimePatches() {
  const patchPackageEntry = path.join(projectRoot, 'node_modules', 'patch-package', 'index.js')
  if (!(await pathExists(patchPackageEntry))) {
    throw new Error('patch-package is not installed in the development workspace.')
  }
  await cp(path.join(projectRoot, 'patches'), path.join(coreRuntimeRoot, 'patches'), {
    recursive: true
  })
  await run(process.execPath, [patchPackageEntry], { cwd: coreRuntimeRoot })
}

async function materializeLocalPackage(packageName) {
  const destination = path.join(runtimeModules, packageName)
  const source = path.join(projectRoot, 'packages', packageName)
  const metadata = await lstat(destination)
  if (metadata.isSymbolicLink()) {
    await rm(destination, { recursive: true, force: true })
    await cp(source, destination, { recursive: true })
  }
  const manifest = JSON.parse(await readFile(path.join(destination, 'package.json'), 'utf8'))
  return manifest.version
}

async function removeMany(targets) {
  const batchSize = 64
  for (let index = 0; index < targets.length; index += batchSize) {
    await Promise.all(
      targets
        .slice(index, index + batchSize)
        .map((target) => rm(target, { recursive: true, force: true }))
    )
  }
}

async function pruneGenericRuntimeFiles(root) {
  const stack = [root]
  const removals = []
  while (stack.length > 0) {
    const directory = stack.pop()
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        const relativeParts = path.relative(root, target).split(path.sep)
        if (
          entry.name === '.bin' ||
          (relativeParts.length > 1 && removableDirectories.has(entry.name.toLowerCase()))
        ) {
          removals.push(target)
        } else {
          stack.push(target)
        }
      } else if (entry.isFile() && removableFile(entry.name)) {
        removals.push(target)
      }
    }
  }
  await removeMany(removals)
  return removals.length
}

async function pruneNodePty() {
  const root = path.join(runtimeModules, 'node-pty')
  if (!(await pathExists(root))) return
  const prebuilds = path.join(root, 'prebuilds')
  const targetName = `${process.platform}-${process.arch}`
  const target = path.join(prebuilds, targetName)
  if (!(await pathExists(target))) {
    throw new Error(`node-pty does not contain the required ${targetName} prebuild.`)
  }
  const entries = await readdir(prebuilds, { withFileTypes: true })
  await removeMany(
    entries.filter((entry) => entry.name !== targetName).map((entry) => path.join(prebuilds, entry.name))
  )
  await removeMany(
    ['build', 'scripts', 'src', 'third_party', 'typings', 'binding.gyp'].map((name) =>
      path.join(root, name)
    )
  )
}

async function prunePnpmPlatformBinaries() {
  const dist = path.join(runtimeModules, 'pnpm', 'dist')
  if (!(await pathExists(dist))) return
  const platformPrefix = `reflink.${process.platform}-${process.arch}`
  const entries = await readdir(dist, { withFileTypes: true })
  await removeMany(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.startsWith('reflink.') &&
          entry.name.endsWith('.node') &&
          !entry.name.startsWith(platformPrefix)
      )
      .map((entry) => path.join(dist, entry.name))
  )

  const vendor = path.join(dist, 'vendor')
  if (process.platform === 'win32' && (await pathExists(vendor))) {
    const wanted = process.arch === 'ia32' ? 'x86' : process.arch
    const vendorEntries = await readdir(vendor, { withFileTypes: true })
    await removeMany(
      vendorEntries
        .filter(
          (entry) => entry.isFile() && entry.name.startsWith('fastlist-') && !entry.name.includes(`-${wanted}.`)
        )
        .map((entry) => path.join(vendor, entry.name))
    )
  }
}

async function pruneKnownPublishedBuildArtifacts() {
  const targets = [
    path.join(runtimeModules, '@anthropic-ai', 'sdk', 'src'),
    path.join(runtimeModules, '@mistralai', 'mistralai', 'examples'),
    path.join(runtimeModules, '@mistralai', 'mistralai', 'packages'),
    path.join(runtimeModules, '@mistralai', 'mistralai', 'tests'),
    path.join(runtimeModules, '@mixmark-io', 'domino', 'test'),
    path.join(runtimeModules, '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'examples'),
    path.join(runtimeModules, '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'examples'),
    path.join(runtimeModules, 'ajv', 'lib'),
    path.join(runtimeModules, 'ajv-formats', 'src'),
    path.join(runtimeModules, 'dsh-desktop-market', 'scripts'),
    path.join(runtimeModules, 'dsh-desktop-market', 'src'),
    path.join(runtimeModules, 'dsh-desktop-market', 'node_modules'),
    path.join(runtimeModules, 'dsh-desktop-market', 'tsconfig.json'),
    path.join(runtimeModules, 'dsh-desktop-market', 'tsconfig.client.json'),
    path.join(runtimeModules, 'dsh-desktop-market', 'tsdown.config.ts'),
    path.join(runtimeModules, 'dsh-desktop-market', 'UPSTREAM.md'),
    path.join(runtimeModules, 'dsh-desktop-verifier', 'scripts'),
    path.join(runtimeModules, 'dsh-desktop-verifier', 'src'),
    path.join(runtimeModules, 'dsh-desktop-verifier', 'node_modules'),
    path.join(runtimeModules, 'dsh-desktop-verifier', 'tsconfig.json'),
    path.join(runtimeModules, 'dsh-desktop-verifier', 'tsconfig.client.json'),
    path.join(runtimeModules, 'dsh-desktop-verifier', 'tsdown.config.ts'),
    path.join(runtimeModules, 'dsh-desktop-verifier', 'UPSTREAM.md'),
    path.join(runtimeModules, 'openai', 'src'),
    path.join(runtimeModules, 'sharp', 'install'),
    path.join(runtimeModules, 'sharp', 'src'),
    path.join(runtimeModules, 'zod', 'src'),
    path.join(runtimeModules, 'koffi', 'cnoke.cjs'),
    path.join(runtimeModules, 'koffi', 'doc'),
    path.join(runtimeModules, 'koffi', 'lib'),
    path.join(runtimeModules, 'koffi', 'vendor'),
    path.join(runtimeModules, 'koffi', 'src', 'koffi', 'CMakeLists.txt')
  ]

  const koffiSource = path.join(runtimeModules, 'koffi', 'src', 'koffi', 'src')
  if (await pathExists(koffiSource)) {
    const runtimeFiles = new Set(['static.cjs', 'static.js'])
    const entries = await readdir(koffiSource, { withFileTypes: true })
    targets.push(
      ...entries
        .filter((entry) => !entry.isFile() || !runtimeFiles.has(entry.name))
        .map((entry) => path.join(koffiSource, entry.name))
    )
  }

  const nativeSharp = path.join(runtimeModules, '@img', `sharp-${process.platform}-${process.arch}`)
  if (await pathExists(nativeSharp)) targets.push(path.join(runtimeModules, '@img', 'sharp-wasm32'))
  await removeMany(targets)
}

async function collectStats(root) {
  let files = 0
  let bytes = 0
  const stack = [root]
  while (stack.length > 0) {
    const directory = stack.pop()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) stack.push(target)
      else if (entry.isFile()) {
        files += 1
        bytes += (await stat(target)).size
      }
    }
  }
  return { files, bytes }
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

async function assertFile(root, relative) {
  const target = path.join(root, relative)
  const metadata = await stat(target).catch(() => undefined)
  if (!metadata?.isFile()) throw new Error(`Core staging is missing ${relative}.`)
}

function governedHashBytes(bytes) {
  return bytes.includes(0)
    ? bytes
    : Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'))
}

async function hashFileTree(hash, root, label) {
  const files = []
  const stack = [root]
  while (stack.length > 0) {
    const directory = stack.pop()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!governedHashExcludedDirectories.has(entry.name)) stack.push(target)
      } else if (entry.isSymbolicLink()) {
        throw new Error(`Governed Core input contains a symbolic link: ${target}`)
      } else if (entry.isFile()) {
        files.push({
          target,
          relative: path.relative(root, target).replaceAll('\\', '/')
        })
      }
    }
  }
  files.sort((left, right) =>
    left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0
  )
  for (const file of files) {
    hash.update(`${label}/${file.relative}\0`)
    const bytes = await readFile(file.target)
    hash.update(governedHashBytes(bytes))
    hash.update('\0')
  }
}

async function patchsetHash() {
  const hash = createHash('sha256')
  await hashFileTree(hash, path.join(projectRoot, 'patches'), 'patches')
  for (const [relative, label] of [
    ['build/dsh-desktop.patch.yml', 'composition'],
    ['build/harness-node-entry.mjs', 'runner-entry'],
    ['build/runtime-module-fallback.mjs', 'module-fallback'],
    ['build/icon.png', 'brand-icon'],
    ['build/brand.png', 'brand-lockup'],
    ['packages/dsh-desktop-market', 'market'],
    ['packages/dsh-desktop-plugin-runtime', 'plugin-runtime'],
    ['packages/dsh-desktop-verifier', 'verifier']
  ]) {
    const target = path.join(projectRoot, relative)
    const metadata = await stat(target)
    if (metadata.isDirectory()) await hashFileTree(hash, target, label)
    else {
      hash.update(`${label}\0`)
      hash.update(governedHashBytes(await readFile(target)))
      hash.update('\0')
    }
  }
  return hash.digest('hex')
}

export async function prepareCoreRunnerDistribution() {
  const runnerRoot = path.join(coreDistributionRoot, 'core-runner')
  await rm(runnerRoot, { recursive: true, force: true })
  await mkdir(runnerRoot, { recursive: true })
  const executableName = process.platform === 'win32' ? 'node.exe' : 'node'
  const sourceExecutable = path.join(projectRoot, 'node_modules', 'node', 'bin', executableName)
  if (!(await pathExists(sourceExecutable))) {
    throw new Error('The governed standalone Node Runner is not installed.')
  }
  const executablePath = path.join(runnerRoot, executableName)
  await copyFile(sourceExecutable, executablePath)
  if (process.platform !== 'win32') await chmod(executablePath, 0o755)
  const metadata = JSON.parse(
    await run(
      executablePath,
      [
        '-p',
        'JSON.stringify({schemaVersion:1,version:process.version,abi:process.versions.modules,platform:process.platform,arch:process.arch})'
      ],
      { capture: true }
    )
  )
  if (metadata.platform !== process.platform || metadata.arch !== process.arch) {
    throw new Error(
      `Governed Node Runner target ${metadata.platform}-${metadata.arch} does not match ${process.platform}-${process.arch}.`
    )
  }
  await writeFile(path.join(runnerRoot, 'runner.json'), `${JSON.stringify(metadata, null, 2)}\n`)
  const nodeLicense = path.join(projectRoot, 'node_modules', 'node', 'LICENSE')
  if (await pathExists(nodeLicense)) {
    await copyFile(nodeLicense, path.join(runnerRoot, 'LICENSE.node.txt'))
  }
  return metadata
}

async function macSigningIdentity(keychain) {
  const output = await run('security', ['find-identity', '-v', '-p', 'codesigning', keychain], {
    capture: true
  })
  const match = output.match(/\)\s+[A-F0-9]+\s+"(Developer ID Application:[^"]+)"/u)
  if (!match?.[1]) throw new Error('Developer ID Application identity was not found for Core signing.')
  return match[1]
}

async function signMacCoreRuntime() {
  if (process.platform !== 'darwin' || !process.env.CSC_KEYCHAIN) return
  const identity = await macSigningIdentity(process.env.CSC_KEYCHAIN)
  const runnerExecutable = path.join(coreDistributionRoot, 'core-runner', 'node')
  const runnerEntitlements = path.join(projectRoot, 'build', 'core-runner-entitlements.plist')
  const candidates = []
  for (const root of [coreRuntimeRoot, path.join(coreDistributionRoot, 'core-runner')]) {
    const stack = [root]
    while (stack.length > 0) {
      const directory = stack.pop()
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name)
        if (entry.isDirectory()) stack.push(target)
        else if (entry.isFile()) {
          const description = await run('file', ['-b', target], { capture: true })
          if (description.includes('Mach-O')) candidates.push(target)
        }
      }
    }
  }
  candidates.sort((left, right) => right.split(path.sep).length - left.split(path.sep).length)
  for (const target of candidates) {
    const args = [
      '--keychain',
      process.env.CSC_KEYCHAIN,
      '--sign',
      identity,
      '--timestamp',
      '--options',
      'runtime',
      '--force'
    ]
    if (target === runnerExecutable) args.push('--entitlements', runnerEntitlements)
    args.push(target)
    await run('codesign', args)
  }
  console.log(`Signed ${candidates.length} Core Mach-O files with ${identity}.`)
}

export async function stageCoreRuntime() {
  assertOwnedTarget(coreWorkRoot, `.core-runtime/work/${coreTarget}`)
  await rm(coreWorkRoot, { recursive: true, force: true })
  await mkdir(coreRuntimeRoot, { recursive: true })

  const release = JSON.parse(await readFile(path.join(projectRoot, 'core', 'core-release.json'), 'utf8'))
  if (release.schemaVersion !== 1 || !Number.isSafeInteger(release.generation) || release.generation < 1) {
    throw new Error('core/core-release.json is invalid.')
  }
  const sourceManifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
  const runtimeManifest = {
    name: sourceManifest.name,
    version: `0.0.0-core.g${release.generation}`,
    private: true,
    type: sourceManifest.type,
    dependencies: { ...sourceManifest.dependencies },
    overrides: sourceManifest.overrides
  }
  await writeFile(
    path.join(coreRuntimeRoot, 'package.json'),
    `${JSON.stringify(runtimeManifest, null, 2)}\n`,
    'utf8'
  )
  await copyFile(path.join(projectRoot, 'package-lock.json'), path.join(coreRuntimeRoot, 'package-lock.json'))
  await mkdir(path.join(coreRuntimeRoot, 'packages'), { recursive: true })
  for (const packageName of ['dsh-desktop-plugin-runtime', 'dsh-desktop-market', 'dsh-desktop-verifier']) {
    await cp(
      path.join(projectRoot, 'packages', packageName),
      path.join(coreRuntimeRoot, 'packages', packageName),
      { recursive: true }
    )
  }

  await installProductionDependencies()
  await applyRuntimePatches()
  await installBrandAssets({ packageRoot: coreRuntimeRoot, assetRoot: projectRoot })
  for (const packageName of ['dsh-desktop-market', 'dsh-desktop-plugin-runtime', 'dsh-desktop-verifier']) {
    runtimeManifest.dependencies[packageName] = await materializeLocalPackage(packageName)
  }

  const resources = path.join(coreRuntimeRoot, 'resources')
  await mkdir(resources, { recursive: true })
  for (const name of [
    'harness-node-entry.mjs',
    'runtime-module-fallback.mjs',
    'dsh-desktop.patch.yml'
  ]) {
    await copyFile(path.join(projectRoot, 'build', name), path.join(resources, name))
  }

  await pruneNodePty()
  await prunePnpmPlatformBinaries()
  await pruneKnownPublishedBuildArtifacts()
  await removeMany([
    path.join(runtimeModules, '@mistralai', 'mistralai', 'src'),
    path.join(coreRuntimeRoot, 'package-lock.json'),
    path.join(coreRuntimeRoot, 'patches'),
    path.join(coreRuntimeRoot, 'packages')
  ])
  const prunedFiles = await pruneGenericRuntimeFiles(runtimeModules)
  await writeFile(
    path.join(coreRuntimeRoot, 'package.json'),
    `${JSON.stringify(runtimeManifest, null, 2)}\n`,
    'utf8'
  )

  for (const required of [
    'package.json',
    'node_modules/@deepseek-ai/dsh/lib/bin.js',
    'node_modules/pnpm/bin/pnpm.cjs',
    'node_modules/dsh-desktop-market/lib/index.js',
    'node_modules/dsh-desktop-market/client/client.js',
    'node_modules/dsh-desktop-plugin-runtime/index.js',
    'node_modules/dsh-desktop-verifier/lib/index.js',
    'node_modules/dsh-desktop-verifier/client/client.js',
    'resources/harness-node-entry.mjs',
    'resources/runtime-module-fallback.mjs',
    'resources/dsh-desktop.patch.yml'
  ]) {
    await assertFile(coreRuntimeRoot, required)
  }

  const runner = await prepareCoreRunnerDistribution()
  const descriptor = {
    schemaVersion: 1,
    generation: release.generation,
    coreId: `dsh-core-g${release.generation}-${process.platform}-${process.arch}`,
    dshVersion: sourceManifest.dependencies['@deepseek-ai/dsh'],
    patchsetHash: await patchsetHash(),
    desktopProtocol: 1,
    runnerVersion: runner.version,
    runnerAbi: runner.abi,
    dataSchema: 1,
    platform: process.platform,
    arch: process.arch
  }
  await writeFile(path.join(coreArtifactRoot, 'core.json'), `${JSON.stringify(descriptor, null, 2)}\n`)
  await signMacCoreRuntime()
  const staged = await collectStats(coreRuntimeRoot)
  console.log(
    `Core staging ready: ${staged.files.toLocaleString('en-US')} files, ${formatBytes(staged.bytes)} (${prunedFiles.toLocaleString('en-US')} generic files/directories pruned).`
  )
  return descriptor
}

async function sha256File(target) {
  const bytes = await readFile(target)
  return { size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function deterministicArchiveEntries(root) {
  const entries = ['core.json']
  const stack = ['runtime']
  while (stack.length > 0) {
    const relativePath = stack.pop()
    const absolutePath = path.join(root, ...relativePath.split('/'))
    const metadata = await lstat(absolutePath)
    if (metadata.isSymbolicLink()) {
      throw new Error(`Core artifacts cannot contain symbolic links: ${relativePath}`)
    }
    if (metadata.isDirectory()) {
      entries.push(relativePath)
      const children = await readdir(absolutePath, { withFileTypes: true })
      for (const child of children) {
        stack.push(`${relativePath}/${child.name}`)
      }
      continue
    }
    if (!metadata.isFile()) {
      throw new Error(`Core artifacts can contain only files and directories: ${relativePath}`)
    }
    entries.push(relativePath)
  }
  return entries.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

export async function packageStagedCore() {
  const descriptor = JSON.parse(await readFile(path.join(coreArtifactRoot, 'core.json'), 'utf8'))
  const archiveName = `dsh-core-g${descriptor.generation}-${descriptor.platform}-${descriptor.arch}.tar.gz`
  const releaseRoot = path.join(coreDistributionRoot, 'core-release')
  const baselineRoot = path.join(coreDistributionRoot, 'core-baseline')
  await rm(releaseRoot, { recursive: true, force: true })
  await rm(baselineRoot, { recursive: true, force: true })
  await mkdir(releaseRoot, { recursive: true })
  await mkdir(baselineRoot, { recursive: true })
  const archivePath = path.join(releaseRoot, archiveName)
  const entries = await deterministicArchiveEntries(coreArtifactRoot)
  await createTar(
    {
      cwd: coreArtifactRoot,
      file: archivePath,
      gzip: true,
      portable: true,
      noMtime: true,
      noDirRecurse: true,
      strict: true
    },
    entries
  )
  const digest = await sha256File(archivePath)
  const artifact = {
    core: descriptor,
    archive: { format: 'tar.gz', fileName: archiveName, ...digest }
  }
  await writeFile(path.join(releaseRoot, 'artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`)
  await copyFile(archivePath, path.join(baselineRoot, archiveName))
  await writeFile(path.join(baselineRoot, 'manifest.json'), `${JSON.stringify(artifact, null, 2)}\n`)
  console.log(`Core archive ready: ${archiveName}, ${formatBytes(digest.size)}.`)
  return { archivePath, artifact }
}

export async function prepareCoreRuntime() {
  await stageCoreRuntime()
  return packageStagedCore()
}
