import { listPackage } from '@electron/asar'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

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
const required = [
  '/out/main/index.js',
  '/out/preload/index.cjs',
  '/node_modules/@deepseek-ai/dsh/lib/bin.js',
  '/node_modules/pnpm/bin/pnpm.cjs',
  '/node_modules/dsh-desktop-plugin-runtime/index.js',
  '/node_modules/dshmarket/lib/index.js',
  '/node_modules/dshmarket/client/client.js',
  '/resources/harness-node-entry.mjs',
  '/resources/runtime-module-fallback.mjs',
  '/resources/dsh-desktop.patch.yml',
  '/resources/splash.html',
  '/resources/brand.png',
  '/resources/plugin-recovery.html',
  '/resources/icon.png'
]
for (const entry of required) {
  if (!entrySet.has(entry)) throw new Error(`Packaged runtime is missing ${entry}.`)
}

const forbidden = entries.filter(
  (entry) =>
    entry.startsWith('/node_modules/node/') ||
    entry === '/node_modules/node' ||
    entry.startsWith('/node_modules/@img/sharp-wasm32/') ||
    entry.startsWith('/node_modules/@mixmark-io/domino/test/') ||
    entry.startsWith('/node_modules/dsh-desktop-market-installer/') ||
    entry === '/node_modules/dsh-desktop-market-installer' ||
    entry.startsWith('/node_modules/dshmarket/src/') ||
    entry === '/node_modules/dshmarket/src' ||
    entry.startsWith('/node_modules/openai/src/') ||
    entry.startsWith('/node_modules/zod/src/') ||
    entry.startsWith('/packages/') ||
    entry.startsWith('/patches/') ||
    entry === '/package-lock.json' ||
    /\.(?:d\.(?:ts|mts|cts)|map|pdb|tsbuildinfo)$/iu.test(entry) ||
    /\/(?:coverage|\.github|\.storybook|\.vscode)(?:\/|$)/iu.test(entry) ||
    /\/(?:readme|changelog|history|contributing|security|code_of_conduct|governance|news|release-notes)(?:\.[^/]+)?\.md$/iu.test(
      entry
    )
)
if (forbidden.length > 0) {
  throw new Error(`Packaged runtime contains non-runtime files, starting with ${forbidden[0]}.`)
}

const archiveStats = await stat(archive)
const unpackedRoot = `${archive}.unpacked`
const unpacked = await collectStats(unpackedRoot)
if (unpacked.files > 500) {
  throw new Error(
    `Packaged runtime has ${unpacked.files.toLocaleString('en-US')} loose app files; expected at most 500.`
  )
}

const resourcesRoot = path.dirname(archive)
const applicationRoot = path.dirname(resourcesRoot)
const installed = await collectStats(applicationRoot)
console.log(`Verified packaged runtime: ${path.relative(process.cwd(), archive)}`)
console.log(
  `app.asar ${formatBytes(archiveStats.size)}; native unpack ${unpacked.files.toLocaleString('en-US')} files / ${formatBytes(unpacked.bytes)}; installed image ${installed.files.toLocaleString('en-US')} files / ${formatBytes(installed.bytes)}.`
)
