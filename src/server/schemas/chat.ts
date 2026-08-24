import { z } from 'zod'
import type { ChatCompletionRequest } from '../../main/proxy/types.js'
import {
  applyJsonModeInstruction,
  applyToolInstruction,
  buildToolInstruction,
  normalizeStopSequences,
  type OpenAiFunctionTool,
  resolveModelAlias,
  wantsJsonResponse,
} from './openaiCompat.js'

const MAX_MESSAGE_TEXT_CHARACTERS = 200_000
const MAX_MEDIA_PARTS_PER_MESSAGE = 4
const MAX_INLINE_MEDIA_CHARACTERS = 9 * 1024 * 1024
const ALLOWED_MEDIA_DATA_URL = /^data:(?:image\/(?:png|jpeg|webp)|application\/pdf);base64,[a-z0-9+/=_-]+$/i

function hasNoControlCharacters(value: string): boolean {
  return [...value].every((character) => {
    const code = character.charCodeAt(0)
    return code >= 32 && code !== 127
  })
}

const textContent = z.string()
  .min(1)
  .max(MAX_MESSAGE_TEXT_CHARACTERS)
  .refine((content) => content.trim().length > 0)

const inlineMediaDataUrl = z.string()
  .min(1)
  .max(MAX_INLINE_MEDIA_CHARACTERS)
  .regex(ALLOWED_MEDIA_DATA_URL, 'Only inline PNG, JPEG, WebP, and PDF data URLs are supported.')

const mediaFilename = z.string()
  .min(1)
  .max(160)
  .refine(hasNoControlCharacters, 'The media filename contains control characters.')

const textPartSchema = z.object({
  type: z.literal('text'),
  text: textContent,
}).strict()

const imagePartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: inlineMediaDataUrl,
  }).strict(),
  filename: mediaFilename.optional(),
}).strict()

const filePartSchema = z.object({
  type: z.literal('file'),
  file: z.object({
    filename: mediaFilename,
    file_data: inlineMediaDataUrl,
  }).strict(),
}).strict()

const contentPartSchema = z.discriminatedUnion('type', [
  textPartSchema,
  imagePartSchema,
  filePartSchema,
])

const userContentParts = z.array(contentPartSchema)
  .min(1)
  .max(MAX_MEDIA_PARTS_PER_MESSAGE + 1)
  .superRefine((parts, context) => {
    const mediaCount = parts.filter((part) => part.type !== 'text').length
    const textLength = parts.reduce(
      (total, part) => total + (part.type === 'text' ? part.text.length : 0),
      0,
    )
    if (mediaCount > MAX_MEDIA_PARTS_PER_MESSAGE) {
      context.addIssue({
        code: 'custom',
        message: `A message may contain at most ${MAX_MEDIA_PARTS_PER_MESSAGE} media parts.`,
      })
    }
    if (textLength > MAX_MESSAGE_TEXT_CHARACTERS) {
      context.addIssue({
        code: 'custom',
        message: 'Combined message text is too long.',
      })
    }
  })

const optionalName = z.string().max(256).optional()

// Message objects use `.strip()` (not `.strict()`) so OpenAI-compat extras such
// as `name`, `tool_call_id`, or `tool_calls` are dropped rather than rejected,
// while the media/content validation stays authoritative.
const messageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: textContent, name: optionalName }).strip(),
  z.object({ role: z.literal('assistant'), content: textContent, name: optionalName }).strip(),
  z.object({
    role: z.literal('user'),
    content: z.union([textContent, userContentParts]),
    name: optionalName,
  }).strip(),
])

const responseFormatSchema = z.object({
  type: z.enum(['text', 'json_object', 'json_schema']).optional(),
}).passthrough()

const stopSchema = z.union([
  z.string().max(1024),
  z.array(z.string().max(1024)).max(4),
])

// Accept the standard OpenAI sampling/formatting fields so any OpenAI-compatible
// client works as a drop-in. Known fields are validated; honored ones are
// forwarded to the request, the rest are accepted and ignored. `.strip()` drops
// any further unknown fields instead of returning 400.
const chatRequestSchema = z.object({
  model: z.string().min(1).max(256),
  messages: z.array(messageSchema).min(1).max(100),
  stream: z.boolean().optional(),
  web_search: z.boolean().optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high']).optional(),
  max_tokens: z.number().int().positive().max(1_000_000).optional(),
  max_completion_tokens: z.number().int().positive().max(1_000_000).optional(),
  stop: stopSchema.optional(),
  response_format: responseFormatSchema.optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  n: z.number().int().min(1).max(1).optional(),
  seed: z.number().int().optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  logit_bias: z.record(z.string(), z.number()).optional(),
  logprobs: z.boolean().optional(),
  top_logprobs: z.number().int().min(0).max(20).optional(),
  user: z.string().max(256).optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().optional(),
  tools: z.array(z.unknown()).max(128).optional(),
  tool_choice: z.unknown().optional(),
  parallel_tool_calls: z.boolean().optional(),
}).strip()

export function parseChatRequest(value: unknown): ChatCompletionRequest {
  const parsed = chatRequestSchema.parse(value)

  let messages: ChatCompletionRequest['messages'] = parsed.messages
  if (wantsJsonResponse(parsed.response_format)) {
    messages = applyJsonModeInstruction(messages)
  }

  const tools = (parsed.tools ?? []) as OpenAiFunctionTool[]
  const wantsTools = tools.length > 0 && parsed.tool_choice !== 'none'
  if (wantsTools) {
    const instruction = buildToolInstruction(tools, parsed.tool_choice)
    if (instruction) messages = applyToolInstruction(messages, instruction)
  }

  return {
    model: resolveModelAlias(parsed.model),
    messages,
    stream: parsed.stream,
    web_search: parsed.web_search,
    reasoning_effort: parsed.reasoning_effort,
    max_tokens: parsed.max_completion_tokens ?? parsed.max_tokens,
    stop: normalizeStopSequences(parsed.stop),
    response_format: parsed.response_format,
    tools: wantsTools ? tools : undefined,
    tool_choice: parsed.tool_choice,
  }
}
