export const DEEPSEEK_WEB_API_BASE = 'https://chat.deepseek.com/api'
export const DEEPSEEK_CURRENT_USER_ENDPOINT = `${DEEPSEEK_WEB_API_BASE}/v0/users/current`

export const DEEPSEEK_WEB_HEADERS = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Origin: 'https://chat.deepseek.com',
  Referer: 'https://chat.deepseek.com/',
  'Sec-Ch-Ua': '"Not/A)Brand";v="99", "Chromium";v="148"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'X-App-Version': '2.0.0',
  'X-Client-Locale': 'zh_CN',
  'X-Client-Platform': 'web',
  'X-Client-Version': '2.0.0',
} as const

type DeepSeekCurrentUserInspection =
  | { kind: 'valid'; accessToken: string; providerIdentity?: string }
  | { kind: 'suspended'; suspendedUntil?: number; providerIdentity?: string }
  | { kind: 'authentication_error' }
  | { kind: 'protocol_error' }

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function numericCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function providerIdentity(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim()
    return normalized.length > 0 ? normalized : undefined
  }
  return typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : undefined
}

export function inspectDeepSeekCurrentUser(
  value: unknown,
): DeepSeekCurrentUserInspection {
  const root = record(value)
  const data = record(root?.data)
  const rootCode = numericCode(root?.code)
  const businessCode = numericCode(data?.biz_code)

  if (rootCode === 40_003 || businessCode === 40_003) {
    return { kind: 'authentication_error' }
  }

  const businessData = record(data?.biz_data) ?? record(root?.biz_data)
  const accessToken = businessData?.token
  const identity = providerIdentity(businessData?.id)
  const acceptedCodes = (rootCode === undefined || rootCode === 0)
    && (businessCode === undefined || businessCode === 0)
  if (acceptedCodes && typeof accessToken === 'string' && accessToken.length > 0) {
    const chat = record(businessData?.chat)
    const isMuted = chat?.is_muted === true || chat?.is_muted === 1
    if (isMuted) {
      const muteUntilSeconds = numericCode(chat?.mute_until)
      return {
        kind: 'suspended',
        ...(identity === undefined ? {} : { providerIdentity: identity }),
        ...(muteUntilSeconds === undefined
          ? {}
          : { suspendedUntil: Math.round(muteUntilSeconds * 1000) }),
      }
    }
    return {
      kind: 'valid',
      accessToken,
      ...(identity === undefined ? {} : { providerIdentity: identity }),
    }
  }

  return { kind: 'protocol_error' }
}
