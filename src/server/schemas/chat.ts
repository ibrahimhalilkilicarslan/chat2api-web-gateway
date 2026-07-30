import { z } from 'zod'
import type { ChatCompletionRequest } from '../../main/proxy/types.js'

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string()
    .min(1)
    .max(200_000)
    .refine((content) => content.trim().length > 0),
}).strict()

const chatRequestSchema = z.object({
  model: z.string().min(1).max(256),
  messages: z.array(messageSchema).min(1).max(100),
  stream: z.boolean().optional(),
  web_search: z.boolean().optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high']).optional(),
}).strict()

export function parseChatRequest(value: unknown): ChatCompletionRequest {
  return chatRequestSchema.parse(value)
}
