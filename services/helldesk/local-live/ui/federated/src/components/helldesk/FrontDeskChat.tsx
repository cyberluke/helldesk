'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { useSidebar } from '@/components/ui/sidebar';
import { ChevronDown, ChevronUp, Terminal as TerminalIcon } from '@/lib/icons';
import { useXtermPty } from './useXtermPty';

type FrontDeskChatProps = {
  departmentId: string;
};

const COLLAPSED_HEIGHT = 40; // px — title bar only
const EXPANDED_HEIGHT = 320; // px — terminal area

export function FrontDeskChat({ departmentId }: FrontDeskChatProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(false);

  // Eagerly ensure frontDesk agent + container on mount
  const ensureFrontDesk = useMutation(
    trpc.helldesk.ensureFrontDesk.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.helldesk.getFrontDeskStatus.queryKey(),
        });
      },
    })
  );

  // Reset on departmentId change so ensureFrontDesk fires for each department
  const ensuredDepartmentRef = useRef<string | null>(null);
  useEffect(() => {
    if (ensuredDepartmentRef.current === departmentId) return;
    ensuredDepartmentRef.current = departmentId;
    ensureFrontDesk.mutate({ departmentId });
  }, [departmentId]);

  // Poll frontDesk status to get agentId
  const statusQuery = useQuery({
    ...trpc.helldesk.getFrontDeskStatus.queryOptions({ departmentId }),
    refetchInterval: query => {
      const session = query.state.data?.session;
      if (!session) return 3_000; // Poll faster until frontDesk is available
      if (session.status === 'active' || session.status === 'starting') return 3_000;
      return 10_000;
    },
  });

  const frontDeskAgentId = statusQuery.data?.session?.agentId ?? null;

  const { terminalRef, connected, status, fitAddonRef } = useXtermPty({
    departmentId,
    agentId: frontDeskAgentId,
    retries: 10,
    retryDelay: 3_000,
  });

  const { state: sidebarState, isMobile } = useSidebar();

  // Re-fit terminal when expanding or sidebar changes
  useEffect(() => {
    if (collapsed || !fitAddonRef.current) return;
    // Small delay so the DOM has finished resizing after CSS transitions
    const t = setTimeout(() => fitAddonRef.current?.fit(), 50);
    return () => clearTimeout(t);
  }, [collapsed, sidebarState]);

  // Sidebar is hidden on mobile, 3rem when collapsed to icons, 16rem when expanded.
  // Add extra padding to account for the sidebar's outer spacing.
  const sidebarLeft = isMobile ? '0px' : sidebarState === 'expanded' ? '16rem' : '3rem';

  return (
    <div
      className="fixed right-0 bottom-0 z-50 border-t border-white/10 bg-[#0a0a0a] transition-[left] duration-200 ease-linear"
      style={{
        left: sidebarLeft,
        height: collapsed ? COLLAPSED_HEIGHT : COLLAPSED_HEIGHT + EXPANDED_HEIGHT,
      }}
    >
      {/* Title bar */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className="flex w-full items-center justify-between px-4"
        style={{ height: COLLAPSED_HEIGHT }}
      >
        <div className="flex items-center gap-2">
          <TerminalIcon
            className={`size-3.5 ${connected ? 'text-emerald-400' : 'text-white/30'}`}
          />
          <span className="text-xs font-medium text-white/70">FrontDesk</span>
          <span className="text-[11px] text-white/40">{status}</span>
        </div>
        {collapsed ? (
          <ChevronUp className="size-4 text-white/40" />
        ) : (
          <ChevronDown className="size-4 text-white/40" />
        )}
      </button>

      {/* Terminal area */}
      <div
        ref={terminalRef}
        className="overflow-hidden px-1"
        style={{
          height: EXPANDED_HEIGHT,
          display: collapsed ? 'none' : 'block',
        }}
      />
    </div>
  );
}
