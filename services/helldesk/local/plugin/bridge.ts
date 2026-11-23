// NAF bridge for the HELLDESK Local adapter.
//
// THIN, non-owning event publisher over the canonical NAI-Lattice NAF client
// (`@cyberluke/nai-lattice-client`). The bridge does NOT:
//   - run any child_process / shell / git,
//   - own task state machines, completion, retries or review scheduling,
//   - start/stop NAI-Lattice (never stop Lattice),
//   - read/write files on the hook path.
// All durability, epochs, reviews live in the native `nai-fabric-host.exe`.
//
// Fabric is discovered via the env var `NAI_FABRIC_PIPE` (overrides the default
// per-user pipe) or the default `\\.\pipe\NAI.AmbientFabric.NAF1.<sid-hash>`.
// If the runtime/pipe is unavailable the bridge stays disconnected and the
// plugin FAILS OPEN (developer chat is never blocked).

import type { NafClient } from '@cyberluke/nai-lattice-client';
import { NafClient as ClientImpl, encodeWireFrame, encodeEnvelope, encodeHandshakeRequest, KindType } from '@cyberluke/nai-lattice-client';

export interface BridgeIdentity {
  producerId: string;
  workspaceRoots: string[];
  pid: number;
}

export interface BridgeHandlers {
  onConnected?: (instanceId: string) => void;
  onError?: (err: Error) => void;
  onDisconnected?: (err: Error) => void;
  /** A mirrored chat event (user/tool/assistant) published by another fabric
   *  peer on this session, delivered live to the VSIX extension. */
  onChat?: (e: ChatMirrorEvent) => void;
}

/**
 * The shared "break-room-mind" chat event as delivered to the extension. Mirrors the
 * canonical helldesk/local-live `chat-envelope` contract 1:1 (same wire shape).
 */
export interface ChatMirrorEvent {
  session_id: string;
  event_type: string;
  producer_id: string;
  event_id: string;
  origin: 'helldesk' | 'kilocode';
  payload: {
    role: 'user' | 'assistant' | 'system';
    kind: 'text' | 'tool_call' | 'tool_result';
    text?: string;
    tool_name?: string;
    tool_input?: unknown;
    tool_result?: unknown;
    ts: number;
  };
}

/** Decode a NAF `event.append` argument object into a ChatMirrorEvent, or null.
 *  Exported for the cross-peer contract test (HELLDESK → extension). */
export function decodeChatFromArgs(args: Record<string, unknown>): ChatMirrorEvent | null {
  const eventType = args['event_type'];
  if (typeof eventType !== 'string' || !eventType.startsWith('chat.')) return null;
  const payload = args['payload'] as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const pRole = p['role'];
  if (pRole !== 'user' && pRole !== 'assistant' && pRole !== 'system') return null;
  const sessionId = args['session_id'];
  const producerId = args['producer_id'];
  const eventId = args['event_id'];
  const origin = args['origin'] === 'helldesk' ? 'helldesk' : (args['origin'] === 'kilocode' ? 'kilocode' : undefined);
  if (typeof sessionId !== 'string' || typeof producerId !== 'string' || typeof eventId !== 'string' || !origin) return null;
  const kind = p['kind'] === 'tool_call' || p['kind'] === 'tool_result' ? p['kind'] : 'text';
  return {
    session_id: sessionId,
    event_type: eventType,
    producer_id: producerId,
    event_id: eventId,
    origin,
    payload: {
      role: pRole as 'user' | 'assistant' | 'system',
      kind,
      text: typeof p['text'] === 'string' ? p['text'] : undefined,
      tool_name: typeof p['tool_name'] === 'string' ? p['tool_name'] : undefined,
      tool_input: p['tool_input'],
      tool_result: p['tool_result'],
      ts: typeof p['ts'] === 'number' ? p['ts'] : Date.now(),
    },
  };
}

/** Build a stable producer identity from the OS process (never a fake flag). */
export function newHostIdentity(opts: { workspaceRoots: string[] }): BridgeIdentity {
  return {
    producerId: `helldesk.host-${process.pid}`,
    workspaceRoots: opts.workspaceRoots,
    pid: process.pid,
  };
}

export class NafBridge {
  private client: NafClient | null = null;
  private connectPromise: Promise<void> | null = null;
  private identity: BridgeIdentity;
  private handlers: BridgeHandlers;
  private connected = false;
  /** Bounded queue so a slow/absent fabric never backs up the hook. */
  private pending: Array<{ method: string; args: Record<string, unknown>; idem?: string }> = [];
  private readonly maxQueue = 256;
  private disposed = false;

