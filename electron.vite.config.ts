import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      minify: true,
      sourcemap: false,
      rollupOptions: {
        output: {
          inlineDynamicImports: true
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      minify: true,
      sourcemap: false,
      rollupOptions: {
        output: {
          format: 'cjs',
          inlineDynamicImports: true,
          entryFileNames: '[name].cjs'
        }
      }
    }
  }
})
