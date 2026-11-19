'use client';

import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Trash2 } from '@/lib/icons';
import { formatDistanceToNow } from 'date-fns';
import { motion, AnimatePresence } from 'motion/react';

export type KanbanTicket = {
  ticket_id: string;
  type: string;
  status: string;
  title: string;
  body: string | null;
  workstation_id?: string | null;
  assignee_agent_ticket_id: string | null;
  priority: string;
  labels: string[];
  created_at: string;
};

type TicketBoardProps = {
  tickets: KanbanTicket[];
  isLoading: boolean;
  onDeleteTicket?: (ticketId: string) => void;
  onSelectTicket?: (ticket: KanbanTicket) => void;
  onMoveTicket?: (ticket: KanbanTicket, status: string) => void;
  selectedTicketId?: string | null;
  agentNameById?: Record<string, string>;
  renderActions?: (ticket: KanbanTicket) => ReactNode;
  emptyLabel?: string;
};

const statusColumns = ['open', 'in_progress', 'in_review', 'closed', 'failed'] as const;

const statusLabels: Record<(typeof statusColumns)[number], string> = {
  open: 'Open',
  in_progress: 'In progress',
  in_review: 'In review',
  closed: 'Closed',
  failed: 'Failed',
};

const statusColors: Record<(typeof statusColumns)[number], string> = {
  open: 'border-cyan-400/25 bg-cyan-400/[0.07] text-cyan-200',
  in_progress: 'border-violet-400/25 bg-violet-400/[0.08] text-violet-200',
  in_review: 'border-fuchsia-300/25 bg-fuchsia-300/[0.07] text-fuchsia-100',
  closed: 'border-emerald-300/25 bg-emerald-300/[0.07] text-emerald-200',
  failed: 'border-red-300/25 bg-red-300/[0.07] text-red-200',
};

const priorityColors: Record<string, string> = {
  low: 'text-white/40',
  medium: 'text-sky-300',
  high: 'text-amber-300',
  critical: 'text-red-300',
};

function TicketCard({
  ticket,
  onDelete,
  onSelect,
  isSelected,
  agentNameById,
  actions,
}: {
  ticket: KanbanTicket;
  onDelete?: () => void;
  onSelect?: () => void;
  isSelected?: boolean;
  agentNameById?: Record<string, string>;
  actions?: ReactNode;
}) {
  const assigneeName = ticket.assignee_agent_ticket_id
    ? agentNameById?.[ticket.assignee_agent_ticket_id]
    : null;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onSelect) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
    }
  };

  return (
    <Card
      className={cn(
        'group overflow-hidden border-white/[0.08] bg-[linear-gradient(145deg,rgba(20,25,36,.94),rgba(10,13,20,.98))] shadow-[0_16px_42px_rgba(0,0,0,.22)] transition-[border-color,background-color,transform,box-shadow] hover:-translate-y-px hover:border-violet-300/20 hover:shadow-[0_18px_48px_rgba(0,0,0,.34)]',
        onSelect ? 'cursor-pointer' : 'cursor-default',
        isSelected ? 'border-teal-300/35 ring-1 ring-teal-300/15' : ''
      )}
    >
      <div
        role={onSelect ? 'button' : undefined}
        tabIndex={onSelect ? 0 : undefined}
        onClick={onSelect}
        onKeyDown={handleKeyDown}
        className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-300/30"
      >
        <CardContent className="p-3.5">
          <div className="mb-2 flex items-start justify-between gap-3">
            <h4 className="line-clamp-2 text-[13px] font-semibold leading-[1.35] tracking-[-0.015em] text-white/90">
              {ticket.title}
            </h4>
            <div className="flex shrink-0 items-center gap-1.5">
              <span className={cn('text-[10px] font-semibold uppercase tracking-[.08em]', priorityColors[ticket.priority] ?? 'text-white/35')}>
                {ticket.priority}
              </span>
              {onDelete && (
                <button
                  type="button"
                  aria-label="Delete ticket"
                  onClick={e => {
                    e.stopPropagation();
                    onDelete();
                  }}
                  className="rounded-md p-1 text-white/25 transition-colors hover:bg-red-400/10 hover:text-red-200"
                >
                  <Trash2 className="size-3" />
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="border-white/[0.08] bg-white/[0.025] text-[9px] text-white/45">
              {ticket.type}
            </Badge>
            <span className="font-mono text-[9px] text-white/25">{ticket.ticket_id.slice(0, 8)}</span>
            <span className="text-[9px] text-white/25">
              {formatDistanceToNow(new Date(ticket.created_at), { addSuffix: true })}
            </span>
          </div>

          {assigneeName && (
            <div className="mt-2 text-[10px] text-white/35">
              <span className="text-white/20">agent</span> {assigneeName}
            </div>
          )}

          {ticket.labels.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {ticket.labels.slice(0, 4).map(label => (
                <Badge key={label} variant="secondary" className="bg-white/[0.035] text-[9px] text-white/35">
                  {label}
                </Badge>
              ))}
            </div>
          )}

          {actions && <div className="mt-3 border-t border-white/[0.05] pt-2">{actions}</div>}
        </CardContent>
      </div>
    </Card>
  );
}

