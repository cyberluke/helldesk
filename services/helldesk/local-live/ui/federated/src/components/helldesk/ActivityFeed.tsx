'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';
import { formatDistanceToNow } from 'date-fns';
import {
  Activity,
  GitMerge,
  AlertTriangle,
  CheckCircle,
  PlayCircle,
  PauseCircle,
  Memo,
  ChevronRight,
  Hexagon,
  Layers,
  RefreshCw,
  ShieldCheck,
  XOctagon,
  Zap,
} from '@/lib/icons';
import { motion, AnimatePresence } from 'motion/react';

const EVENT_ICONS: Record<string, typeof Activity> = {
  created: PlayCircle,
  hooked: PlayCircle,
  unhooked: PauseCircle,
  status_changed: Activity,
  closed: CheckCircle,
  escalated: AlertTriangle,
  review_submitted: GitMerge,
  review_completed: GitMerge,
  memo_sent: Memo,
  // Real engine event vocabulary (projected from the control-plane journal).
  'job.enqueued': PlayCircle,
  'job.requeued': RefreshCw,
  'job.retried': RefreshCw,
  'job.completed': CheckCircle,
  'job.cancelled': XOctagon,
  'report.ready': GitMerge,
  'revision.created': Layers,
  'revision.reviewed': GitMerge,
  'revision.rejected': XOctagon,
  'revision.retry': RefreshCw,
  'revision.recovered': RefreshCw,
  'revision.verified': CheckCircle,
  'mission.created': Hexagon,
  'mission.state_changed': Activity,
  'mission.replanned': RefreshCw,
  'mission.blocked': AlertTriangle,
  'mission.verified': CheckCircle,
  'mission.verified_10_10': CheckCircle,
  'mission.resumed': PlayCircle,
  'mission.engine_route_propagated': Zap,
  'ticket.ready': PlayCircle,
  'ticket.verified': CheckCircle,
  'ticket.verification_changed': Activity,
  'evidence.captured': ShieldCheck,
  'quality.updated': ShieldCheck,
  'repair.plan': RefreshCw,
  'repair.failed': AlertTriangle,
};

const EVENT_COLORS: Record<string, string> = {
  created: 'text-blue-500',
  hooked: 'text-green-500',
  unhooked: 'text-yellow-500',
  status_changed: 'text-purple-500',
  closed: 'text-green-600',
  escalated: 'text-red-500',
  review_submitted: 'text-indigo-500',
  review_completed: 'text-green-600',
  memo_sent: 'text-sky-500',
  'job.enqueued': 'text-sky-400',
  'job.requeued': 'text-amber-400',
  'job.retried': 'text-amber-400',
  'job.completed': 'text-emerald-400',
  'job.cancelled': 'text-red-400',
  'report.ready': 'text-indigo-400',
  'revision.created': 'text-violet-400',
  'revision.reviewed': 'text-indigo-400',
  'revision.rejected': 'text-red-400',
  'revision.retry': 'text-amber-400',
  'revision.recovered': 'text-sky-400',
  'revision.verified': 'text-emerald-400',
  'mission.created': 'text-violet-400',
  'mission.state_changed': 'text-white/40',
  'mission.replanned': 'text-amber-400',
  'mission.blocked': 'text-red-400',
  'mission.verified': 'text-emerald-400',
  'mission.verified_10_10': 'text-emerald-400',
  'mission.resumed': 'text-sky-400',
  'ticket.ready': 'text-sky-400',
  'ticket.verified': 'text-emerald-400',
  'ticket.verification_changed': 'text-white/40',
  'evidence.captured': 'text-sky-400',
  'quality.updated': 'text-amber-400',
  'repair.plan': 'text-amber-400',
  'repair.failed': 'text-red-400',
};

type RouterOutputs = inferRouterOutputs<RootRouter>;
type DepartmentEvent = RouterOutputs['helldesk']['getDepartmentEvents'][number];
type TicketEvent = RouterOutputs['helldesk']['getTicketEvents'][number];

