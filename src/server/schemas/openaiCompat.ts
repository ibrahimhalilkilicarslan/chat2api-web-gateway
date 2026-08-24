import type { ChatMessage } from '../../main/proxy/types.js'

// OpenAI-compat model aliases. Requests naming a common OpenAI/other model are
// mapped onto a supported DeepSeek model so existing OpenAI clients work
// unchanged. Reasoning-oriented aliases map to the expert (pro) model.
const MODEL_ALIASES: Readonly<Record<string, string>> = {
  'gpt-4o': 'deepseek-v4-pro',
  'gpt-4o-mini': 'deepseek-v4-flash',
  'gpt-4o-latest': 'deepseek-v4-pro',
  'chatgpt-4o-latest': 'deepseek-v4-pro',
  'gpt-4.1': 'deepseek-v4-pro',
  'gpt-4.1-mini': 'deepseek-v4-flash',
  'gpt-4.1-nano': 'deepseek-v4-flash',
  'gpt-4-turbo': 'deepseek-v4-pro',
  'gpt-4': 'deepseek-v4-pro',
  'gpt-3.5-turbo': 'deepseek-v4-flash',
  'gpt-4o-search-preview': 'deepseek-v4-pro',
  'o1': 'deepseek-v4-pro',
  'o1-mini': 'deepseek-v4-pro',
  'o1-preview': 'deepseek-v4-pro',
  'o3': 'deepseek-v4-pro',
  'o3-mini': 'deepseek-v4-pro',
  'o4-mini': 'deepseek-v4-pro',
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-pro',
}

export function listModelAliases(): ReadonlyArray<{ alias: string; target: string }> {
  return Object.entries(MODEL_ALIASES).map(([alias, target]) => ({ alias, target }))
}

// Resolve a possibly-aliased model id to a canonical model string. Unknown
// values (including the real DeepSeek ids) are returned unchanged so downstream
// allow-list and routing checks stay authoritative.
export function resolveModelAlias(model: string): string {
  const normalized = model.trim().toLowerCase()
  return MODEL_ALIASES[normalized] ?? model
}

const JSON_OBJECT_INSTRUCTION =
  'You must respond with a single valid JSON value only. Do not include any prose, '
  + 'explanation, markdown, or code fences — output nothing but the JSON document.'

// Whether the OpenAI response_format asks for JSON output.
export function wantsJsonResponse(
  responseFormat: { type?: string } | undefined,
): boolean {
  const type = responseFormat?.type
  return type === 'json_object' || type === 'json_schema'
}

// DeepSeek web has no native response_format; emulate JSON mode by injecting a
// strict system instruction. If a system message already exists it is augmented,
// otherwise a new leading system message is added.
export function applyJsonModeInstruction(messages: ChatMessage[]): ChatMessage[] {
  const alreadyRequested = messages.some(
    (message) =>
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes(JSON_OBJECT_INSTRUCTION),
  )
  if (alreadyRequested) return messages

  const firstSystemIndex = messages.findIndex((message) => message.role === 'system')
  if (firstSystemIndex >= 0) {
    const target = messages[firstSystemIndex]
    if (typeof target.content === 'string') {
      const next = messages.slice()
      next[firstSystemIndex] = {
        ...target,
        content: `${target.content}\n\n${JSON_OBJECT_INSTRUCTION}`,
      }
      return next
    }
  }
  return [{ role: 'system', content: JSON_OBJECT_INSTRUCTION }, ...messages]
}

// Normalize the OpenAI `stop` field (string | string[]) into a bounded list.
export function normalizeStopSequences(
  stop: string | string[] | undefined,
): string[] | undefined {
  if (stop === undefined) return undefined
  const list = (Array.isArray(stop) ? stop : [stop])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .slice(0, 4)
  return list.length > 0 ? list : undefined
}

// Best-effort application of stop sequences to a completed (non-stream) text.
// DeepSeek web does not honor stop natively, so the gateway truncates at the
// earliest occurrence of any stop string.
export function applyStopSequences(
  text: string,
  stop: string[] | undefined,
): string {
  if (!stop || stop.length === 0) return text
  let cut = text.length
  for (const marker of stop) {
    const index = text.indexOf(marker)
    if (index >= 0 && index < cut) cut = index
  }
  return cut < text.length ? text.slice(0, cut) : text
}

// ---------------------------------------------------------------------------
// Tool / function calling emulation
//
// DeepSeek web has no native function-calling surface, so the gateway describes
// the requested tools in a system instruction and asks the model to emit a
// fixed JSON envelope when it wants to call one. On the non-stream response path
// that envelope is parsed back into OpenAI `tool_calls`. This keeps the hot
// streaming pipeline untouched; tool calls are structured on non-stream requests.
// ---------------------------------------------------------------------------

