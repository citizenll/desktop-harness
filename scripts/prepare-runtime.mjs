import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { coreDistributionRoot, prepareCoreRuntime, projectRoot } from './core-runtime-lib.mjs'

const runtimeRoot = path.join(projectRoot, '.runtime')

function assertRuntimeTarget() {
  const relative = path.relative(projectRoot, path.resolve(runtimeRoot)).replaceAll('\\', '/')
  if (relative !== '.runtime') {
    throw new Error(`Refusing to replace unexpected Host runtime directory: ${runtimeRoot}`)
  }
}

async function assertFile(relative) {
  const metadata = await stat(path.join(runtimeRoot, relative)).catch(() => undefined)
  if (!metadata?.isFile()) throw new Error(`Host staging is missing ${relative}.`)
}

async function stageHostRuntime() {
  assertRuntimeTarget()
  await rm(runtimeRoot, { recursive: true, force: true })
  await mkdir(runtimeRoot, { recursive: true })
  const source = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
  const manifest = {
    name: source.name,
    version: source.version,
    description: source.description,
    private: true,
    type: source.type,
    main: source.main,
    desktopName: source.desktopName,
    author: source.author,
    license: source.license,
    repository: source.repository,
    bugs: source.bugs,
    homepage: source.homepage,
    keywords: source.keywords
  }
  await writeFile(path.join(runtimeRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const lockfile = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: manifest.name,
        version: manifest.version,
        license: manifest.license
      }
    }
  }
  await writeFile(
    path.join(runtimeRoot, 'package-lock.json'),
    `${JSON.stringify(lockfile, null, 2)}\n`
  )
  await cp(path.join(projectRoot, 'out'), path.join(runtimeRoot, 'out'), { recursive: true })
  const resources = path.join(runtimeRoot, 'resources')
  await mkdir(resources, { recursive: true })
  const assets = [
    ['splash.html', 'splash.html'],
    ['brand.png', 'brand.png'],
    ['logo-light.png', 'logo-light.png'],
    ['logo-dark.png', 'logo-dark.png'],
    ['plugin-recovery.html', 'plugin-recovery.html'],
    ['app-icon.png', 'icon.png'],
    ['core-update-public-key.pem', 'core-update-public-key.pem']
  ]
  for (const [sourceName, destinationName] of assets) {
    await copyFile(path.join(projectRoot, 'build', sourceName), path.join(resources, destinationName))
  }
  for (const required of [
    'package.json',
    'package-lock.json',
    'out/main/index.js',
    'out/preload/index.cjs',
    'resources/splash.html',
    'resources/brand.png',
    'resources/logo-light.png',
    'resources/logo-dark.png',
    'resources/plugin-recovery.html',
    'resources/icon.png',
    'resources/core-update-public-key.pem'
  ]) {
    await assertFile(required)
  }
  const hostPackage = JSON.parse(await readFile(path.join(runtimeRoot, 'package.json'), 'utf8'))
  if ('dependencies' in hostPackage) {
    throw new Error('The Host staging manifest must not contain dependencies.')
  }
}

if (process.env.DSH_USE_PUBLISHED_CORE_BASELINE !== '1') {
  await prepareCoreRuntime()
}
await stageHostRuntime()
const [coreRelease, baselineManifest, runnerManifest] = await Promise.all([
  readFile(path.join(projectRoot, 'core', 'core-release.json'), 'utf8').then((text) => JSON.parse(text)),
  readFile(path.join(coreDistributionRoot, 'core-baseline', 'manifest.json'), 'utf8').then((text) => JSON.parse(text)),
  readFile(path.join(coreDistributionRoot, 'core-runner', 'runner.json'), 'utf8').then((text) => JSON.parse(text))
])
if (
  baselineManifest.core?.generation !== coreRelease.generation ||
  baselineManifest.core?.platform !== process.platform ||
  baselineManifest.core?.arch !== process.arch ||
  baselineManifest.core?.runnerVersion !== runnerManifest.version ||
  baselineManifest.core?.runnerAbi !== runnerManifest.abi
) {
  throw new Error('Prepared Core baseline does not match the declared generation and Core Runner.')
}
for (const relative of [
  'core-runner/runner.json',
  `core-runner/${process.platform === 'win32' ? 'node.exe' : 'node'}`,
  'core-baseline/manifest.json'
]) {
  const metadata = await stat(path.join(coreDistributionRoot, relative)).catch(() => undefined)
  if (!metadata?.isFile()) throw new Error(`Core distribution is missing ${relative}.`)
}
console.log('Host staging ready without a bundled DSH dependency tree.')
