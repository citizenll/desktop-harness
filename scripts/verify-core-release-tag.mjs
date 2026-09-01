import { readFile } from 'node:fs/promises'

const release = JSON.parse(await readFile(new URL('../core/core-release.json', import.meta.url), 'utf8'))
const expected = `core-g${release.generation}`
const actual = process.env.GITHUB_REF_NAME ?? process.argv[2]
if (actual !== expected) {
  throw new Error(`Core release tag ${actual ?? '(missing)'} does not match ${expected}.`)
}
console.log(`Core release tag ${expected} matches the governed generation.`)
