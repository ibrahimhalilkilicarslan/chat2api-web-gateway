import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const backupInput = process.env.CHAT2API_BACKUP_PATH
const masterKey = process.env.CHAT2API_MASTER_KEY
const image = process.env.CHAT2API_RESTORE_IMAGE ?? 'chat2api-web-gateway:local'
const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`
const seedContainer = `chat2api-restore-seed-${suffix}`
const drillContainer = `chat2api-restore-drill-${suffix}`
const volume = `chat2api-restore-drill-${suffix}`

if (!backupInput || !masterKey) {
  throw new Error('CHAT2API_BACKUP_PATH and CHAT2API_MASTER_KEY are required')
}

const backupPath = resolve(backupInput)
if (!existsSync(backupPath) || !statSync(backupPath).isFile()) {
  throw new Error('The requested backup is not a regular file')
}
if (Buffer.from(masterKey, 'base64').length !== 32) {
  throw new Error('CHAT2API_MASTER_KEY must be a 32-byte base64 value')
}

async function docker(args, options = {}) {
  return execFileAsync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  })
}

async function getAvailablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not allocate a loopback port'))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolvePort(address.port)
      })
    })
  })
}

async function waitUntilReady(baseUrl) {
  const deadline = Date.now() + 60_000
  let lastFailure = 'gateway did not answer'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health/ready`)
      if (response.status === 200) return
      lastFailure = `health returned ${response.status}`
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error)
    }
    await delay(500)
  }
  throw new Error(`Restored container did not become ready: ${lastFailure}`)
}

function environmentArguments(environment) {
  return Object.entries(environment).flatMap(([name, value]) => [
    '--env',
    `${name}=${value}`,
  ])
}

async function cleanup() {
  await docker(['rm', '--force', drillContainer]).catch(() => undefined)
  await docker(['rm', '--force', seedContainer]).catch(() => undefined)
  await docker(['volume', 'rm', '--force', volume]).catch(() => undefined)
}

async function run() {
  const port = await getAvailablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const bootstrapApiKey = `c2a_restore_${randomBytes(32).toString('base64url')}`

  try {
    await docker(['volume', 'create', volume])
    await docker([
      'create',
      '--name',
      seedContainer,
      '--volume',
      `${volume}:/data`,
      image,
    ])
    await docker(['cp', backupPath, `${seedContainer}:/data/chat2api.sqlite`])
    await docker(['rm', seedContainer])
    await docker([
      'run',
      '--rm',
      '--user',
      '0:0',
      '--entrypoint',
      '/bin/chown',
      '--volume',
      `${volume}:/data`,
      image,
      '10001:10001',
      '/data/chat2api.sqlite',
    ])

    await docker([
      'run',
      '--detach',
      '--name',
      drillContainer,
      '--read-only',
      '--tmpfs',
      '/tmp:rw,size=32m,mode=1777',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '128',
      '--memory',
      '512m',
      '--cpus',
      '1',
      '--publish',
      `127.0.0.1:${port}:8080`,
      '--volume',
      `${volume}:/data`,
      ...environmentArguments({
        NODE_ENV: 'production',
        CHAT2API_HOST: '0.0.0.0',
        PORT: '8080',
        CHAT2API_DATABASE_PATH: '/data/chat2api.sqlite',
        CHAT2API_LOG_LEVEL: 'fatal',
        CHAT2API_TRUST_PROXY: 'false',
        CHAT2API_SECURE_COOKIES: 'false',
        CHAT2API_MASTER_KEY: masterKey,
        CHAT2API_BOOTSTRAP_API_KEY: bootstrapApiKey,
        CHAT2API_ADMIN_TOKEN: randomBytes(48).toString('base64url'),
        CHAT2API_SESSION_SECRET: randomBytes(48).toString('base64url'),
        CHAT2API_ADMIN_ORIGINS: baseUrl,
        CHAT2API_ADMIN_HOSTS: '127.0.0.1',
        CHAT2API_ACCOUNT_HEALTH_INTERVAL_MS: '0',
      }),
      image,
    ])

    await waitUntilReady(baseUrl)
    const unauthenticated = await fetch(`${baseUrl}/v1/models`)
    assert.equal(unauthenticated.status, 401)
    const authenticated = await fetch(`${baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${bootstrapApiKey}` },
    })
    assert.equal(authenticated.status, 200)
    const models = await authenticated.json()
    assert.ok(Array.isArray(models?.data))

    process.stdout.write(`${JSON.stringify({
      backup: backupPath,
      image,
      integrity: 'pass',
      credentialDecryption: 'pass',
      readiness: 'pass',
      authenticationBoundary: 'pass',
      modelsContract: 'pass',
      providerGeneration: 'not-run',
    }, null, 2)}\n`)
  } finally {
    await cleanup()
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`Restore drill failed: ${message}\n`)
  process.exitCode = 1
})
