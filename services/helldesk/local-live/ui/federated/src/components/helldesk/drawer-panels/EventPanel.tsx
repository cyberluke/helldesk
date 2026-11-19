'use client';

import type { DepartmentEvent } from '@/components/helldesk/ActivityFeed';
import type { ResourceRef } from '@/components/helldesk/DrawerStack';
import { format, formatDistanceToNow } from 'date-fns';
import {
  Activity,
  GitMerge,
  AlertTriangle,
  CheckCircle,
  PlayCircle,
  PauseCircle,
  Memo,
  Hash,
  Clock,
  Bot,
  Hexagon,
  FileText,
  ArrowRight,
  ChevronRight,
  GitBranch,
  MessageSquare,
  Send,
} from '@/lib/icons';

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
};

const EVENT_ACCENT: Record<string, string> = {
  created: 'border-sky-500/20 bg-sky-500/8',
  hooked: 'border-emerald-500/20 bg-emerald-500/8',
  unhooked: 'border-amber-500/20 bg-amber-500/8',
  status_changed: 'border-violet-500/20 bg-violet-500/8',
  closed: 'border-emerald-500/20 bg-emerald-500/8',
  escalated: 'border-red-500/20 bg-red-500/8',
  review_submitted: 'border-indigo-500/20 bg-indigo-500/8',
  review_completed: 'border-emerald-500/20 bg-emerald-500/8',
  memo_sent: 'border-sky-500/20 bg-sky-500/8',
};

const EVENT_ICON_COLOR: Record<string, string> = {
  created: 'text-sky-400',
  hooked: 'text-emerald-400',
  unhooked: 'text-amber-400',
  status_changed: 'text-violet-400',
  closed: 'text-emerald-400',
  escalated: 'text-red-400',
  review_submitted: 'text-indigo-400',
  review_completed: 'text-emerald-400',
  memo_sent: 'text-sky-400',
};

const EVENT_LABEL: Record<string, string> = {
  created: 'Ticket Created',
  hooked: 'Agent Hooked',
  unhooked: 'Agent Unhooked',
  status_changed: 'Status Changed',
  closed: 'Ticket Closed',
  escalated: 'Escalation Created',
  review_submitted: 'Submitted for Review',
  review_completed: 'Review Completed',
  memo_sent: 'Memo Sent',
};

const STATUS_PILL: Record<string, string> = {
  open: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  in_progress: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  closed: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  failed: 'border-red-500/30 bg-red-500/10 text-red-300',
};

/** Build a human-readable one-line summary. */
function eventSummary(event: DepartmentEvent): string | null {
  const meta = event.metadata;
  switch (event.event_type) {
    case 'created': {
      const title = typeof meta.title === 'string' ? meta.title : null;
      const type = typeof meta.type === 'string' ? meta.type : null;
      return title ? `A new ${type ?? 'ticket'} "${title}" was created.` : null;
    }
    case 'hooked':
      return 'An agent picked up this ticket and started working on it.';
    case 'unhooked':
      return 'The agent released this ticket and is no longer working on it.';
    case 'status_changed':
      return `Status changed from ${event.old_value ?? '?'} to ${event.new_value ?? '?'}.`;
    case 'closed':
      return 'This ticket has been completed and closed.';
    case 'escalated':
      return 'An escalation was raised — this may need human attention.';
    case 'review_submitted': {
      const branch = typeof meta.branch === 'string' ? meta.branch : event.new_value;
      return branch ? `Branch "${branch}" was submitted for review.` : 'Submitted for code review.';
    }
    case 'review_completed': {
      const msg = typeof meta.message === 'string' ? meta.message : null;
      const by = typeof meta.completedBy === 'string' ? meta.completedBy : null;
      if (event.new_value === 'merged') return `Branch merged${by ? ` by ${by}` : ''}.`;
      return msg ? `Review completed: ${msg}` : `Review ${event.new_value ?? 'completed'}.`;
    }
    case 'memo_sent': {
      const subject = typeof meta.subject === 'string' ? meta.subject : null;
      return subject ? `Memo sent: "${subject}"` : 'Inter-agent memo was sent.';
    }
    default:
      return null;
  }
}

