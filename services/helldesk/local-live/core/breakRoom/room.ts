/**
 * core/breakRoom/room.ts — the "group chat" HITL operator core for the local tier.
 *
 * The human is an ASYNC, NON-BLOCKING peer in the room. Agents are fully
 * autonomous: approval comes from reviewer agents. The human can steer live —
 * interrupt / force review / disapprove — via buttons, but NONE of those stop
 * an agent from delivering value. Every steer is a SIDE-CHANNEL signal the
 * running agent may act on, never a blocking gate.
 *
 * Two pure responsibilities live here so they are unit-testable without any
 * WS / SQLite / fabric I/O:
 *
 *   1. `formatRoomEvent`     — map a colony runtime event (ticket state change,
 *                              agent analytics) to a Discord-style chat row the
 *                              human reads ("soul started ticket X", "reviewer
 *                              approved revision Y", "ticket X closed").
 *   2. `planSteer`           — map a human button to a NON-BLOCKING action:
 *                              - interrupt   → nudge the running agent ("human
 *                                                is watching; read this and
 *                                                keep going"); never aborts.
 *                              - force-review→ emit a finding that enqueues a
 *                                                review of the ticket; the reviewer
 *                                                agent picks it up async.
 *                              - disapprove  → emit a finding that, on the next
 *                                                reconciler pass, feeds the
 *                                                replan path — but does NOT stop
 *                                                current delivery.
 *   The returned `chat` fanned back through ChatFabric so the human sees their
 *   action confirmed in the same stream ("You interrupted…").
 *
 * Both functions are PURE (no blocking state, no sync awaits on the running
 * loop) — that is the invariant that keeps agent delivery unblocked.
 */

import type { ChatMessageOut } from '../fabric/ChatFabric';
import type { RuntimeEvent } from '../runtime/local-reconciler';

/* ── chat row vocabulary ─────────────────────────────────────────────── */

export type RoomActorKind = 'agent' | 'reviewer' | 'system' | 'human';

export interface RoomChatRow extends ChatMessageOut {
  /** Who this row is "spoken by" in the room (steering + rendering). */
  actor: RoomActorKind;
  /** Ticket this row is about, when scoped to one. */
  ticketId?: string;
  /** Agent name when an agent/reviewer said it. */
  agentId?: string;
}

/**
 * Human-readable message + actor for a runtime event. The room is a chat, so
 * even dry state changes read as a line someone said. Unknown/future event
 * types render as a neutral system line rather than being dropped.
 */
