import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { deepStrictEqual } from 'node:assert'
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import path from 'node:path'
import { extract } from 'tar'
import {
  coreDistributionRoot,
  coreTarget,
  prepareCoreRunnerDistribution,
  projectRoot
} from './core-runtime-lib.mjs'
import { verifyCoreChannelEnvelope } from './core-channel-verifier.mjs'

const release = JSON.parse(
  await readFile(path.join(projectRoot, 'core', 'core-release.json'), 'utf8')
)
if (release.schemaVersion !== 1 || !Number.isSafeInteger(release.generation) || release.generation < 1) {
  throw new Error('core/core-release.json is invalid.')
}

const tag = `core-g${release.generation}`
const archiveName = `dsh-core-g${release.generation}-${coreTarget}.tar.gz`
const artifactName = `artifact-${coreTarget}.json`
const downloadRoot = path.join(projectRoot, '.core-runtime', 'published', coreTarget)
const baselineRoot = path.join(coreDistributionRoot, 'core-baseline')
await rm(downloadRoot, { recursive: true, force: true })
await mkdir(downloadRoot, { recursive: true })

async function downloadAsset(pattern) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === 'win32' ? 'gh.exe' : 'gh',
      [
        'release',
        'download',
        tag,
        '--repo',
        'citizenll/desktop-harness',
        '--pattern',
        pattern,
        '--dir',
        downloadRoot
      ],
      { stdio: 'inherit', windowsHide: true, shell: false }
    )
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`gh release download failed (${signal ? `signal ${signal}` : `exit ${code}`}).`))
    })
  })
}

await downloadAsset('channel.json')
await downloadAsset(artifactName)
await downloadAsset(archiveName)

const publicPem = await readFile(path.join(projectRoot, 'build', 'core-update-public-key.pem'), 'utf8')
const channel = verifyCoreChannelEnvelope(
  JSON.parse(await readFile(path.join(downloadRoot, 'channel.json'), 'utf8')),
  publicPem
)
if (channel.generation !== release.generation) {
  throw new Error(`Published Core channel generation ${channel.generation} does not match ${release.generation}.`)
}
const signedArtifact = channel.artifacts[coreTarget]
if (!signedArtifact) throw new Error(`Published Core generation has no ${coreTarget} artifact.`)
const expectedUrl =
  `https://github.com/citizenll/desktop-harness/releases/download/${tag}/${archiveName}`
if (signedArtifact.archive?.url !== expectedUrl) {
  throw new Error('Published Core channel contains an unexpected archive URL.')
}

const artifact = JSON.parse(await readFile(path.join(downloadRoot, artifactName), 'utf8'))
const { url: _signedUrl, ...signedArchive } = signedArtifact.archive
deepStrictEqual(artifact, { core: signedArtifact.core, archive: signedArchive })
if (
  artifact.archive?.format !== 'tar.gz' ||
  artifact.archive.fileName !== archiveName ||
  artifact.core?.generation !== release.generation ||
  artifact.core?.coreId !== `dsh-core-g${release.generation}-${coreTarget}` ||
  `${artifact.core?.platform}-${artifact.core?.arch}` !== coreTarget
) {
  throw new Error('Published Core artifact metadata is invalid for this target.')
}

const archivePath = path.join(downloadRoot, archiveName)
const archiveBytes = await readFile(archivePath)
if (
  archiveBytes.byteLength !== artifact.archive.size ||
  createHash('sha256').update(archiveBytes).digest('hex') !== artifact.archive.sha256
) {
  throw new Error('Published Core archive bytes do not match the signed channel.')
}
const inspectionRoot = path.join(downloadRoot, 'inspection')
await mkdir(inspectionRoot, { recursive: true })
await extract(
  { cwd: inspectionRoot, file: archivePath, gzip: true, strict: true, preservePaths: false },
  ['core.json']
)
deepStrictEqual(
  JSON.parse(await readFile(path.join(inspectionRoot, 'core.json'), 'utf8')),
  artifact.core
)

const runner = await prepareCoreRunnerDistribution()
if (
  runner.version !== artifact.core.runnerVersion ||
  runner.abi !== artifact.core.runnerAbi ||
  runner.platform !== artifact.core.platform ||
  runner.arch !== artifact.core.arch
) {
  throw new Error('Published Core is incompatible with the Desktop Core Runner.')
}

await rm(baselineRoot, { recursive: true, force: true })
await mkdir(baselineRoot, { recursive: true })
await copyFile(archivePath, path.join(baselineRoot, archiveName))
await writeFile(path.join(baselineRoot, 'manifest.json'), `${JSON.stringify(artifact, null, 2)}\n`)
await rm(downloadRoot, { recursive: true, force: true })
console.log(`Prepared immutable published Core baseline ${tag} for ${coreTarget}.`)
