import { defineConfig } from 'tsdown'

/** Keep the pinned pnpm distribution deployable as data instead of bundling its full CLI graph. */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    skipNodeModulesBundle: true,
  },
})
