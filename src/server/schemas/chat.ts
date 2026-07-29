import { z } from 'zod'
import type { ChatCompletionRequest } from '../../main/proxy/types.js'

const SUPPORTED_IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i

function hasExpectedImageSignature(mimeSubtype: string, bytes: Buffer): boolean {
  if (mimeSubtype === 'png') {
    return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  }
  if (mimeSubtype === 'jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  if (mimeSubtype === 'gif') {
    const signature = bytes.subarray(0, 6).toString('ascii')
    return signature === 'GIF87a' || signature === 'GIF89a'
  }
  return bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
}

const textPartSchema = z.object({
  type: z.literal('text'),
  text: z.string().max(200_000),
})

const imagePartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string().min(1).max(1_000_000),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }),
})

const toolCallSchema = z.object({
  id: z.string().min(1).max(256),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1).max(128),
    arguments: z.string().max(200_000),
  }),
})

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([
    z.string().max(200_000),
    z.array(z.union([textPartSchema, imagePartSchema])).max(64),
    z.null(),
  ]),
  name: z.string().max(128).optional(),
  tool_call_id: z.string().max(256).optional(),
  tool_calls: z.array(toolCallSchema).max(64).optional(),
})

const toolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
    description: z.string().max(8_000).optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
})

const chatRequestSchema = z.object({
  model: z.string().min(1).max(256),
  messages: z.array(messageSchema).min(1).max(100),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  n: z.literal(1).optional(),
  stream: z.boolean().optional(),
  stop: z.union([z.string().max(256), z.array(z.string().max(256)).max(16)]).optional(),
  max_tokens: z.number().int().min(1).max(65_536).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  user: z.string().max(128).optional(),
  web_search: z.boolean().optional(),
  web_search_options: z.object({
    search_context_size: z.enum(['low', 'medium', 'high']).optional(),
    user_location: z.object({
      type: z.literal('approximate'),
      approximate: z.object({
        country: z.string().max(2).optional(),
        city: z.string().max(128).optional(),
        region: z.string().max(128).optional(),
      }).optional(),
    }).optional(),
  }).optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high']).optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  deep_research: z.boolean().optional(),
  tools: z.array(toolSchema).max(64).optional(),
  tool_choice: z.union([
    z.enum(['none', 'auto', 'required']),
    z.object({
      type: z.literal('function'),
      function: z.object({ name: z.string().min(1).max(128) }),
    }),
  ]).optional(),
  tool_format: z.enum(['native', 'json', 'auto']).optional(),
})

export function parseChatRequest(value: unknown): ChatCompletionRequest {
  const parsed = chatRequestSchema.parse(value)
  for (const message of parsed.messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type !== 'image_url') continue
      const url = part.image_url.url
      const match = SUPPORTED_IMAGE_DATA_URL.exec(url)
      if (!match?.[1] || !match[2]) {
        throw new Error('Only base64-encoded PNG, JPEG, WebP, or GIF images are accepted')
      }
      const bytes = Buffer.from(match[2], 'base64')
      if (
        bytes.length === 0
        || bytes.toString('base64') !== match[2]
        || !hasExpectedImageSignature(match[1].toLowerCase(), bytes)
      ) {
        throw new Error('Image data does not match its declared format')
      }
    }
  }
  return parsed as ChatCompletionRequest
}
