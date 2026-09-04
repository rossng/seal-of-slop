import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  platform: 'browser',
  target: ['chrome111', 'firefox113', 'safari16.4'],
  dts: true,
  clean: true,
  // Consumers bundle and minify; shipping readable ESM keeps the package
  // debuggable and lets their minifier do the work once.
  minify: false,
})