export interface OpenAiFunctionTool {
  type?: string
  function?: {
    name?: string
    description?: string
    parameters?: unknown
  }
}

export interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

function toolFunctionName(tool: OpenAiFunctionTool): string | undefined {
  const name = tool.function?.name
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : undefined
}

// Names of the callable tools, de-duplicated and safe to reference in prompts.
export function toolNames(tools: readonly OpenAiFunctionTool[] | undefined): string[] {
  if (!tools) return []
  const names = new Set<string>()
  for (const tool of tools) {
    const name = toolFunctionName(tool)
    if (name) names.add(name)
  }
  return [...names]
}

// Build the system instruction that teaches the model the tool contract.
export function buildToolInstruction(
  tools: readonly OpenAiFunctionTool[],
  toolChoice: unknown,
): string | undefined {
  const usable = tools.filter((tool) => toolFunctionName(tool))
  if (usable.length === 0) return undefined

  const catalog = usable
    .map((tool) => {
      const name = toolFunctionName(tool) as string
      const description = tool.function?.description
      const params = tool.function?.parameters
      const parts = [`- ${name}`]
      if (typeof description === 'string' && description.trim()) parts.push(`: ${description.trim()}`)
      if (params !== undefined) parts.push(`\n  parameters (JSON Schema): ${JSON.stringify(params)}`)
      return parts.join('')
    })
    .join('\n')

  const choiceName = typeof toolChoice === 'object'
    && toolChoice !== null
    && typeof (toolChoice as { function?: { name?: string } }).function?.name === 'string'
    ? (toolChoice as { function: { name: string } }).function.name
    : undefined
  const forced = toolChoice === 'required' || choiceName !== undefined
  const none = toolChoice === 'none'

  const lines = [
    'You can call the following tools:',
    catalog,
    '',
    'When you decide to call a tool, respond with ONLY a single JSON object and nothing else:',
    '{"tool_call": {"name": "<tool name>", "arguments": { ... }}}',
    'The arguments object must satisfy that tool\'s JSON Schema. Do not add prose, '
      + 'markdown, or code fences around the JSON.',
  ]
  if (none) {
    lines.push('For this request do NOT call any tool; answer the user directly instead.')
  } else if (forced) {
    lines.push(
      choiceName
        ? `For this request you MUST call the "${choiceName}" tool using the JSON envelope above.`
        : 'For this request you MUST call one of the tools using the JSON envelope above.',
    )
  } else {
    lines.push('If no tool is needed, answer the user normally in plain text.')
  }
  return lines.join('\n')
}

// Inject the tool instruction the same way JSON mode does: augment the first
// system message, or prepend a new one.
export function applyToolInstruction(messages: ChatMessage[], instruction: string): ChatMessage[] {
  const firstSystemIndex = messages.findIndex((message) => message.role === 'system')
  if (firstSystemIndex >= 0) {
    const target = messages[firstSystemIndex]
    if (typeof target.content === 'string') {
      const next = messages.slice()
      next[firstSystemIndex] = { ...target, content: `${target.content}\n\n${instruction}` }
      return next
    }
  }
  return [{ role: 'system', content: instruction }, ...messages]
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return fenced ? fenced[1].trim() : trimmed
}

let toolCallCounter = 0

// Parse the tool-call envelope from a completed assistant message. Returns the
// OpenAI tool_calls array, or undefined when the content is a normal answer or
// names a tool that was not offered.
export function parseToolCalls(
  content: string,
  allowedNames: readonly string[],
): OpenAiToolCall[] | undefined {
  const candidate = stripJsonFences(content)
  if (!candidate.startsWith('{')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return undefined
  }
  const envelope = (parsed as { tool_call?: unknown; tool_calls?: unknown })
  const raw = Array.isArray(envelope.tool_calls)
    ? envelope.tool_calls
    : envelope.tool_call !== undefined
      ? [envelope.tool_call]
      : undefined
  if (!raw) return undefined

  const allowed = new Set(allowedNames)
  const calls: OpenAiToolCall[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const name = (entry as { name?: unknown }).name
    if (typeof name !== 'string' || !allowed.has(name)) return undefined
    const args = (entry as { arguments?: unknown }).arguments
    const argumentString = typeof args === 'string' ? args : JSON.stringify(args ?? {})
    toolCallCounter += 1
    calls.push({
      id: `call_${Date.now().toString(36)}${toolCallCounter.toString(36)}`,
      type: 'function',
      function: { name, arguments: argumentString },
    })
  }
  return calls.length > 0 ? calls : undefined
}
