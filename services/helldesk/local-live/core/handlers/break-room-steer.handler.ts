/**
 * core/handlers/break-room-steer.handler.ts — the human-as-async-peer control surface.
 *
 * Non-blocking by construction: every steer maps to a nudge + a finding that a
 * reviewer agent / the reconler consumes asynchronously. Nothing here awaits a
 * running mutation or injects a blocking `AWAITING_*` state. Agent delivery is
 * never held; the buttons steer, they do not gate.
 *
 * It also exposes `bridgeRoomActivity`: subscribe a department's runtime eventBus and
 * publish every colony event (ticket state, agent, reviewer verdict) into the
 * department's ChatFabric, so the Discord-style BreakRoomChat shows agents + reviewer as
 * live chat rows alongside the human.
 */
import type { ChatFabric } from '../fabric/ChatFabric';
import {z} from 'zod';
import type { RuntimeEvent } from '../runtime/local-reconciler';
import { formatRoomEvent, planSteer, type RoomChatRow, type SteerKind } from '../breakRoom/room';

/** Minimal structural context the handler touches (Hono Context satisfies it). */
export type BreakRoomCtx = {
  req: { json(): Promise<unknown> };
  json: (body: unknown, status?: number | undefined) => Response;
};

interface SteerBody {
  kind?: string;
  ticketId?: string;
  agentId?: string;
  note?: string;
}

export interface BreakRoomSteerDeps {
  fabric: ChatFabric;
  /** Broadcast a runtime ticket/analytics event to the colony eventBus (non-blocking). */
  broadcast: (evt: { event: string; departmentId?: string; ticketId?: string; [k: string]: unknown }) => void;
  /** Queue a nudge to a running agent (non-blocking advisory; real department.queueNudge). */
  queueNudge: (agentId: string, message: string, opts?: { type?: string; metadata?: Record<string, unknown>; mode?: string; source?: string }) => Promise<string>;
  queueMissionSteer?: (ticketId:string,note:string,kind:SteerKind) => Promise<{ok:true;delivery:string}>;
}

function isSteerKind(k: string | undefined): k is SteerKind {
  return k === 'interrupt' || k === 'force-review' || k === 'disapprove';
}

/** POST /api/departments/:departmentId/breakRoom/steer — human steer button → async nudge + finding. */
export async function handleBreakRoomSteer(c: BreakRoomCtx, params: { departmentId: string }, deps: BreakRoomSteerDeps) {
  const parsed = z.object({kind:z.enum(['interrupt','force-review','disapprove']),ticketId:z.string().trim().min(1),agentId:z.string().min(1).optional(),note:z.string().max(16000).optional()}).safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success)return c.json({success:false,error:'Invalid steering request',issues:parsed.error.issues},400);
  const body = parsed.data;
  const { kind, ticketId, agentId, note } = body;
  if (!isSteerKind(kind)) {
    return c.json({ success: false, error: `kind must be one of interrupt | force-review | disapprove (got ${String(kind)})` }, 400);
  }
  if (!ticketId || typeof ticketId !== 'string' || !ticketId.trim()) {
    return c.json({ success: false, error: 'ticketId is required' }, 400);
  }

  const plan = planSteer(kind, { ticketId, agentId, note: note ?? '' });
  const warnings: string[] = [];
  let nudgeId: string | undefined;
  let signalEmitted = false;
  let missionDelivery: string | undefined;
  if(deps.queueMissionSteer){
    try {missionDelivery=(await deps.queueMissionSteer(ticketId,note||kind,kind)).delivery;}
    catch {return c.json({success:false,error:'Could not persist mission steering. Work continues; retry your message.'},503);}
  }

  // 1) Publish the human's steer as a chat row so the whole room sees it live.
  try {
    deps.fabric.publish({ role: plan.chat.role, kind: plan.chat.kind, text: plan.chat.text, origin: 'helldesk' });
  } catch { warnings.push('Room notification could not be published'); }

  // 2) Enqueue the advisory nudge (interrupt / disapprove steer the running agent).
  if (plan.nudge && plan.nudge.agentId) {
    try {
      nudgeId = await deps.queueNudge(plan.nudge.agentId, plan.nudge.text, { type: 'human-steer', source: 'human', mode:'queue' });
    } catch { warnings.push('Agent nudge could not be queued; retry your steering message'); }
  }

  // 3) Emit the finding / review-queue signal so reviewer + replan act async.
  if (plan.emit) {
    try {
      deps.broadcast({ ...plan.emit, departmentId: params.departmentId });
      signalEmitted = true;
    } catch { warnings.push('Review signal could not be emitted'); }
  }

  if(!nudgeId&&!missionDelivery)return c.json({success:false,error:agentId?'Steering was not queued':'Select the agent to receive your nudge',warnings},409);
  return c.json({ success: true, data: { kind, ticketId: plan.chat.ticketId, applied: 'async-nonblocking',nudgeId,signalEmitted,warnings,delivery:missionDelivery||'queued-not-acknowledged' } });
}

/**
 * Bridge a department's runtime event bus onto its ChatFabric as a live agent/reviewer
 * chat stream. Returns an unsubscribe. This is what makes the BreakRoomChat a real
 * "group" room: every colony actor speaks into it as a chat row, and the human
 * steers back.
 */
export function bridgeRoomActivity(
  departmentId: string,
  subscribe: (fn: (e: RuntimeEvent) => void) => () => void,
  fabric: ChatFabric,
  publishChat: (row: RoomChatRow) => void,
): () => void {
  return subscribe((evt) => {
    if (evt.departmentId !== departmentId) return;
    let row: RoomChatRow | null;
    try {
      row = formatRoomEvent(evt);
    } catch {
      row = null;
    }
    if (!row) return;
    try {
      // Publish the colony activity into the shared chat stream so every peer
      // (this dashboard, VSIX, CLI) sees agents speak. origin stays helldesk.
      publishChat(row);
      void fabric.publish({ role: row.role, kind: row.kind, text: row.text, origin: 'helldesk' });
    } catch { /* fail-open */ }
  });
}
