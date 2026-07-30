import { describe, expect, it } from 'vitest'
import { resolveDeepSeekChatOptions } from './providerModelOptions.js'

describe('DeepSeek model options', () => {
  it('maps only the two code-owned models and explicit request controls', () => {
    expect(resolveDeepSeekChatOptions({
      model: 'deepseek-v4-flash',
    })).toEqual({
      modelType: 'default',
      searchEnabled: false,
      thinkingEnabled: false,
    })
    expect(resolveDeepSeekChatOptions({
      model: 'deepseek-v4-pro',
      web_search: true,
      reasoning_effort: 'high',
    })).toEqual({
      modelType: 'expert',
      searchEnabled: true,
      thinkingEnabled: true,
    })
  })

  it('does not infer hidden features from legacy model-name suffixes', () => {
    expect(resolveDeepSeekChatOptions({
      model: 'deepseek-v4-flash-think-search',
    })).toEqual({
      modelType: 'default',
      searchEnabled: false,
      thinkingEnabled: false,
    })
  })
})
