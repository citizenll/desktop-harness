const path = require('node:path')
const stagedConfig = require('./electron-builder.staged.cjs')

module.exports = {
  ...stagedConfig,
  appId: 'io.dsh.desktop.dev',
  productName: 'DSH Desktop Dev',
  protocols: [],
  directories: {
    ...stagedConfig.directories,
    output: path.resolve(__dirname, 'dist-dev')
  },
  extraMetadata: {
    name: 'dsh-desktop-dev',
    productName: 'DSH Desktop Dev',
    dshDesktopChannel: 'development'
  },
  nsis: {
    ...stagedConfig.nsis,
    artifactName: 'dsh-desktop-dev-windows-${arch}-setup.${ext}'
  },
  win: {
    ...stagedConfig.win,
    extraResources: stagedConfig.win.extraResources.filter(
      (entry) => entry.to !== 'dsh-cli'
    )
  },
  publish: null
}
