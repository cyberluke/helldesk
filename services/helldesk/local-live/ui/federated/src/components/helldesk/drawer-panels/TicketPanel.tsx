'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { Badge } from '@/components/ui/badge';
import { TicketEventTimeline } from '@/components/helldesk/ActivityFeed';
import { MissionChat } from '@/components/helldesk/MissionChat';
import { TicketControls } from '@/components/helldesk/TicketControls';
import { MissionReportPanel } from '@/components/helldesk/MissionReportPanel';
import type { ResourceRef } from '@/components/helldesk/DrawerStack';

import { format } from 'date-fns';
import {
  Clock,
  Flag,
  Hash,
  Tags,
  User,
  Hexagon,
  FileText,
  GitBranch,
  ChevronRight,
  Bot,
  Network,
  ArrowDownRight,
  GitPullRequest,
  CircleDot,
  AlertTriangle,
  Play,
  Loader2,
  ShieldCheck,
  Layers,
} from '@/lib/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const STATUS_STYLES: Record<string, string> = {
  open: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  in_progress: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  closed: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  failed: 'border-red-500/30 bg-red-500/10 text-red-300',
};

const PRIORITY_STYLES: Record<string, string> = {
  critical: 'text-red-400',
  high: 'text-orange-400',
  medium: 'text-amber-400',
  low: 'text-white/50',
};

