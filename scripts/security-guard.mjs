import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []

function fail(message) {
  failures.push(message)
}

const prohibitedAgentDirectories = ['.codex', '.claude', '.agents']
if (existsSync(resolve(root, '.git'))) {
  const trackedPaths = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0').filter(Boolean)

  for (const prohibitedDirectory of prohibitedAgentDirectories) {
    const prohibitedPrefix = `${prohibitedDirectory}/`
    const tracked = trackedPaths.find(
      (path) => path.startsWith(prohibitedPrefix) && existsSync(resolve(root, path)),
    )
    if (tracked) fail(`local agent configuration is tracked: ${tracked}`)
  }
} else {
  // Docker build contexts intentionally omit .git, so inspect what was copied.
  for (const prohibitedDirectory of prohibitedAgentDirectories) {
    const absolutePath = resolve(root, prohibitedDirectory)
    if (
      existsSync(absolutePath)
      && readdirSync(absolutePath, { recursive: true, withFileTypes: true })
        .some((entry) => entry.isFile() || entry.isSymbolicLink())
    ) {
      fail(`local agent configuration is present in build context: ${prohibitedDirectory}`)
    }
  }
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
  'scripts/build-server.mjs',
].map((path) => readFileSync(resolve(root, path), 'utf8')).join('\n')
const storeSource = readFileSync(resolve(root, 'src/main/store/store.ts'), 'utf8')
const databaseSource = readFileSync(resolve(root, 'src/core/storage/database.ts'), 'utf8')
const chatSchemaSource = readFileSync(resolve(root, 'src/server/schemas/chat.ts'), 'utf8')

if (!serverSource.includes("drop: ['console', 'debugger']")) {
  fail('production build does not strip legacy console diagnostics')
}
for (const persistedBodyMarker of [
  'request_body',
  'response_body',
  'requestBody',
  'responseBody',
  'prompt_text',
]) {
  if (storeSource.includes(persistedBodyMarker) || databaseSource.includes(persistedBodyMarker)) {
    fail(`request content persistence surface remains: ${persistedBodyMarker}`)
  }
}
if (!serverSource.includes("provider.type !== 'builtin'")) {
  fail('custom provider fail-closed guard is missing')
}
if (!/const textContent = z\.string\(\)[\s\S]{0,160}\.min\(1\)/.test(chatSchemaSource)) {
  fail('bounded text chat input contract is missing')
}
for (const requiredMediaGuard of [
  'ALLOWED_MEDIA_DATA_URL',
  'MAX_MEDIA_PARTS_PER_MESSAGE',
  "type: z.literal('image_url')",
  "type: z.literal('file')",
  'Only inline PNG, JPEG, WebP, and PDF data URLs are supported.',
]) {
  if (!chatSchemaSource.includes(requiredMediaGuard)) {
    fail(`bounded inline-media schema guard is missing: ${requiredMediaGuard}`)
  }
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

const deepSeekAdapter = readFileSync(
  resolve(root, 'src/main/proxy/adapters/deepseek.ts'),
  'utf8',
)
const deepSeekWebProtocol = readFileSync(
  resolve(root, 'src/main/providers/deepseek-web.ts'),
  'utf8',
)
if (deepSeekAdapter.includes('console.')) {
  fail('DeepSeek adapter contains runtime console diagnostics')
}
if (!deepSeekAdapter.includes("return provider.id === 'deepseek'")) {
  fail('DeepSeek web adapter provider guard is missing')
}
if (deepSeekAdapter.includes('sessionCache')) {
  fail('DeepSeek requests may reuse an upstream conversation session')
}
if (
  !deepSeekAdapter.includes('DEEPSEEK_WEB_API_BASE')
  || !deepSeekWebProtocol.includes(
    "export const DEEPSEEK_WEB_API_BASE = 'https://chat.deepseek.com/api'",
  )
) {
  fail('DeepSeek adapter no longer uses the fixed code-owned API base')
}
for (const requiredUploadGuard of [
  "const UPLOAD_FILE_PATH = '/v0/file/upload_file'",
  "const FETCH_FILES_PATH = '/v0/file/fetch_files'",
  "const UPLOAD_FILE_TARGET_PATH = '/api/v0/file/upload_file'",
  'assertMediaMagicBytes',
  'MAX_MEDIA_FILE_BYTES',
  'MAX_MEDIA_TOTAL_BYTES',
  'ref_file_ids: refFileIds',
]) {
  if (!deepSeekAdapter.includes(requiredUploadGuard)) {
    fail(`DeepSeek inline-media upload guard is missing: ${requiredUploadGuard}`)
  }
}
const storeTypes = readFileSync(resolve(root, 'src/main/store/types.ts'), 'utf8')
if (storeTypes.includes('apiEndpoint') || storeTypes.includes('chatPath')) {
  fail('provider endpoint configuration is exposed through the persistent store model')
}
if (databaseSource.includes('CREATE TABLE sessions')) {
  fail('new databases still create the obsolete upstream session table')
}

const providerIndex = readFileSync(
  resolve(root, 'src/main/providers/builtin/index.ts'),
  'utf8',
)
const providerModuleImports = [...providerIndex.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)]
  .map((match) => match[1])
