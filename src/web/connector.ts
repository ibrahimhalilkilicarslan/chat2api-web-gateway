const nativeCapabilityPrefix = 'c2a-ds-native-v1.'
const nativeConnectorScheme = 'chat2api-connector'
const maxCapabilityLength = 7 * 1024

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
