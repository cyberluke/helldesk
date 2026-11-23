'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { missionTaskName } from '@/lib/mission-title';
import { requestTaskSizingBackfill } from '@/lib/mission-client';
import type { ObservabilityEvent, ObservabilitySnapshot } from '@/lib/trpc/observability';
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle,
  CircleDot,
  Clock,
  GitMerge,
  Hexagon,
  Layers,
  PlayCircle,
  RefreshCw,
  Shield,
  ShieldCheck,
  Users,
  XOctagon,
  Zap,
} from '@/lib/icons';
import { formatDistanceToNow, format } from 'date-fns';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  ComposedChart,
  Line,
  LineChart,
  Legend,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';

// ── formatting ───────────────────────────────────────────────────────────────

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function shortObjective(text: string): string {
  // mission-dispatch prefixes the objective with "[HELLDESK ticket <id>]"; the
  // selector must show the task, not the machine envelope.
  const clean = missionTaskName(text).replace(/\s+/g, ' ').trim();
  return clean.length > 52 ? `${clean.slice(0, 51)}…` : clean;
}

function relative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '—';
  return formatDistanceToNow(new Date(ts), { addSuffix: true });
}

function share(part: number, total: number): string {
  if (total <= 0) return '—';
  return `${Math.round((part / total) * 100)}%`;
}

// ── event presentation ───────────────────────────────────────────────────────

const EVENT_ICON_MAP: Record<string, typeof Activity> = {
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
  'revision.review_inconclusive': AlertTriangle,
  'revision.review_inconclusive_exhausted': AlertTriangle,
  'revision.deferred_verify': Clock,
  'mission.created': Hexagon,
  'mission.state_changed': Activity,
  'mission.replanned': RefreshCw,
  'mission.blocked': AlertTriangle,
  'mission.verified': CheckCircle,
  'mission.verified_10_10': CheckCircle,
  'mission.resumed': PlayCircle,
  'mission.budget_blocked': AlertTriangle,
  'mission.engine_route_propagated': Zap,
  'ticket.ready': PlayCircle,
  'ticket.verified': CheckCircle,
  'ticket.verification_changed': Activity,
  'evidence.captured': ShieldCheck,
  'quality.updated': ShieldCheck,
  'repair.plan': RefreshCw,
  'repair.failed': AlertTriangle,
};

