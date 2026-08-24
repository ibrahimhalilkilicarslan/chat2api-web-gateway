import { describe, expect, it } from 'vitest'
import {
  applyJsonModeInstruction,
  applyStopSequences,
  buildToolInstruction,
  listModelAliases,
  normalizeStopSequences,
  parseToolCalls,
  resolveModelAlias,
  toolNames,
  wantsJsonResponse,
} from './openaiCompat.js'
import { parseChatRequest } from './chat.js'

const weatherTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Look up the weather for a city.',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
  },
}

describe('resolveModelAlias', () => {
  it('maps common OpenAI names onto supported DeepSeek models', () => {
    expect(resolveModelAlias('gpt-4o')).toBe('deepseek-v4-pro')
    expect(resolveModelAlias('gpt-4o-mini')).toBe('deepseek-v4-flash')
    expect(resolveModelAlias('gpt-3.5-turbo')).toBe('deepseek-v4-flash')
    expect(resolveModelAlias('o1')).toBe('deepseek-v4-pro')
  })

  it('is case-insensitive and passes unknown ids through unchanged', () => {
    expect(resolveModelAlias('GPT-4O')).toBe('deepseek-v4-pro')
    expect(resolveModelAlias('deepseek-v4-flash')).toBe('deepseek-v4-flash')
    expect(resolveModelAlias('some-custom-model')).toBe('some-custom-model')
  })

  it('exposes the alias table', () => {
    expect(listModelAliases().some((entry) => entry.alias === 'gpt-4o')).toBe(true)
  })
})

describe('json mode', () => {
  it('detects json response formats', () => {
    expect(wantsJsonResponse({ type: 'json_object' })).toBe(true)
    expect(wantsJsonResponse({ type: 'json_schema' })).toBe(true)
    expect(wantsJsonResponse({ type: 'text' })).toBe(false)
    expect(wantsJsonResponse(undefined)).toBe(false)
  })

  it('augments an existing system message', () => {
    const messages = applyJsonModeInstruction([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'hi' },
    ])
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('Be terse.')
    expect(messages[0].content).toContain('valid JSON')
  })

  it('prepends a system message when none exists and stays idempotent', () => {
    const once = applyJsonModeInstruction([{ role: 'user', content: 'hi' }])
    expect(once[0].role).toBe('system')
    expect(once).toHaveLength(2)
    const twice = applyJsonModeInstruction(once)
    expect(twice).toHaveLength(2)
  })
})

describe('stop sequences', () => {
  it('normalizes string and array forms and caps the count', () => {
    expect(normalizeStopSequences('END')).toEqual(['END'])
    expect(normalizeStopSequences(['a', 'b'])).toEqual(['a', 'b'])
    expect(normalizeStopSequences(['1', '2', '3', '4', '5'])).toHaveLength(4)
    expect(normalizeStopSequences(['', 'x'])).toEqual(['x'])
    expect(normalizeStopSequences(undefined)).toBeUndefined()
  })

  it('truncates at the earliest marker only', () => {
    expect(applyStopSequences('hello END world STOP', ['STOP', 'END'])).toBe('hello ')
    expect(applyStopSequences('no marker here', ['STOP'])).toBe('no marker here')
    expect(applyStopSequences('abc', undefined)).toBe('abc')
  })
})

describe('parseChatRequest OpenAI-compat integration', () => {
  const base = { messages: [{ role: 'user', content: 'hi' }] }

  it('accepts standard sampling fields and resolves aliases', () => {
    const parsed = parseChatRequest({
      ...base,
      model: 'gpt-4o',
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 128,
      stop: 'END',
      seed: 42,
      presence_penalty: 0,
      user: 'u1',
    })
    expect(parsed.model).toBe('deepseek-v4-pro')
    expect(parsed.max_tokens).toBe(128)
    expect(parsed.stop).toEqual(['END'])
  })

  it('injects a JSON instruction when response_format is json', () => {
    const parsed = parseChatRequest({
      ...base,
      model: 'deepseek-v4-flash',
      response_format: { type: 'json_object' },
    })
    expect(parsed.messages[0].role).toBe('system')
    expect(parsed.messages[0].content).toContain('valid JSON')
  })

  it('prefers max_completion_tokens over max_tokens', () => {
    const parsed = parseChatRequest({
      ...base,
      model: 'deepseek-v4-flash',
      max_tokens: 100,
      max_completion_tokens: 200,
    })
    expect(parsed.max_tokens).toBe(200)
  })
})

describe('tool / function calling emulation', () => {
  it('lists callable tool names and builds an instruction', () => {
    expect(toolNames([weatherTool])).toEqual(['get_weather'])
    const instruction = buildToolInstruction([weatherTool], undefined)
    expect(instruction).toContain('get_weather')
    expect(instruction).toContain('tool_call')
  })

  it('reflects required and none tool_choice in the instruction', () => {
    expect(buildToolInstruction([weatherTool], 'required')).toContain('MUST call')
    expect(buildToolInstruction([weatherTool], { function: { name: 'get_weather' } }))
      .toContain('"get_weather"')
    expect(buildToolInstruction([weatherTool], 'none')).toContain('do NOT call')
    expect(buildToolInstruction([], undefined)).toBeUndefined()
  })

  it('parses a tool-call envelope into OpenAI tool_calls', () => {
    const calls = parseToolCalls(
      '{"tool_call": {"name": "get_weather", "arguments": {"city": "Izmir"}}}',
      ['get_weather'],
    )
    expect(calls).toHaveLength(1)
    expect(calls?.[0]).toMatchObject({ type: 'function', function: { name: 'get_weather' } })
    expect(JSON.parse(calls![0].function.arguments)).toEqual({ city: 'Izmir' })
  })

  it('tolerates code fences and ignores tools that were not offered', () => {
    expect(parseToolCalls('```json\n{"tool_call":{"name":"get_weather","arguments":{}}}\n```', ['get_weather']))
      .toHaveLength(1)
    expect(parseToolCalls('{"tool_call":{"name":"evil","arguments":{}}}', ['get_weather']))
      .toBeUndefined()
    expect(parseToolCalls('Just a normal answer.', ['get_weather'])).toBeUndefined()
  })

  it('injects the tool instruction and carries tools through parseChatRequest', () => {
    const parsed = parseChatRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'weather in izmir?' }],
      tools: [weatherTool],
    })
    expect(parsed.tools).toHaveLength(1)
    expect(parsed.messages[0].role).toBe('system')
    expect(parsed.messages[0].content).toContain('get_weather')
  })

  it('does not inject or carry tools when tool_choice is none', () => {
    const parsed = parseChatRequest({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [weatherTool],
      tool_choice: 'none',
    })
    expect(parsed.tools).toBeUndefined()
    expect(parsed.messages[0].role).toBe('user')
  })
})
