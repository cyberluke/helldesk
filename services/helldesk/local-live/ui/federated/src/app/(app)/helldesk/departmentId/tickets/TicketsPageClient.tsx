'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { useDrawerStack } from '@/components/helldesk/DrawerStack';
import { TicketBoard, type KanbanTicket } from '@/components/helldesk/TicketBoard';
import { TicketControls } from '@/components/helldesk/TicketControls';
import { CheckCircle, Hexagon, Search, ShieldCheck, SlidersHorizontal } from '@/lib/icons';
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

export function TicketsPageClient({ departmentId }: TicketsPageClientProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { open: openDrawer } = useDrawerStack();
  const [search, setSearch] = useState('');
  const [workstationFilter, setWorkstationFilter] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [optimisticStatus, setOptimisticStatus] = useState<Record<string, string>>({});
  const [notificationPermission, setNotificationPermission] = useState<string>(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  );
  const knownVerified = useRef<Set<string> | null>(null);
  const initialTicketsLoaded = useRef(false);

  const workstationsQuery = useQuery(trpc.helldesk.listWorkstations.queryOptions({ departmentId }));
  const workstations = workstationsQuery.data ?? [];

  // One department-wide query (includes the engine mission projection) or one
  // seat query when a workstation filter is active.
  const ticketsQuery = useQuery({
    ...trpc.helldesk.listTickets.queryOptions(
      workstationFilter
        ? { departmentId, workstationId: workstationFilter, includeArchived: showArchived }
        : { departmentId, includeArchived: showArchived },
    ),
    refetchInterval: 6000,
  });

  // A deleted workstation must not leave the board pinned to a dead filter.
  useEffect(() => {
    if (!workstationFilter || workstations.length === 0) return;
    if (!workstations.some(workstation => workstation.id === workstationFilter)) {
      setWorkstationFilter('');
    }
  }, [workstationFilter, workstations]);

  const selectedWorkstation = workstations.find(workstation => workstation.id === workstationFilter);

  const workstationNameById = useMemo(
    () => new Map(workstations.map(workstation => [workstation.id, workstation.name])),
    [workstations],
  );

  const allTickets = useMemo(() => {
    const rows = ticketsQuery.data ?? [];
    return rows
      .map(ticket => ({
        ...ticket,
        status: optimisticStatus[ticket.ticket_id] ?? ticket.status,
        workstationId: ticket.workstation_id ?? undefined,
        workstationName: ticket.workstation_id
          ? workstationNameById.get(ticket.workstation_id)
          : undefined,
      }))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [ticketsQuery.data, workstationNameById, optimisticStatus]);

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

  const archiveTickets = useMutation(
    trpc.helldesk.archiveTickets.mutationOptions({
      onSuccess: (
        result: { count?: number; archived?: boolean },
        variables: { ticketIds?: string[]; archived?: boolean },
      ) => {
        void queryClient.invalidateQueries({ queryKey: ['helldesk', 'listTickets'] });
        // Count the cards the operator acted on, not the expanded server ids
        // (a mission-bound card also archives its mission projection id).
        const count = variables?.ticketIds?.length ?? result?.count ?? 0;
        toast.success(
          `${count} task${count === 1 ? '' : 's'} ${result?.archived === false ? 'restored' : 'archived'}.`,
        );
      },
      onError: (error: unknown) => {
        toast.error(error instanceof Error ? error.message : 'Could not update the archive');
      },
    }),
  );

  const archiveClosed = () => {
    const ids = allTickets
      .filter(ticket => ticket.status === 'closed' && !ticket.archived)
      .map(ticket => ticket.ticket_id);
    if (!ids.length) {
      toast.info('No closed tasks to archive.');
      return;
    }
    archiveTickets.mutate({ departmentId, ticketIds: ids, archived: true });
  };

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

  const isLoading = workstationsQuery.isLoading || ticketsQuery.isLoading;

  const awaitingAcceptance = useMemo(
    () =>
      allTickets.filter(ticket => {
        const meta = (ticket.metadata ?? {}) as Record<string, unknown>;
        return (
          meta.awaiting_human_acceptance === true ||
          (meta.engine_state === 'VERIFIED_10_10' && meta.human_acceptance !== 'accepted')
        );
      }),
    [allTickets],
  );

  const openMission = (ticketId: string, workstationId?: string) => {
    openDrawer({ type: 'ticket', ticketId, workstationId, departmentId });
  };

  const deleteTask = async (ticketId: string) => {
    const full = allTickets.find(candidate => candidate.ticket_id === ticketId);
    const meta = (full?.metadata ?? {}) as Record<string, unknown>;
    const localMission = meta.local_mission && typeof meta.local_mission === 'object'
      ? (meta.local_mission as { missionId?: unknown })
      : null;
    const missionId = ticketId.startsWith('mis_')
      ? ticketId
      : typeof localMission?.missionId === 'string'
        ? localMission.missionId
        : '';
    const label = full?.title ?? ticketId.slice(0, 8);
    const confirmed = window.confirm(
      missionId
        ? `Cancel mission "${label}" and remove it from the board?`
        : `Delete task "${label}"? This cannot be undone.`,
    );
    if (!confirmed) return;
    try {
      if (missionId) {
        const response = await fetch(`/api/missions/${encodeURIComponent(missionId)}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!response.ok) throw new Error(`Cancel failed (HTTP ${response.status})`);
        await archiveTickets.mutateAsync({
          departmentId,
          ticketIds: [ticketId, missionId],
          archived: true,
        });
      } else {
        const response = await fetch(
          `/api/departments/${encodeURIComponent(departmentId)}/tickets/${encodeURIComponent(ticketId)}`,
          { method: 'DELETE' },
        );
        if (!response.ok) throw new Error(`Delete failed (HTTP ${response.status})`);
        void queryClient.invalidateQueries({ queryKey: ['helldesk', 'listTickets'] });
      }
      toast.success(missionId ? 'Mission cancelled and archived.' : 'Task deleted.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not remove the task');
    }
  };

  // Completion notification: a mission that becomes VERIFIED_10_10 while the
  // board is open announces itself. First load is silent (no replay spam).
  useEffect(() => {
    // Wait for the FIRST complete snapshot before arming notifications; otherwise
    // incremental ticket-query results replay every historical verification as a
    // fresh toast on page load.
    if (isLoading) return;
    const verified = new Set(
      allTickets
        .filter(ticket => ((ticket.metadata ?? {}) as Record<string, unknown>).engine_state === 'VERIFIED_10_10')
        .map(ticket => ticket.ticket_id),
    );
    if (!initialTicketsLoaded.current) {
      initialTicketsLoaded.current = true;
      knownVerified.current = verified;
      return;
    }
    if (knownVerified.current === null) {
      knownVerified.current = verified;
      return;
    }
    for (const ticketId of verified) {
      if (knownVerified.current.has(ticketId)) continue;
      const ticket = allTickets.find(candidate => candidate.ticket_id === ticketId);
      if (!ticket) continue;
      const meta = (ticket.metadata ?? {}) as Record<string, unknown>;
      if (meta.human_acceptance === 'accepted') continue;
      const title = ticket.title || 'Mission verified';
      toast.success('Mission verified — Governor PASS', {
        description: `${title} is awaiting your acceptance.`,
        action: { label: 'Review', onClick: () => openMission(ticket.ticket_id, ticket.workstationId) },
      });
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification('Mission verified — Governor PASS', { body: `${title} is awaiting your acceptance.` });
        } catch { /* notification construction is best effort */ }
      }
    }
    knownVerified.current = verified;
  }, [allTickets, isLoading]);

  const enableDesktopAlerts = async () => {
    if (typeof Notification === 'undefined') {
      toast.error('Desktop alerts are not available in this browser.');
      return;
    }
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    if (permission === 'granted') toast.success('Desktop alerts enabled for mission completion.');
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between border-b border-white/[0.055] px-7 py-4">
        <div>
          <div className="flex items-center gap-2">
            <Hexagon className="size-4 text-teal-200/70" />
            <h1 className="text-lg font-semibold tracking-[-0.025em] text-white/90">Kanban</h1>
            <span className="font-mono text-[10px] text-white/30">{allTickets.filter(ticket => ticket.type !== 'agent' && ticket.type !== 'message').length}</span>
          </div>
          <p className="mt-1 text-[11px] text-white/30">
            {selectedWorkstation
              ? `Showing ${selectedWorkstation.name} — seat-routed work only. Department missions stay on All workstations.`
              : 'One live workflow across every workstation. Drag cards to transition; agents keep running.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2 [color-scheme:dark]">
            <SlidersHorizontal className="size-3.5 text-white/25" />
            <select
              value={workstationFilter}
              onChange={event => setWorkstationFilter(event.target.value)}
              aria-label="Filter by workstation"
              className="min-w-[130px] bg-transparent text-xs text-white/80 outline-none"
            >
              <option value="">All workstations</option>
              {workstations.map(workstation => (
                <option key={workstation.id} value={workstation.id}>{workstation.name}</option>
              ))}
            </select>
          </label>
          {workstationFilter ? (
            <button
              type="button"
              onClick={() => setWorkstationFilter('')}
              className="text-[10px] text-white/30 transition-colors hover:text-white/70"
            >
              Clear
            </button>
          ) : null}
          <label className="flex items-center gap-1.5 text-[10px] text-white/35">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={event => setShowArchived(event.target.checked)}
              className="size-3 accent-teal-300"
            />
            Show archived
          </label>
          <button
            type="button"
            onClick={archiveClosed}
            disabled={archiveTickets.isPending}
            className="rounded-md border border-white/[0.07] bg-white/[0.025] px-2 py-1 text-[10px] text-white/45 transition-colors hover:bg-white/[0.05] hover:text-white/75 disabled:opacity-40"
          >
            Archive closed
          </button>
          <label className="flex w-[280px] items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2">
            <Search className="size-3.5 text-white/25" />
            <input
              type="text"
              placeholder="Search title, ticket, workstation…"
              value={search}
              onChange={event => setSearch(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-xs text-white/80 outline-none placeholder:text-white/20"
            />
          </label>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4 [scrollbar-color:rgba(148,163,184,.28)_transparent] [scrollbar-width:thin]">
        {awaitingAcceptance.length > 0 ? (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-amber-300/15 bg-amber-300/[0.05] px-4 py-3">
            <ShieldCheck className="size-4 shrink-0 text-amber-100/70" />
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-amber-100/85">
                {awaitingAcceptance.length === 1
                  ? 'One mission is verified and awaiting your acceptance'
                  : `${awaitingAcceptance.length} missions are verified and awaiting your acceptance`}
              </div>
              <div className="mt-0.5 truncate text-[10px] text-amber-100/40">
                {awaitingAcceptance[0]?.title}
              </div>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const first = awaitingAcceptance[0];
                  if (first) openMission(first.ticket_id, first.workstationId);
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-amber-300/20 bg-amber-300/10 px-2.5 py-1.5 text-[10px] font-semibold text-amber-100/85 hover:bg-amber-300/15"
              >
                <CheckCircle className="size-3" /> Review & accept
              </button>
              {notificationPermission === 'default' ? (
                <button
                  type="button"
                  onClick={() => void enableDesktopAlerts()}
                  className="text-[10px] text-amber-100/35 hover:text-amber-100/70"
                >
                  Enable desktop alerts
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        <TicketBoard
          tickets={visibleTickets as unknown as KanbanTicket[]}
          isLoading={isLoading}
          onDeleteTicket={deleteTask}
          onRestoreTicket={ticketId => {
            archiveTickets.mutate({ departmentId, ticketIds: [ticketId], archived: false });
          }}
          onSelectTicket={ticket => {
            const full = allTickets.find(candidate => candidate.ticket_id === ticket.ticket_id);
            // Department missions have no workstation binding; the drawer accepts
            // an undefined workstation and resolves the ticket department-wide.
            openDrawer({ type: 'ticket', ticketId: ticket.ticket_id, workstationId: full?.workstationId, departmentId });
          }}
          onMoveTicket={(ticket, status) => {
            const full = allTickets.find(candidate => candidate.ticket_id === ticket.ticket_id);
            const meta = (full?.metadata ?? {}) as Record<string, unknown>;
            const awaitingHumanAcceptance =
              meta.awaiting_human_acceptance === true ||
              (meta.engine_state === 'VERIFIED_10_10' && meta.human_acceptance !== 'accepted');
            // Machine verification is not human acceptance. Never let a drop to
            // CLOSED silently flip back to IN REVIEW — send the operator to the
            // acceptance gate in the drawer instead.
            if (status === 'closed' && awaitingHumanAcceptance) {
              toast.info('Machine verification passed. Open the task and accept it to close it.');
              if (full) openDrawer({ type: 'ticket', ticketId: full.ticket_id, workstationId: full.workstationId, departmentId });
              return;
            }
            setOptimisticStatus(current => ({ ...current, [ticket.ticket_id]: status }));
            moveTicket.mutate({
              departmentId,
              workstationId: full?.workstationId,
              ticketId: ticket.ticket_id,
              status,
            });
          }}
          renderActions={ticket => {
            const full = allTickets.find(candidate => candidate.ticket_id === ticket.ticket_id);
            return full ? (
              <TicketControls
                departmentId={departmentId}
                ticket={full}
                onUpdated={() => void queryClient.invalidateQueries()}
              />
            ) : null;
          }}
        />
      </div>
    </div>
  );
}
