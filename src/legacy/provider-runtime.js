// This file is the only boundary between the hardened gateway and the retained
// provider adapters. TypeScript consumes provider-runtime.d.ts instead of
// traversing provider-specific implementation details.
import { requestForwarder } from '../main/proxy/forwarder.ts'
import { proxyStatusManager } from '../main/proxy/status.ts'
import { streamHandler } from '../main/proxy/stream.ts'

export function configureProviderRuntime(config) {
  proxyStatusManager.updateConfig({
    timeout: config.requestTimeoutMs,
    retryCount: 0,
    maxConnections: config.globalConcurrency,
    enableCors: false,
    corsOrigin: '',
  })
}

export { requestForwarder, streamHandler }
