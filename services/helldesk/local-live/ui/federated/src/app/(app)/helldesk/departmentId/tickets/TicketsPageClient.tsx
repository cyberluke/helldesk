'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { useDrawerStack } from '@/components/helldesk/DrawerStack';
import { TicketBoard, type KanbanTicket } from '@/components/helldesk/TicketBoard';
import { Hexagon, Search, ShieldCheck, Users, Layers } from '@/lib/icons';
import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';

type RouterOutputs = inferRouterOutputs<RootRouter>;
type Ticket = RouterOutputs['helldesk']['listTickets'][number] & {
  workstationName?: string;
  workstationId?: string;
};

type TicketsPageClientProps = {
  departmentId: string;
};

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
      const response = await fetch(`/api/departments/${departmentId}/tickets/${ticket.ticket_id}/controls`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: next[key] }),
      });
      if (!response.ok) setControls(controls);
    } catch {
      setControls(controls);
    } finally {
      setBusy(null);
    }
  };

  const items: Array<{ key: 'excellenceGovernor' | 'reviewer' | 'agents'; label: string; icon: typeof ShieldCheck }> = [
    { key: 'excellenceGovernor', label: 'Governor', icon: ShieldCheck },
    { key: 'reviewer', label: 'Review', icon: Users },
    { key: 'agents', label: 'Agents', icon: Layers },
  ];

  return (
    <div className="flex flex-wrap items-center gap-1" onClick={event => event.stopPropagation()}>
      {items.map(item => {
        const on = controls[item.key] !== false;
        const Icon = item.icon;
        return (
          <button
            key={item.key}
            type="button"
            title={`${on ? 'Disable' : 'Enable'} ${item.label}`}
            disabled={busy === item.key}
            onClick={() => void toggle(item.key)}
            className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-1 text-[9px] font-semibold transition-colors ${
              on
                ? 'border-teal-300/15 bg-teal-300/[0.07] text-teal-100/80 hover:bg-teal-300/[0.12]'
                : 'border-white/[0.05] bg-white/[0.02] text-white/25 hover:bg-white/[0.05]'
            }`}
          >
            <Icon className="size-2.5" />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function TicketsPageClient({ departmentId }: TicketsPageClientProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { open: openDrawer } = useDrawerStack();
  const [search, setSearch] = useState('');
  const [optimisticStatus, setOptimisticStatus] = useState<Record<string, string>>({});

  const workstationsQuery = useQuery(trpc.helldesk.listWorkstations.queryOptions({ departmentId }));
  const workstations = workstationsQuery.data ?? [];

  const ticketQueries = useQueries({
    queries: workstations.map(workstation => ({
      ...trpc.helldesk.listTickets.queryOptions({ departmentId, workstationId: workstation.id }),
      refetchInterval: false,
    })),
  });

  const allTickets = useMemo(() => {
    const result: Ticket[] = [];
    ticketQueries.forEach((query, index) => {
      const workstation = workstations[index];
      if (!workstation || !query.data) return;
      for (const ticket of query.data) {
        result.push({
          ...ticket,
          status: optimisticStatus[ticket.ticket_id] ?? ticket.status,
          workstationId: workstation.id,
          workstationName: workstation.name,
        });
      }
    });
    return result.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [ticketQueries.map(query => query.data), workstations, optimisticStatus]);

  const visibleTickets = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return allTickets;
    return allTickets.filter(ticket =>
      ticket.title.toLowerCase().includes(query) ||
      ticket.ticket_id.toLowerCase().includes(query) ||
      ticket.workstationName?.toLowerCase().includes(query)
    );
  }, [allTickets, search]);

  const moveTicket = useMutation(
    trpc.helldesk.updateTicketStatus.mutationOptions({
      onSuccess: (_data: unknown, variables: { ticketId: string }) => {
        setOptimisticStatus(current => {
          const next = { ...current };
          delete next[variables.ticketId];
          return next;
        });
        void queryClient.invalidateQueries({ queryKey: ['helldesk', 'listTickets'] });
      },
      onError: (_error: unknown, variables: { ticketId: string }) => {
        setOptimisticStatus(current => {
          const next = { ...current };
          delete next[variables.ticketId];
          return next;
        });
      },
    })
  );

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}/api/departments/${encodeURIComponent(departmentId)}/events-ws`);
      socket.onmessage = () => {
        void queryClient.invalidateQueries({ queryKey: ['helldesk', 'listTickets'] });
      };
      socket.onclose = () => {
        if (!disposed) retry = setTimeout(connect, 1200);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [departmentId, queryClient]);

  const isLoading = workstationsQuery.isLoading || ticketQueries.some(query => query.isLoading);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between border-b border-white/[0.055] px-7 py-4">
        <div>
          <div className="flex items-center gap-2">
            <Hexagon className="size-4 text-teal-200/70" />
            <h1 className="text-lg font-semibold tracking-[-0.025em] text-white/90">Kanban</h1>
            <span className="font-mono text-[10px] text-white/30">{allTickets.filter(ticket => ticket.type !== 'agent' && ticket.type !== 'message').length}</span>
          </div>
          <p className="mt-1 text-[11px] text-white/30">One live workflow across every workstation. Drag cards to transition; agents keep running.</p>
        </div>
        <label className="flex w-[320px] items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2">
          <Search className="size-3.5 text-white/25" />
          <input
            type="text"
            placeholder="Search title, ticket, workstation…"
            value={search}
            onChange={event => setSearch(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-xs text-white/80 outline-none placeholder:text-white/20"
          />
        </label>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4 [scrollbar-color:rgba(148,163,184,.28)_transparent] [scrollbar-width:thin]">
        <TicketBoard
          tickets={visibleTickets as unknown as KanbanTicket[]}
          isLoading={isLoading}
          onSelectTicket={ticket => {
            const full = allTickets.find(candidate => candidate.ticket_id === ticket.ticket_id);
            if (!full?.workstationId) return;
            openDrawer({ type: 'ticket', ticketId: ticket.ticket_id, workstationId: full.workstationId });
          }}
          onMoveTicket={(ticket, status) => {
            const full = allTickets.find(candidate => candidate.ticket_id === ticket.ticket_id);
            if (!full?.workstationId) return;
            setOptimisticStatus(current => ({ ...current, [ticket.ticket_id]: status }));
            moveTicket.mutate({
              departmentId,
              workstationId: full.workstationId,
              ticketId: ticket.ticket_id,
              status,
            });
          }}
          renderActions={ticket => {
            const full = allTickets.find(candidate => candidate.ticket_id === ticket.ticket_id);
            return full ? <TicketControls departmentId={departmentId} ticket={full} /> : null;
          }}
        />
      </div>
    </div>
  );
}
