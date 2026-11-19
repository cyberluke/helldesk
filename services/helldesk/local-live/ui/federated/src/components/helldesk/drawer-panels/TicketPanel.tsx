'use client';

import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Badge } from '@/components/ui/badge';
import { TicketEventTimeline } from '@/components/helldesk/ActivityFeed';
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
  push,
}: {
  ticketId: string;
  workstationId: string;
  push: (ref: ResourceRef) => void;
}) {
  const trpc = useTRPC();
  const ticketsQuery = useQuery(trpc.helldesk.listTickets.queryOptions({ workstationId }));
  const agentsQuery = useQuery(trpc.helldesk.listAgents.queryOptions({ workstationId }));
  const workstationQuery = useQuery(trpc.helldesk.getWorkstation.queryOptions({ workstationId }));

  const ticket = (ticketsQuery.data ?? []).find(b => b.ticket_id === ticketId);
  const agentNameById = (agentsQuery.data ?? []).reduce<Record<string, string>>((acc, a) => {
    acc[a.id] = a.name;
    return acc;
  }, {});

  if (!ticket) {
    return <div className="p-6 text-center text-sm text-white/30">Loading ticket…</div>;
  }

  const assigneeName = ticket.assignee_agent_ticket_id
    ? agentNameById[ticket.assignee_agent_ticket_id]
    : null;

  const departmentId = workstationQuery.data?.department_id;

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
            onClick={() => push({ type: 'ticket', ticketId: ticket.parent_ticket_id ?? '', workstationId })}
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
                onClick={() => push({ type: 'ticket', ticketId: rel.ticket.ticket_id, workstationId })}
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
        <TicketEventTimeline workstationId={workstationId} ticketId={ticket.ticket_id} />
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
