import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import Database from 'better-sqlite3'

const root = resolve(import.meta.dirname, '..')

function option(name, environmentName) {
  const index = process.argv.indexOf(name)
  const commandLineValue = index >= 0 ? process.argv[index + 1] : undefined
  return commandLineValue || process.env[environmentName]
}

function fail(message) {
  process.stderr.write(`SQLite backup failed: ${message}\n`)
  process.exit(1)
}

const databaseInput = option('--database', 'CHAT2API_DATABASE_PATH')
const outputInput = option('--output', 'CHAT2API_BACKUP_PATH')
if (!databaseInput || !outputInput) {
  fail('provide --database/CHAT2API_DATABASE_PATH and --output/CHAT2API_BACKUP_PATH')
}

const databasePath = resolve(databaseInput)
const outputPath = resolve(outputInput)
const outputRelativeToRepository = relative(root, outputPath)

if (databasePath === outputPath) fail('source and destination must be different')
if (!existsSync(databasePath) || !statSync(databasePath).isFile()) {
  fail('source database does not exist or is not a regular file')
}
if (
  outputRelativeToRepository === ''
  || (!outputRelativeToRepository.startsWith('..') && !isAbsolute(outputRelativeToRepository))
) {
  fail('backup destination must be outside the source repository')
}
if (existsSync(outputPath)) fail('destination already exists')

mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 })

let source
let backup
try {
  source = new Database(databasePath, { readonly: true, fileMustExist: true })
  await source.backup(outputPath)
  chmodSync(outputPath, 0o600)

  backup = new Database(outputPath, { readonly: true, fileMustExist: true })
  const integrity = backup.pragma('integrity_check', { simple: true })
  if (integrity !== 'ok') throw new Error('backup integrity check failed')
} catch (cause) {
  backup?.close()
  source?.close()
  if (existsSync(outputPath)) rmSync(outputPath, { force: true })
  fail(cause instanceof Error ? cause.message : 'unknown backup error')
}

backup?.close()
source?.close()
process.stdout.write(`SQLite online backup verified: ${outputPath}\n`)
