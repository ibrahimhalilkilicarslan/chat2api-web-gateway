import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []

function fail(message) {
  failures.push(message)
}

const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const dependencyNames = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.devDependencies ?? {}),
])
for (const prohibited of [
  'electron',
  'electron-builder',
  'electron-vite',
  'koa',
  '@koa/router',
  'cors',
]) {
  if (dependencyNames.has(prohibited)) fail(`prohibited dependency remains: ${prohibited}`)
}

for (const prohibitedPath of [
  'src/renderer',
  'src/preload',
  'src/main/oauth',
  'src/main/proxy/server.ts',
  'electron.vite.config.ts',
  'vite.renderer.config.ts',
]) {
  const absolutePath = resolve(root, prohibitedPath)
  if (!existsSync(absolutePath)) continue

  const isObsoleteDirectory = !prohibitedPath.includes('.')
    && readdirSync(absolutePath, { recursive: true, withFileTypes: true })
      .some((entry) => entry.isFile() || entry.isSymbolicLink())
  if (prohibitedPath.includes('.') || isObsoleteDirectory) {
    fail(`obsolete runtime surface remains: ${prohibitedPath}`)
  }
}

const serverSource = [
  'src/server/security/api-auth.ts',
  'src/server/schemas/chat.ts',
  'src/core/config.ts',
  'src/server/app.ts',
  'src/main/store/store.ts',
  'tsup.config.ts',
].map((path) => readFileSync(resolve(root, path), 'utf8')).join('\n')

if (!serverSource.includes("options.drop = ['console', 'debugger']")) {
  fail('production build does not strip legacy console diagnostics')
}
if (!serverSource.includes('includeBodies: false')) {
  fail('request body persistence is not forced off')
}
if (!serverSource.includes("provider.type !== 'builtin'")) {
  fail('custom provider fail-closed guard is missing')
}
if (!serverSource.includes('Only base64-encoded PNG, JPEG, WebP, or GIF images are accepted')) {
  fail('remote media URL rejection is missing')
}
if (serverSource.includes('CHAT2API_ALLOW_REMOTE_MEDIA')) {
  fail('remote media URL opt-in must not be available')
}
if (!serverSource.includes("value === false || value === 'false'")) {
  fail('bounded reverse-proxy trust parser is missing')
}
if (/request\.(?:query|params).{0,80}(?:api.?key|token)/is.test(
  readFileSync(resolve(root, 'src/server/security/api-auth.ts'), 'utf8'),
)) {
  fail('API credentials may be accepted outside the Authorization header')
}

const bundlePath = resolve(root, 'dist/server/bootstrap.js')
if (existsSync(bundlePath)) {
  const bundle = readFileSync(bundlePath, 'utf8')
  for (const marker of [
    'Account credentials:',
    'Request payload:',
    'Request headers:',
    'Raw stream data:',
    'Token response:',
    'Electron',
    '@koa/router',
    'noVNC',
    'websockify',
  ]) {
    if (bundle.includes(marker)) fail(`unsafe production bundle marker remains: ${marker}`)
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.map((failure) => `- ${failure}`).join('\n')}\n`)
  process.exit(1)
}

process.stdout.write('Security guard passed.\n')
