'use client';

import { Drawer } from 'vaul';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Badge } from '@/components/ui/badge';
import { TicketEventTimeline } from '@/components/helldesk/ActivityFeed';
import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';
import { format, formatDistanceToNow } from 'date-fns';
import {
  X,
  Bot,
  Crown,
  Shield,
  Eye,
  Hash,
  Clock,
  Hexagon,
  Terminal,
  Zap,
  Activity,
} from '@/lib/icons';

type RouterOutputs = inferRouterOutputs<RootRouter>;
type Agent = RouterOutputs['helldesk']['listAgents'][number];
type Ticket = RouterOutputs['helldesk']['listTickets'][number];

type AgentDetailDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: Agent | null;
  workstationId?: string;
  onConnect?: (agentId: string, agentName: string) => void;
  onDelete?: () => void;
};

const ROLE_ICONS: Record<string, typeof Bot> = {
  soul: Bot,
  frontDesk: Crown,
  qualityAssurance: Shield,
  complianceWitness: Eye,
};

const STATUS_DOT: Record<string, string> = {
  idle: 'bg-white/25',
  working: 'bg-emerald-400',
  stalled: 'bg-amber-400',
  dead: 'bg-red-400',
};

const STATUS_LABEL: Record<string, string> = {
  idle: 'Idle',
  working: 'Working',
  stalled: 'Stalled',
  dead: 'Dead',
};

