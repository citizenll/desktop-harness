const path = require('node:path')
const packageJson = require('./package.json')
const electronPackage = require('./node_modules/electron/package.json')

const projectRoot = __dirname
const build = packageJson.build
const { app: _sourceAppDirectory, ...buildDirectories } = build.directories

const fromProjectRoot = (value) => path.resolve(projectRoot, value)
const absoluteExtraResources = (entries = []) =>
  entries.map((entry) => ({ ...entry, from: fromProjectRoot(entry.from) }))

module.exports = {
  ...build,
  electronVersion: electronPackage.version,
  directories: {
    ...buildDirectories,
    output: fromProjectRoot(build.directories.output),
    buildResources: fromProjectRoot(build.directories.buildResources)
  },
  mac: {
    ...build.mac,
    icon: fromProjectRoot(build.mac.icon),
    extraResources: absoluteExtraResources(build.mac.extraResources)
  },
  win: {
    ...build.win,
    icon: fromProjectRoot(build.win.icon),
    extraResources: absoluteExtraResources(build.win.extraResources)
  },
  linux: {
    ...build.linux,
    icon: fromProjectRoot(build.linux.icon),
    extraResources: absoluteExtraResources(build.linux.extraResources)
  },
  nsis: {
    ...build.nsis,
    include: fromProjectRoot(build.nsis.include)
  }
}
