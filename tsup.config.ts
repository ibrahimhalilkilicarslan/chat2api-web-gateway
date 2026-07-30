import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/server/bootstrap.ts'],
  outDir: 'dist/server',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: false,
  minify: false,
  external: ['better-sqlite3'],
  esbuildOptions(options) {
    // Production bundles must not retain diagnostics that can expose prompts.
    options.drop = ['console', 'debugger']
  },
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
})
