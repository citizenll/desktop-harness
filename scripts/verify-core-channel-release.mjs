import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyCoreChannelEnvelope } from './core-channel-verifier.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const inputPath = path.resolve(process.argv[2] ?? '')
const outputPath = path.resolve(process.argv[3] ?? '')
if (!process.argv[2] || !process.argv[3]) {
  throw new Error('Usage: node scripts/verify-core-channel-release.mjs <channel.json> <release.json>')
}

const envelope = JSON.parse(await readFile(inputPath, 'utf8'))
const publicPem = await readFile(path.join(root, 'build', 'core-update-public-key.pem'), 'utf8')
const payload = verifyCoreChannelEnvelope(envelope, publicPem)

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(
  outputPath,
  `${JSON.stringify({
    schemaVersion: 1,
    generation: payload.generation,
    releaseNotes: payload.releaseNotes
  }, null, 2)}\n`,
  'utf8'
)
console.log(`Verified stable Core generation ${payload.generation}.`)