function eventDescription(event: {
  event_type: string;
  old_value: string | null;
  new_value: string | null;
  metadata: Record<string, unknown>;
  workstation_name?: string;
}): string {
  const workstationPrefix = event.workstation_name ? `[${event.workstation_name}] ` : '';
  switch (event.event_type) {
    case 'created': {
      const title = event.metadata?.title;
      return `${workstationPrefix}Ticket created: ${typeof title === 'string' ? title : (event.new_value ?? 'unknown')}`;
    }
    case 'hooked':
      return `${workstationPrefix}Agent hooked to ticket`;
    case 'unhooked':
      return `${workstationPrefix}Agent unhooked from ticket`;
    case 'status_changed':
      return `${workstationPrefix}Status: ${event.old_value ?? '?'} → ${event.new_value ?? '?'}`;
    case 'closed':
      return `${workstationPrefix}Ticket closed`;
    case 'escalated':
      return `${workstationPrefix}Escalation created`;
    case 'review_submitted':
      return `${workstationPrefix}Submitted for review: ${event.new_value ?? ''}`;
    case 'review_completed':
      return `${workstationPrefix}Review ${event.new_value ?? 'completed'}`;
    case 'memo_sent':
      return `${workstationPrefix}Memo sent`;
    default: {
      // Engine journal events carry their structured payload in metadata.payload.
      const payload = (event.metadata?.payload ?? {}) as Record<string, unknown>;
      const text = (key: string): string | undefined => {
        const value = payload[key];
        return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
      };
      switch (event.event_type) {
        case 'mission.state_changed':
          return `${workstationPrefix}Mission → ${text('state') ?? 'state changed'}`;
        case 'ticket.verification_changed':
          return `${workstationPrefix}Verification → ${text('verification_state') ?? text('execution_state') ?? 'changed'}`;
        case 'revision.created':
          return `${workstationPrefix}Revision ${text('revision_no') ?? ''} created`.trim();
        case 'revision.reviewed':
          return `${workstationPrefix}Revision reviewed: ${text('verdict') ?? 'verdict recorded'}`;
        case 'revision.rejected':
          return `${workstationPrefix}Revision rejected`;
        case 'revision.verified':
          return `${workstationPrefix}Revision verified`;
        case 'mission.replanned':
          return `${workstationPrefix}Mission replanned${text('reason') ? `: ${text('reason')}` : ''}`;
        case 'mission.verified':
        case 'mission.verified_10_10':
          return `${workstationPrefix}Mission verified`;
        case 'mission.blocked':
          return `${workstationPrefix}Mission blocked${text('blocked_reason') ? `: ${text('blocked_reason')}` : ''}`;
        case 'job.enqueued':
          return `${workstationPrefix}Review job enqueued`;
        case 'job.requeued':
          return `${workstationPrefix}Review job requeued${text('reason') ? `: ${text('reason')}` : ''}`;
        case 'job.completed':
          return `${workstationPrefix}Review job ${text('state') ?? 'completed'}`;
        case 'report.ready':
          return `${workstationPrefix}Review report ready`;
        case 'evidence.captured':
          return `${workstationPrefix}Evidence captured${text('kind') ? ` (${text('kind')})` : ''}`;
        case 'repair.failed':
          return `${workstationPrefix}Repair failed${text('error') ? `: ${text('error')}` : ''}`;
        default:
          return `${workstationPrefix}${event.event_type}`;
      }
    }
  }
}

function toEventDescriptionInput(event: DepartmentEvent | TicketEvent) {
  return {
    event_type: event.event_type,
    old_value: event.old_value,
    new_value: event.new_value,
    metadata: event.metadata,
    workstation_name: 'workstation_name' in event ? event.workstation_name : undefined,
  };
}

type ActivityFeedViewProps = {
  departmentId: string;
  events?: DepartmentEvent[];
  isLoading?: boolean;
  onEventClick?: (event: DepartmentEvent) => void;
};

