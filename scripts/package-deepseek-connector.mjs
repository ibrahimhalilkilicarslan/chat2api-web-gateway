import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = resolve(root, 'tools', 'deepseek-session-connector')
const output = resolve(root, 'dist', 'web', 'downloads', 'deepseek-session-connector-v1.0.0.zip')
const sourceFiles = [
  'manifest.json',
  'service-worker.js',
  'content-script.js',
  'popup.html',
  'popup.js',
  'popup.css',
]
const archiveRoot = 'deepseek-session-connector'

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return value >>> 0
})

function crc32(value) {
  let crc = 0xffffffff
  for (const byte of value) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function localHeader(name, data, crc) {
  const nameBuffer = Buffer.from(name, 'utf8')
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(0, 6)
  header.writeUInt16LE(0, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(33, 12)
  header.writeUInt32LE(crc, 14)
  header.writeUInt32LE(data.length, 18)
  header.writeUInt32LE(data.length, 22)
  header.writeUInt16LE(nameBuffer.length, 26)
  header.writeUInt16LE(0, 28)
  return Buffer.concat([header, nameBuffer, data])
}

function centralHeader(name, data, crc, offset) {
  const nameBuffer = Buffer.from(name, 'utf8')
  const header = Buffer.alloc(46)
  header.writeUInt32LE(0x02014b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(20, 6)
  header.writeUInt16LE(0, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(0, 12)
  header.writeUInt16LE(33, 14)
  header.writeUInt32LE(crc, 16)
  header.writeUInt32LE(data.length, 20)
  header.writeUInt32LE(data.length, 24)
  header.writeUInt16LE(nameBuffer.length, 28)
  header.writeUInt16LE(0, 30)
  header.writeUInt16LE(0, 32)
  header.writeUInt16LE(0, 34)
  header.writeUInt16LE(0, 36)
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38)
  header.writeUInt32LE(offset, 42)
  return Buffer.concat([header, nameBuffer])
}

function endRecord(entryCount, centralSize, centralOffset) {
  const record = Buffer.alloc(22)
  record.writeUInt32LE(0x06054b50, 0)
  record.writeUInt16LE(0, 4)
  record.writeUInt16LE(0, 6)
  record.writeUInt16LE(entryCount, 8)
  record.writeUInt16LE(entryCount, 10)
  record.writeUInt32LE(centralSize, 12)
  record.writeUInt32LE(centralOffset, 16)
  record.writeUInt16LE(0, 20)
  return record
}

const manifest = JSON.parse(await readFile(resolve(sourceRoot, 'manifest.json'), 'utf8'))
const prohibitedPermissions = ['cookies', 'webRequest', 'webRequestBlocking', 'history', 'downloads']
if (prohibitedPermissions.some((permission) => manifest.permissions?.includes(permission))) {
  throw new Error('DeepSeek connector requests a prohibited browser permission')
}
if (
  JSON.stringify(manifest.host_permissions) !== JSON.stringify(['https://chat.deepseek.com/*'])
) {
  throw new Error('DeepSeek connector host permissions are broader than expected')
}

const entries = await Promise.all(sourceFiles.map(async (file) => ({
  name: `${archiveRoot}/${file}`,
  data: await readFile(resolve(sourceRoot, file)),
})))
const localParts = []
const centralParts = []
let offset = 0
for (const entry of entries) {
  const crc = crc32(entry.data)
  const local = localHeader(entry.name, entry.data, crc)
  localParts.push(local)
  centralParts.push(centralHeader(entry.name, entry.data, crc, offset))
  offset += local.length
}
const central = Buffer.concat(centralParts)
const archive = Buffer.concat([
  ...localParts,
  central,
  endRecord(entries.length, central.length, offset),
])

await mkdir(dirname(output), { recursive: true })
await writeFile(output, archive, { mode: 0o644 })
await chmod(output, 0o644)