export function AgentDetailDrawer({
  open,
  onOpenChange,
  agent,
  workstationId,
  onConnect,
  onDelete,
}: AgentDetailDrawerProps) {
  const trpc = useTRPC();

  // Fetch related tickets for this agent
  const ticketsQuery = useQuery({
    ...trpc.helldesk.listTickets.queryOptions({ workstationId: workstationId ?? '' }),
    enabled: open && Boolean(agent) && Boolean(workstationId),
    refetchInterval: 8_000,
  });

  const relatedTickets = (ticketsQuery.data ?? []).filter(b => b.assignee_agent_ticket_id === agent?.id);

  const RoleIcon = agent ? (ROLE_ICONS[agent.role] ?? Bot) : Bot;

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} direction="right">
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Drawer.Content
          className="fixed top-0 right-0 bottom-0 z-50 flex w-[480px] max-w-[94vw] flex-col outline-none"
          style={{ '--initial-transform': 'calc(100% + 8px)' } as React.CSSProperties}
        >
          <div className="flex h-full flex-col overflow-hidden rounded-l-2xl border-l border-white/[0.08] bg-[oklch(0.12_0_0)]">
            {/* Header */}
            <div className="flex items-start justify-between border-b border-white/[0.06] px-5 pt-5 pb-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3">
                  <div className="flex size-10 items-center justify-center rounded-xl bg-white/[0.05] ring-1 ring-white/[0.08]">
                    <RoleIcon className="size-5 text-white/50" />
                  </div>
                  <div>
                    <Drawer.Title className="text-base font-semibold text-white/90">
                      {agent?.name ?? 'Agent'}
                    </Drawer.Title>
                    <Drawer.Description className="mt-0.5 flex items-center gap-2 text-xs text-white/35">
                      <span className="capitalize">{agent?.role}</span>
                      {agent && (
                        <>
                          <span className="text-white/15">·</span>
                          <span className="flex items-center gap-1">
                            <span
                              className={`size-1.5 rounded-full ${STATUS_DOT[agent.status] ?? 'bg-white/20'}`}
                            />
                            {STATUS_LABEL[agent.status] ?? agent.status}
                          </span>
                        </>
                      )}
                    </Drawer.Description>
                  </div>
                </div>
              </div>

              <button
                onClick={() => onOpenChange(false)}
                className="rounded-md p-1.5 text-white/30 transition-colors hover:bg-white/5 hover:text-white/60"
              >
                <X className="size-4" />
              </button>
            </div>

            {/* Actions bar */}
            {agent && (
              <div className="flex items-center gap-2 border-b border-white/[0.06] px-5 py-3">
                {onConnect && (
                  <button
                    onClick={() => {
                      onConnect(agent.id, agent.name);
                      onOpenChange(false);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[color:oklch(95%_0.15_108_/_0.12)] px-3 py-1.5 text-xs font-medium text-[color:oklch(95%_0.15_108)] ring-1 ring-[color:oklch(95%_0.15_108_/_0.2)] transition-colors hover:bg-[color:oklch(95%_0.15_108_/_0.2)]"
                  >
                    <Terminal className="size-3.5" />
                    Connect
                  </button>
                )}
                {onDelete && (
                  <button
                    onClick={onDelete}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/8 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/15"
                  >
                    Delete
                  </button>
                )}
              </div>
            )}

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
              {!agent ? (
                <div className="p-6 text-center text-sm text-white/30">
                  Select an agent to inspect.
                </div>
              ) : (
                <>
                  {/* Metadata grid */}
                  <div className="grid grid-cols-2 border-b border-white/[0.06]">
                    <MetaCell icon={Hash} label="ID" value={agent.id.slice(0, 12)} mono />
                    <MetaCell
                      icon={Clock}
                      label="Created"
                      value={format(new Date(agent.created_at), 'MMM d, HH:mm')}
                    />
                    <MetaCell
                      icon={Zap}
                      label="Dispatch Attempts"
                      value={String(agent.dispatch_attempts)}
                    />
                    <MetaCell
                      icon={Activity}
                      label="Last Active"
                      value={
                        agent.last_activity_at
                          ? formatDistanceToNow(new Date(agent.last_activity_at), {
                              addSuffix: true,
                            })
                          : 'Never'
                      }
                    />
                    <MetaCell
                      icon={Hexagon}
                      label="Hooked Ticket"
                      value={
                        agent.current_hook_ticket_id
                          ? agent.current_hook_ticket_id.slice(0, 12)
                          : 'None'
                      }
                      mono={Boolean(agent.current_hook_ticket_id)}
                    />
                    <MetaCell icon={Bot} label="Identity" value={agent.identity || 'Default'} />
                  </div>

                  {/* Related Tickets */}
                  <div className="border-b border-white/[0.06] px-5 py-4">
                    <div className="mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <Hexagon className="size-3 text-white/25" />
                        <span className="text-[10px] font-medium tracking-wide text-white/30 uppercase">
                          Assigned Tickets
                        </span>
                      </div>
                      <span className="font-mono text-[10px] text-white/20">
                        {relatedTickets.length}
                      </span>
                    </div>

                    {relatedTickets.length === 0 ? (
                      <p className="text-xs text-white/20">No tickets assigned to this agent.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {relatedTickets.map(ticket => (
                          <TicketRow key={ticket.ticket_id} ticket={ticket} />
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Activity Timeline */}
                  {agent.current_hook_ticket_id && (
                    <div className="px-5 pt-4">
                      <div className="mb-2 flex items-center gap-1.5">
                        <Clock className="size-3 text-white/25" />
                        <span className="text-[10px] font-medium tracking-wide text-white/30 uppercase">
                          Hooked Ticket Events
                        </span>
                      </div>
                    </div>
                  )}
                  {agent.current_hook_ticket_id && (
                    <div className="px-3 pb-6">
                      <TicketEventTimeline workstationId={workstationId} ticketId={agent.current_hook_ticket_id} />
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
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

const TICKET_STATUS_DOT: Record<string, string> = {
  open: 'bg-sky-400',
  in_progress: 'bg-amber-400',
  closed: 'bg-emerald-400',
  failed: 'bg-red-400',
};

function TicketRow({ ticket }: { ticket: Ticket }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-white/[0.05] bg-white/[0.015] px-3 py-2">
      <span
        className={`size-2 shrink-0 rounded-full ${TICKET_STATUS_DOT[ticket.status] ?? 'bg-white/20'}`}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-white/70">{ticket.title}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-white/30">
          <span className="font-mono">{ticket.ticket_id.slice(0, 8)}</span>
          <span className="text-white/10">·</span>
          <span className="capitalize">{ticket.status.replace('_', ' ')}</span>
        </div>
      </div>
      <Badge variant="outline" className="shrink-0 text-[9px]">
        {ticket.type}
      </Badge>
    </div>
  );
}