if (
  providerModuleImports.length !== 1
  || providerModuleImports[0] !== 'deepseek.ts'
  || !/builtinProviders:[^=]+=\s*\[\s*deepseekConfig\s*,?\s*\]/s.test(providerIndex)
) {
  fail('provider registry contains a provider other than DeepSeek web')
}

const openAiRoutes = readFileSync(resolve(root, 'src/server/routes/openai.ts'), 'utf8')
for (const unsupportedRoute of ['/v1/completions', '/v1/responses']) {
  if (openAiRoutes.includes(unsupportedRoute)) {
    fail(`unsupported compatibility route remains: ${unsupportedRoute}`)
  }
}
for (const obsoletePath of [
  'src/main/proxy/sessionManager.ts',
  'src/main/proxy/stream.ts',
  'src/main/proxy/toolCalling',
  'src/shared/toolCalling.ts',
]) {
  if (existsSync(resolve(root, obsoletePath))) {
    fail(`obsolete session or tool-emulation surface remains: ${obsoletePath}`)
  }
}

const connectorRoot = resolve(root, 'tools/deepseek-session-connector')
const connectorManifest = JSON.parse(readFileSync(resolve(connectorRoot, 'manifest.json'), 'utf8'))
const connectorWorker = readFileSync(resolve(connectorRoot, 'service-worker.js'), 'utf8')
const nativeConnectorLaunch = readFileSync(resolve(root, 'src/web/connector.ts'), 'utf8')
const adminRoutes = readFileSync(resolve(root, 'src/server/routes/admin.ts'), 'utf8')
for (const permission of ['cookies', 'webRequest', 'webRequestBlocking', 'history', 'downloads']) {
  if (connectorManifest.permissions?.includes(permission)) {
    fail(`DeepSeek connector requests prohibited permission: ${permission}`)
  }
}
if (
  JSON.stringify(connectorManifest.host_permissions)
  !== JSON.stringify(['https://chat.deepseek.com/*'])
) {
  fail('DeepSeek connector host permissions exceed the fixed provider origin')
}
if (/console\./.test(connectorWorker)) {
  fail('DeepSeek connector contains runtime console diagnostics')
}
if (/chrome\.storage\.[a-z]+\.set\(\s*\{[^}]*\btoken\s*:/i.test(connectorWorker)) {
  fail('DeepSeek connector may persist the provider token')
}
if (
  !adminRoutes.includes("const DEEPSEEK_CONNECTOR_ORIGIN = 'https://chat.deepseek.com'")
  || !adminRoutes.includes('request.headers.origin !== DEEPSEEK_CONNECTOR_ORIGIN')
) {
  fail('DeepSeek connector completion route is not bound to the fixed provider origin')
}
if (
  !adminRoutes.includes("const NATIVE_CONNECTOR_HEADER = 'native-v1'")
  || !adminRoutes.includes("request.headers['x-chat2api-connector'] !== NATIVE_CONNECTOR_HEADER")
  || !adminRoutes.includes("request.headers.origin !== undefined")
) {
  fail('native connector completion route lacks its non-browser request boundary')
}
if (
  !adminRoutes.includes("'browser-extension', reply")
  || !adminRoutes.includes("'native', reply")
  || !adminRoutes.includes('c2a-ds-native-v1.')
) {
  fail('DeepSeek pairing capabilities are not transport-bound')
}
if (
  !nativeConnectorLaunch.includes("const nativeConnectorScheme = 'chat2api-connector'")
  || !nativeConnectorLaunch.includes("const nativeCapabilityPrefix = 'c2a-ds-native-v1.'")
  || !nativeConnectorLaunch.includes('new URLSearchParams({ code: value })')
  || /console\./.test(nativeConnectorLaunch)
) {
  fail('native connector custom-protocol handoff is missing or unsafe')
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
