import { isIP } from 'node:net'

interface ParsedIp {
  value: bigint
  bits: 32 | 128
}

function parseIpv4(value: string): ParsedIp | undefined {
  if (isIP(value) !== 4) return undefined
  const parts = value.split('.').map(Number)
  const parsed = parts.reduce((result, part) => (result << 8n) | BigInt(part), 0n)
  return { value: parsed, bits: 32 }
}

function parseIpv6(value: string): ParsedIp | undefined {
  const withoutZone = value.split('%', 1)[0] ?? value
  if (isIP(withoutZone) !== 6) return undefined

  let normalized = withoutZone.toLowerCase()
  const ipv4Match = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized)
  if (ipv4Match) {
    const ipv4 = parseIpv4(ipv4Match[1])
    if (!ipv4) return undefined
    const high = Number((ipv4.value >> 16n) & 0xffffn).toString(16)
    const low = Number(ipv4.value & 0xffffn).toString(16)
    normalized = `${normalized.slice(0, -ipv4Match[1].length)}${high}:${low}`
  }

  const halves = normalized.split('::')
  if (halves.length > 2) return undefined
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : []
  const right = halves[1] ? halves[1].split(':').filter(Boolean) : []
  const missing = 8 - left.length - right.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined
  const groups = halves.length === 2
    ? [...left, ...Array.from({ length: missing }, () => '0'), ...right]
    : left
  if (groups.length !== 8) return undefined

  let parsed = 0n
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined
    parsed = (parsed << 16n) | BigInt(`0x${group}`)
  }
  return { value: parsed, bits: 128 }
}

function parseIp(value: string): ParsedIp | undefined {
  const normalized = value.trim().replace(/^\[|\]$/g, '')
  return parseIpv4(normalized) ?? parseIpv6(normalized)
}

function parseCidr(value: string): { network: bigint; prefix: number; bits: 32 | 128 } | undefined {
  const [address, rawPrefix, ...extra] = value.trim().split('/')
  if (!address || extra.length > 0) return undefined
  const parsed = parseIp(address)
  if (!parsed) return undefined
  const prefix = rawPrefix === undefined ? parsed.bits : Number(rawPrefix)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > parsed.bits) return undefined
  const shift = BigInt(parsed.bits - prefix)
  const network = shift === 0n ? parsed.value : (parsed.value >> shift) << shift
  return { network, prefix, bits: parsed.bits }
}

export function isValidIpOrCidr(value: string): boolean {
  return parseCidr(value) !== undefined
}

export function isIpAllowed(ip: string, allowedCidrs: readonly string[]): boolean {
  if (allowedCidrs.length === 0) return true
  const candidate = parseIp(ip)
  if (!candidate) return false

  return allowedCidrs.some((entry) => {
    const cidr = parseCidr(entry)
    if (!cidr || cidr.bits !== candidate.bits) return false
    const shift = BigInt(candidate.bits - cidr.prefix)
    const network = shift === 0n ? candidate.value : (candidate.value >> shift) << shift
    return network === cidr.network
  })
}
