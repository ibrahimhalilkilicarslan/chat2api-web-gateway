import { describe, expect, it } from 'vitest'
import {
  buildNativeConnectorUrl,
  connectorDownloadOptions,
  connectorReleaseVersion,
  detectConnectorDownload,
  resolveConnectorDownload,
  supportsNativeConnectorLaunch,
} from './connector.js'

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

describe('connector downloads', () => {
  it('builds immutable direct release asset URLs for every supported target', () => {
    expect(connectorReleaseVersion).toBe('0.2.0')
    expect(connectorDownloadOptions).toHaveLength(6)
    expect(connectorDownloadOptions.map((download) => download.url)).toEqual(
      connectorDownloadOptions.map((download) => (
        `https://github.com/ibrahimhalilkilicarslan/chat2api-session-connector/releases/download/v0.2.0/${download.filename}`
      )),
    )
  })

  it('detects common desktop operating systems without opening the release page', () => {
    expect(detectConnectorDownload({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      platform: 'Win32',
    })).toMatchObject({
      platform: 'windows',
      architecture: 'amd64',
      filename: 'chat2api-session-connector_0.2.0_windows_amd64.zip',
    })

    expect(detectConnectorDownload({
      userAgent: 'Mozilla/5.0 (X11; Linux aarch64)',
      platform: 'Linux armv8l',
    })).toMatchObject({
      platform: 'linux',
      architecture: 'arm64',
    })

    expect(detectConnectorDownload({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
      platform: 'MacIntel',
    })).toMatchObject({
      platform: 'macos',
      architecture: 'arm64',
    })
  })

  it('uses high-entropy client hints when the browser exposes architecture', async () => {
    const download = await resolveConnectorDownload({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      platform: 'Win32',
      userAgentData: {
        platform: 'Windows',
        getHighEntropyValues: async () => ({
          architecture: 'arm',
          bitness: '64',
          platform: 'Windows',
        }),
      },
    })

    expect(download).toMatchObject({
      platform: 'windows',
      architecture: 'arm64',
      filename: 'chat2api-session-connector_0.2.0_windows_arm64.zip',
    })
  })

  it('does not offer a desktop connector as an automatic mobile download', () => {
    expect(detectConnectorDownload({
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)',
      platform: 'Linux armv8l',
      maxTouchPoints: 5,
    })).toBeNull()
    expect(detectConnectorDownload({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    })).toBeNull()
  })
})
