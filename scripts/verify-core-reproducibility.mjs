import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  coreDistributionRoot,
  packageStagedCore
} from './core-runtime-lib.mjs'

const artifactPath = path.join(coreDistributionRoot, 'core-release', 'artifact.json')
const before = JSON.parse(await readFile(artifactPath, 'utf8'))
await packageStagedCore()
const after = JSON.parse(await readFile(artifactPath, 'utf8'))

if (JSON.stringify(after) !== JSON.stringify(before)) {
  throw new Error(
    `Rebuilding Core generation ${before.core?.generation ?? 'unknown'} did not produce identical bytes.`
  )
}

console.log(`Core generation ${after.core.generation} is reproducible (${after.archive.sha256}).`)
