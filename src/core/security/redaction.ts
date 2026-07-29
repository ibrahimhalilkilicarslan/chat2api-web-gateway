const secretValues = new Set<string>()
const TOKEN_PATTERNS = [
  /(\b(?:authorization|cookie|token|api[_-]?key|secret|password)\b\s*[:=]\s*)([^\s,;]+)/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bc2a_[A-Za-z0-9_-]{16,}/g,
]

export function registerSecret(value: string): void {
  if (value.length >= 6) {
    secretValues.add(value)
  }
}

export function redactText(input: string): string {
  let output = input
  for (const secret of secretValues) {
    output = output.replaceAll(secret, '[REDACTED]')
  }
  for (const pattern of TOKEN_PATTERNS) {
    output = output.replace(pattern, (match, prefix: string | undefined) =>
      prefix ? `${prefix}[REDACTED]` : '[REDACTED]')
  }
  return output
}

function safeConsoleArgument(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value)
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
    }
  }
  return '[non-string diagnostic omitted]'
}

export function installLegacyConsoleGuard(options: { diagnostics: boolean }): void {
  const originalWarn = globalThis.console.warn.bind(globalThis.console)
  const originalError = globalThis.console.error.bind(globalThis.console)

  globalThis.console.log = () => undefined
  globalThis.console.debug = () => undefined
  globalThis.console.info = () => undefined
  globalThis.console.warn = (...values: unknown[]) => {
    if (options.diagnostics) {
      originalWarn(...values.map(safeConsoleArgument))
    }
  }
  globalThis.console.error = (...values: unknown[]) => {
    originalError(...values.map(safeConsoleArgument))
  }
}
