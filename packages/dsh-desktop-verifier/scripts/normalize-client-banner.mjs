import fs from 'node:fs'
import { sortClassMaps } from './sort-class-maps.mjs'

const file = 'client/client.js'
const name = JSON.parse(fs.readFileSync('package.json', 'utf8')).name
const required = `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {`

let code = fs.readFileSync(file, 'utf8')
if (!code.startsWith(required)) {
  const lines = code.split('\n')
  const head = [
    'window.__ModuleLoader__.load({',
    `\tid: ${JSON.stringify(name)},`,
    '\tfactory: (require) => {',
  ]
  if (lines[0] !== head[0] || lines[1] !== head[1] || lines[2] !== head[2]) {
    throw new Error(`Unexpected ${file} loader banner.`)
  }
  lines[0] = required
  lines[1] = ''
  lines[2] = ''
  code = lines.join('\n')
}

const root = process.cwd().replaceAll('\\', '/')
code = code.replace(/(dsh-css:)([^\n"]*?)(src[/\\][^\n"]*?\.css\.mjs)/g, (_all, prefix, _dir, rel) =>
  prefix + rel.replaceAll('\\', '/'))
if (code.includes(root) || /dsh-css:(?:\/|[A-Za-z]:[/\\])[^\n"]*/.test(code)) {
  throw new Error(`Absolute build path left in ${file}.`)
}

code = sortClassMaps(code).code
fs.writeFileSync(file, code)
