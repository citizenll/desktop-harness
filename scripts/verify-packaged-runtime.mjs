import { listPackage } from '@electron/asar'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { list as listTar } from 'tar'

const outputRoot = path.resolve(process.argv[2] ?? 'dist')

async function findArchives(root) {
  const archives = []
  const stack = [root]
  while (stack.length > 0) {
    const directory = stack.pop()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) stack.push(target)
      else if (
        entry.isFile() &&
        entry.name === 'app.asar' &&
        path.basename(directory).toLowerCase() === 'resources'
      ) {
        archives.push({ path: target, modified: (await stat(target)).mtimeMs })
      }
    }
  }
  return archives.sort((left, right) => right.modified - left.modified)
}

async function collectStats(root) {
  let files = 0
  let bytes = 0
  const stack = [root]
  while (stack.length > 0) {
    const directory = stack.pop()
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
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

async function sha256File(target) {
  const hash = createHash('sha256')
  let size = 0
  await new Promise((resolve, reject) => {
    const stream = createReadStream(target)
    stream.on('data', (chunk) => {
      size += chunk.length
      hash.update(chunk)
    })
    stream.once('error', reject)
    stream.once('end', resolve)
  })
  return { size, sha256: hash.digest('hex') }
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

const archives = await findArchives(outputRoot)
if (archives.length === 0) {
  throw new Error(`No packaged resources/app.asar was found below ${outputRoot}.`)
}

const archive = archives[0].path
const entries = listPackage(archive, { isPack: false }).map((entry) =>
  `/${entry.replaceAll('\\', '/').replace(/^\/+/, '')}`
)
const entrySet = new Set(entries)
for (const required of [
  '/out/main/index.js',
  '/out/preload/index.cjs',
  '/resources/splash.html',
  '/resources/brand.png',
  '/resources/logo-light.png',
  '/resources/logo-dark.png',
  '/resources/plugin-recovery.html',
  '/resources/icon.png',
  '/resources/core-update-public-key.pem'
]) {
  if (!entrySet.has(required)) throw new Error(`Packaged Host is missing ${required}.`)
}

const forbiddenHostEntry = entries.find(
  (entry) =>
    entry === '/node_modules' ||
    entry.startsWith('/node_modules/') ||
    entry.startsWith('/packages/') ||
    entry.startsWith('/patches/') ||
    entry === '/package-lock.json' ||
    entry.endsWith('/harness-node-entry.mjs') ||
    entry.endsWith('/runtime-module-fallback.mjs') ||
    entry.endsWith('/dsh-desktop.patch.yml')
)
if (forbiddenHostEntry) {
  throw new Error(`Packaged Host contains Core-owned content: ${forbiddenHostEntry}.`)
}

const resourcesRoot = path.dirname(archive)
const runnerRoot = path.join(resourcesRoot, 'core-runner')
const runnerExecutable = path.join(runnerRoot, process.platform === 'win32' ? 'node.exe' : 'node')
const runnerMetadata = JSON.parse(await readFile(path.join(runnerRoot, 'runner.json'), 'utf8'))
if (
  runnerMetadata.schemaVersion !== 1 ||
  runnerMetadata.platform !== process.platform ||
  runnerMetadata.arch !== process.arch ||
  typeof runnerMetadata.abi !== 'string'
) {
  throw new Error('Packaged Core Runner metadata does not match the target.')
}
if (!(await stat(runnerExecutable)).isFile()) {
  throw new Error('Packaged Core Runner executable is missing.')
}

const baselineRoot = path.join(resourcesRoot, 'core-baseline')
const baseline = JSON.parse(await readFile(path.join(baselineRoot, 'manifest.json'), 'utf8'))
if (
  baseline.core?.platform !== process.platform ||
  baseline.core?.arch !== process.arch ||
  baseline.core?.runnerAbi !== runnerMetadata.abi ||
  baseline.archive?.format !== 'tar.gz' ||
  baseline.archive?.url !== undefined
) {
  throw new Error('Packaged Core baseline manifest is incompatible with the Runner.')
}
const baselineArchive = path.join(baselineRoot, baseline.archive.fileName)
const baselineDigest = await sha256File(baselineArchive)
if (
  baselineDigest.size !== baseline.archive.size ||
  baselineDigest.sha256 !== baseline.archive.sha256
) {
  throw new Error('Packaged Core baseline archive does not match its manifest.')
}
const baselineEntries = new Set()
await listTar({
  file: baselineArchive,
  gzip: true,
  strict: true,
  onentry: (entry) => baselineEntries.add(entry.path.replaceAll('\\', '/').replace(/\/$/u, ''))
})
for (const required of [
  'core.json',
  'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
  'runtime/node_modules/pnpm/bin/pnpm.cjs',
  'runtime/node_modules/dsh-desktop-market/lib/index.js',
  'runtime/node_modules/dsh-desktop-market/client/client.js',
  'runtime/node_modules/dsh-desktop-plugin-runtime/index.js',
  'runtime/node_modules/dsh-desktop-verifier/lib/index.js',
  'runtime/node_modules/dsh-desktop-verifier/client/client.js',
  'runtime/resources/harness-node-entry.mjs',
  'runtime/resources/runtime-module-fallback.mjs',
  'runtime/resources/dsh-desktop.patch.yml'
]) {
  if (!baselineEntries.has(required)) throw new Error(`Core baseline is missing ${required}.`)
}

const archiveStats = await stat(archive)
const unpacked = await collectStats(`${archive}.unpacked`)
if (unpacked.files > 20) {
  throw new Error(`Packaged Host has ${unpacked.files} loose app files; expected at most 20.`)
}

if (process.platform === 'win32' && path.basename(outputRoot).toLowerCase() === 'dist') {
  for (const file of ['dsh.cmd', 'dsh.ps1', 'dsh-path.ps1']) {
    const target = path.join(resourcesRoot, 'dsh-cli', file)
    const metadata = await stat(target).catch(() => undefined)
    if (!metadata?.isFile()) {
      throw new Error(`Packaged Windows runtime is missing resources/dsh-cli/${file}.`)
    }
  }
  const launcher = await readFile(path.join(resourcesRoot, 'dsh-cli', 'dsh.ps1'), 'utf8')
  for (const marker of [
    'dsh-desktop://plugin/install?source=',
    'Remove-Item Env:NODE_OPTIONS',
    'Remove-Item Env:ELECTRON_RUN_AS_NODE'
  ]) {
    if (!launcher.includes(marker)) {
      throw new Error(`Packaged Windows dsh launcher is missing: ${marker}`)
    }
  }
}

const applicationRoot = path.dirname(resourcesRoot)
const installed = await collectStats(applicationRoot)
console.log(`Verified packaged Host: ${path.relative(process.cwd(), archive)}`)
console.log(
  `app.asar ${formatBytes(archiveStats.size)}; Core baseline ${formatBytes(baselineDigest.size)}; native unpack ${unpacked.files} files / ${formatBytes(unpacked.bytes)}; installed image ${installed.files.toLocaleString('en-US')} files / ${formatBytes(installed.bytes)}.`
)
