import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const command = args.find(value => value === 'add' || value === 'update' || value === 'remove')
const separator = args.lastIndexOf('--')
const operand = separator === -1 ? undefined : args[separator + 1]

if (command === undefined || operand === undefined) {
  process.stderr.write('fake-pnpm: unsupported argv\n')
  process.exit(2)
}
if (operand === 'fail') {
  process.stderr.write('fixture registry denied package\n')
  process.exit(7)
}

const profilePath = join(process.cwd(), 'package.json')
const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
profile.dependencies ??= {}

function installedPath(packageName) {
  return join(process.cwd(), 'node_modules', ...packageName.split('/'))
}

if (command === 'add') {
  const source = resolve(operand.replace(/^(?:file|link):/, ''))
  const sourceManifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  const packageName = sourceManifest.name
  const destination = installedPath(packageName)
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: true })
  profile.dependencies[packageName] = `file:${source}`
} else if (command === 'update') {
  if (!Object.hasOwn(profile.dependencies, operand)) {
    process.stderr.write('fake-pnpm: dependency is absent\n')
    process.exit(8)
  }
  const manifestPath = join(installedPath(operand), 'package.json')
  const installed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  installed.version = '9.9.9'
  writeFileSync(manifestPath, JSON.stringify(installed, undefined, 2) + '\n')
  profile.dependencies[operand] = '9.9.9'
} else {
  delete profile.dependencies[operand]
  rmSync(installedPath(operand), { recursive: true, force: true })
}

writeFileSync(profilePath, JSON.stringify(profile, undefined, 2) + '\n')
