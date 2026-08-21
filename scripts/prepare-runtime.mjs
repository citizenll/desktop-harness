import { spawn } from 'node:child_process'
import {
  access,
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
import { installBrandAssets } from './install-brand-assets.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtimeRoot = path.join(projectRoot, '.runtime')
const runtimeModules = path.join(runtimeRoot, 'node_modules')

const removableDirectories = new Set([
  '.github',
  '.storybook',
  '.vscode',
  'coverage'
])

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

function assertRuntimeTarget(target) {
  const relative = path.relative(projectRoot, path.resolve(target))
  if (relative !== '.runtime') {
    throw new Error(`Refusing to replace unexpected runtime directory: ${target}`)
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
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? projectRoot,
      env: options.env ?? process.env,
      stdio: 'inherit',
      windowsHide: true,
      shell: false
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new Error(
          `${path.basename(command)} failed (${signal ? `signal ${signal}` : `exit ${String(code)}`}).`
        )
      )
    })
  })
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
    await run(process.execPath, [npmCli, ...args], { cwd: runtimeRoot })
    return
  }
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: runtimeRoot })
}

async function applyRuntimePatches() {
  const patchPackageEntry = path.join(projectRoot, 'node_modules', 'patch-package', 'index.js')
  if (!(await pathExists(patchPackageEntry))) {
    throw new Error('patch-package is not installed in the development workspace.')
  }
  await cp(path.join(projectRoot, 'patches'), path.join(runtimeRoot, 'patches'), {
    recursive: true
  })
  await run(process.execPath, [patchPackageEntry], { cwd: runtimeRoot })
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
    path.join(runtimeModules, 'dshmarket', 'src'),
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
  if (await pathExists(nativeSharp)) {
    targets.push(path.join(runtimeModules, '@img', 'sharp-wasm32'))
  }

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

async function assertFile(relative) {
  const target = path.join(runtimeRoot, relative)
  const metadata = await stat(target).catch(() => undefined)
  if (!metadata?.isFile()) throw new Error(`Runtime staging is missing ${relative}.`)
}

async function main() {
  assertRuntimeTarget(runtimeRoot)
  await rm(runtimeRoot, { recursive: true, force: true })
  await mkdir(runtimeRoot, { recursive: true })

  const sourceManifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
  const runtimeManifest = {
    name: sourceManifest.name,
    version: sourceManifest.version,
    description: sourceManifest.description,
    private: true,
    type: sourceManifest.type,
    main: sourceManifest.main,
    desktopName: sourceManifest.desktopName,
    author: sourceManifest.author,
    license: sourceManifest.license,
    repository: sourceManifest.repository,
    bugs: sourceManifest.bugs,
    homepage: sourceManifest.homepage,
    keywords: sourceManifest.keywords,
    dependencies: { ...sourceManifest.dependencies },
    overrides: sourceManifest.overrides
  }
  await writeFile(
    path.join(runtimeRoot, 'package.json'),
    `${JSON.stringify(runtimeManifest, null, 2)}\n`,
    'utf8'
  )
  await copyFile(path.join(projectRoot, 'package-lock.json'), path.join(runtimeRoot, 'package-lock.json'))
  await mkdir(path.join(runtimeRoot, 'packages'), { recursive: true })
  await cp(
    path.join(projectRoot, 'packages', 'dsh-desktop-plugin-runtime'),
    path.join(runtimeRoot, 'packages', 'dsh-desktop-plugin-runtime'),
    { recursive: true }
  )

  await installProductionDependencies()
  await applyRuntimePatches()
  await installBrandAssets({ packageRoot: runtimeRoot, assetRoot: projectRoot })

  const localPackageVersion = await materializeLocalPackage('dsh-desktop-plugin-runtime')
  runtimeManifest.dependencies['dsh-desktop-plugin-runtime'] = localPackageVersion

  await cp(path.join(projectRoot, 'out'), path.join(runtimeRoot, 'out'), { recursive: true })
  const resources = path.join(runtimeRoot, 'resources')
  await mkdir(resources, { recursive: true })
  const runtimeAssets = [
    ['harness-node-entry.mjs', 'harness-node-entry.mjs'],
    ['runtime-module-fallback.mjs', 'runtime-module-fallback.mjs'],
    ['dsh-desktop.patch.yml', 'dsh-desktop.patch.yml'],
    ['splash.html', 'splash.html'],
    ['brand.png', 'brand.png'],
    ['plugin-recovery.html', 'plugin-recovery.html'],
    ['app-icon.png', 'icon.png']
  ]
  await Promise.all(
    runtimeAssets.map(([source, destination]) =>
      copyFile(path.join(projectRoot, 'build', source), path.join(resources, destination))
    )
  )

  await pruneNodePty()
  await prunePnpmPlatformBinaries()
  await pruneKnownPublishedBuildArtifacts()
  await removeMany([
    path.join(runtimeModules, '@mistralai', 'mistralai', 'src'),
    path.join(runtimeRoot, 'package-lock.json'),
    path.join(runtimeRoot, 'patches'),
    path.join(runtimeRoot, 'packages')
  ])
  const prunedFiles = await pruneGenericRuntimeFiles(runtimeModules)
  await writeFile(
    path.join(runtimeRoot, 'package.json'),
    `${JSON.stringify(runtimeManifest, null, 2)}\n`,
    'utf8'
  )

  for (const required of [
    'package.json',
    'out/main/index.js',
    'out/preload/index.cjs',
    'node_modules/@deepseek-ai/dsh/lib/bin.js',
    'node_modules/pnpm/bin/pnpm.cjs',
    'node_modules/dsh-desktop-plugin-runtime/index.js',
    'node_modules/dshmarket/lib/index.js',
    'node_modules/dshmarket/client/client.js',
    'resources/harness-node-entry.mjs',
    'resources/runtime-module-fallback.mjs',
    'resources/dsh-desktop.patch.yml',
    'resources/splash.html',
    'resources/brand.png',
    'resources/plugin-recovery.html',
    'resources/icon.png'
  ]) {
    await assertFile(required)
  }
  if (await pathExists(path.join(runtimeModules, 'node'))) {
    throw new Error('The staging directory still contains the redundant standalone Node runtime.')
  }

  const staged = await collectStats(runtimeRoot)
  console.log(
    `Runtime staging ready: ${staged.files.toLocaleString('en-US')} files, ${formatBytes(staged.bytes)} (${prunedFiles.toLocaleString('en-US')} generic files/directories pruned).`
  )
}

await main()
