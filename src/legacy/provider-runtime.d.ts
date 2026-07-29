import type { Transform } from 'node:stream'
import type { RuntimeConfig } from '../core/config.js'
import type { Account, Provider } from '../main/store/types.js'
import type {
  ChatCompletionRequest,
  ForwardResult,
  ProxyContext,
} from '../main/proxy/types.js'

export function configureProviderRuntime(config: RuntimeConfig): void

export const requestForwarder: {
  forwardChatCompletion(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext,
  ): Promise<ForwardResult>
}

export const streamHandler: {
  createTransformStream(model: string, requestId?: string): Transform
}