export function TicketPanel({
  ticketId,
  workstationId,
  departmentId: departmentIdProp,
  push,
}: {
  ticketId: string;
  workstationId?: string;
  departmentId?: string;
  push: (ref: ResourceRef) => void;
}) {
  const trpc = useTRPC();
  // Operator recovery state (engine resume); hooks must precede any early return.
  const [resuming, setResuming] = useState(false);
  const [sizeBusy, setSizeBusy] = useState(false);
  // A ticket drawer can open without workstation context (department board,
  // crew/global views). Workstation-scoped drawers query the seat lists;
  // department-scoped drawers query the department-wide lists (which include
  // the engine mission projection), so mission review/acceptance still works.
  const scoped = Boolean(workstationId);
  const deptId = departmentIdProp ?? 'default';
  const ticketsQuery = useQuery({
    ...(scoped
      ? trpc.helldesk.listTickets.queryOptions({ workstationId, includeArchived: true })
      : trpc.helldesk.listTickets.queryOptions({ departmentId: deptId, includeArchived: true })),
  });
  const agentsQuery = useQuery({
    ...(scoped
      ? trpc.helldesk.listAgents.queryOptions({ workstationId })
      : trpc.helldesk.listDepartmentAgents.queryOptions({ departmentId: deptId })),
  });
  const workstationQuery = useQuery({
    ...trpc.helldesk.getWorkstation.queryOptions({ workstationId: workstationId ?? '' }),
    enabled: scoped,
  });

  const ticket = (ticketsQuery.data ?? []).find(b => b.ticket_id === ticketId);
  const agentNameById = (agentsQuery.data ?? []).reduce<Record<string, string>>((acc, a) => {
    acc[a.id] = a.name;
    return acc;
  }, {});

  if (!ticket) {
    return (
      <div className="p-6 text-center text-sm text-white/30">
        {ticketsQuery.isLoading
          ? 'Loading ticket…'
          : scoped
            ? 'Ticket not found on this workstation.'
            : 'Ticket not found in this department.'}
      </div>
    );
  }

  const assigneeName = ticket.assignee_agent_ticket_id
    ? agentNameById[ticket.assignee_agent_ticket_id]
    : null;

  // Mission-owned tickets carry the mission id in ticket_id (mis_*) or in
  // metadata.local_mission.missionId. Only those get the real Kilo chat.
  const missionId = (() => {
    if (typeof ticket.ticket_id === 'string' && ticket.ticket_id.startsWith('mis_')) return ticket.ticket_id;
    const meta = (ticket as { metadata?: unknown }).metadata;
    if (meta && typeof meta === 'object') {
      const local = (meta as { local_mission?: unknown }).local_mission;
      if (local && typeof local === 'object') {
        const mid = (local as { missionId?: unknown }).missionId;
        if (typeof mid === 'string' && mid.startsWith('mis_')) return mid;
      }
    }
    return undefined;
  })();

  // Engine truth for a mission card. The board column may be an operator overlay
  // (see mission-reconcile); the real mission STATE is always engine-owned.
  const engineState = (() => {
    const meta = (ticket as { metadata?: unknown }).metadata;
    if (!meta || typeof meta !== 'object') return null;
    const state = (meta as { engine_state?: unknown }).engine_state;
    return typeof state === 'string' ? state : null;
  })();
  // Runtime detail (revision + review job) so EVIDENCE_CAPTURED / REVIEWING_A_B /
  // ADJUDICATING / INCONCLUSIVE are visible, not just the coarse engine state.
  const metaForRuntime = (ticket as { metadata?: unknown }).metadata;
  const metaObj = metaForRuntime && typeof metaForRuntime === 'object' ? (metaForRuntime as Record<string, unknown>) : {};
  const revisionState = typeof metaObj.revision_state === 'string' ? metaObj.revision_state : null;
  const revisionNo = typeof metaObj.revision_no === 'number' ? metaObj.revision_no : null;
  const reviewJobState = typeof metaObj.review_job_state === 'string' ? metaObj.review_job_state : null;
  const engineBlocked = !!engineState && ['BLOCKED_EXTERNAL', 'BLOCKED', 'CANCELLED', 'REJECTED', 'FAILED_TERMINAL'].includes(engineState);
  const resumeMission = async () => {
    if (!missionId || resuming) return;
    setResuming(true);
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !body?.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      toast.success('Mission resumed — the engine will dispatch it again');
      await ticketsQuery.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setResuming(false);
    }
  };

  const departmentId = departmentIdProp ?? workstationQuery.data?.department_id ?? deptId;

  // Build related tickets from the flat list (no extra API needed)
  const allTickets = ticketsQuery.data ?? [];
  const relatedTickets = buildRelatedTickets(ticket, allTickets);

  return (
    <div className="flex flex-col gap-0">
      {/* Title area */}
      <div className="border-b border-white/[0.06] px-5 pt-4 pb-4">
        <div className="flex items-center gap-2 text-base font-semibold text-white/90">
          <Hexagon className="size-4 shrink-0 text-[color:oklch(95%_0.15_108_/_0.7)]" />
          <span className="truncate">{ticket.title}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLES[ticket.status] ?? 'border-white/10 text-white/50'}`}
          >
            {ticket.status.replace('_', ' ')}
          </span>
          <Badge variant="outline" className="text-[10px]">
            {ticket.type}
          </Badge>
          <span
            className={`inline-flex items-center gap-0.5 text-[10px] font-medium ${PRIORITY_STYLES[ticket.priority] ?? 'text-white/50'}`}
          >
            <Flag className="size-2.5" />
            {ticket.priority}
          </span>
        </div>
      </div>

      {/* Metadata grid */}
      <div className="grid grid-cols-2 border-b border-white/[0.06]">
        <MetaCell icon={Hash} label="Ticket ID" value={ticket.ticket_id.slice(0, 8)} mono />
        <MetaCell
          icon={Clock}
          label="Created"
          value={format(new Date(ticket.created_at), 'MMM d, HH:mm')}
        />

        {/* Assignee — clickable to open agent drawer */}
        {ticket.assignee_agent_ticket_id ? (
          <button
            onClick={() => {
              if (departmentId) {
                push({
                  type: 'agent',
                  agentId: ticket.assignee_agent_ticket_id ?? '',
                  workstationId,
                  departmentId,
                });
              }
            }}
            className="group/link flex flex-col border-r border-b border-white/[0.04] px-4 py-3 text-left transition-colors hover:bg-white/[0.03] [&:nth-child(2n)]:border-r-0"
          >
            <div className="flex items-center gap-1 text-[10px] text-white/30">
              <User className="size-3" />
              Assignee
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-sm text-[color:oklch(95%_0.15_108)]">
              <Bot className="size-3" />
              <span className="truncate">
                {assigneeName ?? ticket.assignee_agent_ticket_id.slice(0, 8)}
              </span>
              <ChevronRight className="size-3 shrink-0 text-white/15 transition-colors group-hover/link:text-white/30" />
            </div>
          </button>
        ) : (
          <MetaCell icon={User} label="Assignee" value="Unassigned" />
        )}

        <MetaCell
          icon={Tags}
          label="Labels"
          value={ticket.labels.length ? ticket.labels.join(', ') : 'None'}
        />

        {/* Parent ticket — clickable */}
        {ticket.parent_ticket_id && (
          <button
            onClick={() => push({ type: 'ticket', ticketId: ticket.parent_ticket_id ?? '', workstationId, departmentId })}
            className="group/link flex flex-col border-r border-b border-white/[0.04] px-4 py-3 text-left transition-colors hover:bg-white/[0.03] [&:nth-child(2n)]:border-r-0"
          >
            <div className="flex items-center gap-1 text-[10px] text-white/30">
              <GitBranch className="size-3" />
              Parent Ticket
            </div>
            <div className="mt-0.5 flex items-center gap-1 font-mono text-xs text-[color:oklch(95%_0.15_108)]">
              <span>{ticket.parent_ticket_id.slice(0, 8)}</span>
              <ChevronRight className="size-3 shrink-0 text-white/15 transition-colors group-hover/link:text-white/30" />
            </div>
          </button>
        )}
      </div>

      {/* Related Tickets DAG */}
      {relatedTickets.length > 0 && (
        <div className="border-b border-white/[0.06] px-5 py-4">
          <div className="mb-3 flex items-center gap-1.5">
            <Network className="size-3 text-white/25" />
            <span className="text-[10px] font-medium tracking-wide text-white/30 uppercase">
              Related Tickets
            </span>
          </div>
          <div className="flex flex-col gap-1">
            {relatedTickets.map(rel => (
              <button
                key={`${rel.relation}-${rel.ticket.ticket_id}`}
                onClick={() => push({ type: 'ticket', ticketId: rel.ticket.ticket_id, workstationId, departmentId })}
                className="group/rel flex items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-white/[0.04]"
              >
                <rel.icon className="size-3.5 shrink-0 text-white/30" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-medium text-white/35">{rel.label}</span>
                    <Badge variant="outline" className="px-1 py-0 text-[9px]">
                      {rel.ticket.type.replace('_', ' ')}
                    </Badge>
                    <span
                      className={`ml-auto inline-flex items-center rounded-md border px-1.5 py-0 text-[9px] font-medium ${STATUS_STYLES[rel.ticket.status] ?? 'border-white/10 text-white/50'}`}
                    >
                      {rel.ticket.status.replace('_', ' ')}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1">
                    <span className="truncate text-xs text-white/65">{rel.ticket.title}</span>
                    <ChevronRight className="size-3 shrink-0 text-white/10 transition-colors group-hover/rel:text-white/25" />
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Engine truth: a mission card's column may be the operator's overlay, but
          the mission STATE is always engine-owned. Recovery lives here. */}
      {missionId && engineState && (
        <div
          className={`flex items-center gap-2 border-b px-5 py-2.5 text-[11px] ${
            engineBlocked
              ? 'border-amber-300/15 bg-amber-300/[0.06] text-amber-200/80'
              : 'border-white/[0.06] text-white/40'
          }`}
        >
          <AlertTriangle className="size-3.5 shrink-0" />
          <span>
            Engine state: <span className="font-mono text-white/75">{engineState}</span>
          </span>
          {revisionNo != null && <span className="font-mono text-white/30">· rev {revisionNo}/{revisionState ?? '?'}</span>}
          {reviewJobState && <span className="font-mono text-white/30">· review {reviewJobState}</span>}
          {engineState !== ticket.status && <span className="text-white/25">· board column is your overlay</span>}
          {engineBlocked && (
            <button
              type="button"
              onClick={() => void resumeMission()}
              disabled={resuming}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-amber-300/25 bg-amber-300/10 px-2 py-1 font-medium text-amber-100/90 disabled:opacity-40"
            >
              {resuming ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
              Resume
            </button>
          )}
        </div>
      )}

      {/* Per-task review controls: live Governor / Reviewer A / Reviewer B / Agents */}
      <div className="border-b border-white/[0.06] px-5 py-4">
        <div className="mb-2 flex items-center gap-1.5">
          <ShieldCheck className="size-3 text-white/25" />
          <span className="text-[10px] font-medium tracking-wide text-white/30 uppercase">
            Task Controls
          </span>
        </div>
        <TicketControls
          departmentId={departmentId}
          ticket={ticket}
          variant="panel"
          onUpdated={() => void ticketsQuery.refetch()}
        />
      </div>

      {/* Story size for LOCAL tickets (mission tickets are sized in the report). */}
      {!missionId && departmentId ? (
        <div className="border-b border-white/[0.06] px-5 py-3">
          <div className="mb-2 flex items-center gap-1.5">
            <Layers className="size-3 text-white/25" />
            <span className="text-[10px] font-medium tracking-wide text-white/30 uppercase">Story size</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={typeof metaObj.tshirt_size === 'string' ? metaObj.tshirt_size : ''}
              disabled={sizeBusy}
              onChange={async event => {
                const tshirt = event.target.value;
                if (!tshirt) return;
                setSizeBusy(true);
                try {
                  const response = await fetch(
                    `/api/departments/${encodeURIComponent(departmentId)}/tickets/${encodeURIComponent(ticketId)}/size`,
                    {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ tshirt }),
                    },
                  );
                  if (!response.ok) throw new Error(`HTTP ${response.status}`);
                  toast.success(`Story size set to ${tshirt}`);
                  await ticketsQuery.refetch();
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : 'Could not update the story size');
                } finally {
                  setSizeBusy(false);
                }
              }}
              className="rounded-md border border-white/[0.08] bg-black/20 px-2 py-1 text-[10px] text-white/70 focus:border-teal-300/30 focus:outline-none disabled:opacity-50"
            >
              <option value="">{typeof metaObj.story_points === 'number' ? 'override…' : 'size…'}</option>
              {['XS', 'S', 'M', 'L', 'XL', 'XXL'].map(size => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
            <span className="font-mono text-[11px] text-white/60">
              {typeof metaObj.story_points === 'number' ? `${metaObj.story_points} pts` : '— pts'}
            </span>
            {typeof metaObj.size_rationale === 'string' ? (
              <span className="min-w-0 flex-1 truncate text-[9px] text-white/25" title={metaObj.size_rationale}>
                {metaObj.size_rationale}
              </span>
            ) : (
              <span className="text-[9px] text-white/20">
                {typeof metaObj.sizing_state === 'string' && metaObj.sizing_state !== 'sized'
                  ? `sizing: ${metaObj.sizing_state}`
                  : 'auto-sized at creation'}
              </span>
            )}
          </div>
        </div>
      ) : null}

      {/* Durable completion record + human acceptance gate */}
      {missionId ? <MissionReportPanel missionId={missionId} onUpdated={() => void ticketsQuery.refetch()} /> : null}

      {/* Body (markdown) */}
      {ticket.body && ticket.body.trim().length > 0 && (
        <div className="border-b border-white/[0.06] px-5 py-4">
          <div className="mb-2 flex items-center gap-1.5">
            <FileText className="size-3 text-white/25" />
            <span className="text-[10px] font-medium tracking-wide text-white/30 uppercase">
              Description
            </span>
          </div>
          <div className="prose prose-sm prose-invert prose-headings:text-white/80 prose-p:text-white/65 prose-a:text-[color:oklch(95%_0.15_108)] prose-strong:text-white/80 prose-code:rounded prose-code:bg-white/[0.06] prose-code:px-1 prose-code:py-0.5 prose-code:text-[11px] prose-code:text-white/70 prose-pre:bg-white/[0.04] prose-pre:border prose-pre:border-white/[0.06] prose-li:text-white/65 max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{ticket.body}</ReactMarkdown>
          </div>
        </div>
      )}

      {/* REAL Kilo conversation (mission-owned tickets only) */}
      {missionId && (
        <div className="border-b border-white/[0.06] px-5 py-4">
          <MissionChat missionId={missionId} />
        </div>
      )}

      {/* Event Timeline */}
      <div className="px-5 pt-4 pb-2">
        <div className="mb-2 flex items-center gap-1.5">
          <Clock className="size-3 text-white/25" />
          <span className="text-[10px] font-medium tracking-wide text-white/30 uppercase">
            Event Timeline
          </span>
        </div>
      </div>
      <div className="px-3 pb-6">
        {scoped ? (
          <TicketEventTimeline workstationId={workstationId ?? ''} ticketId={ticket.ticket_id} />
        ) : (
          <p className="px-2 text-xs text-white/30">
            Mission events are in the report and conversation above.
          </p>
        )}
      </div>
    </div>
  );
}

function MetaCell({
  icon: Icon,
  label,
  value,
  mono,
}: {
  icon: typeof Clock;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="border-r border-b border-white/[0.04] px-4 py-3 [&:nth-child(2n)]:border-r-0">
      <div className="flex items-center gap-1 text-[10px] text-white/30">
        <Icon className="size-3" />
        {label}
      </div>
      <div className={`mt-0.5 truncate text-sm text-white/75 ${mono ? 'font-mono text-xs' : ''}`}>
        {value}
      </div>
    </div>
  );
}

// ── Related tickets DAG ─────────────────────────────────────────────────

type TicketLike = {
  ticket_id: string;
  type: string;
  status: string;
  title: string;
  parent_ticket_id: string | null;
  metadata: Record<string, unknown>;
};

type RelatedTicket = {
  relation: string;
  label: string;
  icon: typeof Clock;
  ticket: TicketLike;
};

/** Compute the DAG neighborhood of a ticket from the flat list. */
function buildRelatedTickets(ticket: TicketLike, allTickets: TicketLike[]): RelatedTicket[] {
  const related: RelatedTicket[] = [];

  // Parent ticket (already shown in metadata grid, but include in DAG for completeness)
  // Skip — the metadata grid already renders a clickable parent link.

  // Child tickets (tickets whose parent_ticket_id = this ticket)
  for (const b of allTickets) {
    if (b.parent_ticket_id === ticket.ticket_id) {
      related.push({ relation: 'child', label: 'Child', icon: ArrowDownRight, ticket: b });
    }
  }

  // For merge_request tickets: link back to the source ticket
  if (ticket.type === 'merge_request' && typeof ticket.metadata?.source_ticket_id === 'string') {
    const source = allTickets.find(b => b.ticket_id === ticket.metadata.source_ticket_id);
    if (source) {
      related.push({ relation: 'source', label: 'Source Work', icon: CircleDot, ticket: source });
    }
  }

  // For non-MR tickets: find any MR tickets that track this ticket
  if (ticket.type !== 'merge_request') {
    for (const b of allTickets) {
      if (b.type === 'merge_request' && b.metadata?.source_ticket_id === ticket.ticket_id) {
        related.push({ relation: 'review', label: 'Review', icon: GitPullRequest, ticket: b });
      }
    }
  }

  // Tickets that share the same parent (siblings) — skip, too noisy for now

  return related;
}