export function EventPanel({
  event,
  push,
}: {
  event: DepartmentEvent;
  push: (ref: ResourceRef) => void;
}) {
  const Icon = EVENT_ICONS[event.event_type] ?? Activity;
  const accent = EVENT_ACCENT[event.event_type] ?? 'border-white/10 bg-white/5';
  const iconColor = EVENT_ICON_COLOR[event.event_type] ?? 'text-white/50';
  const label = EVENT_LABEL[event.event_type] ?? event.event_type;
  const summary = eventSummary(event);

  const meta = event.metadata;
  const workstationId = 'workstation_id' in event && typeof event.workstation_id === 'string' ? event.workstation_id : undefined;
  const workstationName = 'workstation_name' in event ? event.workstation_name : undefined;

  // Extract well-known metadata fields to show in context sections
  const ticketTitle = typeof meta.title === 'string' ? meta.title : null;
  const ticketType = typeof meta.type === 'string' ? meta.type : null;
  const branch = typeof meta.branch === 'string' ? meta.branch : null;
  const commitSha = typeof meta.commit_sha === 'string' ? meta.commit_sha : null;
  const reviewMessage = typeof meta.message === 'string' ? meta.message : null;
  const completedBy = typeof meta.completedBy === 'string' ? meta.completedBy : null;
  const memoSubject = typeof meta.subject === 'string' ? meta.subject : null;
  const memoTo = typeof meta.to === 'string' ? meta.to : null;

  // Metadata entries excluding the ones we render in context sections
  const contextKeys = new Set([
    'title',
    'type',
    'branch',
    'commit_sha',
    'message',
    'completedBy',
    'subject',
    'to',
  ]);
  const extraMetadata = Object.entries(meta).filter(
    ([k, v]) => !contextKeys.has(k) && v !== null && v !== undefined && v !== ''
  );

  return (
    <div>
      {/* Header */}
      <div className="px-5 pt-4 pb-2">
        <div className="text-base font-semibold text-white/90">Event Detail</div>
        <div className="mt-0.5 text-xs text-white/30">
          {format(new Date(event.created_at), 'EEEE, MMM d yyyy · HH:mm:ss')}
        </div>
      </div>

      {/* Event type banner */}
      <div className={`mx-5 mt-2 rounded-xl border p-4 ${accent}`}>
        <div className="flex items-center gap-3">
          <div
            className={`flex size-10 items-center justify-center rounded-lg bg-black/20 ${iconColor}`}
          >
            <Icon className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-white/85">{label}</div>
            {summary && <div className="mt-1 text-xs leading-relaxed text-white/50">{summary}</div>}
          </div>
        </div>
      </div>

      {/* ── Event-type-specific context ──────────────────────────── */}

      {/* created: ticket title + type */}
      {event.event_type === 'created' && ticketTitle && (
        <ContextSection icon={Hexagon} title="Created Ticket">
          <div className="flex items-center gap-2">
            <span className="text-sm text-white/75">{ticketTitle}</span>
            {ticketType && (
              <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-medium text-white/40">
                {ticketType}
              </span>
            )}
          </div>
          {workstationId && (
            <ResourceLink
              icon={Hexagon}
              label="Open ticket"
              onClick={() => push({ type: 'ticket', ticketId: event.ticket_id, workstationId })}
            />
          )}
        </ContextSection>
      )}

      {/* status_changed: status transition */}
      {event.event_type === 'status_changed' && (event.old_value || event.new_value) && (
        <ContextSection icon={Activity} title="Status Transition">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex rounded-md border px-2 py-0.5 text-[10px] font-medium ${STATUS_PILL[event.old_value ?? ''] ?? 'border-white/10 text-white/40'}`}
            >
              {event.old_value ?? '—'}
            </span>
            <ArrowRight className="size-3.5 text-white/20" />
            <span
              className={`inline-flex rounded-md border px-2 py-0.5 text-[10px] font-medium ${STATUS_PILL[event.new_value ?? ''] ?? 'border-white/10 text-white/40'}`}
            >
              {event.new_value ?? '—'}
            </span>
          </div>
        </ContextSection>
      )}

      {/* hooked / unhooked: agent involved */}
      {(event.event_type === 'hooked' || event.event_type === 'unhooked') && event.agent_id && (
        <ContextSection
          icon={Bot}
          title={event.event_type === 'hooked' ? 'Agent Assigned' : 'Agent Released'}
        >
          {workstationId ? (
            <ResourceLink
              icon={Bot}
              label={event.agent_id.slice(0, 12)}
              mono
              onClick={() =>
                push({ type: 'agent', agentId: event.agent_id ?? '', workstationId, departmentId: undefined })
              }
            />
          ) : (
            <span className="font-mono text-xs text-white/50">{event.agent_id.slice(0, 12)}</span>
          )}
        </ContextSection>
      )}

      {/* review_submitted: branch info */}
      {event.event_type === 'review_submitted' && branch && (
        <ContextSection icon={GitBranch} title="Branch">
          <div className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2">
            <GitBranch className="size-3 text-indigo-400/60" />
            <span className="font-mono text-xs text-white/70">{branch}</span>
          </div>
        </ContextSection>
      )}

      {/* review_completed: result details */}
      {event.event_type === 'review_completed' && (
        <ContextSection icon={GitMerge} title="Review Result">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex rounded-md border px-2 py-0.5 text-[10px] font-medium ${
                  event.new_value === 'merged'
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-white/10 text-white/50'
                }`}
              >
                {event.new_value ?? 'completed'}
              </span>
              {completedBy && <span className="text-[10px] text-white/30">by {completedBy}</span>}
            </div>
            {reviewMessage && (
              <div className="rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                <MessageSquare className="mb-1 size-3 text-white/20" />
                <p className="text-xs leading-relaxed text-white/55">{reviewMessage}</p>
              </div>
            )}
            {commitSha && (
              <div className="flex items-center gap-1.5 text-[10px] text-white/30">
                <Hash className="size-3" />
                <span className="font-mono">{commitSha.slice(0, 12)}</span>
              </div>
            )}
          </div>
        </ContextSection>
      )}

      {/* memo_sent: subject + recipient */}
      {event.event_type === 'memo_sent' && (
        <ContextSection icon={Send} title="Memo">
          <div className="space-y-2">
            {memoSubject && (
              <div className="rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                <div className="mb-0.5 text-[9px] font-medium tracking-wide text-white/25 uppercase">
                  Subject
                </div>
                <p className="text-xs text-white/65">{memoSubject}</p>
              </div>
            )}
            {memoTo && workstationId && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-white/30">To:</span>
                <ResourceLink
                  icon={Bot}
                  label={memoTo.slice(0, 12)}
                  mono
                  onClick={() => push({ type: 'agent', agentId: memoTo, workstationId, departmentId: undefined })}
                />
              </div>
            )}
            {event.agent_id && workstationId && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-white/30">From:</span>
                <ResourceLink
                  icon={Bot}
                  label={event.agent_id.slice(0, 12)}
                  mono
                  onClick={() =>
                    push({ type: 'agent', agentId: event.agent_id ?? '', workstationId, departmentId: undefined })
                  }
                />
              </div>
            )}
          </div>
        </ContextSection>
      )}

      {/* ── Core metadata grid ────────────────────────────────────── */}
      <div className="mt-2 border-t border-white/[0.06]">
        <div className="grid grid-cols-2">
          <MetaCell icon={Hash} label="Event ID" value={event.ticket_event_id.slice(0, 12)} mono />
          <MetaCell
            icon={Clock}
            label="Time"
            value={format(new Date(event.created_at), 'MMM d, HH:mm:ss')}
          />

          {/* Ticket — clickable */}
          {workstationId ? (
            <LinkCell
              icon={Hexagon}
              label="Ticket"
              value={event.ticket_id.slice(0, 12)}
              onClick={() => push({ type: 'ticket', ticketId: event.ticket_id, workstationId })}
            />
          ) : (
            <MetaCell icon={Hexagon} label="Ticket" value={event.ticket_id.slice(0, 12)} mono />
          )}

          {/* Agent — clickable */}
          {event.agent_id && workstationId ? (
            <LinkCell
              icon={Bot}
              label="Agent"
              value={event.agent_id.slice(0, 12)}
              onClick={() =>
                push({ type: 'agent', agentId: event.agent_id ?? '', workstationId, departmentId: undefined })
              }
            />
          ) : (
            <MetaCell
              icon={Bot}
              label="Agent"
              value={event.agent_id ? event.agent_id.slice(0, 12) : 'System'}
              mono={Boolean(event.agent_id)}
            />
          )}

          {workstationName && <MetaCell icon={FileText} label="Workstation" value={workstationName} />}
          <MetaCell
            icon={Clock}
            label="Relative"
            value={formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
          />
        </div>
      </div>

      {/* Value transition (for types not already shown in context sections) */}
      {event.event_type !== 'status_changed' && (event.old_value || event.new_value) && (
        <div className="mx-5 mt-4">
          <div className="mb-2 text-[10px] font-medium tracking-wide text-white/30 uppercase">
            Value Change
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
            <span className="max-w-[160px] truncate rounded bg-white/[0.04] px-2 py-1 font-mono text-xs text-white/50">
              {event.old_value ?? '—'}
            </span>
            <ArrowRight className="size-3.5 shrink-0 text-white/20" />
            <span className="max-w-[160px] truncate rounded bg-white/[0.04] px-2 py-1 font-mono text-xs text-white/70">
              {event.new_value ?? '—'}
            </span>
          </div>
        </div>
      )}

      {/* Extra metadata (fields not already shown in context sections) */}
      {extraMetadata.length > 0 && (
        <div className="mx-5 mt-4 pb-6">
          <div className="mb-2 text-[10px] font-medium tracking-wide text-white/30 uppercase">
            Metadata
          </div>
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02]">
            {extraMetadata.map(([key, value], i) => (
              <div
                key={key}
                className={`flex items-start justify-between gap-4 px-3 py-2 ${
                  i < extraMetadata.length - 1 ? 'border-b border-white/[0.04]' : ''
                }`}
              >
                <span className="shrink-0 text-[11px] text-white/40">{key}</span>
                <span className="min-w-0 truncate text-right font-mono text-[11px] text-white/65">
                  {typeof value === 'string' ? value : JSON.stringify(value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────

function ContextSection({
  icon: SectionIcon,
  title,
  children,
}: {
  icon: typeof Activity;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-5 mt-4">
      <div className="mb-2 flex items-center gap-1.5">
        <SectionIcon className="size-3 text-white/25" />
        <span className="text-[10px] font-medium tracking-wide text-white/30 uppercase">
          {title}
        </span>
      </div>
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">{children}</div>
    </div>
  );
}

function ResourceLink({
  icon: LinkIcon,
  label,
  mono,
  onClick,
}: {
  icon: typeof Bot;
  label: string;
  mono?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group/rlink mt-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:bg-white/[0.04]"
    >
      <LinkIcon className="size-3 text-[color:oklch(95%_0.15_108_/_0.6)]" />
      <span className={`text-[color:oklch(95%_0.15_108)] ${mono ? 'font-mono text-[11px]' : ''}`}>
        {label}
      </span>
      <ChevronRight className="size-3 text-white/15 transition-colors group-hover/rlink:text-white/30" />
    </button>
  );
}

function LinkCell({
  icon: CellIcon,
  label,
  value,
  onClick,
}: {
  icon: typeof Hexagon;
  label: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group/link flex flex-col border-r border-b border-white/[0.04] px-4 py-3 text-left transition-colors hover:bg-white/[0.03] [&:nth-child(2n)]:border-r-0"
    >
      <div className="flex items-center gap-1 text-[10px] text-white/30">
        <CellIcon className="size-3" />
        {label}
      </div>
      <div className="mt-0.5 flex items-center gap-1 font-mono text-xs text-[color:oklch(95%_0.15_108)]">
        <span>{value}</span>
        <ChevronRight className="size-3 shrink-0 text-white/15 transition-colors group-hover/link:text-white/30" />
      </div>
    </button>
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
