'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { Button } from '@/components/Button';
import { Skeleton } from '@/components/ui/skeleton';
import { TicketBoard } from '@/components/helldesk/TicketBoard';
import { AgentCard } from '@/components/helldesk/AgentCard';
import { SlingDialog } from '@/components/helldesk/SlingDialog';
import { useDrawerStack } from '@/components/helldesk/DrawerStack';
import { Plus, GitBranch, Hexagon, Bot } from '@/lib/icons';
import { motion, AnimatePresence } from 'motion/react';

type WorkstationDetailPageClientProps = {
  departmentId: string;
  workstationId: string;
};

export function WorkstationDetailPageClient({ departmentId, workstationId }: WorkstationDetailPageClientProps) {
  const trpc = useTRPC();
  const [isSlingOpen, setIsSlingOpen] = useState(false);
  const { open: openDrawer } = useDrawerStack();

  const queryClient = useQueryClient();
  const workstationQuery = useQuery(trpc.helldesk.getWorkstation.queryOptions({ workstationId }));
  const ticketsQuery = useQuery({
    ...trpc.helldesk.listTickets.queryOptions({ workstationId }),
    refetchInterval: 8_000,
  });
  const agentsQuery = useQuery({
    ...trpc.helldesk.listAgents.queryOptions({ workstationId }),
    refetchInterval: 5_000,
  });

  const workstation = workstationQuery.data;

  const agentNameById = (agentsQuery.data ?? []).reduce<Record<string, string>>((acc, a) => {
    acc[a.id] = a.name;
    return acc;
  }, {});

  const deleteTicket = useMutation(
    trpc.helldesk.deleteTicket.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.helldesk.listTickets.queryKey() });
        toast.success('Ticket deleted');
      },
      onError: err => toast.error(err.message),
    })
  );

  const moveTicket = useMutation(
    trpc.helldesk.updateTicketStatus.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.helldesk.listTickets.queryKey() });
      },
      onError: err => toast.error(err.message),
    })
  );

  const deleteAgent = useMutation(
    trpc.helldesk.deleteAgent.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.helldesk.listAgents.queryKey() });
        toast.success('Agent deleted');
      },
      onError: err => toast.error(err.message),
    })
  );

  const tickets = ticketsQuery.data ?? [];
  const agents = agentsQuery.data ?? [];

  const openTickets = tickets.filter(b => b.status === 'open' && b.type !== 'agent').length;
  const inProgressTickets = tickets.filter(
    b => b.status === 'in_progress' && b.type !== 'agent'
  ).length;
  const closedTickets = tickets.filter(b => b.status === 'closed' && b.type !== 'agent').length;

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-3">
        <div className="flex items-center gap-3">
          {workstationQuery.isLoading ? (
            <Skeleton className="h-6 w-40" />
          ) : (
            <>
              <h1 className="text-lg font-semibold tracking-tight text-white/90">{workstation?.name}</h1>
              {workstation && (
                <span className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[11px] text-white/40">
                  <GitBranch className="size-3" />
                  {workstation.default_branch}
                </span>
              )}
            </>
          )}
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => setIsSlingOpen(true)}
          className="gap-1.5 bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
        >
          <Plus className="size-3.5" />
          Sling Work
        </Button>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-3 border-b border-white/[0.06]">
        <WorkstationStatCell label="Open" value={openTickets} color="text-sky-400" />
        <WorkstationStatCell label="In Progress" value={inProgressTickets} color="text-amber-400" />
        <WorkstationStatCell label="Closed" value={closedTickets} color="text-emerald-400" />
      </div>

      {/* Main content: columns layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Column 1: Ticket Board */}
        <div className="flex flex-1 flex-col overflow-y-auto border-r border-white/[0.06]">
          <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
            <Hexagon className="size-3 text-white/25" />
            <span className="text-[10px] font-medium tracking-wide text-white/35 uppercase">
              Ticket Board
            </span>
            <span className="ml-auto font-mono text-[10px] text-white/20">{tickets.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            <TicketBoard
              tickets={tickets}
              isLoading={ticketsQuery.isLoading}
              onDeleteTicket={ticketId => {
                if (confirm('Delete this ticket?')) {
                  deleteTicket.mutate({ workstationId, ticketId });
                }
              }}
              onSelectTicket={ticket => openDrawer({ type: 'ticket', ticketId: ticket.ticket_id, workstationId })}
              onMoveTicket={(ticket, status) => moveTicket.mutate({ departmentId, workstationId, ticketId: ticket.ticket_id, status })}
              agentNameById={agentNameById}
            />
          </div>
        </div>

        {/* Column 2: Agent Roster */}
        <div className="flex w-[320px] shrink-0 flex-col overflow-y-auto">
          <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
            <Bot className="size-3 text-white/25" />
            <span className="text-[10px] font-medium tracking-wide text-white/35 uppercase">
              Agents
            </span>
            <span className="ml-auto font-mono text-[10px] text-white/20">{agents.length}</span>
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            {agentsQuery.isLoading && (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-20 w-full rounded-lg" />
                ))}
              </div>
            )}

            {agents.length === 0 && !agentsQuery.isLoading && (
              <div className="rounded-lg border border-dashed border-white/[0.08] p-4 text-center text-xs text-white/30">
                No agents yet. Sling work to spawn a soul.
              </div>
            )}

            <AnimatePresence mode="popLayout">
              {agents.map((agent, i) => (
                <motion.div
                  key={agent.id}
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -12 }}
                  transition={{ delay: i * 0.03, duration: 0.2 }}
                  className="mb-2"
                >
                  <AgentCard
                    agent={agent}
                    isSelected={false}
                    onSelect={() => openDrawer({ type: 'agent', agentId: agent.id, workstationId, departmentId })}
                    onDelete={() => {
                      if (confirm(`Delete agent "${agent.name}"?`)) {
                        deleteAgent.mutate({ workstationId, agentId: agent.id });
                      }
                    }}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      </div>

      <SlingDialog workstationId={workstationId} isOpen={isSlingOpen} onClose={() => setIsSlingOpen(false)} />
    </div>
  );
}

function WorkstationStatCell({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="border-r border-white/[0.06] px-4 py-2.5 last:border-r-0">
      <div className={`text-[10px] font-medium tracking-wide uppercase ${color} opacity-60`}>
        {label}
      </div>
      <motion.div
        key={value}
        initial={{ y: 4, opacity: 0.4 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 20 }}
        className="mt-0.5 font-mono text-lg font-semibold text-white/80"
      >
        {value}
      </motion.div>
    </div>
  );
}