export function TicketBoard({
  tickets,
  isLoading,
  onDeleteTicket,
  onSelectTicket,
  onMoveTicket,
  selectedTicketId,
  agentNameById,
  renderActions,
  emptyLabel = 'No tickets',
}: TicketBoardProps) {
  if (isLoading) {
    return (
      <div className="grid min-w-[1120px] grid-cols-5 gap-3">
        {statusColumns.map(status => (
          <div key={status}>
            <Skeleton className="mb-3 h-6 w-24" />
            <div className="space-y-2">
              <Skeleton className="h-24 w-full rounded-xl" />
              <Skeleton className="h-24 w-full rounded-xl" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  const ticketById = new Map(tickets.map(ticket => [ticket.ticket_id, ticket]));

  return (
    <div className="min-w-[1120px] grid-cols-5 gap-3 lg:grid">
      {statusColumns.map((status, colIdx) => {
        const columnTickets = tickets.filter(ticket => ticket.status === status && ticket.type !== 'agent' && ticket.type !== 'message');
        return (
          <motion.section
            key={status}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: colIdx * 0.035, duration: 0.22 }}
            onDragOver={event => {
              if (!onMoveTicket) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }}
            onDrop={event => {
              if (!onMoveTicket) return;
              event.preventDefault();
              const ticket = ticketById.get(event.dataTransfer.getData('application/x-helldesk-ticket'));
              if (ticket && ticket.status !== status) onMoveTicket(ticket, status);
            }}
            className="min-h-[260px] rounded-2xl border border-white/[0.055] bg-white/[0.015] p-2.5"
          >
            <div className="mb-2.5 flex items-center justify-between gap-2 px-1">
              <span className={cn('rounded-lg border px-2 py-1 text-[10px] font-semibold uppercase tracking-[.08em]', statusColors[status])}>
                {statusLabels[status]}
              </span>
              <motion.span
                key={columnTickets.length}
                initial={{ scale: 1.2, opacity: 0.5 }}
                animate={{ scale: 1, opacity: 1 }}
                className="font-mono text-[10px] text-white/30"
              >
                {columnTickets.length}
              </motion.span>
            </div>
            <div className="space-y-2">
              <AnimatePresence mode="popLayout" initial={false}>
                {columnTickets.length === 0 && (
                  <motion.div
                    key="empty"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="rounded-xl border border-dashed border-white/[0.05] px-3 py-8 text-center text-[10px] text-white/20"
                  >
                    {emptyLabel}
                  </motion.div>
                )}
                {columnTickets.map(ticket => (
                  <motion.div
                    key={ticket.ticket_id}
                    layout
                    draggable={Boolean(onMoveTicket)}
                    onDragStart={event => {
                      if (!onMoveTicket) return;
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('application/x-helldesk-ticket', ticket.ticket_id);
                    }}
                    initial={{ opacity: 0, scale: 0.98, y: 5 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98, y: -5 }}
                    transition={{ layout: { duration: 0.2 }, opacity: { duration: 0.14 } }}
                    className={onMoveTicket ? 'cursor-grab active:cursor-grabbing' : ''}
                  >
                    <TicketCard
                      ticket={ticket}
                      onDelete={onDeleteTicket ? () => onDeleteTicket(ticket.ticket_id) : undefined}
                      onSelect={onSelectTicket ? () => onSelectTicket(ticket) : undefined}
                      isSelected={selectedTicketId === ticket.ticket_id}
                      agentNameById={agentNameById}
                      actions={renderActions?.(ticket)}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </motion.section>
        );
      })}
    </div>
  );
}
