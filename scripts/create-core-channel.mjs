import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extract } from 'tar'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const inputRoot = path.resolve(process.argv[2] ?? path.join(root, 'core-artifacts'))
const outputPath = path.resolve(process.argv[3] ?? path.join(inputRoot, 'channel.json'))
const targets = ['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64']
const privatePem = process.env.CORE_UPDATE_PRIVATE_KEY
if (!privatePem) throw new Error('CORE_UPDATE_PRIVATE_KEY is required to sign the stable Core channel.')
const privateKey = createPrivateKey(privatePem)
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Core channel key must be Ed25519.')
const publicKey = createPublicKey(privateKey)
const trustedPublicPem = await readFile(path.join(root, 'build', 'core-update-public-key.pem'), 'utf8')
const generatedPublicDer = publicKey.export({ type: 'spki', format: 'der' })
const trustedPublicDer = createPublicKey(trustedPublicPem).export({ type: 'spki', format: 'der' })
if (!Buffer.from(generatedPublicDer).equals(Buffer.from(trustedPublicDer))) {
  throw new Error('CORE_UPDATE_PRIVATE_KEY does not match the public key embedded in Desktop.')
}
const keyId = createHash('sha256')
  .update(generatedPublicDer)
  .digest('hex')
  .slice(0, 32)
const releasePath = path.resolve(
  process.env.CORE_RELEASE_FILE ?? path.join(root, 'core', 'core-release.json')
)
const release = JSON.parse(await readFile(releasePath, 'utf8'))
if (release.schemaVersion !== 1 || !Number.isSafeInteger(release.generation) || release.generation < 1) {
  throw new Error('core/core-release.json is invalid.')
}
const artifacts = {}
let sharedCore
for (const target of targets) {
  const artifact = JSON.parse(await readFile(path.join(inputRoot, target, 'artifact.json'), 'utf8'))
  if (artifact.core.generation !== release.generation) {
    throw new Error(`${target} does not match Core generation ${release.generation}.`)
  }
  if (`${artifact.core.platform}-${artifact.core.arch}` !== target) {
    throw new Error(`${target} contains a Core descriptor for another target.`)
  }
  const expectedCoreId =
    `dsh-core-g${release.generation}-${artifact.core.platform}-${artifact.core.arch}`
  if (artifact.core.coreId !== expectedCoreId) {
    throw new Error(`${target} contains an invalid immutable Core id.`)
  }
  const expectedFileName = `dsh-core-g${release.generation}-${artifact.core.platform}-${artifact.core.arch}.tar.gz`
  if (artifact.archive?.format !== 'tar.gz' || artifact.archive.fileName !== expectedFileName) {
    throw new Error(`${target} contains an invalid Core archive descriptor.`)
  }
  if (artifact.archive.url !== undefined) {
    throw new Error(`${target} artifact metadata must be immutable before channel publication.`)
  }
  const archiveBytes = await readFile(path.join(inputRoot, target, expectedFileName))
  const archiveHash = createHash('sha256').update(archiveBytes).digest('hex')
  if (archiveBytes.byteLength !== artifact.archive.size || archiveHash !== artifact.archive.sha256) {
    throw new Error(`${target} archive bytes do not match artifact.json.`)
  }
  const inspectionRoot = await mkdtemp(path.join(tmpdir(), 'dsh-core-channel-'))
  try {
    await extract({
      cwd: inspectionRoot,
      file: path.join(inputRoot, target, expectedFileName),
      gzip: true,
      strict: true,
      preservePaths: false
    }, ['core.json'])
    const archivedCore = JSON.parse(await readFile(path.join(inspectionRoot, 'core.json'), 'utf8'))
    for (const field of [
      'schemaVersion',
      'generation',
      'coreId',
      'dshVersion',
      'patchsetHash',
      'desktopProtocol',
      'runnerVersion',
      'runnerAbi',
      'dataSchema',
      'platform',
      'arch'
    ]) {
      if (archivedCore[field] !== artifact.core[field]) {
        throw new Error(`${target} archive core.json does not match artifact.json.`)
      }
    }
  } finally {
    await rm(inspectionRoot, { recursive: true, force: true })
  }
  const shared = {
    dshVersion: artifact.core.dshVersion,
    patchsetHash: artifact.core.patchsetHash,
    desktopProtocol: artifact.core.desktopProtocol,
    runnerVersion: artifact.core.runnerVersion,
    runnerAbi: artifact.core.runnerAbi,
    dataSchema: artifact.core.dataSchema
  }
  if (sharedCore === undefined) sharedCore = shared
  else if (JSON.stringify(sharedCore) !== JSON.stringify(shared)) {
    throw new Error(`${target} does not belong to the same governed Core release train.`)
  }
  artifact.archive.url = `https://github.com/citizenll/desktop-harness/releases/download/core-g${release.generation}/${artifact.archive.fileName}`
  artifacts[target] = artifact
}
const publishedAt = new Date()
const expiresAt = new Date(publishedAt.getTime() + 14 * 24 * 60 * 60 * 1000)
const payload = {
  schemaVersion: 1,
  channel: 'stable',
  generation: release.generation,
  publishedAt: publishedAt.toISOString(),
  expiresAt: expiresAt.toISOString(),
  releaseNotes: release.releaseNotes,
  artifacts
}
const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8')
const envelope = {
  keyId,
  payload: payloadBytes.toString('base64url'),
  signature: sign(null, payloadBytes, privateKey).toString('base64url')
}
await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
console.log(`Signed stable Core channel generation ${release.generation}.`)
