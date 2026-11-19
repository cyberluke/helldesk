/**
 * chat-envelope — canonical "break-room-mind" chat message envelope over the NAF
 * fabric (AAF federation: reuse the existing NAF `event.append` channel rather
 * than build a parallel bus).
 *
 * Both HELLDESK (local-live) and the Kilo VSIX extension publish and subscribe
 * to these so a user message / tool call / assistant response typed in one is
 * mirrored 1:1 to the other, all under ONE shared session id (the HELLDESK
 * departmentId).
 */
import { z } from 'zod';

/** Canonical shared chat session id. For the 1:1 loop it is the HELLDESK department. */
export function chatSessionId(departmentId: string): string {
  return `department:${departmentId}`;
}

export const ChatEventSchema = z.object({
  schema_version: z.literal(1),
  namespace: z.literal('helldesk'),
  /** The shared conversation/session this event belongs to (chatSessionId). */
  session_id: z.string(),
  /** event_type is one of the chat kinds below. */
  event_type: z.enum(['chat.user_message', 'chat.tool_call', 'chat.assistant_message']),
  producer_id: z.string(),
  event_id: z.string(),
  event_timestamp_utc_ms: z.number(),
  /** HELLDESK dashboard vs Kilo VSIX extension. */
  origin: z.enum(['helldesk', 'kilocode']),
  payload: z.object({
    role: z.enum(['user', 'assistant', 'system']),
    kind: z.enum(['text', 'tool_call', 'tool_result']),
    text: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.unknown().optional(),
    tool_result: z.unknown().optional(),
    ts: z.number(),
  }),
});
export type ChatEvent = z.output<typeof ChatEventSchema>;

export const CHAT_EVENT_TYPES = ChatEventSchema.shape.event_type.options;

/** Human label for a chat event (for UI/render). */
export function chatEventLabel(e: ChatEvent): string {
  switch (e.payload.kind) {
    case 'tool_call':
      return `🔧 ${e.payload.tool_name ?? 'tool'}`;
    case 'tool_result':
      return `⚙️ ${e.payload.tool_name ?? 'tool'} → ${typeof e.payload.tool_result === 'string' ? e.payload.tool_result.length + ' chars' : 'ok'}`;
    default:
      return e.payload.role === 'user' ? '🧑 you' : '🤖 assistant';
  }
}