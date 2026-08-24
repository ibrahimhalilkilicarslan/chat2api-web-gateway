import { spawnSync } from 'node:child_process'

const allowedLicenses = new Set([
  'MIT',
  'OFL-1.1',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'BlueOak-1.0.0',
])

const pnpmCli = process.env.npm_execpath
const command = pnpmCli ? process.execPath : 'pnpm'
const args = pnpmCli
  ? [pnpmCli, 'licenses', 'list', '--prod', '--json']
  : ['licenses', 'list', '--prod', '--json']

const result = spawnSync(command, args, {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
})

if (result.status !== 0) {
  process.stderr.write('Production license audit failed: pnpm could not enumerate licenses.\n')
  process.exit(1)
}

let report
try {
  report = JSON.parse(result.stdout)
} catch {
  process.stderr.write('Production license audit failed: invalid pnpm license report.\n')
  process.exit(1)
}

const licenses = Object.keys(report)
const rejected = licenses.filter((license) => !allowedLicenses.has(license))
if (rejected.length > 0) {
  process.stderr.write(
    `Production license audit failed: unreviewed license group(s): ${rejected.join(', ')}\n`,
  )
  process.exit(1)
}

const packageVersions = new Set()
for (const entries of Object.values(report)) {
  for (const entry of entries) {
    for (const version of entry.versions ?? []) {
      packageVersions.add(`${entry.name}@${version}`)
    }
  }
}

process.stdout.write(
  `Production license audit passed: ${packageVersions.size} package versions across ${licenses.length} approved license groups.\n`,
)
