import { build } from 'esbuild'

await build({
  entryPoints: ['src/server/bootstrap.ts'],
  outfile: 'dist/server/bootstrap.js',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  bundle: true,
  splitting: false,
  sourcemap: false,
  minify: false,
  external: ['better-sqlite3'],
  drop: ['console', 'debugger'],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
})