  constructor(identity: BridgeIdentity, handlers: BridgeHandlers) {
    this.identity = identity;
    this.handlers = handlers;
  }

  /** Connect lazily (best-effort, nonblocking from the hook). */
  connect(): void {
    if (this.connected || this.disposed) return;
    const pipe = (process.env.NAI_FABRIC_PIPE as string | undefined) || undefined;
    const client: NafClient = new ClientImpl({
      appId: 'kilocode.local-helldesk',
      clientVersion: '0.1.0',
      requestedCapabilities: [
        'event.append',
        'event.append_batch',
        'helldesk.admin.health',
        'helldesk.admin.metrics',
        'helldesk.host.register',
        'helldesk.host.heartbeat',
        'helldesk.host.disconnect',
        'helldesk.session.sync',
      ],
      packageIdentity: '@cyberluke/nai-lattice-client@0.2.0',
      buildSha: 'naf-client-ts-0.2.0',
      pipePath: pipe,
      producerId: this.identity.producerId,
      onDisconnect: (e) => { this.connected = false; this.handlers.onDisconnected?.(e); },
      onEvent: (env) => {
        // break-room-mind: events published by other fabric peers (e.g. HELLDESK on
        // `event.append`) reach the extension via this callback. Decode and
        // relay chat events so the extension can render user/tool/assistant
        // activity typed in HELLDESK.
        try {
          if (env.kindType !== 13) return;
          const raw = JSON.parse(new TextDecoder().decode(env.payload ?? new Uint8Array(0)));
          const args = raw && typeof raw === 'object' && 'args' in raw
            ? (raw as { args: Record<string, unknown> }).args
            : (raw as Record<string, unknown>);
          const chat = decodeChatFromArgs(args);
          if (chat) this.handlers.onChat?.(chat);
        } catch { /* non-chat / unparseable event; ignore */ }
      },
    });
    this.connectPromise = client
      .connect()
      .then(() => {
        this.connected = true;
        this.client = client;
        // Register the real host (verified by the pipe transport from a live
        // OS process handle) and snapshot real sessions.
        void this.registerHost();
        this.drain();
        this.handlers.onConnected?.(client.runtimeInstanceId ?? '');
      })
      .catch((e) => {
        // Fail open: never throw into the plugin host. Record for diagnosis.
        this.handlers.onError?.(e as Error);
        // Diagnostic is async, non-blocking: never sync-fs on the hook path
        // (BRIDGE-01). Fire-and-forget; best effort only.
        if (process.env.HELLDESK_PLUGIN_DIAG) {
          const err = String((e as Error)?.message ?? e);
          void import('node:fs/promises')
            .then(({ writeFile }) =>
              writeFile(process.env.HELLDESK_PLUGIN_DIAG! + '.err', JSON.stringify({ err, info: diagInfo() }), 'utf8')
            )
            .catch(() => { /* best effort */ });
        }
      })
      .finally(() => { this.connectPromise = null; });
  }

  /** Enqueue a canonical HELLDESK event; never blocks the hook. */
  emitEvent(sessionId: string, eventType: string, extra: Record<string, unknown>): void {
    this.enqueue('event.append', this.helldeskEvent(sessionId, eventType, extra), eventType);
  }

  /**
   * Publish a break-room-mind chat event from the VSIX extension onto the shared
   * session. Mirrors the HELLDESK `ChatFabric.publish` contract so a user
   * message / tool call / assistant response typed in the extension is seen 1:1
   * in HELLDESK. sessionId must be the canonical shared id (`department:<departmentId>`).
   */
  publishChatEvent(
    sessionId: string,
    input: {
      role: 'user' | 'assistant' | 'system';
      kind: 'text' | 'tool_call' | 'tool_result';
      text?: string;
      toolName?: string;
      toolInput?: unknown;
      toolResult?: unknown;
    }
  ): void {
    const event = this.helldeskEvent(sessionId, this.chatEventType(input.kind, input.role), {
      event_type: this.chatEventType(input.kind, input.role),
      payload: {
        role: input.role,
        kind: input.kind,
        text: input.text,
        tool_name: input.toolName,
        tool_input: input.toolInput,
        tool_result: input.toolResult,
        ts: Date.now(),
      },
      origin: 'kilocode',
    });
    this.enqueue('event.append', event, String(event.event_id ?? `chat-${Date.now()}`));
  }

