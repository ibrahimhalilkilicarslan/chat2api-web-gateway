import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const environmentPath = resolve(import.meta.dirname, '..', '.env')
if (!existsSync(environmentPath)) {
  process.stderr.write('No .env file found. Run pnpm setup first.\n')
  process.exit(1)
}

const line = readFileSync(environmentPath, 'utf8')
  .split(/\r?\n/)
  .find((entry) => entry.startsWith('CHAT2API_ADMIN_TOKEN='))
const token = line?.slice('CHAT2API_ADMIN_TOKEN='.length)
if (!token) {
  process.stderr.write('CHAT2API_ADMIN_TOKEN is missing from .env.\n')
  process.exit(1)
}
process.stdout.write(`${token}\n`)
