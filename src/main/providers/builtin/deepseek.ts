import type { BuiltinProviderConfig } from '../../store/types'

export const deepseekConfig: BuiltinProviderConfig = {
  id: 'deepseek',
  name: 'DeepSeek',
  type: 'builtin',
  authType: 'userToken',
  enabled: true,
  description: 'DeepSeek web oturumunu izole ve metin tabanlı Chat Completions API yüzeyine dönüştürür.',
  supportedModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  credentialFields: [
    {
      name: 'token',
      label: 'User Token',
      type: 'password',
      required: true,
      placeholder: 'DeepSeek web oturum tokenı',
      helpText: 'Yalnız bu gateway için ayrılmış, yetkili bir DeepSeek web hesabının oturum tokenını kullanın.',
    },
  ],
}

export default deepseekConfig
