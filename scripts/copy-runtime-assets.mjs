import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destination = resolve(root, 'dist', 'sha3_wasm_bg.7b9ca65ddd.wasm')

await mkdir(dirname(destination), { recursive: true })
await copyFile(resolve(root, 'sha3_wasm_bg.7b9ca65ddd.wasm'), destination)
