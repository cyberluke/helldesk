'use client';

import { useState, useMemo } from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { useDrawerStack } from '@/components/helldesk/DrawerStack';
import { Hexagon, Search, ShieldCheck, Users, Layers } from '@/lib/icons';
import { formatDistanceToNow } from 'date-fns';
import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';
import { motion, AnimatePresence } from 'motion/react';

type RouterOutputs = inferRouterOutputs<RootRouter>;
type Ticket = RouterOutputs['helldesk']['listTickets'][number];

type TicketsPageClientProps = {
  departmentId: string;
};

const STATUS_DOT: Record<string, string> = {
  open: 'bg-sky-400',
  in_progress: 'bg-amber-400',
  closed: 'bg-emerald-400',
  failed: 'bg-red-400',
};

/** On-the-fly per-task toggles: NAI ExcellenceGovernor / Reviewer / Department agents.
 *  Persists to the ticket's metadata.break_room_controls (engine dispatch reads these to
 *  actually enable/disable each, not just a visual switch). */
function TicketControls({ departmentId, ticket }: { departmentId: string; ticket: Ticket }) {
  const meta = ((ticket as unknown as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>;
  const breakRoom = (meta.break_room_controls ?? {}) as Record<string, unknown>;
  const [controls, setControls] = useState<Record<string, boolean>>({
    excellenceGovernor: breakRoom.excellenceGovernor !== false,
    reviewer: breakRoom.reviewer !== false,
    agents: breakRoom.agents !== false,
  });
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (key: 'excellenceGovernor' | 'reviewer' | 'agents') => {
    const next = { ...controls, [key]: !controls[key] };
    setBusy(key);
    setControls(next);
    try {
      await fetch(`/api/departments/${departmentId}/tickets/${ticket.ticket_id}/controls`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: next[key] }),
      });
    } finally {
      setBusy(null);
    }
  };

  const items: Array<{ key: 'excellenceGovernor' | 'reviewer' | 'agents'; label: string; icon: typeof ShieldCheck }> = [
    { key: 'excellenceGovernor', label: 'Inq', icon: ShieldCheck },
    { key: 'reviewer', label: 'Rev', icon: Users },
    { key: 'agents', label: 'Agents', icon: Layers },
  ];

  return (
    <div className="flex shrink-0 items-center gap-1" onClick={e => e.stopPropagation()}>
      {items.map(it => {
        const on = controls[it.key] !== false;
        const Icon = it.icon;
        return (
          <button
            key={it.key}
            title={`${on ? 'Disable' : 'Enable'} ${it.label}`}
            disabled={busy === it.key}
            onClick={() => toggle(it.key)}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors ${
              on ? 'bg-emerald-500/15 text-emerald-300/90 hover:bg-emerald-500/25' : 'bg-white/[0.04] text-white/25 hover:bg-white/[0.08]'
            }`}
          >
            <Icon className="size-2.5" />
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

export function TicketsPageClient({ departmentId }: TicketsPageClientProps) {
  const trpc = useTRPC();
  const { open: openDrawer } = useDrawerStack();
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const workstationsQuery = useQuery(trpc.helldesk.listWorkstations.queryOptions({ departmentId }));
  const workstations = workstationsQuery.data ?? [];

  // Fetch tickets for each workstation — useQueries handles dynamic-length arrays safely
  const workstationTicketQueries = useQueries({
    queries: workstations.map(workstation => ({
      ...trpc.helldesk.listTickets.queryOptions({ workstationId: workstation.id }),
      refetchInterval: 8_000,
    })),
  });

  const workstationTicketData = workstationTicketQueries.map(q => q.data);
  const allTickets = useMemo(() => {
    const tickets: Array<Ticket & { workstationName: string; workstationId: string }> = [];
    workstationTicketData.forEach((data, i) => {
      const workstation = workstations[i];
      if (data && workstation) {
        for (const ticket of data) {
          tickets.push({ ...ticket, workstationName: workstation.name, workstationId: workstation.id });
        }
      }
    });
    // Sort newest first
    tickets.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return tickets;
  }, [workstationTicketData, workstations]);

  const filteredTickets = useMemo(() => {
    let tickets = allTickets;
    if (statusFilter) {
      tickets = tickets.filter(b => b.status === statusFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      tickets = tickets.filter(
        b => b.title.toLowerCase().includes(q) || b.ticket_id.toLowerCase().includes(q)
      );
    }
    return tickets;
  }, [allTickets, statusFilter, search]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { open: 0, in_progress: 0, closed: 0, failed: 0 };
    for (const ticket of allTickets) {
      counts[ticket.status] = (counts[ticket.status] ?? 0) + 1;
    }
    return counts;
  }, [allTickets]);

  const isLoading = workstationsQuery.isLoading || workstationTicketQueries.some(q => q.isLoading);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-3">
        <div className="flex items-center gap-2">
          <Hexagon className="size-4 text-[color:oklch(95%_0.15_108_/_0.6)]" />
          <h1 className="text-lg font-semibold tracking-tight text-white/90">Tickets</h1>
          <span className="ml-1 font-mono text-xs text-white/30">{allTickets.length}</span>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-6 py-2">
        {/* Search */}
        <div className="flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5">
          <Search className="size-3 text-white/30" />
          <input
            type="text"
            placeholder="Search tickets..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-48 bg-transparent text-xs text-white/80 outline-none placeholder:text-white/25"
          />
        </div>

        {/* Status filter chips */}
        <div className="flex items-center gap-1">
          <FilterChip
            label="All"
            count={allTickets.length}
            active={statusFilter === null}
            onClick={() => setStatusFilter(null)}
          />
          {Object.entries(statusCounts).map(([status, count]) => (
            <FilterChip
              key={status}
              label={status.replace('_', ' ')}
              count={count}
              active={statusFilter === status}
              onClick={() => setStatusFilter(statusFilter === status ? null : status)}
              dotColor={STATUS_DOT[status]}
            />
          ))}
        </div>
      </div>

      {/* Ticket list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="space-y-0">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="flex animate-pulse items-center gap-3 border-b border-white/[0.04] px-6 py-3"
              >
                <div className="size-2 rounded-full bg-white/10" />
                <div className="h-3 w-40 rounded bg-white/5" />
                <div className="ml-auto h-3 w-20 rounded bg-white/5" />
              </div>
            ))}
          </div>
        )}

        {!isLoading && filteredTickets.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Hexagon className="mb-3 size-8 text-white/10" />
            <p className="text-sm text-white/30">
              {search || statusFilter ? 'No tickets match your filters.' : 'No tickets yet.'}
            </p>
          </div>
        )}

        <AnimatePresence mode="popLayout">
          {filteredTickets.map((ticket, i) => (
            <motion.div
              key={ticket.ticket_id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ delay: Math.min(i * 0.02, 0.3), duration: 0.15 }}
              onClick={() => {
                const workstationId = (ticket as Ticket & { workstationId: string }).workstationId;
                openDrawer({ type: 'ticket', ticketId: ticket.ticket_id, workstationId });
              }}
              className="group flex cursor-pointer items-center gap-3 border-b border-white/[0.04] px-6 py-2.5 transition-colors hover:bg-white/[0.02]"
            >
              <span
                className={`size-2 shrink-0 rounded-full ${STATUS_DOT[ticket.status] ?? 'bg-white/20'}`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm text-white/80">{ticket.title}</span>
                  <span className="shrink-0 rounded bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-medium text-white/30">
                    {ticket.type}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-white/30">
                  <span className="font-mono">{ticket.ticket_id.slice(0, 8)}</span>
                  <span className="text-white/15">|</span>
                  <span>{(ticket as Ticket & { workstationName: string }).workstationName}</span>
                  <span className="text-white/15">|</span>
                  <span>{formatDistanceToNow(new Date(ticket.created_at), { addSuffix: true })}</span>
                </div>
              </div>
              <TicketControls departmentId={departmentId} ticket={ticket} />
              <span className="shrink-0 text-[10px] text-white/25 capitalize">{ticket.priority}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Drawers are rendered by the layout-level DrawerStackProvider */}
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
  dotColor,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  dotColor?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium capitalize transition-colors ${
        active
          ? 'bg-white/[0.08] text-white/70'
          : 'text-white/30 hover:bg-white/[0.04] hover:text-white/50'
      }`}
    >
      {dotColor && <span className={`size-1.5 rounded-full ${dotColor}`} />}
      {label}
      <span className="font-mono text-[9px] opacity-60">{count}</span>
    </button>
  );
}