export function ActivityFeedView({
  departmentId,
  events,
  isLoading,
  onEventClick,
}: ActivityFeedViewProps) {
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.helldesk.getDepartmentEvents.queryOptions({ departmentId, limit: 50 }),
    refetchInterval: 5000,
    enabled: events === undefined,
  });

  const effectiveEvents = events ?? query.data;
  const effectiveLoading = isLoading ?? query.isLoading;

  const PAGE_SIZE = 10;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  if (effectiveLoading) {
    return (
      <div className="space-y-2 p-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: i * 0.05 }}
            className="flex items-center gap-2"
          >
            <div className="size-4 rounded-full bg-white/[0.06]" />
            <div className="h-3 flex-1 rounded bg-white/[0.04]" />
          </motion.div>
        ))}
      </div>
    );
  }

  if (!effectiveEvents?.length) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-muted-foreground flex flex-col items-center justify-center p-6 text-sm"
      >
        <Activity className="mb-2 h-8 w-8 opacity-40" />
        <p>No activity yet</p>
      </motion.div>
    );
  }

  // Newest first — events from the API come oldest-first, so reverse.
  const sorted = [...effectiveEvents].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  const visible = sorted.slice(0, visibleCount);
  const hasMore = visibleCount < sorted.length;

  const clickable = Boolean(onEventClick);

  return (
    <div className="space-y-0.5 p-2">
      <AnimatePresence initial={false}>
        {visible.map(event => {
          const Icon = EVENT_ICONS[event.event_type] ?? Activity;
          const color = EVENT_COLORS[event.event_type] ?? 'text-muted-foreground';

          return (
            <motion.div
              key={event.ticket_event_id}
              layout
              initial={{ opacity: 0, height: 0, y: -8 }}
              animate={{ opacity: 1, height: 'auto', y: 0 }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              onClick={clickable ? () => onEventClick?.(event) : undefined}
              onKeyDown={
                clickable
                  ? e => {
                      if (e.key === 'Enter' || e.key === ' ') onEventClick?.(event);
                    }
                  : undefined
              }
              className={`flex items-start gap-2 rounded-xl px-2 py-1.5 text-sm transition-colors hover:bg-white/[0.05] ${clickable ? 'cursor-pointer' : ''}`}
            >
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${color}`} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-white/85">
                  {eventDescription(toEventDescriptionInput(event))}
                </p>
                <p className="text-xs text-white/40">
                  {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
                </p>
              </div>
              {clickable && <ChevronRight className="mt-1 size-3 shrink-0 text-white/15" />}
            </motion.div>
          );
        })}
      </AnimatePresence>
      {hasMore && (
        <button
          onClick={() => setVisibleCount(c => c + PAGE_SIZE)}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-xs text-white/35 transition-colors hover:bg-white/[0.04] hover:text-white/55"
        >
          Show more
          <span className="font-mono text-[10px] text-white/20">
            {sorted.length - visibleCount} remaining
          </span>
        </button>
      )}
    </div>
  );
}

export type { DepartmentEvent };

export function ActivityFeed({ departmentId }: { departmentId: string }) {
  return <ActivityFeedView departmentId={departmentId} />;
}

export function TicketEventTimeline({ workstationId, ticketId }: { workstationId: string; ticketId: string }) {
  const trpc = useTRPC();
  const { data: events, isLoading } = useQuery({
    ...trpc.helldesk.getTicketEvents.queryOptions({ workstationId, ticketId }),
    refetchInterval: 5000,
  });

  if (isLoading) {
    return (
      <div className="space-y-2 p-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: i * 0.06 }}
            className="flex items-center gap-2"
          >
            <div className="size-3 rounded-full bg-white/[0.06]" />
            <div className="h-2.5 flex-1 rounded bg-white/[0.04]" />
          </motion.div>
        ))}
      </div>
    );
  }

  if (!events?.length) {
    return <p className="text-muted-foreground p-2 text-xs">No events</p>;
  }

  return (
    <div className="space-y-1 p-2">
      <AnimatePresence initial={false}>
        {events.map((event, i) => {
          const Icon = EVENT_ICONS[event.event_type] ?? Activity;
          const color = EVENT_COLORS[event.event_type] ?? 'text-muted-foreground';

          return (
            <motion.div
              key={event.ticket_event_id}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.03, duration: 0.2 }}
              className="flex items-start gap-2 py-1 text-xs"
            >
              <Icon className={`mt-0.5 h-3 w-3 shrink-0 ${color}`} />
              <div className="min-w-0 flex-1">
                <span className="text-foreground">
                  {eventDescription(toEventDescriptionInput(event))}
                </span>
                <span className="text-muted-foreground ml-1">
                  {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
                </span>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
