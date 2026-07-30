import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

function fail(message) {
  process.stderr.write(`SQLite backup verification failed: ${message}\n`)
  process.exit(1)
}

const argumentIndex = process.argv.indexOf('--backup')
const input = argumentIndex >= 0
  ? process.argv[argumentIndex + 1]
  : process.env.CHAT2API_BACKUP_PATH
if (!input) fail('provide --backup or CHAT2API_BACKUP_PATH')

const backupPath = resolve(input)
if (!existsSync(backupPath) || !statSync(backupPath).isFile()) {
  fail('backup does not exist or is not a regular file')
}

const requiredTables = [
  'schema_migrations',
  'providers',
  'accounts',
  'settings',
  'api_keys',
  'api_key_daily_usage',
  'request_logs',
  'audit_logs',
]

let database
try {
  database = new Database(backupPath, {
    readonly: true,
    fileMustExist: true,
  })
  const integrity = database.pragma('integrity_check', { simple: true })
  if (integrity !== 'ok') fail('PRAGMA integrity_check did not return ok')

  const tables = new Set(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  )
  const missing = requiredTables.filter((table) => !tables.has(table))
  if (missing.length > 0) fail(`required tables are missing: ${missing.join(', ')}`)

  const migration = database
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get()
  if (!migration || migration.version < 1) fail('schema migration version is invalid')

  const malformedCredentialCount = database
    .prepare(`
      SELECT COUNT(*) AS count
      FROM accounts
      WHERE encrypted_credentials IS NULL OR length(encrypted_credentials) < 16
    `)
    .get()
  if (malformedCredentialCount?.count > 0) {
    fail('one or more encrypted credential envelopes are malformed')
  }
} catch (cause) {
  fail(cause instanceof Error ? cause.message : 'unknown verification error')
} finally {
  database?.close()
}

process.stdout.write(`SQLite backup verified read-only: ${backupPath}\n`)
