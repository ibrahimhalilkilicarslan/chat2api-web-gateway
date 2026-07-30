import assert from 'node:assert/strict'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const temporaryRoot = mkdtempSync(join(tmpdir(), 'chat2api-setup-smoke-'))
const scriptsDirectory = join(temporaryRoot, 'scripts')

function run(script, args = []) {
  return spawnSync(process.execPath, [join(scriptsDirectory, script), ...args], {
    cwd: temporaryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

try {
  mkdirSync(scriptsDirectory, { mode: 0o700 })
  for (const file of ['setup.mjs', 'doctor.mjs', 'show-admin-token.mjs']) {
    copyFileSync(join(root, 'scripts', file), join(scriptsDirectory, file))
  }

  const setup = run('setup.mjs', [
    '--origin',
    'http://localhost:8080',
    '--non-interactive',
  ])
  assert.equal(setup.status, 0, setup.stderr)

  const environmentPath = join(temporaryRoot, '.env')
  assert.equal(statSync(environmentPath).mode & 0o777, 0o600)
  const environment = readFileSync(environmentPath, 'utf8')
  const token = environment
    .split(/\r?\n/)
    .find((line) => line.startsWith('CHAT2API_ADMIN_TOKEN='))
    ?.slice('CHAT2API_ADMIN_TOKEN='.length)
  assert.ok(token && token.length >= 32)
  assert.ok(!setup.stdout.includes(token), 'setup output leaked the generated admin token')

  const doctor = run('doctor.mjs', ['--skip-docker'])
  assert.equal(doctor.status, 0, doctor.stderr)
  assert.match(doctor.stdout, /Installation preflight passed/)

  const reveal = run('show-admin-token.mjs')
  assert.equal(reveal.status, 0, reveal.stderr)
  assert.equal(reveal.stdout.trim(), token)

  const secondSetup = run('setup.mjs', [
    '--origin',
    'http://localhost:8080',
    '--non-interactive',
  ])
  assert.notEqual(secondSetup.status, 0)
  assert.match(secondSetup.stderr, /\.env already exists/)

  chmodSync(environmentPath, 0o644)
  const insecureDoctor = run('doctor.mjs', ['--skip-docker'])
  assert.notEqual(insecureDoctor.status, 0)
  assert.match(insecureDoctor.stdout, /FAIL\s+Environment permissions/)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}

process.stdout.write('Setup smoke passed: generation, permissions, redaction, doctor, and overwrite guard.\n')
