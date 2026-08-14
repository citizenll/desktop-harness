import { defineConfig } from 'tsdown'

/**
 * The dsh CLI ships the `bin` plus the shared profile launcher consumed by the
 * Electron app. Declarations come from `tsc -b` (dts: false), matching every
 * package.
 */
export default defineConfig({
  entry: ['lib/types/bin.js', 'lib/types/profile-boot.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
