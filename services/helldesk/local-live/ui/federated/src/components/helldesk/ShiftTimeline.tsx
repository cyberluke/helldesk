'use client';

import { useMemo } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';
import { Hexagon, AlertTriangle, CheckCircle, Loader2 } from '@/lib/icons';
import { motion } from 'motion/react';

type RouterOutputs = inferRouterOutputs<RootRouter>;
type Ticket = RouterOutputs['helldesk']['listTickets'][number];

type ShiftTimelineProps = {
  /** All tickets from a workstation (or across workstations) */
  tickets: Ticket[];
  agentNameById: Record<string, string>;
  onSelectTicket?: (ticketId: string) => void;
};

const STATUS_COLORS: Record<string, string> = {
  open: 'border-sky-500/40 bg-sky-500/15',
  in_progress: 'border-amber-500/40 bg-amber-500/15',
  closed: 'border-emerald-500/40 bg-emerald-500/15',
  failed: 'border-red-500/40 bg-red-500/15',
};

const STATUS_DOT_COLORS: Record<string, string> = {
  open: 'bg-sky-400',
  in_progress: 'bg-amber-400',
  closed: 'bg-emerald-400',
  failed: 'bg-red-400',
};

/**
 * Horizontal timeline showing ticket completion events over time.
 * Groups tickets by parent_ticket_id to form "shifts".
 */
export function ShiftTimeline({ tickets, agentNameById, onSelectTicket }: ShiftTimelineProps) {
  // Group into shifts by parent_ticket_id
  const shifts = useMemo(() => {
    const groups: Record<string, Ticket[]> = {};
    const standalone: Ticket[] = [];

    for (const ticket of tickets) {
      if (ticket.parent_ticket_id) {
        const key = ticket.parent_ticket_id;
        groups[key] ??= [];
        groups[key].push(ticket);
      } else {
        standalone.push(ticket);
      }
    }

    const result: Array<{ id: string; label: string; tickets: Ticket[]; isShift: boolean }> = [];

    // Add actual shifts
    for (const [parentId, children] of Object.entries(groups)) {
      const parent = tickets.find(b => b.ticket_id === parentId);
      result.push({
        id: parentId,
        label: parent?.title ?? `Shift ${parentId.slice(0, 8)}`,
        tickets: children.sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        ),
        isShift: true,
      });
    }

    // Add standalone tickets as single-ticket "shifts"
    for (const ticket of standalone) {
      if (!groups[ticket.ticket_id]) {
        result.push({
          id: ticket.ticket_id,
          label: ticket.title,
          tickets: [ticket],
          isShift: false,
        });
      }
    }

    return result;
  }, [tickets]);

  if (tickets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <Hexagon className="mb-2 size-6 text-white/10" />
        <p className="text-xs text-white/25">No tickets to visualize.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {shifts.map(shift => {
        const completedCount = shift.tickets.filter(b => b.status === 'closed').length;
        const total = shift.tickets.length;
        const hasStalled = shift.tickets.some(b => b.status === 'open' && !b.assignee_agent_ticket_id);

        return (
          <div
            key={shift.id}
            className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3"
          >
            {/* Shift header */}
            <div className="mb-2.5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                {shift.isShift && (
                  <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-medium text-white/40">
                    shift
                  </span>
                )}
                <span className="max-w-[300px] truncate text-xs font-medium text-white/70">
                  {shift.label}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {hasStalled && (
                  <span className="flex items-center gap-1 text-[9px] text-orange-400">
                    <AlertTriangle className="size-2.5" />
                    Stranded
                  </span>
                )}
                <span className="font-mono text-[10px] text-white/30">
                  {completedCount}/{total}
                </span>
              </div>
            </div>

            {/* Timeline track */}
            <div className="relative flex items-center gap-1 overflow-x-auto py-1">
              {/* Track line */}
              <div className="absolute top-1/2 right-0 left-0 h-px -translate-y-1/2 bg-white/[0.06]" />

              {shift.tickets.map((ticket, i) => {
                const assigneeName = ticket.assignee_agent_ticket_id
                  ? agentNameById[ticket.assignee_agent_ticket_id]
                  : null;

                return (
                  <motion.button
                    key={ticket.ticket_id}
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ delay: i * 0.06, duration: 0.25 }}
                    onClick={() => onSelectTicket?.(ticket.ticket_id)}
                    className={`relative z-10 flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[10px] transition-all hover:scale-105 ${STATUS_COLORS[ticket.status] ?? 'border-white/10 bg-white/[0.03]'}`}
                    title={`${ticket.title} (${ticket.status})`}
                  >
                    {ticket.status === 'closed' ? (
                      <CheckCircle className="size-3 text-emerald-400" />
                    ) : ticket.status === 'in_progress' ? (
                      <Loader2 className="size-3 animate-spin text-amber-400" />
                    ) : (
                      <span
                        className={`size-2 rounded-full ${STATUS_DOT_COLORS[ticket.status] ?? 'bg-white/20'}`}
                      />
                    )}
                    <span className="max-w-[80px] truncate text-white/70">
                      {ticket.title.slice(0, 20)}
                    </span>
                    {assigneeName && <span className="ml-0.5 text-white/30">{assigneeName}</span>}
                  </motion.button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Detects shifts where tickets are open but no agents are assigned.
 */
export function StrandedShiftAlert({ tickets, onSling }: { tickets: Ticket[]; onSling?: () => void }) {
  const strandedTickets = tickets.filter(b => b.status === 'open' && !b.assignee_agent_ticket_id);

  if (strandedTickets.length === 0) return null;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-orange-500/20 bg-orange-500/5 px-4 py-2.5">
      <AlertTriangle className="size-4 shrink-0 text-orange-400" />
      <div className="flex-1">
        <span className="text-xs font-medium text-orange-300">
          {strandedTickets.length} stranded ticket{strandedTickets.length > 1 ? 's' : ''}
        </span>
        <span className="ml-1 text-[10px] text-orange-400/60">— open but no agent assigned</span>
      </div>
      {onSling && (
        <button
          onClick={onSling}
          className="rounded-md bg-orange-500/15 px-3 py-1 text-[10px] font-medium text-orange-300 transition-colors hover:bg-orange-500/25"
        >
          Sling
        </button>
      )}
    </div>
  );
}
