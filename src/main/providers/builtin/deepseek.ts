import type { BuiltinProviderConfig } from '../../store/types'

export const deepseekConfig: BuiltinProviderConfig = {
  id: 'deepseek',
  name: 'DeepSeek',
  type: 'builtin',
  authType: 'userToken',
  enabled: true,
  description: 'DeepSeek web oturumunu izole, metin ve sınırlı inline dosya destekli Chat Completions API yüzeyine dönüştürür.',
  supportedModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  credentialFields: [
    {
      name: 'token',
      label: 'Web oturum tokenı',
      type: 'password',
      required: true,
      placeholder: 'Bearer ... veya yalnız token değeri',
      helpText: 'Yalnız bu gateway için ayrılmış ve size ait yetkili bir DeepSeek hesabının tokenını kullanın.',
    },
  ],
}

export default deepseekConfig
