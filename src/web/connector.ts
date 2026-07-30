const nativeCapabilityPrefix = 'c2a-ds-native-v1.'
const nativeConnectorScheme = 'chat2api-connector'
const maxCapabilityLength = 7 * 1024
const connectorRepository = 'ibrahimhalilkilicarslan/chat2api-session-connector'

export const connectorReleaseVersion = '0.2.0'
export const connectorChecksumUrl = buildReleaseAssetUrl('SHA256SUMS')

export type ConnectorPlatform = 'windows' | 'macos' | 'linux'
export type ConnectorArchitecture = 'amd64' | 'arm64'

export interface ConnectorDownload {
  platform: ConnectorPlatform
  architecture: ConnectorArchitecture
  label: string
  shortLabel: string
  filename: string
  url: string
}

interface UserAgentDataLike {
  platform?: string
  getHighEntropyValues?: (hints: string[]) => Promise<{
    architecture?: string
    bitness?: string
    platform?: string
  }>
}

export interface ConnectorNavigatorLike {
  userAgent: string
  platform?: string
  maxTouchPoints?: number
  userAgentData?: UserAgentDataLike
}

const platformNames: Record<ConnectorPlatform, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
}

function buildReleaseAssetUrl(filename: string): string {
  return `https://github.com/${connectorRepository}/releases/download/v${connectorReleaseVersion}/${filename}`
}

function buildConnectorDownload(
  platform: ConnectorPlatform,
  architecture: ConnectorArchitecture,
): ConnectorDownload {
  const extension = platform === 'linux' ? 'tar.gz' : 'zip'
  const filename = `chat2api-session-connector_${connectorReleaseVersion}_${platform}_${architecture}.${extension}`
  const architectureLabel = architecture === 'arm64' ? 'ARM64' : '64-bit'
  const platformLabel = platformNames[platform]

  return {
    platform,
    architecture,
    label: `${platformLabel} için indir`,
    shortLabel: `${platformLabel} · ${architectureLabel}`,
    filename,
    url: buildReleaseAssetUrl(filename),
  }
}

export const connectorDownloadOptions: ConnectorDownload[] = (
  ['windows', 'macos', 'linux'] as const
).flatMap((platform) => (
  (['amd64', 'arm64'] as const).map((architecture) => (
    buildConnectorDownload(platform, architecture)
  ))
))

function detectPlatform(value: string, maxTouchPoints = 0): ConnectorPlatform | null {
  if (/Android|iPhone|iPad|iPod/iu.test(value)) return null
  if (/Mac/iu.test(value) && maxTouchPoints > 1) return null
  if (/Windows|Win32|Win64/iu.test(value)) return 'windows'
  if (/Macintosh|Mac OS X|MacIntel/iu.test(value)) return 'macos'
  if (/Linux|X11/iu.test(value)) return 'linux'
  return null
}

function detectArchitecture(value: string, platform: ConnectorPlatform): ConnectorArchitecture {
  if (/arm64|aarch64|armv8|\barm\b/iu.test(value)) return 'arm64'
  if (/amd64|x86_64|x64|win64|\bx86\b/iu.test(value)) return 'amd64'

  // Reduced user-agent strings often omit architecture. These defaults match
  // the dominant desktop install base; all alternatives remain one click away.
  return platform === 'macos' ? 'arm64' : 'amd64'
}

export function detectConnectorDownload(
  navigatorLike: ConnectorNavigatorLike,
): ConnectorDownload | null {
  const platformSource = [
    navigatorLike.userAgentData?.platform,
    navigatorLike.platform,
    navigatorLike.userAgent,
  ].filter(Boolean).join(' ')
  const platform = detectPlatform(platformSource, navigatorLike.maxTouchPoints)
  if (!platform) return null

  const architecture = detectArchitecture(platformSource, platform)
  return buildConnectorDownload(platform, architecture)
}

export async function resolveConnectorDownload(
  navigatorLike: ConnectorNavigatorLike,
): Promise<ConnectorDownload | null> {
  const initial = detectConnectorDownload(navigatorLike)
  const userAgentData = navigatorLike.userAgentData
  if (!initial || !userAgentData?.getHighEntropyValues) return initial

  try {
    const hints = await userAgentData.getHighEntropyValues([
      'architecture',
      'bitness',
      'platform',
    ])
    const platformSource = [
      hints.platform,
      userAgentData.platform,
      navigatorLike.platform,
      navigatorLike.userAgent,
    ].filter(Boolean).join(' ')
    const platform = detectPlatform(platformSource, navigatorLike.maxTouchPoints)
    if (!platform) return null

    const architecture = detectArchitecture(
      `${hints.architecture ?? ''} ${hints.bitness ?? ''} ${platformSource}`,
      platform,
    )
    return buildConnectorDownload(platform, architecture)
  } catch {
    return initial
  }
}

export function buildNativeConnectorUrl(capability: string): string {
  const value = capability.trim()
  if (
    !value.startsWith(nativeCapabilityPrefix)
    || value.length > maxCapabilityLength
    || /[\r\n]/u.test(value)
  ) {
    throw new Error('Connector bağlantı kodu geçersiz.')
  }
  const query = new URLSearchParams({ code: value })
  return `${nativeConnectorScheme}://pair?${query.toString()}`
}

export function supportsNativeConnectorLaunch(userAgent: string): boolean {
  return !/Macintosh|Mac OS X/iu.test(userAgent)
}
