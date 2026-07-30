import { Buffer } from 'node:buffer'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const environmentPath = resolve(root, '.env')
const checks = []

function record(name, passed, detail) {
  checks.push({ name, passed, detail })
}

function command(binary, args) {
  return spawnSync(binary, args, {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function parseEnvironment(content) {
  const values = new Map()
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator < 1) continue
    values.set(trimmed.slice(0, separator), trimmed.slice(separator + 1))
  }
  return values
}

record('Node.js', Number(process.versions.node.split('.')[0]) >= 22, `v${process.versions.node}`)

if (!existsSync(environmentPath)) {
  record('Environment', false, '.env is missing; run pnpm setup')
} else {
  const mode = statSync(environmentPath).mode & 0o777
  record('Environment permissions', mode === 0o600, `mode ${mode.toString(8).padStart(3, '0')}`)
  const environment = parseEnvironment(readFileSync(environmentPath, 'utf8'))
  const required = [
    'CHAT2API_MASTER_KEY',
    'CHAT2API_BOOTSTRAP_API_KEY',
    'CHAT2API_ADMIN_TOKEN',
    'CHAT2API_SESSION_SECRET',
    'CHAT2API_ADMIN_ORIGINS',
  ]
  record(
    'Required configuration',
    required.every((name) => (environment.get(name)?.length ?? 0) > 0),
    `${required.filter((name) => environment.has(name)).length}/${required.length} values present`,
  )
  const masterKey = environment.get('CHAT2API_MASTER_KEY') ?? ''
  record('Master key', Buffer.from(masterKey, 'base64').length === 32, '32-byte base64 value')
  const secretsLongEnough = [
    environment.get('CHAT2API_BOOTSTRAP_API_KEY'),
    environment.get('CHAT2API_ADMIN_TOKEN'),
    environment.get('CHAT2API_SESSION_SECRET'),
  ].every((value) => (value?.length ?? 0) >= 32)
  record('Secret lengths', secretsLongEnough, 'minimum 32 characters')
  try {
    const origin = new URL(environment.get('CHAT2API_ADMIN_ORIGINS') ?? '')
    const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(origin.hostname)
    record(
      'Admin origin',
      origin.origin === environment.get('CHAT2API_ADMIN_ORIGINS')
        && (origin.protocol === 'https:' || (origin.protocol === 'http:' && isLoopback)),
      `${origin.protocol}//${origin.host}`,
    )
  } catch {
    record('Admin origin', false, 'invalid exact origin')
  }
}

if (!process.argv.includes('--skip-docker')) {
  const dockerVersion = command('docker', ['--version'])
  record('Docker', dockerVersion.status === 0, dockerVersion.status === 0 ? dockerVersion.stdout.trim() : 'not available')
  const composeVersion = command('docker', ['compose', 'version'])
  record('Docker Compose', composeVersion.status === 0, composeVersion.status === 0 ? composeVersion.stdout.trim() : 'not available')
  if (existsSync(environmentPath) && composeVersion.status === 0) {
    const composeConfig = command('docker', ['compose', 'config', '--quiet'])
    record('Compose configuration', composeConfig.status === 0, composeConfig.status === 0 ? 'valid' : 'invalid')
  }
}

const width = Math.max(...checks.map((check) => check.name.length), 12)
for (const check of checks) {
  process.stdout.write(`${check.passed ? 'PASS' : 'FAIL'}  ${check.name.padEnd(width)}  ${check.detail}\n`)
}

const failures = checks.filter((check) => !check.passed)
if (failures.length > 0) {
  process.stderr.write(`\nDoctor found ${failures.length} blocking issue(s).\n`)
  process.exit(1)
}
process.stdout.write('\nInstallation preflight passed.\n')
