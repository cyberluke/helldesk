'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/Button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { TicketEventTimeline } from '@/components/helldesk/ActivityFeed';
import { cn } from '@/lib/utils';
import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';
import { formatDistanceToNow } from 'date-fns';
import { Clock, Flag, Hash, Tags, User } from '@/lib/icons';

type RouterOutputs = inferRouterOutputs<RootRouter>;
type Ticket = RouterOutputs['helldesk']['listTickets'][number];

type HelldeskTicketDetailSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticket: Ticket | null;
  workstationId: string;
  agentNameById?: Record<string, string>;
  onDelete?: () => void;
};

function MetaRow({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Clock;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 size-4 text-white/40" />
      <div className="min-w-0">
        <div className="text-xs text-white/45">{label}</div>
        <div className="truncate text-sm text-white/85">{value}</div>
      </div>
    </div>
  );
}

export function HelldeskTicketDetailSheet({
  open,
  onOpenChange,
  ticket,
  workstationId,
  agentNameById,
  onDelete,
}: HelldeskTicketDetailSheetProps) {
  const assigneeName = ticket?.assignee_agent_ticket_id
    ? agentNameById?.[ticket.assignee_agent_ticket_id]
    : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn(
          'w-[540px] max-w-[92vw] border-white/10 bg-[color:oklch(0.155_0_0)]',
          'shadow-[0_30px_120px_-70px_rgba(0,0,0,0.95)]'
        )}
      >
        <SheetHeader className="gap-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <SheetTitle className="truncate text-base text-white/90">
                {ticket?.title ?? 'Ticket'}
              </SheetTitle>
              <SheetDescription className="mt-1 text-xs text-white/45">
                Click-through audit trail: events, status changes, hooks, and memo.
              </SheetDescription>
            </div>
            {onDelete && ticket && (
              <Button
                variant="secondary"
                size="sm"
                onClick={onDelete}
                className="shrink-0 border border-red-500/25 bg-red-500/10 text-red-200 hover:bg-red-500/15"
              >
                Delete
              </Button>
            )}
          </div>

          {ticket && (
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-xs">
                {ticket.type}
              </Badge>
              <Badge variant="secondary" className="text-xs">
                {ticket.status}
              </Badge>
              <Badge variant="outline" className="text-xs">
                <Flag className="size-3" />
                {ticket.priority}
              </Badge>
            </div>
          )}
        </SheetHeader>

        <div className="space-y-4 px-4">
          {!ticket ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-white/50">
              Select a ticket to inspect details.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <MetaRow icon={Hash} label="Ticket ID" value={ticket.ticket_id} />
                <MetaRow
                  icon={Clock}
                  label="Created"
                  value={formatDistanceToNow(new Date(ticket.created_at), { addSuffix: true })}
                />
                <MetaRow
                  icon={User}
                  label="Assignee"
                  value={
                    assigneeName ??
                    (ticket.assignee_agent_ticket_id ? ticket.assignee_agent_ticket_id : 'Unassigned')
                  }
                />
                <MetaRow
                  icon={Tags}
                  label="Labels"
                  value={ticket.labels.length ? ticket.labels.join(', ') : 'None'}
                />
              </div>

              {ticket.body && ticket.body.trim().length > 0 && (
                <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                  <div className="text-xs font-medium tracking-wide text-white/55">Body</div>
                  <div className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-white/80">
                    {ticket.body}
                  </div>
                </div>
              )}

              <div className="rounded-2xl border border-white/10 bg-white/[0.02]">
                <div className="border-b border-white/10 px-4 py-3">
                  <div className="text-xs font-medium tracking-wide text-white/55">
                    Event Timeline
                  </div>
                  <div className="mt-1 text-xs text-white/40">
                    Append-only ledger for this ticket.
                  </div>
                </div>
                <TicketEventTimeline workstationId={workstationId} ticketId={ticket.ticket_id} />
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