const EVENT_COLOR_MAP: Record<string, string> = {
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
  'revision.review_inconclusive': 'text-amber-400',
  'revision.review_inconclusive_exhausted': 'text-red-400',
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

function eventIcon(type: string): typeof Activity {
  if (EVENT_ICON_MAP[type]) return EVENT_ICON_MAP[type]!;
  if (type.includes('verified') || type.endsWith('.completed')) return CheckCircle;
  if (type.includes('fail') || type.includes('reject') || type.includes('blocked')) return AlertTriangle;
  if (type.includes('replan') || type.includes('retry') || type.includes('requeue')) return RefreshCw;
  if (type.startsWith('bead.')) return CircleDot;
  return Activity;
}

function eventColor(type: string): string {
  if (EVENT_COLOR_MAP[type]) return EVENT_COLOR_MAP[type]!;
  if (type.includes('verified') || type.endsWith('.completed')) return 'text-emerald-400';
  if (type.includes('fail') || type.includes('reject') || type.includes('blocked')) return 'text-red-400';
  if (type.includes('replan') || type.includes('retry') || type.includes('requeue')) return 'text-amber-400';
  return 'text-white/40';
}

const SEVERITY_COLOR: Record<string, string> = {
  BLOCKER: 'bg-red-500/70',
  HIGH: 'bg-orange-500/70',
  MEDIUM: 'bg-amber-500/70',
  LOW: 'bg-sky-500/70',
};

const STATE_COLOR: Record<string, string> = {
  COMPLETED_PASS: 'text-emerald-400',
  COMPLETED_FINDINGS: 'text-amber-400',
  INCONCLUSIVE: 'text-orange-400',
  FAILED_TERMINAL: 'text-red-400',
  CANCELLED: 'text-white/30',
  REVIEWING_A_B: 'text-sky-400',
  ADJUDICATING: 'text-violet-400',
  QUEUED: 'text-indigo-400',
};

const tooltipStyles = {
  contentStyle: {
    background: 'oklch(0.12 0 0)',
    border: '1px solid oklch(1 0 0 / 0.08)',
    borderRadius: '8px',
    fontSize: '11px',
    color: 'oklch(1 0 0 / 0.7)',
  },
};

// ── panels ───────────────────────────────────────────────────────────────────

function Panel({
  icon: Icon,
  title,
  detail,
  children,
  className = '',
}: {
  icon: typeof Activity;
  title: string;
  detail?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 ${className}`}>
      <div className="mb-3 flex items-center gap-2">
        <Icon className="size-3.5 text-white/25" />
        <span className="text-[11px] font-medium tracking-wide text-white/40 uppercase">{title}</span>
        {detail && <span className="ml-auto font-mono text-[10px] text-white/25">{detail}</span>}
      </div>
      {children}
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'default' | 'good' | 'warn' | 'bad';
}) {
  const toneClass =
    tone === 'good'
      ? 'text-emerald-400'
      : tone === 'warn'
        ? 'text-amber-400'
        : tone === 'bad'
          ? 'text-red-400'
          : 'text-white/90';
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
      <div className="text-[10px] font-medium tracking-wide text-white/35 uppercase">{label}</div>
      <div className={`mt-1 font-mono text-xl leading-none ${toneClass}`}>{value}</div>
      {sub && <div className="mt-1.5 truncate text-[10px] text-white/30">{sub}</div>}
    </div>
  );
}

function LatestEvents({ events }: { events: ObservabilityEvent[] }) {
  return (
    <div className="max-h-[280px] space-y-0.5 overflow-y-auto pr-1">
      {events.length === 0 && <p className="text-xs text-white/25">No engine events in the journal tail</p>}
      {events
        .slice()
        .reverse()
        .map(event => {
          const Icon = eventIcon(event.eventType);
          return (
            <div
              key={event.seq}
              className="flex items-center gap-2 rounded px-1.5 py-1 text-[11px] transition-colors hover:bg-white/[0.03]"
            >
              <Icon className={`size-3 shrink-0 ${eventColor(event.eventType)}`} />
              <span className="min-w-0 flex-1 truncate text-white/60" title={event.eventType}>
                {event.eventType}
              </span>
              {event.workspaceName && (
                <span className="max-w-[120px] shrink-0 truncate font-mono text-[9px] text-white/25">
                  {event.workspaceName}
                </span>
              )}
              <span className="shrink-0 text-[10px] text-white/20">{relative(event.createdAt)}</span>
            </div>
          );
        })}
    </div>
  );
}

function WorkstationBars({ rows }: { rows: ObservabilitySnapshot['events']['byWorkspace24h'] }) {
  const max = Math.max(rows[0]?.count ?? 1, 1);
  return (
    <div className="space-y-2">
      {rows.length === 0 && <p className="text-xs text-white/25">No event-to-workspace mapping in the last 24h</p>}
      {rows.map(row => (
        <div key={`${row.workspaceId ?? 'none'}:${row.workspaceName}`} className="flex items-center gap-3">
          <span className="w-36 shrink-0 truncate text-xs text-white/60" title={row.workspaceId ?? undefined}>
            {row.workspaceName}
          </span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.04]">
            <div
              className="h-full rounded-full bg-[color:oklch(95%_0.15_108_/_0.55)]"
              style={{ width: `${Math.max((row.count / max) * 100, 2)}%` }}
            />
          </div>
          <span className="w-14 shrink-0 text-right font-mono text-[10px] text-white/30">
            {formatCount(row.count)}
          </span>
        </div>
      ))}
    </div>
  );
}

function Breakdown({
  rows,
  colors,
}: {
  rows: Array<{ label: string; count: number }>;
  colors?: Record<string, string>;
}) {
  const max = Math.max(...rows.map(r => r.count), 1);
  return (
    <div className="space-y-1.5">
      {rows.length === 0 && <p className="text-xs text-white/25">No data</p>}
      {rows.map(row => (
        <div key={row.label} className="flex items-center gap-2">
          <span className="w-28 shrink-0 truncate text-[11px] text-white/55">{row.label}</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.04]">
            <div
              className={`h-full rounded-full ${colors?.[row.label] ?? 'bg-white/25'}`}
              style={{ width: `${Math.max((row.count / max) * 100, 2)}%` }}
            />
          </div>
          <span className="w-12 shrink-0 text-right font-mono text-[10px] text-white/30">
            {formatCount(row.count)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

function RetriesPanel({ workers }: { workers: Array<Record<string, unknown>> }) {
  const rows = useMemo(
    () =>
      [...workers].sort(
        (a, b) =>
          (Date.parse(String(b.started_at ?? '')) || 0) - (Date.parse(String(a.started_at ?? '')) || 0),
      ),
    [workers],
  );
  const failed = workers.filter(worker =>
    ['failed', 'terminated', 'blocked'].includes(String(worker.status)),
  ).length;
  const running = workers.filter(
    worker => worker.status === 'running' || worker.status === 'launching',
  ).length;
  const transport = workers.filter(worker =>
    /provider_unreachable|socket|ECONN|unexpected server error|closed unexpectedly|temporarily unavailable/i.test(
      String(worker.error ?? ''),
    ),
  ).length;

  return (
    <section className="rounded-xl border border-white/[0.06] bg-white/[0.02]">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-3">
        <div className="flex items-center gap-2">
          <RefreshCw className="size-4 text-white/35" />
          <h2 className="text-sm font-semibold tracking-tight text-white/85">
            Retries &amp; provider attempts
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[10px] text-white/30">
          <span>{workers.length} recorded</span>
          <span>{running} live</span>
          <span>{failed} failed/terminated</span>
          <span>{transport} transport/provider</span>
          {rows.length > 25 ? <span>latest 25</span> : null}
        </div>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[11px]">
          <thead className="text-[9px] uppercase tracking-wide text-white/25">
            <tr>
              {['role', 'status', 'route', 'started', 'took', 'error'].map(heading => (
                <th key={heading} className="px-4 py-2 font-medium">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-4 text-xs text-white/25">
                  No worker attempts recorded yet.
                </td>
              </tr>
            ) : (
              rows.slice(0, 25).map((worker, index) => {
                const started = Date.parse(String(worker.started_at ?? ''));
                const finished = Date.parse(String(worker.finished_at ?? ''));
                const took =
                  Number.isFinite(started) && Number.isFinite(finished)
                    ? Math.max(0, Math.round((finished - started) / 1000))
                    : null;
                const status = String(worker.status ?? 'unknown');
                const error = String(worker.error ?? '');
                const statusClass =
                  status === 'running' || status === 'launching'
                    ? 'text-[color:oklch(95%_0.15_108)]'
                    : status === 'failed' || status === 'terminated' || status === 'blocked'
                      ? 'text-red-300'
                      : status === 'succeeded'
                        ? 'text-emerald-300'
                        : 'text-white/35';
                return (
                  <tr
                    key={String(worker.worker_id ?? index)}
                    className="border-t border-white/[0.04]"
                  >
                    <td className="px-4 py-1.5 font-mono text-white/60">
                      {String(worker.role ?? '—')}
                    </td>
                    <td className={`px-4 py-1.5 ${statusClass}`}>{status}</td>
                    <td className="px-4 py-1.5 font-mono text-white/30">
                      {String(worker.provider_id ?? '')}
                      {worker.model_id ? `/${String(worker.model_id)}` : ''}
                    </td>
                    <td className="px-4 py-1.5 text-white/30">
                      {Number.isFinite(started) ? relative(new Date(started).toISOString()) : '—'}
                    </td>
                    <td className="px-4 py-1.5 text-white/30">
                      {took != null ? `${took}s` : '—'}
                    </td>
                    <td
                      className={`max-w-[560px] truncate px-4 py-1.5 ${error ? 'text-red-300/80' : 'text-white/25'}`}
                      title={error}
                    >
                      {error || '—'}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-2 text-[10px] text-white/25">
        Every governor, reviewer, adjudicator and mutation attempt is recorded here — including
        provider preflight failures and retry-backoff attempts.
      </p>
    </section>
  );
}

export function ObservabilityPageClient({ departmentId }: { departmentId: string }) {
  const trpc = useTRPC();
  const [agileRange, setAgileRange] = useState<'1d' | '3d' | '7d' | '30d'>('3d');
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const [agileUnit, setAgileUnit] = useState<'points' | 'tickets'>('points');
  const [sizingBusy, setSizingBusy] = useState(false);

  const snapshotQuery = useQuery({
    ...trpc.helldesk.getDepartmentObservability.queryOptions({ departmentId }),
    refetchInterval: 5_000,
  });

  const workersQuery = useQuery({
    queryKey: ['helldesk', 'worker-attempts'],
    queryFn: async () => {
      const response = await fetch('/api/v1/workers');
      if (!response.ok) return [] as Array<Record<string, unknown>>;
      const json = (await response.json().catch(() => null)) as { workers?: unknown } | null;
      return Array.isArray(json?.workers) ? (json.workers as Array<Record<string, unknown>>) : [];
    },
    refetchInterval: 5_000,
  });

  const snapshot = snapshotQuery.data as ObservabilitySnapshot | undefined;
  const agile = snapshot?.agile;

  const hourlyData = useMemo(
    () =>
      (snapshot?.events.perHour24h ?? []).map(bucket => ({
        label: format(new Date(bucket.hour), 'HH:mm'),
        count: bucket.count,
      })),
    [snapshot]
  );

  const typeData = useMemo(
    () =>
      (snapshot?.events.byType24h ?? []).slice(0, 12).map(row => ({
        type: row.eventType,
        count: row.count,
      })),
    [snapshot]
  );

  const gateRows = useMemo(
    () =>
      (snapshot?.gates.byGate ?? []).slice(0, 10).map(gate => ({
        gateKey: gate.gateKey,
        pass: gate.pass,
        fail: gate.fail,
        unverified: gate.unverified,
      })),
    [snapshot]
  );

  const events24h = snapshot?.events.last24h ?? 0;
  const completed24h = snapshot?.reviews.completed24h ?? 0;
  const blockerCount =
    snapshot?.findings.bySeverity.find(row => row.severity === 'BLOCKER')?.count ?? 0;
  const hasUsage = (snapshot?.usage.runs ?? 0) > 0;

  const selectedMission = useMemo(() => {
    if (!agile) return null;
    return (
      agile.missions.find(mission => mission.missionId === selectedMissionId) ??
      agile.missions.find(mission => mission.state !== 'VERIFIED_10_10' && mission.state !== 'CANCELLED') ??
      agile.missions[0] ??
      null
    );
  }, [agile, selectedMissionId]);

  const rangeHours = agileRange === '1d' ? 24 : agileRange === '3d' ? 72 : 168;
  const rangeBuckets = useMemo(() => {
    if (!agile) return [];
    if (agileRange === '30d') return agile.throughputDaily.slice(-30);
    return agile.throughputHourly.slice(-rangeHours);
  }, [agile, agileRange, rangeHours]);

  const reviewBuckets = useMemo(() => {
    if (!agile) return [];
    const rows = agileRange === '30d'
      ? agile.reviewLatencyDaily.slice(-30)
      : agile.reviewLatencyHourly.slice(-rangeHours);
    return rows.map(bucket => ({
      ...bucket,
      avgMinutes: bucket.avgMs == null ? null : Math.round((bucket.avgMs / 60_000) * 10) / 10,
      p85Minutes: bucket.p85Ms == null ? null : Math.round((bucket.p85Ms / 60_000) * 10) / 10,
    }));
  }, [agile, agileRange, rangeHours]);

  const rangeLabel = agileRange;
  const sizingCoverage = agile?.sizing.coverage ?? 0;
  const unsizedTickets = (agile?.sizing.totalTickets ?? 0) - (agile?.sizing.sizedTickets ?? 0);
  const effectiveUnit = agileUnit === 'points' && sizingCoverage > 0 ? 'points' : 'tickets';
  const rangeTicketsVerified = rangeBuckets.reduce((sum, bucket) => sum + bucket.ticketsVerified, 0);
  const rangeMissionsVerified = rangeBuckets.reduce((sum, bucket) => sum + bucket.missionsVerified, 0);
  const rangeTicketsCreated = rangeBuckets.reduce((sum, bucket) => sum + bucket.ticketsCreated, 0);
  const rangeMissionsCreated = rangeBuckets.reduce((sum, bucket) => sum + bucket.missionsCreated, 0);
  const rangeStoryPointsVerified = rangeBuckets.reduce((sum, bucket) => sum + bucket.storyPointsVerified, 0);
  const rangeStoryPointsCreated = rangeBuckets.reduce((sum, bucket) => sum + bucket.storyPointsCreated, 0);
  const cumulativeHourly = useMemo(() => {
    let created = 0;
    let verified = 0;
    let createdPoints = 0;
    let verifiedPoints = 0;
    return (agile?.throughputHourly ?? []).map(bucket => {
      created += bucket.ticketsCreated;
      verified += bucket.ticketsVerified;
      createdPoints += bucket.storyPointsCreated;
      verifiedPoints += bucket.storyPointsVerified;
      return {
        ...bucket,
        cumulativeCreated: created,
        cumulativeVerified: verified,
        remaining: Math.max(0, created - verified),
        cumulativeCreatedPoints: createdPoints,
        cumulativeVerifiedPoints: verifiedPoints,
        remainingPoints: Math.max(0, createdPoints - verifiedPoints),
      };
    });
  }, [agile]);
  const cumulativeDaily = useMemo(() => {
    let created = 0;
    let verified = 0;
    let createdPoints = 0;
    let verifiedPoints = 0;
    return (agile?.throughputDaily ?? []).map(bucket => {
      created += bucket.ticketsCreated;
      verified += bucket.ticketsVerified;
      createdPoints += bucket.storyPointsCreated;
      verifiedPoints += bucket.storyPointsVerified;
      return {
        ...bucket,
        cumulativeCreated: created,
        cumulativeVerified: verified,
        remaining: Math.max(0, created - verified),
        cumulativeCreatedPoints: createdPoints,
        cumulativeVerifiedPoints: verifiedPoints,
        remainingPoints: Math.max(0, createdPoints - verifiedPoints),
      };
    });
  }, [agile]);
  const burnupBuckets = agileRange === '30d' ? cumulativeDaily : cumulativeHourly.slice(-rangeHours);
  const missionChartData = useMemo(() => {
    if (!selectedMission) return [];
    const usePoints = effectiveUnit === 'points' && selectedMission.sizingCoverage >= 1;
    return selectedMission.burndown.map(point => ({
      label: point.label,
      remaining: usePoints ? point.remainingPoints : point.remaining,
      ideal: usePoints ? point.idealPoints : point.ideal,
      scope: usePoints ? point.createdPoints : point.created,
    }));
  }, [selectedMission, effectiveUnit]);

  const runSizingBackfill = async () => {
    setSizingBusy(true);
    try {
      const result = await requestTaskSizingBackfill(10);
      if (result.queued > 0) {
        toast.success(`Queued ${result.queued} task${result.queued === 1 ? '' : 's'} for sizing`, {
          description: 'Estimates land in the background; coverage refreshes as they finish.',
        });
      } else if (result.running) {
        toast('Sizing pass already running', {
          description: `${result.remaining} task${result.remaining === 1 ? '' : 's'} still unsized.`,
        });
      } else {
        toast.success('All visible task tickets are sized');
      }
      await snapshotQuery.refetch();
      // The engine sizes sequentially; refresh a few times while the queue drains.
      for (const delay of [6_000, 18_000, 40_000, 90_000, 180_000]) {
        setTimeout(() => void snapshotQuery.refetch(), delay);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Sizing backfill failed');
    } finally {
      setSizingBusy(false);
    }
  };

  const cycleRows = useMemo(
    () =>
      (agile?.missions ?? [])
        .filter(mission => mission.cycleTimeMs != null)
        .slice(0, 8)
        .map(mission => ({
          label: mission.objective.length > 34 ? `${mission.objective.slice(0, 33)}…` : mission.objective,
          hours: Math.round(((mission.cycleTimeMs ?? 0) / 3_600_000) * 10) / 10,
        })),
    [agile]
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-3">
        <div className="flex items-center gap-2">
          <Activity className="size-4 text-[color:oklch(95%_0.15_108_/_0.6)]" />
          <h1 className="text-lg font-semibold tracking-tight text-white/90">Observability</h1>
          {snapshot ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
              <span className="size-1.5 rounded-full bg-emerald-400" />
              Engine live
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/20 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-400">
              <span className="size-1.5 rounded-full bg-red-400" />
              {snapshotQuery.isError ? 'Engine unreachable' : 'Connecting…'}
            </span>
          )}
          {snapshot && (
            <span className="ml-1 font-mono text-xs text-white/30">
              {formatCount(events24h)} events / 24h · {formatCount(snapshot.events.total)} journaled
            </span>
          )}
        </div>
        <span className="font-mono text-[10px] text-white/20">
          {snapshot ? `refreshed ${relative(snapshot.generatedAt)}` : ''}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {snapshotQuery.isLoading && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-[74px] animate-pulse rounded-xl border border-white/[0.06] bg-white/[0.02]" />
            ))}
          </div>
        )}

        {snapshotQuery.isError && !snapshot && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/[0.04] p-6 text-sm text-red-300">
            The engine observability endpoint is unreachable. The console is showing no synthetic data.
            <div className="mt-2 font-mono text-xs text-red-300/60">
              {(snapshotQuery.error as Error | null)?.message ?? 'unknown error'}
            </div>
          </div>
        )}

        {snapshot && (
          <div className="space-y-5">
            {/* KPI strip */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
              <Kpi
                label="Queue"
                value={formatCount(snapshot.engine.queue.queued + snapshot.engine.queue.running)}
                sub={`${snapshot.engine.queue.queued} queued · ${snapshot.engine.queue.running} running`}
                tone={snapshot.engine.queue.queued > 0 ? 'warn' : 'good'}
              />
              <Kpi
                label="Events / 24h"
                value={formatCount(events24h)}
                sub={`${formatCount(snapshot.events.lastHour)} in the last hour`}
              />
              <Kpi
                label="Open reviews"
                value={formatCount(snapshot.reviews.open)}
                sub={`${formatCount(completed24h)} completed / 24h`}
                tone={snapshot.reviews.open > 0 ? 'warn' : 'good'}
              />
              <Kpi
                label="PASS share"
                value={share(snapshot.reviews.pass24h, completed24h)}
                sub={`${snapshot.reviews.pass24h} pass · ${snapshot.reviews.findings24h} findings · ${snapshot.reviews.inconclusive24h} inconclusive`}
                tone={completed24h > 0 && snapshot.reviews.pass24h / completed24h >= 0.6 ? 'good' : 'warn'}
              />
              <Kpi
                label="Verified missions"
                value={formatCount(snapshot.missions.verified24h)}
                sub={`${formatCount(snapshot.missions.verified)} verified · ${formatCount(snapshot.missions.active)} active${
                  snapshot.missions.blocked > 0 ? ` · ${formatCount(snapshot.missions.blocked)} blocked` : ''
                }`}
                tone={snapshot.missions.blocked > 0 ? 'warn' : 'good'}
              />
              <Kpi
                label="Blockers"
                value={formatCount(blockerCount)}
                sub={`${formatCount(snapshot.findings.total)} findings total`}
                tone={blockerCount > 0 ? 'bad' : 'good'}
              />
              <Kpi
                label="Workers running"
                value={formatCount(snapshot.workers.running)}
                sub={`${formatCount(snapshot.workers.recentFailures24h)} failures / 24h`}
                tone={snapshot.workers.recentFailures24h > 0 ? 'warn' : 'good'}
              />
              <Kpi
                label="Tokens"
                value={hasUsage ? formatCount(snapshot.usage.tokensIn + snapshot.usage.tokensOut) : '—'}
                sub={
                  hasUsage
                    ? `all-time in ${formatCount(snapshot.usage.tokensIn)} · out ${formatCount(snapshot.usage.tokensOut)}`
                    : 'no recorded runs'
                }
              />
            </div>

            <RetriesPanel workers={workersQuery.data ?? []} />

            {/* ── AGILE / KANBAN ───────────────────────────────────────────── */}
            <div className="space-y-3">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <Zap className="size-4 text-[color:oklch(95%_0.15_108_/_0.6)]" />
                    <h2 className="text-sm font-semibold tracking-tight text-white/90">Agile / Kanban</h2>
                    <span className="rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-white/35">
                      {effectiveUnit === 'points' ? 'story points' : 'ticket counts'}
                    </span>
                  </div>
                  <p className="mt-1 max-w-2xl text-[10px] leading-relaxed text-white/30">
                    A mission is our sprint/portfolio item. Tasks are T-shirt sized at creation by a small
                    structured-JSON model, so points are estimates — not promises. Unsized scopes fall back to ticket counts.
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <div className="flex items-center gap-1">
                    {(['points', 'tickets'] as const).map(unit => (
                      <button
                        key={unit}
                        type="button"
                        disabled={unit === 'points' && sizingCoverage === 0}
                        title={unit === 'points' && sizingCoverage === 0 ? 'No task tickets are sized yet' : undefined}
                        onClick={() => setAgileUnit(unit)}
                        className={`rounded-md border px-2 py-1 text-[10px] font-semibold transition-colors disabled:opacity-35 ${
                          effectiveUnit === unit
                            ? 'border-[color:oklch(95%_0.15_108_/_0.3)] bg-[color:oklch(95%_0.15_108_/_0.1)] text-[color:oklch(95%_0.15_108)]'
                            : 'border-white/[0.06] text-white/35 hover:bg-white/[0.04] hover:text-white/60'
                        }`}
                      >
                        {unit === 'points' ? 'Points' : 'Tickets'}
                      </button>
                    ))}
                  </div>
                  <span className="text-[9px] text-white/25">
                    sized {snapshot.agile.sizing.sizedTickets}/{snapshot.agile.sizing.totalTickets} ·{' '}
                    {Math.round(sizingCoverage * 100)}%
                  </span>
                  {unsizedTickets > 0 ? (
                    <button
                      type="button"
                      disabled={sizingBusy}
                      onClick={() => void runSizingBackfill()}
                      className="rounded-md border border-amber-300/20 bg-amber-300/[0.06] px-2 py-1 text-[9px] font-semibold text-amber-100/75 hover:bg-amber-300/10 disabled:opacity-50"
                      title="Run the structured-JSON T-shirt sizer on unsized mission tickets"
                    >
                      {sizingBusy ? 'Sizing…' : `Size ${unsizedTickets} unsized`}
                    </button>
                  ) : null}
                  <div className="flex items-center gap-1">
                    {(['1d', '3d', '7d', '30d'] as const).map(range => (
                      <button
                        key={range}
                        type="button"
                        onClick={() => setAgileRange(range)}
                        className={`rounded-md border px-2.5 py-1 text-[10px] font-semibold transition-colors ${
                          agileRange === range
                            ? 'border-[color:oklch(95%_0.15_108_/_0.3)] bg-[color:oklch(95%_0.15_108_/_0.1)] text-[color:oklch(95%_0.15_108)]'
                            : 'border-white/[0.06] text-white/35 hover:bg-white/[0.04] hover:text-white/60'
                        }`}
                      >
                        {range}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                <Kpi
                  label={effectiveUnit === 'points' ? 'Story points verified' : 'Tickets verified'}
                  value={formatCount(effectiveUnit === 'points' ? rangeStoryPointsVerified : rangeTicketsVerified)}
                  sub={`${rangeMissionsVerified} missions · ${rangeLabel} · ${Math.round(sizingCoverage * 100)}% sized`}
                  tone={(effectiveUnit === 'points' ? rangeStoryPointsVerified : rangeTicketsVerified) > 0 ? 'good' : 'warn'}
                />
                <Kpi
                  label={effectiveUnit === 'points' ? 'Story points created' : 'Tickets created'}
                  value={formatCount(effectiveUnit === 'points' ? rangeStoryPointsCreated : rangeTicketsCreated)}
                  sub={`${rangeMissionsCreated} missions · scope added`}
                />
                <Kpi
                  label="Mission cycle p50"
                  value={formatDuration(snapshot.agile.cycleTime.missions.p50Ms)}
                  sub={`p85 ${formatDuration(snapshot.agile.cycleTime.missions.p85Ms)} · ${snapshot.agile.cycleTime.missions.count} missions · 30d`}
                />
                <Kpi
                  label="Ticket cycle p50"
                  value={formatDuration(snapshot.agile.cycleTime.tickets.p50Ms)}
                  sub={`p85 ${formatDuration(snapshot.agile.cycleTime.tickets.p85Ms)} · ${snapshot.agile.cycleTime.tickets.count} tickets · 30d`}
                />
                <Kpi
                  label="Awaiting acceptance"
                  value={formatCount(snapshot.agile.wip.awaitingAcceptance)}
                  sub="verified · human gate"
                  tone={snapshot.agile.wip.awaitingAcceptance > 0 ? 'warn' : 'good'}
                />
                <Kpi
                  label="Active WIP"
                  value={formatCount(snapshot.agile.wip.open + snapshot.agile.wip.inProgress)}
                  sub={`${snapshot.agile.wip.inReview} in review · ${snapshot.agile.wip.blocked} blocked`}
                  tone={snapshot.agile.wip.blocked > 0 ? 'bad' : 'default'}
                />
              </div>

              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                {/* Mission burndown */}
                <Panel
                  icon={Clock}
                  title="Mission Burndown"
                  detail={selectedMission
                    ? `${selectedMission.storyPoints} pts · ${selectedMission.tickets} tickets · ${Math.round(selectedMission.sizingCoverage * 100)}% sized · ${selectedMission.state}`
                    : 'no mission'}
                >
                  {selectedMission && selectedMission.burndown.length > 0 ? (
                    <>
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <select
                          value={selectedMission.missionId}
                          onChange={event => setSelectedMissionId(event.target.value)}
                          className="max-w-[430px] rounded-md border border-white/[0.08] bg-black/20 px-2 py-1 text-[10px] text-white/70 focus:border-teal-300/30 focus:outline-none"
                        >
                          {snapshot.agile.missions.map(mission => (
                            <option key={mission.missionId} value={mission.missionId}>
                              {shortObjective(mission.objective)} · {mission.state} · {mission.storyPoints} pts · {mission.tickets} tickets
                            </option>
                          ))}
                        </select>
                        <span className="text-[9px] text-white/30">
                          {selectedMission.verifiedAt
                            ? `verified ${relative(selectedMission.verifiedAt)}`
                            : 'active · no target line'}
                        </span>
                      </div>
                      <div className="h-[200px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={missionChartData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                            <CartesianGrid stroke="oklch(1 0 0 / 0.04)" strokeDasharray="3 3" />
                            <XAxis
                              dataKey="label"
                              tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                              axisLine={{ stroke: 'oklch(1 0 0 / 0.06)' }}
                              tickLine={false}
                              minTickGap={24}
                            />
                            <YAxis
                              allowDecimals={false}
                              tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                              axisLine={false}
                              tickLine={false}
                              width={28}
                            />
                            <Tooltip {...tooltipStyles} />
                            <Legend wrapperStyle={{ fontSize: 10, color: 'oklch(1 0 0 / 0.4)' }} />
                            <Line type="monotone" dataKey="remaining" name="remaining" stroke="oklch(95% 0.15 108)" strokeWidth={2} dot={false} />
                            <Line type="monotone" dataKey="created" name="scope" stroke="oklch(70% 0.14 250 / 0.6)" dot={false} />
                            {selectedMission.burndown.some(point => point.ideal != null) ? (
                              <Line
                                type="monotone"
                                dataKey="ideal"
                                name="ideal"
                                stroke="oklch(1 0 0 / 0.3)"
                                strokeDasharray="4 3"
                                dot={false}
                              />
                            ) : null}
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </>
                  ) : (
                    <p className="text-xs text-white/25">No ticket burndown for this mission yet.</p>
                  )}
                </Panel>

                {/* Throughput */}
                <Panel icon={Zap} title="Throughput" detail={`${rangeLabel} · ${effectiveUnit === 'points' ? 'points' : 'tickets'} / missions`}>
                  {rangeTicketsVerified + rangeMissionsVerified + rangeTicketsCreated > 0 ? (
                    <div className="h-[200px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={rangeBuckets} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                          <CartesianGrid stroke="oklch(1 0 0 / 0.04)" strokeDasharray="3 3" />
                          <XAxis
                            dataKey="label"
                            tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                            axisLine={{ stroke: 'oklch(1 0 0 / 0.06)' }}
                            tickLine={false}
                            minTickGap={18}
                          />
                          <YAxis
                            yAxisId="left"
                            allowDecimals={false}
                            tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                            axisLine={false}
                            tickLine={false}
                            width={28}
                          />
                          <YAxis
                            yAxisId="right"
                            orientation="right"
                            allowDecimals={false}
                            tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                            axisLine={false}
                            tickLine={false}
                            width={22}
                          />
                          <Tooltip {...tooltipStyles} />
                          <Legend wrapperStyle={{ fontSize: 10, color: 'oklch(1 0 0 / 0.4)' }} />
                          <Bar
                            yAxisId="left"
                            dataKey={effectiveUnit === 'points' ? 'storyPointsVerified' : 'ticketsVerified'}
                            name={effectiveUnit === 'points' ? 'points verified' : 'tickets verified'}
                            fill="oklch(95% 0.15 108 / 0.45)"
                            radius={[3, 3, 0, 0]}
                          />
                          <Line
                            yAxisId="right"
                            type="monotone"
                            dataKey="missionsVerified"
                            name="missions verified"
                            stroke="oklch(75% 0.18 150)"
                            strokeWidth={2}
                            dot={false}
                          />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <p className="text-xs text-white/25">No created or verified work in this window.</p>
                  )}
                </Panel>

                {/* Portfolio burnup / remaining */}
                <Panel icon={GitMerge} title="Portfolio Burnup / Remaining" detail={`cumulative ${effectiveUnit === 'points' ? 'points' : 'tickets'} · ${rangeLabel}`}>
                  {burnupBuckets.some(bucket => bucket.cumulativeCreated > 0) ? (
                    <div className="h-[200px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={burnupBuckets} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                          <CartesianGrid stroke="oklch(1 0 0 / 0.04)" strokeDasharray="3 3" />
                          <XAxis
                            dataKey="label"
                            tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                            axisLine={{ stroke: 'oklch(1 0 0 / 0.06)' }}
                            tickLine={false}
                            minTickGap={18}
                          />
                          <YAxis
                            allowDecimals={false}
                            tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                            axisLine={false}
                            tickLine={false}
                            width={28}
                          />
                          <Tooltip {...tooltipStyles} />
                          <Legend wrapperStyle={{ fontSize: 10, color: 'oklch(1 0 0 / 0.4)' }} />
                          <Area
                            type="monotone"
                            dataKey={effectiveUnit === 'points' ? 'remainingPoints' : 'remaining'}
                            name="remaining"
                            stroke="oklch(95% 0.15 108 / 0.55)"
                            fill="oklch(95% 0.15 108 / 0.08)"
                            strokeWidth={1.5}
                          />
                          <Line
                            type="monotone"
                            dataKey={effectiveUnit === 'points' ? 'cumulativeCreatedPoints' : 'cumulativeCreated'}
                            name="scope created"
                            stroke="oklch(70% 0.14 250 / 0.6)"
                            dot={false}
                          />
                          <Line
                            type="monotone"
                            dataKey={effectiveUnit === 'points' ? 'cumulativeVerifiedPoints' : 'cumulativeVerified'}
                            name="done"
                            stroke="oklch(75% 0.18 150)"
                            dot={false}
                          />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <p className="text-xs text-white/25">No ticket scope created in the last 30 days.</p>
                  )}
                </Panel>

                {/* Cycle time */}
                <Panel icon={Activity} title="Cycle Time" detail="created → verified · 30d">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2">
                      <div className="text-[9px] uppercase tracking-wide text-white/30">
                        Missions · {snapshot.agile.cycleTime.missions.count}
                      </div>
                      {[
                        ['p50', snapshot.agile.cycleTime.missions.p50Ms],
                        ['p85', snapshot.agile.cycleTime.missions.p85Ms],
                        ['p95', snapshot.agile.cycleTime.missions.p95Ms],
                      ].map(([label, value]) => (
                        <div key={String(label)} className="mt-1 flex items-center justify-between text-[10px]">
                          <span className="text-white/40">{label}</span>
                          <span className="font-mono text-white/70">{formatDuration(value as number | null)}</span>
                        </div>
                      ))}
                    </div>
                    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2">
                      <div className="text-[9px] uppercase tracking-wide text-white/30">
                        Tickets · {snapshot.agile.cycleTime.tickets.count}
                      </div>
                      {[
                        ['p50', snapshot.agile.cycleTime.tickets.p50Ms],
                        ['p85', snapshot.agile.cycleTime.tickets.p85Ms],
                        ['p95', snapshot.agile.cycleTime.tickets.p95Ms],
                      ].map(([label, value]) => (
                        <div key={String(label)} className="mt-1 flex items-center justify-between text-[10px]">
                          <span className="text-white/40">{label}</span>
                          <span className="font-mono text-white/70">{formatDuration(value as number | null)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  {cycleRows.length > 0 ? (
                    <div className="mt-2" style={{ height: Math.max(120, cycleRows.length * 22) }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={cycleRows} layout="vertical" margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                          <CartesianGrid stroke="oklch(1 0 0 / 0.04)" strokeDasharray="3 3" />
                          <XAxis
                            type="number"
                            tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                            axisLine={false}
                            tickLine={false}
                          />
                          <YAxis
                            dataKey="label"
                            type="category"
                            width={128}
                            tick={{ fontSize: 8, fill: 'oklch(1 0 0 / 0.35)' }}
                            axisLine={false}
                            tickLine={false}
                            interval={0}
                          />
                          <Tooltip {...tooltipStyles} />
                          <Bar dataKey="hours" name="hours" fill="oklch(95% 0.15 108 / 0.45)" radius={[0, 3, 3, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-white/25">No verified mission cycle time yet.</p>
                  )}
                </Panel>

                {/* Workstation velocity */}
                <Panel
                  icon={Users}
                  title="Workstation Velocity"
                  detail={`${snapshot.agile.workstations.length} workspaces · 7d`}
                >
                  {snapshot.agile.workstations.length > 0 ? (
                    <div style={{ height: Math.max(160, snapshot.agile.workstations.slice(0, 8).length * 26) }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={snapshot.agile.workstations.slice(0, 8)}
                          layout="vertical"
                          margin={{ top: 0, right: 8, left: 0, bottom: 0 }}
                        >
                          <CartesianGrid stroke="oklch(1 0 0 / 0.04)" strokeDasharray="3 3" />
                          <XAxis
                            type="number"
                            allowDecimals={false}
                            tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                            axisLine={false}
                            tickLine={false}
                          />
                          <YAxis
                            dataKey="workspaceName"
                            type="category"
                            width={130}
                            tick={{ fontSize: 8, fill: 'oklch(1 0 0 / 0.35)' }}
                            axisLine={false}
                            tickLine={false}
                            interval={0}
                          />
                          <Tooltip {...tooltipStyles} />
                          <Legend wrapperStyle={{ fontSize: 10, color: 'oklch(1 0 0 / 0.4)' }} />
                          <Bar
                            dataKey={effectiveUnit === 'points' ? 'verifiedStoryPoints' : 'verifiedTickets'}
                            name={effectiveUnit === 'points' ? 'points' : 'tickets'}
                            fill="oklch(95% 0.15 108 / 0.45)"
                            radius={[0, 3, 3, 0]}
                          />
                          <Bar dataKey="verifiedMissions" name="missions" fill="oklch(70% 0.14 250 / 0.55)" radius={[0, 3, 3, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <p className="text-xs text-white/25">No workstation activity in the last 30 days.</p>
                  )}
                </Panel>

                {/* Review latency */}
                <Panel icon={ShieldCheck} title="Review Latency" detail={`${rangeLabel} · requested → verdict`}>
                  {reviewBuckets.some(bucket => bucket.completed > 0) ? (
                    <div className="h-[200px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={reviewBuckets} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                          <CartesianGrid stroke="oklch(1 0 0 / 0.04)" strokeDasharray="3 3" />
                          <XAxis
                            dataKey="label"
                            tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                            axisLine={{ stroke: 'oklch(1 0 0 / 0.06)' }}
                            tickLine={false}
                            minTickGap={18}
                          />
                          <YAxis
                            yAxisId="left"
                            allowDecimals={false}
                            tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                            axisLine={false}
                            tickLine={false}
                            width={26}
                          />
                          <YAxis
                            yAxisId="right"
                            orientation="right"
                            tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                            axisLine={false}
                            tickLine={false}
                            width={26}
                            tickFormatter={(value: number) => `${value}m`}
                          />
                          <Tooltip {...tooltipStyles} />
                          <Legend wrapperStyle={{ fontSize: 10, color: 'oklch(1 0 0 / 0.4)' }} />
                          <Bar
                            yAxisId="left"
                            dataKey="completed"
                            name="reviews"
                            fill="oklch(70% 0.14 250 / 0.45)"
                            radius={[3, 3, 0, 0]}
                          />
                          <Line
                            yAxisId="right"
                            type="monotone"
                            dataKey="avgMinutes"
                            name="avg minutes"
                            stroke="oklch(95% 0.15 108)"
                            strokeWidth={2}
                            dot={false}
                          />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <p className="text-xs text-white/25">No completed reviews in this window.</p>
                  )}
                </Panel>

                {/* WIP */}
                <Panel icon={Bot} title="Current WIP" detail="tickets · live">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {(
                      [
                        ['Open', snapshot.agile.wip.open, 'text-white/65'],
                        ['In progress', snapshot.agile.wip.inProgress, 'text-sky-400'],
                        ['In review', snapshot.agile.wip.inReview, 'text-violet-400'],
                        ['Blocked', snapshot.agile.wip.blocked, 'text-red-400'],
                        ['Done', snapshot.agile.wip.done, 'text-emerald-400'],
                        ['Cancelled', snapshot.agile.wip.cancelled, 'text-white/30'],
                        ['Awaiting acceptance', snapshot.agile.wip.awaitingAcceptance, 'text-amber-400'],
                      ] as const
                    ).map(([label, value, tone]) => (
                      <div key={label} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-2">
                        <div className="text-[9px] uppercase tracking-wide text-white/30">{label}</div>
                        <div className={`mt-0.5 font-mono text-lg leading-none ${tone}`}>{formatCount(value)}</div>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-[9px] leading-snug text-white/25">
                    Awaiting acceptance is verified work waiting for the human gate — separate from active work-in-progress.
                  </p>
                </Panel>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              {/* Event rate */}
              <Panel icon={Clock} title="Events / Hour — 24h" detail={`${hourlyData.length} buckets`}>
                <div className="h-[180px]">
                  {events24h === 0 ? (
                    <div className="flex h-full items-center justify-center text-xs text-white/20">
                      No engine events in the last 24h
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={hourlyData}>
                        <defs>
                          <linearGradient id="obsGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="oklch(95% 0.15 108)" stopOpacity={0.25} />
                            <stop offset="100%" stopColor="oklch(95% 0.15 108)" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid stroke="oklch(1 0 0 / 0.04)" strokeDasharray="3 3" />
                        <XAxis
                          dataKey="label"
                          tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                          axisLine={{ stroke: 'oklch(1 0 0 / 0.06)' }}
                          tickLine={false}
                          interval={3}
                        />
                        <YAxis
                          tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                          axisLine={false}
                          tickLine={false}
                          width={36}
                        />
                        <Tooltip {...tooltipStyles} />
                        <Area
                          type="monotone"
                          dataKey="count"
                          stroke="oklch(95% 0.15 108)"
                          strokeWidth={1.5}
                          fill="url(#obsGrad)"
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </Panel>

              {/* Event types */}
              <Panel icon={Hexagon} title="Event Types — 24h" detail={`${snapshot.events.byType24h.length} distinct`}>
                <div style={{ height: Math.max(200, typeData.length * 22) }}>
                  {typeData.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-xs text-white/20">
                      No event types recorded
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={typeData} layout="vertical" margin={{ left: 4, right: 8 }}>
                        <CartesianGrid stroke="oklch(1 0 0 / 0.04)" strokeDasharray="3 3" />
                        <XAxis
                          type="number"
                          tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.25)' }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis
                          dataKey="type"
                          type="category"
                          tick={{ fontSize: 9, fill: 'oklch(1 0 0 / 0.35)' }}
                          axisLine={false}
                          tickLine={false}
                          width={150}
                          // Every category gets its own label; auto-interval was
                          // skipping the top (largest) type and shifting the rest.
                          interval={0}
                          tickFormatter={(value: string) =>
                            value.length > 26 ? `${value.slice(0, 25)}…` : value
                          }
                        />
                        <Tooltip {...tooltipStyles} />
                        <Bar dataKey="count" fill="oklch(95% 0.15 108 / 0.5)" radius={[0, 3, 3, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </Panel>

              {/* Workstations */}
              <Panel
                icon={Bot}
                title="Events by Workstation — 24h"
                detail={`${snapshot.events.byWorkspace24h.length} workspaces`}
              >
                <WorkstationBars rows={snapshot.events.byWorkspace24h} />
              </Panel>

              {/* Latest events */}
              <Panel icon={Activity} title="Latest Events" detail="journal tail">
                <LatestEvents events={snapshot.events.latest} />
              </Panel>

              {/* Review outcomes */}
              <Panel icon={GitMerge} title="Review Outcomes" detail={`${snapshot.reviews.total} jobs`}>
                <div className="space-y-4">
                  <Breakdown
                    rows={snapshot.reviews.byState.map(row => ({ label: row.state, count: row.count }))}
                    colors={STATE_COLOR}
                  />
                  <div className="grid grid-cols-2 gap-3 border-t border-white/[0.05] pt-3">
                    <div>
                      <div className="mb-1.5 text-[10px] tracking-wide text-white/30 uppercase">Findings</div>
                      <Breakdown
                        rows={snapshot.findings.bySeverity.map(row => ({
                          label: row.severity,
                          count: row.count,
                        }))}
                        colors={SEVERITY_COLOR}
                      />
                    </div>
                    <div className="space-y-1.5 text-[11px] text-white/45">
                      <div className="flex justify-between">
                        <span>Avg time to verdict</span>
                        <span className="font-mono text-white/70">
                          {formatDuration(snapshot.reviews.avgTimeToVerdictMs)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>Oldest open review</span>
                        <span className="font-mono text-white/70">
                          {formatDuration(snapshot.reviews.oldestOpenAgeMs)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>Gates passed</span>
                        <span className="font-mono text-white/70">
                          {snapshot.gates.byStatus.find(row => row.status === 'PASS')?.count ?? 0}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>Gates failed</span>
                        <span className="font-mono text-white/70">
                          {snapshot.gates.byStatus.find(row => row.status === 'FAIL')?.count ?? 0}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>Gates unverified</span>
                        <span className="font-mono text-white/70">
                          {snapshot.gates.byStatus.find(row => row.status === 'UNVERIFIED')?.count ?? 0}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </Panel>

              {/* Worker health */}
              <Panel icon={Users} title="Worker Health" detail={`${snapshot.workers.total} recorded`}>
                <div className="space-y-3">
                  <Breakdown
                    rows={snapshot.workers.byStatus.map(row => ({ label: row.status, count: row.count }))}
                    colors={{
                      running: 'bg-emerald-500/70',
                      succeeded: 'bg-sky-500/60',
                      failed: 'bg-red-500/70',
                      terminated: 'bg-white/25',
                      launching: 'bg-indigo-500/70',
                    }}
                  />
                  <div className="border-t border-white/[0.05] pt-2">
                    <div className="mb-1.5 text-[10px] tracking-wide text-white/30 uppercase">
                      Active workers
                    </div>
                    {snapshot.workers.active.length === 0 ? (
                      <p className="text-xs text-white/25">No worker processes running</p>
                    ) : (
                      <div className="space-y-1">
                        {snapshot.workers.active.map(worker => (
                          <div key={worker.workerId} className="flex items-center gap-2 text-[11px]">
                            <Shield className="size-3 shrink-0 text-sky-400/70" />
                            <span className="w-24 shrink-0 truncate text-white/65">
                              {worker.role ?? worker.workerId}
                            </span>
                            <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-white/25">
                              {worker.jobId}
                            </span>
                            <span className="shrink-0 text-white/25">
                              {worker.modelId ?? worker.providerId ?? 'engine default'}
                            </span>
                            <span className="w-16 shrink-0 text-right font-mono text-[10px] text-white/30">
                              {formatDuration(worker.ageMs)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </Panel>
            </div>

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
              {/* Recent review jobs */}
              <Panel
                icon={Layers}
                title="Recent Review Jobs"
                detail="newest 10"
                className="lg:col-span-2"
              >
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[11px]">
                    <thead className="text-[9px] tracking-wide text-white/25 uppercase">
                      <tr className="border-b border-white/[0.06]">
                        <th className="pb-1.5 pr-3 font-medium">Job</th>
                        <th className="pb-1.5 pr-3 font-medium">Workspace</th>
                        <th className="pb-1.5 pr-3 font-medium">State</th>
                        <th className="pb-1.5 pr-3 font-medium">Attempts</th>
                        <th className="pb-1.5 pr-3 font-medium">Duration</th>
                        <th className="pb-1.5 font-medium">Requested</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.recentJobs.length === 0 && (
                        <tr>
                          <td colSpan={6} className="py-3 text-center text-white/25">
                            No review jobs recorded
                          </td>
                        </tr>
                      )}
                      {snapshot.recentJobs.map(job => (
                        <tr key={job.jobId} className="border-b border-white/[0.03]">
                          <td className="py-1.5 pr-3 font-mono text-[10px] text-white/45">
                            {job.jobId.slice(0, 14)}
                          </td>
                          <td className="py-1.5 pr-3 text-white/60">{job.workspaceName}</td>
                          <td className={`py-1.5 pr-3 ${STATE_COLOR[job.state] ?? 'text-white/50'}`}>
                            {job.state}
                          </td>
                          <td className="py-1.5 pr-3 font-mono text-white/35">{job.attemptCount}</td>
                          <td className="py-1.5 pr-3 font-mono text-white/45">
                            {formatDuration(job.durationMs)}
                          </td>
                          <td className="py-1.5 text-white/30">{relative(job.requestedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>

              {/* Recovery + usage */}
              <Panel icon={RefreshCw} title="Recovery & Usage" detail="24h / all-time">
                <div className="space-y-2 text-[11px]">
                  {[
                    ['Requeued jobs', snapshot.recovery.requeued24h],
                    ['Retried jobs', snapshot.recovery.retried24h],
                    ['Recovered revisions', snapshot.recovery.recovered24h],
                    ['Replanned missions', snapshot.recovery.replanned24h],
                    ['Blocked missions', snapshot.recovery.blocked24h],
                    ['Failed repairs', snapshot.recovery.failedRepairs24h],
                  ].map(([label, value]) => (
                    <div key={String(label)} className="flex items-center justify-between">
                      <span className="text-white/45">{label}</span>
                      <span className={`font-mono ${Number(value) > 0 ? 'text-amber-400' : 'text-white/60'}`}>
                        {formatCount(Number(value))}
                      </span>
                    </div>
                  ))}
                  <div className="mt-3 space-y-2 border-t border-white/[0.05] pt-3">
                    <div className="flex items-center justify-between">
                      <span className="text-white/45">Agent runs</span>
                      <span className="font-mono text-white/60">{formatCount(snapshot.usage.runs)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-white/45">Token usage</span>
                      <span className="font-mono text-white/60">
                        {formatCount(snapshot.usage.tokensIn)} / {formatCount(snapshot.usage.tokensOut)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-white/45">Avg run duration</span>
                      <span className="font-mono text-white/60">
                        {formatDuration(snapshot.usage.avgRunDurationMs)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-white/45">Recorded cost</span>
                      <span className="font-mono text-white/60">
                        {snapshot.usage.cost > 0 ? `$${snapshot.usage.cost.toFixed(2)}` : 'not reported'}
                      </span>
                    </div>
                  </div>
                </div>
              </Panel>
            </div>

            {/* Gate matrix */}
            <Panel icon={ShieldCheck} title="Quality Gates" detail={`${snapshot.gates.total} evaluations`}>
              {gateRows.length === 0 ? (
                <p className="text-xs text-white/25">No quality-gate evaluations recorded</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[11px]">
                    <thead className="text-[9px] tracking-wide text-white/25 uppercase">
                      <tr className="border-b border-white/[0.06]">
                        <th className="pb-1.5 pr-3 font-medium">Gate</th>
                        <th className="pb-1.5 pr-3 font-medium">Pass</th>
                        <th className="pb-1.5 pr-3 font-medium">Fail</th>
                        <th className="pb-1.5 pr-3 font-medium">Unverified</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gateRows.map(gate => (
                        <tr key={gate.gateKey} className="border-b border-white/[0.03]">
                          <td className="py-1.5 pr-3 text-white/60">{gate.gateKey}</td>
                          <td className="py-1.5 pr-3 font-mono text-emerald-400/80">{gate.pass}</td>
                          <td className="py-1.5 pr-3 font-mono text-red-400/80">{gate.fail}</td>
                          <td className="py-1.5 pr-3 font-mono text-white/40">{gate.unverified}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}
