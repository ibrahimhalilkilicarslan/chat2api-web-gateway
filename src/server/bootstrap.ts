import 'dotenv/config'
import { loadRuntimeConfig } from '../core/config.js'
import { installLegacyConsoleGuard, registerSecret } from '../core/security/redaction.js'

const config = loadRuntimeConfig()
registerSecret(config.bootstrapApiKey)
registerSecret(config.adminToken)
registerSecret(config.sessionSecret)
installLegacyConsoleGuard({ diagnostics: config.nodeEnv === 'development' })

const { buildApp } = await import('./app.js')
const app = await buildApp(config)

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'gateway shutdown requested')
  await app.close()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))

try {
  await app.listen({ host: config.host, port: config.port })
  app.log.info({ host: config.host, port: config.port }, 'gateway listening')
} catch (error) {
  app.log.fatal({ errorType: error instanceof Error ? error.name : 'unknown' }, 'gateway startup failed')
  await app.close().catch(() => undefined)
  process.exit(1)
}
