import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const secretDirectory = path.join(root, '.core-secrets')
const privatePath = path.join(secretDirectory, 'core-update-private-key.pem')
const publicPath = path.join(root, 'build', 'core-update-public-key.pem')

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

await mkdir(secretDirectory, { recursive: true })
let privatePem
if (await exists(privatePath)) {
  privatePem = await readFile(privatePath, 'utf8')
  createPrivateKey(privatePem)
} else {
  const pair = generateKeyPairSync('ed25519')
  privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' })
  await writeFile(privatePath, privatePem, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
}
const publicPem = createPublicKey(privatePem).export({ type: 'spki', format: 'pem' })
await writeFile(publicPath, publicPem, 'utf8')
console.log(`Core update public key written to ${path.relative(root, publicPath)}.`)
console.log(`Private signing key retained at ignored path ${path.relative(root, privatePath)}.`)
