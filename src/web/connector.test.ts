import { describe, expect, it } from 'vitest'
import { buildNativeConnectorUrl, supportsNativeConnectorLaunch } from './connector.js'

describe('native connector launch', () => {
  it('builds an encoded custom-protocol URL without changing the capability', () => {
    const capability = 'c2a-ds-native-v1.example_payload'
    const launchUrl = buildNativeConnectorUrl(capability)
    const parsed = new URL(launchUrl)

    expect(parsed.protocol).toBe('chat2api-connector:')
    expect(parsed.hostname).toBe('pair')
    expect(parsed.searchParams.get('code')).toBe(capability)
  })

  it('rejects malformed or multiline capability values', () => {
    expect(() => buildNativeConnectorUrl('wrong-prefix')).toThrow()
    expect(() => buildNativeConnectorUrl('c2a-ds-native-v1.value\nnext')).toThrow()
  })

  it('keeps macOS on the explicit manual fallback until a native launcher ships', () => {
    expect(supportsNativeConnectorLaunch('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(true)
    expect(supportsNativeConnectorLaunch('Mozilla/5.0 (X11; Linux x86_64)')).toBe(true)
    expect(supportsNativeConnectorLaunch('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe(false)
  })
})
