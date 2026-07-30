import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const image = process.env.CHAT2API_SMOKE_IMAGE ?? 'chat2api-web-gateway:local'
const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`
const containerName = `chat2api-smoke-${suffix}`
const invalidConfigContainerName = `chat2api-invalid-config-${suffix}`

async function docker(args, options = {}) {
  return execFileAsync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  })
}

async function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not allocate a loopback port.'))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
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

  throw new Error(`Container did not become ready: ${lastFailure}`)
}

function environmentArguments(environment) {
  return Object.entries(environment).flatMap(([name, value]) => [
    '--env',
    `${name}=${value}`,
  ])
}

function cookieHeader(response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .join('; ')
}

async function expectStatus(url, expectedStatus, init) {
  const response = await fetch(url, init)
  assert.equal(
    response.status,
    expectedStatus,
    `${init?.method ?? 'GET'} ${url} returned ${response.status}, expected ${expectedStatus}`,
  )
  return response
}

async function run() {
  const port = await getAvailablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const bootstrapApiKey = `c2a_smoke_${randomBytes(32).toString('base64url')}`
  const adminToken = randomBytes(48).toString('base64url')
  const environment = {
    NODE_ENV: 'production',
    CHAT2API_HOST: '0.0.0.0',
    PORT: '8080',
    CHAT2API_DATABASE_PATH: '/data/chat2api.sqlite',
    CHAT2API_LOG_LEVEL: 'fatal',
    CHAT2API_TRUST_PROXY: 'false',
    CHAT2API_SECURE_COOKIES: 'false',
    CHAT2API_MASTER_KEY: randomBytes(32).toString('base64'),
    CHAT2API_BOOTSTRAP_API_KEY: bootstrapApiKey,
    CHAT2API_ADMIN_TOKEN: adminToken,
    CHAT2API_SESSION_SECRET: randomBytes(48).toString('base64url'),
    CHAT2API_ADMIN_ORIGINS: baseUrl,
  }

  try {
    await docker([
      'run',
      '--detach',
      '--name',
      containerName,
      '--read-only',
      '--tmpfs',
      '/tmp:rw,size=64m,mode=1777',
      '--tmpfs',
      '/data:rw,size=64m,uid=10001,gid=10001,mode=0700',
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
      ...environmentArguments(environment),
      image,
    ])

    await waitUntilReady(baseUrl)

    await expectStatus(`${baseUrl}/health/ready`, 200)
    await expectStatus(`${baseUrl}/v1/models`, 401)
    await expectStatus(`${baseUrl}/v1/models?api_key=not-accepted`, 401)
    await expectStatus(`${baseUrl}/v1/models`, 200, {
      headers: { authorization: `Bearer ${bootstrapApiKey}` },
    })

    await expectStatus(`${baseUrl}/v1/chat/completions`, 400, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bootstrapApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'contract check' }],
        tools: [],
      }),
    })
    await expectStatus(`${baseUrl}/v1/completions`, 404, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bootstrapApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'deepseek-chat', prompt: 'legacy request' }),
    })

    const adminPage = await expectStatus(`${baseUrl}/admin/`, 200)
    const adminHtml = await adminPage.text()
    const adminAssetPaths = [...adminHtml.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((path) => !path.startsWith('data:'))
    assert.ok(adminAssetPaths.length > 0, 'Admin page has no bundled assets.')
    assert.ok(
      adminAssetPaths.every((path) => path.startsWith('/admin/')),
      'Admin page contains assets outside the /admin/ mount.',
    )
    for (const path of adminAssetPaths) {
      await expectStatus(new URL(path, baseUrl).toString(), 200)
    }
    const connectorPackage = await expectStatus(
      `${baseUrl}/admin/downloads/deepseek-session-connector-v1.0.0.zip`,
      200,
    )
    const connectorBytes = Buffer.from(await connectorPackage.arrayBuffer())
    assert.equal(
      connectorBytes.subarray(0, 4).toString('hex'),
      '504b0304',
      'DeepSeek connector package is not a ZIP archive.',
    )
    await expectStatus(`${baseUrl}/admin/api/login`, 403, {
      method: 'POST',
      headers: {
        origin: 'https://untrusted.invalid',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: adminToken }),
    })

    const login = await expectStatus(`${baseUrl}/admin/api/login`, 200, {
      method: 'POST',
      headers: {
        origin: baseUrl,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: adminToken }),
    })
    const session = await login.json()
    const cookies = cookieHeader(login)
    assert.ok(cookies.includes('c2a_admin='), 'Admin session cookie was not issued.')
    assert.ok(cookies.includes('c2a_csrf='), 'CSRF cookie was not issued.')
    assert.equal(typeof session.csrfToken, 'string', 'CSRF token was not returned.')

    await expectStatus(`${baseUrl}/admin/api/session`, 200, {
      headers: { cookie: cookies },
    })
    await expectStatus(`${baseUrl}/admin/api/logout`, 200, {
      method: 'POST',
      headers: {
        cookie: cookies,
        origin: baseUrl,
        'x-csrf-token': session.csrfToken,
      },
    })

    const { stdout: imageInspection } = await docker([
      'image',
      'inspect',
      image,
      '--format',
      '{{json .Config.User}}',
    ])
    assert.equal(JSON.parse(imageInspection.trim()), '10001:10001', 'Image does not use the expected non-root user.')

    const { stdout: containerInspection } = await docker([
      'inspect',
      containerName,
      '--format',
      '{{json .HostConfig}}',
    ])
    const hostConfig = JSON.parse(containerInspection)
    assert.equal(hostConfig.ReadonlyRootfs, true, 'Container root filesystem is writable.')
    assert.ok(hostConfig.CapDrop?.includes('ALL'), 'Container capabilities are not fully dropped.')
    assert.ok(
      hostConfig.SecurityOpt?.includes('no-new-privileges'),
      'no-new-privileges is not active.',
    )

    await docker([
      'exec',
      containerName,
      'node',
      '-e',
      "require('node:fs').writeFileSync('/data/smoke-write', 'ok')",
    ])
    let applicationWriteRejected = false
    try {
      await docker([
        'exec',
        containerName,
        'node',
        '-e',
        "require('node:fs').writeFileSync('/app/smoke-write', 'not-allowed')",
      ])
    } catch {
      applicationWriteRejected = true
    }
    assert.equal(applicationWriteRejected, true, 'Read-only application filesystem accepted a write.')

    const databaseInspectionScript = `
      import { createHash } from 'node:crypto';
      import Database from 'better-sqlite3';
      const db = new Database('/data/chat2api.sqlite', { readonly: true });
      const key = db.prepare(
        'SELECT id, key_hash AS keyHash FROM api_keys WHERE id = ?'
      ).get('environment-bootstrap');
      const columns = db.prepare('PRAGMA table_info(request_logs)')
        .all()
        .map((column) => column.name);
      const raw = process.env.CHAT2API_BOOTSTRAP_API_KEY;
      process.stdout.write(JSON.stringify({
        bootstrapPresent: key?.id === 'environment-bootstrap',
        bootstrapMatchesHash:
          key?.keyHash === createHash('sha256').update(raw).digest('hex'),
        bootstrapRawStored: key?.keyHash === raw,
        forbiddenRequestLogColumns: columns.filter((column) =>
          /(body|prompt|response|header|authorization|cookie|credential|secret)/i.test(column)
        ),
      }));
    `
    const { stdout: databaseInspection } = await docker([
      'exec',
      containerName,
      'node',
      '--input-type=module',
      '-e',
      databaseInspectionScript,
    ])
    const persisted = JSON.parse(databaseInspection)
    assert.equal(persisted.bootstrapPresent, true, 'Bootstrap API key record is missing.')
    assert.equal(persisted.bootstrapMatchesHash, true, 'Bootstrap API key hash does not match.')
    assert.equal(persisted.bootstrapRawStored, false, 'Bootstrap API key was stored in plaintext.')
    assert.deepEqual(
      persisted.forbiddenRequestLogColumns,
      [],
      'Request log schema can persist sensitive request data.',
    )

    let unrestrictedProxyTrustRejected = false
    try {
      await docker([
        'run',
        '--rm',
        '--name',
        invalidConfigContainerName,
        '--read-only',
        '--tmpfs',
        '/tmp:rw,size=16m,mode=1777',
        '--tmpfs',
        '/data:rw,size=16m,uid=10001,gid=10001,mode=0700',
        ...environmentArguments({
          ...environment,
          CHAT2API_TRUST_PROXY: 'true',
        }),
        image,
      ])
    } catch {
      unrestrictedProxyTrustRejected = true
    }
    assert.equal(
      unrestrictedProxyTrustRejected,
      true,
      'Unrestricted reverse-proxy trust was accepted.',
    )

    process.stdout.write(`${JSON.stringify({
      image,
      health: 'pass',
      apiAuthentication: 'pass',
      unsupportedFeatureRejection: 'pass',
      adminAssets: 'pass',
      connectorPackage: 'pass',
      adminSessionAndCsrf: 'pass',
      nonRoot: 'pass',
      readOnlyRootFilesystem: 'pass',
      droppedCapabilities: 'pass',
      hashedBootstrapKey: 'pass',
      metadataOnlyRequestLogs: 'pass',
      boundedProxyTrust: 'pass',
    }, null, 2)}\n`)
  } finally {
    await docker(['rm', '--force', containerName]).catch(() => undefined)
    await docker(['rm', '--force', invalidConfigContainerName]).catch(() => undefined)
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`Container smoke test failed: ${message}\n`)
  process.exitCode = 1
})