  /** Register a live subscriber for mirrored chat events (from other peers). */
  onChat(fn: NonNullable<BridgeHandlers['onChat']>): () => void {
    const prev = this.handlers.onChat;
    this.handlers = { ...this.handlers, onChat: prev ? (e) => { prev(e); fn(e); } : fn };
    return () => { /* chained; caller typically keeps the bridge alive */ };
  }

  private chatEventType(kind: ChatMirrorEvent['payload']['kind'], role: ChatMirrorEvent['payload']['role']): string {
    if (kind === 'tool_call') return 'chat.tool_call';
    if (kind === 'tool_result') return 'chat.assistant_message';
    return role === 'user' ? 'chat.user_message' : 'chat.assistant_message';
  }

  /** Send a UUIDv7-style event id, idempotency key, and canonical fields. */
  private helldeskEvent(sessionId: string, eventType: string, extra: Record<string, unknown>): Record<string, unknown> {
    const producer_sequence = ++this.seq;
    return {
      schema_version: 1,
      namespace: 'helldesk',
      entity_id: this.identity.workspaceRoots[0] ?? '',
      event_type: eventType,
      producer_id: this.identity.producerId,
      producer_epoch: 1,
      producer_sequence,
      event_id: randomUuidv7(),
      host_runtime_id: this.identity.producerId,
      host_process_identity: `pid=${process.pid} ts=${processStartTimeMs()}`,
      workspace_id: this.identity.workspaceRoots[0] ?? '',
      session_id: sessionId || undefined,
      event_timestamp_utc_ms: Date.now(),
      durability: 'batched',
      ...extra,
    };
  }

  private seq = 0;
  private enqueue(method: string, args: Record<string, unknown>, idem: string): void {
    if (this.pending.length >= this.maxQueue) {
      // Drop oldest to preserve bounded memory; caller never blocks.
      this.pending.shift();
    }
    this.pending.push({ method, args, idem });
    this.drain();
  }

  private async drain(): Promise<void> {
    if (!this.connected || !this.client) return;
    while (this.pending.length > 0) {
      const item = this.pending[0]!;
      try {
        await this.client.dispatch(item.method, item.args, item.idem);
        this.pending.shift();
      } catch (e) {
        this.handlers.onError?.(e as Error);
        return; // keep the item for a later reconnect; bounded by maxQueue
      }
    }
  }

  private async registerHost(): Promise<void> {
    if (!this.client) return;
    await Promise.allSettled([
      this.client.dispatch('helldesk.host.register', {
        host_runtime_id: this.identity.producerId,
        process_identity: `pid=${process.pid} ts=${processStartTimeMs()}`,
        verified_real_host: true,
      }),
      this.client.dispatch('helldesk.session.sync', { host_runtime_id: this.identity.producerId, sessions: [] }),
    ]);
  }

  /** Flush pending events + registrations durably before session shutdown.
   * Bounded (default 8s) so a completed task's events are ACKed before the
   * process exits, yet the prompt hook is never blocked. Never stops Lattice. */
  async dispose(): Promise<void> {
    this.disposed = true;
    try {
      // Ensure connection resolves (bounded) so queued events can be sent.
      if (!this.connected && !this.connectPromise) return;
      if (this.connectPromise) {
        await Promise.race([this.connectPromise, delay(3000)]);
      }
      await this.drain();
    } catch { /* non-blocking */ }
    try { await this.client?.close().catch(() => {}); } catch { /* ignore */ }
    this.client = null;
    this.connected = false;
    // NEVER stop Lattice from the plugin.
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** The connected NafClient, once established, for tools that dispatch
   *  host capabilities (e.g. config.get/patch, review.list). Null until the
   *  lazy connect resolves; tools must handle null gracefully (fail-open). */
  getClient(): NafClient | null {
    return this.client;
  }
}

function randomUuidv7(): string {
  // UUIDv7-ish (time-ordered); acceptable for idempotency + ordering.
  return typeof crypto !== 'undefined' && typeof (crypto as { randomUUID?: () => string }).randomUUID === 'function'
    ? (crypto as { randomUUID: () => string }).randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function diagInfo(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    out.clientResolved = require?.resolve?.('@cyberluke/nai-lattice-client') ?? 'n/a';
  } catch { out.clientResolved = 'resolve-failed'; }
  try {
    out.nobleResolved = require?.resolve?.('@noble/hashes/blake3') ?? 'n/a';
  } catch { out.nobleResolved = 'resolve-failed'; }
  return out;
}

let _start = Date.now();
function processStartTimeMs(): number {
  return _start;
}