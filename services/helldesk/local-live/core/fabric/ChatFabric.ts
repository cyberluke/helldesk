/**
 * ChatFabric — HELLDESK's bidirectional bus onto the NAF fabric.
 *
 * "Everyone lives in HELLDESK" break-room-mind: this is the HELLDESK terminal for the
 * shared chat session. It
 *   - PUBLISHES chat events (user message / tool call / assistant response)
 *     via the canonical NAF `event.append` channel, signed with the shared
 *     chat session id; and
 *   - SUBSCRIBES via the NAF client's `onEvent` so events published by the Kilo
 *     VSIX extension (or any other fabric peer on the same session) are relayed
 *     to HELLDESK live.
 *
 * Fail-open by design (mirrors the VSIX plugin bridge): if the engine/fabric
 * is down, publish is a no-op best-effort and the local round-trip still works
 * via the in-memory fan-out — never blocks or crashes the dashboard.
 */
import { z } from 'zod';
import { NafClient, type EnvelopeDesc } from '@cyberluke/nai-lattice-client';
import {
  ChatEventSchema,
  chatSessionId,
  type ChatEvent,
} from './chat-envelope';

export interface ChatFabricOptions {
  departmentId: string;
  appId?: string;
  /** Override producer identity (tests / VSIX multi-peer). */
  producerId?: string;
  pipePath?: string;
  /** Supply a pre-wired client when you want to control the transport (stub). */
  client?: NafClient;
}

export interface ChatMessageOut {
  role: ChatEvent['payload']['role'];
  kind: ChatEvent['payload']['kind'];
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  origin: 'helldesk' | 'kilocode';
}

export type ChatListener = (e: ChatEvent) => void;

/** Decode a raw NAF Event envelope into a ChatEvent, when it is one.
 *  Accepts the chat event as either `env.payload` JSON that IS the ChatEvent
 *  (fabric Event delivery) or JSON `{ payload: ChatEvent }` (our publish frame). */
export function decodeChatEvent(env: EnvelopeDesc): ChatEvent | null {
  if (env.kindType !== 13) return null; // KindType.Event
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(env.payload ?? new Uint8Array(0)));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  // 1) raw itself is a ChatEvent.
  const direct = ChatEventSchema.safeParse(raw);
  if (direct.success) return direct.data;
  // 2) publish-frame: { payload: <ChatEvent> }.
  const wrapped = ChatEventSchema.safeParse(obj['payload']);
  if (wrapped.success) return wrapped.data;
  // 3) flat `event.append` args (VSIX bridge publishes this shape):
  //    { event_type, session_id, producer_id, event_id, origin, payload:{...} }.
  if (typeof obj['event_type'] === 'string' && obj['event_type'].startsWith('chat.')) {
    return decodeChatEventArgs(obj, obj['origin'] === 'kilocode' ? 'kilocode' : 'helldesk');
  }
  return null;
}

/** Decode a flat chat `event.append`/`event.read_range` args object into a ChatEvent.
 *  This is the shape the VSIX extension publishes and what `event.read_range`
 *  returns as its payload: `{ event_type, session_id, producer_id, event_id,
 *  origin, payload: { role, kind, text, ... } }`. */
