import type { BuiltinProviderConfig } from '../../store/types'

export const deepseekApiConfig: BuiltinProviderConfig = {
  id: 'deepseek-api',
  name: 'DeepSeek Official API',
  type: 'builtin',
  authType: 'token',
  apiEndpoint: 'https://api.deepseek.com',
  chatPath: '/chat/completions',
  headers: {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  },
  enabled: true,
  routingPriority: 10,
  integrationMode: 'official-api',
  capabilities: {
    jsonOutput: true,
    nativeToolCalling: true,
    webSearch: false,
  },
  description: 'Official DeepSeek API with native OpenAI Chat Completions compatibility.',
  supportedModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  modelMappings: {
    'deepseek-v4-flash': 'deepseek-v4-flash',
    'deepseek-v4-pro': 'deepseek-v4-pro',
  },
  credentialFields: [
    {
      name: 'apiKey',
      label: 'API Key',
      type: 'password',
      required: true,
      placeholder: 'Enter the official DeepSeek API key',
      helpText: 'Create a dedicated key in the official DeepSeek API console. The value is encrypted at rest.',
    },
  ],
  tokenCheckEndpoint: '/models',
  tokenCheckMethod: 'GET',
}

export default deepseekApiConfig
