import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

const id = 'dsh-desktop-verifier'
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@deepseek-ai/dsh-client-ui-primitives',
]
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'client',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: false,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  noExternal: (source: string) => (CLIENT_EXTERNALS.includes(source) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  plugins: [{
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const absolute = importer === undefined ? source : resolvePath(dirname(importer), source)
      return CSS_VIRTUAL_PREFIX + absolute + CSS_VIRTUAL_SUFFIX
    },
    async load(this: { addWatchFile(file: string): void }, virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
        targets: { chrome: 90 << 16, firefox: 100 << 16, safari: 13 << 16, edge: 90 << 16 },
      })
      const classMap: Record<string, string> = {}
      for (const [local, value] of Object.entries(cssExports ?? {})) classMap[local] = value.name
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(id)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