export function decodeChatEventArgs(args: Record<string, unknown>, originDefault: string): ChatEvent | null {
  const eventType = args['event_type'];
  const payload = args['payload'];
  if (typeof eventType !== 'string' || !eventType.startsWith('chat.') || !payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const sessionId = args['session_id'];
  const producerId = args['producer_id'];
  const eventId = args['event_id'];
  if (typeof sessionId !== 'string' || typeof producerId !== 'string' || typeof eventId !== 'string') return null;
  return ChatEventSchema.safeParse({
    schema_version: 1,
    namespace: 'helldesk',
    session_id: sessionId,
    event_type: eventType,
    producer_id: producerId,
    event_id: eventId,
    event_timestamp_utc_ms: typeof args['event_timestamp_utc_ms'] === 'number' ? args['event_timestamp_utc_ms'] : Date.now(),
    origin: args['origin'] === 'kilocode' ? ('kilocode' as const) : (originDefault as 'helldesk' | 'kilocode'),
    payload: {
      role: p['role'] === 'assistant' ? 'assistant' : (p['role'] === 'system' ? 'system' : 'user'),
      kind: p['kind'] === 'tool_call' || p['kind'] === 'tool_result' ? p['kind'] : 'text',
      text: typeof p['text'] === 'string' ? p['text'] : undefined,
      tool_name: typeof p['tool_name'] === 'string' ? p['tool_name'] : undefined,
      tool_input: p['tool_input'],
      tool_result: p['tool_result'],
      ts: typeof p['ts'] === 'number' ? p['ts'] : Date.now(),
    },
  }).success ? ({
    schema_version: 1,
    namespace: 'helldesk',
    session_id: sessionId,
    event_type: eventType,
    producer_id: producerId,
    event_id: eventId,
    event_timestamp_utc_ms: typeof args['event_timestamp_utc_ms'] === 'number' ? args['event_timestamp_utc_ms'] : Date.now(),
    origin: args['origin'] === 'kilocode' ? ('kilocode' as const) : (originDefault as 'helldesk' | 'kilocode'),
    payload: {
      role: (p['role'] === 'assistant' ? 'assistant' : (p['role'] === 'system' ? 'system' : 'user')) as 'user' | 'assistant' | 'system',
      kind: (p['kind'] === 'tool_call' || p['kind'] === 'tool_result' ? p['kind'] : 'text') as 'text' | 'tool_call' | 'tool_result',
      text: typeof p['text'] === 'string' ? p['text'] : undefined,
      tool_name: typeof p['tool_name'] === 'string' ? p['tool_name'] : undefined,
      tool_input: p['tool_input'],
      tool_result: p['tool_result'],
      ts: typeof p['ts'] === 'number' ? p['ts'] : Date.now(),
    },
  }) as ChatEvent : null;
}

let seq = 0;
function uuidv7ish(): string {
  // NAF event ids are UUIDv7-shaped; random hex is sufficient for uniqueness.
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 34)}`;
}

export class ChatFabric {
  private client: NafClient | null;
  private connected = false;
  private readonly listeners = new Set<ChatListener>();
  readonly sessionId: string;
  readonly departmentId: string;
  readonly origin: 'helldesk';
  /** Ledger cursor (runtime_sequence) for the shared-log poll. */
  private cursor: number | undefined;
  /** event_ids this process published (to avoid re-delivering our own on poll). */
  private readonly seen = new Set<string>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly POLL_MS = 1500;

  constructor(private readonly opts: ChatFabricOptions) {
    this.departmentId = opts.departmentId;
    this.sessionId = chatSessionId(opts.departmentId);
    this.origin = 'helldesk';
    // A supplied client (stub/fabric) is already wired to onEvent by the caller;
    // we attach our handler when we build our own client in connect().
    this.client = opts.client ?? null;
  }

  /** Create our own connection to the canonical fabric pipe (best-effort).
   *  Retryable: a failed connect clears the client so a later connect() (e.g.
   *  when the engine/fabric comes up) can retry cleanly. */
  connect(): void {
    if (this.client && this.connected) return;
    if (this.client) { this.client = null; } // drop a failed/stale handle
    try {
      const client = new NafClient({
        appId: this.opts.appId ?? 'helldesk.dashboard',
        clientVersion: '0.1.0',
        // event.read_range is the shared-ledger READ for the break-room-mind (the
        // fabric is store-and-replay, not push; we poll the canonical ledger).
        requestedCapabilities: ['event.append', 'event.read_range'],
        packageIdentity: '@cyberluke/nai-lattice-client@0.1.0',
        buildSha: 'naf-client-ts-0.1.0',
        // Omit pipePath to let NafClient auto-discover the canonical pipe.
        ...(this.opts.pipePath ? { pipePath: this.opts.pipePath } : {}),
        producerId: this.opts.producerId ?? `helldesk.dashboard-${process.pid}`,
        onEvent: (env) => this.handleEvent(env),
        onDisconnect: () => { this.connected = false; },
      });
      this.client = client;
      void client.connect()
        .then(() => {
          this.connected = true;
          this.startPolling();
        })
        .catch((e) => {
          this.connected = false;
          this.client = null; // allow a later retry to mint a fresh handle
          console.log(`[chat-fabric] connect skipped: ${String((e as Error)?.message ?? e)}`);
        });
    } catch (e) {
      this.connected = false;
      this.client = null;
      console.log(`[chat-fabric] no fabric: ${String((e as Error)?.message ?? e)}`);
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    // Poll the shared ledger via event.read_range (cursor = runtime_sequence).
    void this.pollOnce();
    this.pollTimer = setInterval(() => { void this.pollOnce(); }, ChatFabric.POLL_MS);
    if (typeof (setInterval as unknown as { unref?: () => void }).unref === 'function') {
      (setInterval as unknown as { unref(): void }).unref();
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.client || !this.connected) return;
    try {
      const res = await this.client.dispatch('event.read_range', {
        after: this.cursor ?? 0,
        limit: 500,
        namespace: 'helldesk',
      });
      if (res.status !== 0) return;
      const body = JSON.parse(new TextDecoder().decode(res.body)) as { events?: Array<Record<string, unknown>> };
      const events = body?.events ?? [];
      let maxSeq = this.cursor ?? 0;
      for (const ev of events) {
        const seq = Number(ev['runtime_sequence'] ?? 0);
        if (seq > maxSeq) maxSeq = seq;
        const eventType = ev['event_type'];
        if (typeof eventType !== 'string' || !eventType.startsWith('chat.')) continue;
        const chat = this.decodeLedgerEvent(ev);
        if (!chat) continue;
        // Skip events this process itself published (they were already delivered
        // locally on publish).
        if (this.seen.has(chat.event_id)) continue;
        this.deliverLocal(chat);
      }
      this.cursor = maxSeq;
    } catch {
      // transient; next poll retries
    }
  }

  /** Decode an event.read_range record into a ChatEvent (its fields are flat). */
  private decodeLedgerEvent(ev: Record<string, unknown>): ChatEvent | null {
    const payload = ev['payload'];
    if (!payload || typeof payload !== 'object') return null;
    const producerApp = String(ev['producer_app'] ?? '');
    // `event.read_range` returns top-level fields but NOT session_id/origin;
    // infer them: this fabric's session + producer-kind from the producer_app.
    const origin: 'helldesk' | 'kilocode' = producerApp.startsWith('helldesk') ? 'helldesk' : 'kilocode';
    const args: Record<string, unknown> = {
      event_type: ev['event_type'],
      session_id: this.sessionId,           // shared department session
      producer_id: ev['producer_app'],
      event_id: String(ev['event_id'] ?? `ledger-${ev['runtime_sequence']}`),
      event_timestamp_utc_ms: typeof ev['timestamp_utc_ms'] === 'number' ? ev['timestamp_utc_ms'] : undefined,
      origin,
      payload,
    };
    return decodeChatEventArgs(args, origin);
  }

  /** Register a local listener (dashboard UI). */
  onChat(fn: ChatListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private handleEvent(env: EnvelopeDesc): void {
    const chat = decodeChatEvent(env);
    if (!chat) return;
    for (const fn of this.listeners) {
      try { fn(chat); } catch { /* listener must not break the bus */ }
    }
  }

  /** Deliver a chat event to local listeners (used by local fan-out). */
  private deliverLocal(chat: ChatEvent): void {
    for (const fn of this.listeners) {
      try { fn(chat); } catch { /* listener must not break the bus */ }
    }
  }

  /** Publish a chat event onto the fabric (and to local listeners). */
  publish(msg: ChatMessageOut): void {
    const event: ChatEvent = {
      schema_version: 1,
      namespace: 'helldesk',
      session_id: this.sessionId,
      event_type: this.eventTypeFor(msg),
      producer_id: this.opts.producerId ?? `helldesk.dashboard-${process.pid}`,
      event_id: uuidv7ish(),
      event_timestamp_utc_ms: Date.now(),
      origin: msg.origin,
      payload: {
        role: msg.role,
        kind: msg.kind,
        text: msg.text,
        tool_name: msg.toolName,
        tool_input: msg.toolInput,
        tool_result: msg.toolResult,
        ts: Date.now(),
      },
    };
    // Local fan-out first (always works), then best-effort fabric.
    this.seen.add(event.event_id);
    this.deliverLocal(event);
    if (this.client && this.connected) {
      void this.client.dispatch('event.append', this.helldeskEventArgs(event), event.event_id).catch(() => { /* best effort */ });
    }
  }

  private eventTypeFor(m: ChatMessageOut): ChatEvent['event_type'] {
    if (m.kind === 'tool_call' || m.kind === 'tool_result') {
      return m.kind === 'tool_call' ? 'chat.tool_call' : 'chat.assistant_message';
    }
    return m.role === 'user' ? 'chat.user_message' : 'chat.assistant_message';
  }

  private helldeskEventArgs(e: ChatEvent): Record<string, unknown> {
    return {
      schema_version: 1,
      namespace: 'helldesk',
      session_id: e.session_id,
      event_type: e.event_type,
      producer_id: e.producer_id,
      producer_epoch: 1,
      producer_sequence: ++seq,
      event_id: e.event_id,
      event_timestamp_utc_ms: e.event_timestamp_utc_ms,
      payload: e.payload,
      origin: e.origin,
    };
  }

  close(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    void this.client?.close().catch(() => {});
    this.client = null;
    this.connected = false;
    this.listeners.clear();
  }
}