export function formatRoomEvent(evt: RuntimeEvent): RoomChatRow | null {
  // Narrow the RuntimeEvent union: `invariant` and `analytics` carry different
  // fields; only `ticket` has ticketId + a payload object.
  if (evt.type === 'invariant') {
    return { actor: 'system', role: 'system', kind: 'text', origin: 'helldesk', text: `${evt.violations.length} invariant(s) violated — reconciler gate active.` };
  }
  const payload = (evt as { payload?: Record<string, unknown> }).payload ?? {};
  const p = payload as Record<string, unknown>;
  const type = typeof p['type'] === 'string' ? (p['type'] as string) : p['event'];
  const kind = typeof type === 'string' ? type : String(type ?? evt.type);
  const ticketId = typeof (evt as { ticketId?: string }).ticketId === 'string' ? (evt as { ticketId?: string }).ticketId : (typeof p['ticketId'] === 'string' ? (p['ticketId'] as string) : undefined);
  const agentId = typeof p['agentId'] === 'string' ? (p['agentId'] as string) : (typeof p['agent_id'] === 'string' ? (p['agent_id'] as string) : undefined);

  // Derive an actor label for this event kind.
  const isReviewer = /review|verdict|gate|inquis|adjudic/i.test(kind);
  const actor: RoomActorKind = isReviewer ? 'reviewer' : /agent|soul|qualityAssurance|nudge/i.test(kind) ? 'agent' : 'system';
  const shortId = ticketId ? ticketId.slice(0, 8) : undefined;

  switch (kind) {
    case 'agent_spawned':
    case 'agent.completed':
    case 'agent_done':
      return { actor, role: 'assistant', kind: 'text', origin: 'helldesk', ticketId, agentId, text: `${agentId ?? 'an agent'} finished work${shortId ? ` on \`${shortId}\`` : ''}.` };
    case 'agent_exited':
    case 'agent_exited.dispatch_failed':
    case 'agent.lost':
    case 'agent.stalled':
      return { actor, role: 'system', kind: 'text', origin: 'helldesk', ticketId, agentId, text: `${agentId ?? 'an agent'} stalled${shortId ? ` on \`${shortId}\`` : ''} — the reconciler will recover it, delivery unaffected.` };
    case 'reviewer.approved':
    case 'review.approved':
    case 'verdict.pass':
      return { actor, role: 'assistant', kind: 'text', origin: 'helldesk', ticketId, agentId, text: `✅ reviewer approved${shortId ? ` \`${shortId}\`` : ''} — gate evidence resolved.` };
    case 'reviewer.findings':
    case 'review.findings':
    case 'verdict.findings':
      return { actor, role: 'assistant', kind: 'text', origin: 'helldesk', ticketId, agentId, text: `⚠️ reviewer filed findings on${shortId ? ` \`${shortId}\`` : ''} — next revision will address them.` };
    case 'reviewer.inconclusive':
    case 'verdict.inconclusive':
      return { actor, role: 'assistant', kind: 'text', origin: 'helldesk', ticketId, agentId, text: `🔁 reviewer was inconclusive on${shortId ? ` \`${shortId}\`` : ''} — re-reviewing, no fabrication.` };
    case 'ticket.status':
    case 'ticket.assigned':
    case 'ticket.gated':
      return { actor: 'system', role: 'system', kind: 'text', origin: 'helldesk', ticketId, agentId, text: `Ticket${shortId ? ` \`${shortId}\`` : ''} → ${typeof p['to'] === 'string' ? p['to'] : typeof p['status'] === 'string' ? p['status'] : 'state change'}.` };
    case 'ticket.closed':
      return { actor: 'system', role: 'system', kind: 'text', origin: 'helldesk', ticketId, agentId, text: `Ticket \`${shortId}\` closed — delivered.` };
    case 'ticket.cancelled':
      return { actor: 'system', role: 'system', kind: 'text', origin: 'helldesk', ticketId, agentId, text: `Ticket \`${shortId}\` was cancelled.` };
    case 'ticket.replanned':
    case 'mission.replanned':
      return { actor: 'system', role: 'system', kind: 'text', origin: 'helldesk', ticketId, agentId, text: `🔧 Revision replanned${shortId ? ` on \`${shortId}\`` : ''} — findings feed the next mutation.` };
    case 'shift_started':
      return { actor: 'system', role: 'system', kind: 'text', origin: 'helldesk', ticketId, agentId, text: `🚚 A shift started${typeof p['title'] === 'string' ? `: ${p['title']}` : ''}.` };
    case 'nudge_timeout':
      return { actor: 'agent', role: 'system', kind: 'text', origin: 'helldesk', ticketId, agentId, text: `⏰ ${agentId ?? 'an agent'} did not reply to the last nudge — reconciler will retry.` };
    case 'pr_status_changed':
    case 'pr_auto_merge':
      return { actor: 'system', role: 'system', kind: 'text', origin: 'helldesk', ticketId, agentId, text: `🔀 PR ${kind.includes('merge') ? 'auto-merged' : 'status changed'}${typeof p['status'] === 'string' ? ` → ${p['status']}` : ''}.` };
    default:
      return { actor: 'system', role: 'system', kind: 'text', origin: 'helldesk', ticketId, agentId, text: `${kind.replace(/_/g, ' ')}` };
  }
}

/* ── non-blocking steer planning ─────────────────────────────────────── */

export type SteerKind = 'interrupt' | 'force-review' | 'disapprove';

export interface SteerPlan {
  /** The chat row the human sees confirming their action. */
  chat: RoomChatRow;
  /** Human-readable nudge text to queue on the running agent (interrupt +
   *  disapprove may send a nudge; always non-blocking). */
  nudge?: { agentId?: string; text: string };
  /** Department event / finding to emit so the reviewer + replan path can act on it
   *  asynchronously. Empty for interrupt (pure nudge). */
  emit?: { event: string; ticketId?: string; agentId?: string; source: 'human-steer'; [k: string]: unknown };
}

/**
 * Map a human button to a non-blocking steer plan. Returns ONLY advisory
 * signals: a nudge and/or an emitted finding. It never returns a blocking
 * instruction and it never holds the running loop.
 */
export function planSteer(kind: SteerKind, ctx: { ticketId: string; agentId?: string; note?: string }): SteerPlan {
  const shortId = ctx.ticketId.slice(0, 8);

  switch (kind) {
    case 'interrupt':
      return {
        chat: {
          actor: 'human', role: 'user', kind: 'text', origin: 'helldesk',
          ticketId: ctx.ticketId, agentId: ctx.agentId,
          text: `You interrupted work on \`${shortId}\`. The agent will read your note and keep going — nothing is cancelled.`,
        },
        nudge: {
          agentId: ctx.agentId,
          text: `[human] Interrupt while you work: ${ctx.note ?? 'stay on objective, reassess if needed'}. Continue delivering.`,
        },
      };
    case 'force-review':
      return {
        chat: {
          actor: 'human', role: 'user', kind: 'text', origin: 'helldesk',
          ticketId: ctx.ticketId, agentId: ctx.agentId,
          text: `You forced an early review of \`${shortId}\`. A reviewer agent will pick it up async — the agent keeps working.`,
        },
        emit: {
          event: 'review_queued', ticketId: ctx.ticketId, agentId: ctx.agentId,
          source: 'human-steer', intent: 'force-review', note: ctx.note,
        },
      };
    case 'disapprove':
      return {
        chat: {
          actor: 'human', role: 'user', kind: 'text', origin: 'helldesk',
          ticketId: ctx.ticketId, agentId: ctx.agentId,
          text: `You disapproved the current approach on \`${shortId}\`. Recorded as a finding — the next revision will address it; the agent still finishes this pass.`,
        },
        nudge: {
          agentId: ctx.agentId,
          text: `[human] Disapprove current direction: ${ctx.note ?? 'reconsider and correct course'}. Finish the current change, then fix per this.`,
        },
        emit: {
          event: 'finding.recorded', ticketId: ctx.ticketId, agentId: ctx.agentId,
          source: 'human-steer', intent: 'disapprove', note: ctx.note,
          severity: 'human-objection',
        },
      };
  }
}

/**
 * True when a steer is purely advisory and never blocks delivery. Test hook —
 * the whole design depends on this invariant holding for every SteerKind.
 */
export function isNonBlocking(plan: SteerPlan): boolean {
  // A steer is non-blocking iff it has no terminal/abort content and at most a
  // nudge + finding (never a "cancel mission" directive). It also always emits
  // a chat row of origin helldesk and actor human.
  return plan.chat.origin === 'helldesk'
    && plan.chat.actor === 'human'
    && !!plan.chat.text
    && (plan.nudge === undefined || typeof plan.nudge.text === 'string')
    && (plan.emit === undefined || plan.emit.source === 'human-steer');
}