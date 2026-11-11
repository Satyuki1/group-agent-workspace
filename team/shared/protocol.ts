import { z } from 'zod'

export const uuid = z.uuid()
export { prefix } from './paths.ts'
export type Principal = { id: string; name: string; kind: 'user' | 'agent' }
export type Member = Principal & {
  active?: boolean
  admin?: boolean
  description?: string
  model?: string
  tools?: boolean
  instructions?: string
  personal?: boolean
  local_bot_id?: string | null
}
export type Conversation = {
  id: string
  kind: 'dm' | 'group' | 'agent'
  name: string
  owner_id: string
  updated_at: string
  read_seq: string
  unread: number
  routing: boolean
  preview: string | null
}
export type Attachment = { id: string; name: string; media_type: string; size: number }
export type Message = {
  id: string
  conversation_id: string
  seq: string
  user_id: string | null
  agent_id: string | null
  text: string
  status: string
  sender: string
  reply_id: string | null
  quote: string | null
  created_at: string
  attachments: Attachment[]
}
export type AgentRun = {
  id: string
  reply_id: string | null
  author: string
  status: string
  progress: string | null
  approval: { id: string; label: string } | null
  decision: string | null
  outcome: string | null
}
export type ImEvent = {
  id: string
  conversation_id: string | null
  kind: string
  data: Record<string, unknown>
}
export type RunInput = {
  id: string
  lease: string
  kind: 'agent' | 'route'
  location: 'server' | 'personal'
  bindingId: string | null
  localBotId?: string
  conversationId?: string
  conversationName?: string
  approvalId?: string
  model: string
  instructions: string
  tools: boolean
  prompt: string
  candidates: { id: string; name: string; description: string }[]
  files: Attachment[]
}
export const runUpdate = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), text: z.string().min(1).max(16000) }),
  z.object({ type: z.literal('progress'), text: z.string().max(500) }),
  z.object({ type: z.literal('approval'), id: uuid, label: z.string().max(500) }),
  z.object({ type: z.literal('complete'), target: uuid.nullable().optional() }),
  z.object({ type: z.literal('failed'), reason: z.string().max(300) }),
])
export type RunUpdate = z.infer<typeof runUpdate>
