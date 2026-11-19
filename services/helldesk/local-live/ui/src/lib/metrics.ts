// metrics.ts
// SOTA operator-console data aggregation for HELLDESK. All metrics are computed
// CLIENT-SIDE from the real control-plane feed (listColonyMissions + getMissionBoard
// + journal), so there is no new backend surface and the numbers are the engine's
// authoritative state, not a separate counter. Pure functions + one memoized loader
// so the Observability console can render dense telemetry without churn.

import { getMissionBoard, listColonyMissions, type ColonyMission, type MissionTicketCard } from './engine'

export interface MetricsSnapshot {
  // throughput
  missions: { total: number; active: number; verified: number; blocked: number; replanning: number }
  tickets: { total: number; open: number; inProgress: number; inReview: number; closed: number }
  // quality (the operator's core question: can I trust the PASS?)
  gates: { pass: number; fail: number; unverified: number; passRate: number }
  // rework
  rework: { rejected: number; totalRevisions: number; reworkFraction: number }
  // cycle-time / gate-cost telemetry
  cycle: { verifiedAgeMs: number | null; oldestActiveMs: number | null; avgTicketGates: number }
  // live status
  health: boolean | 'unknown'
  generatedAt: string
  updatedAgoMs: number | null
}

/** Age (ms) of the most recent live mission update — a "freshness" pulse. */
export function missionFreshnessMs(missions: ColonyMission[]): number | null {
  let max: number | null = null
  for (const m of missions) {
    const at = m.updated_at ?? m.verified_at
    if (!at) continue
    const t = new Date(at).getTime()
    if (Number.isFinite(t)) max = max === null ? t : Math.max(max, t)
  }
  return max === null ? null : Date.now() - max
}

/** Aggregate a mission board into the dashboard KPIs. */
export function aggregateMetrics(board: MissionTicketCard[], missions: ColonyMission[], health: boolean | 'unknown'): MetricsSnapshot {
  const tickets = {
    total: board.length,
    open: board.filter((t) => t.status === 'open').length,
    inProgress: board.filter((t) => t.status === 'in_progress').length,
    inReview: board.filter((t) => t.status === 'in_review').length,
    closed: board.filter((t) => t.status === 'closed').length,
  }
  const gateBuckets = board.flatMap((t) => t.quality ?? []).reduce(
    (acc, g) => {
      if (g.status === 'PASS') acc.pass++
      else if (g.status === 'FAIL') acc.fail++
      else acc.unverified++
      return acc
    },
    { pass: 0, fail: 0, unverified: 0 },
  )
  // Rework: every REJECTED revision counted against total revision states we can
  // observe from the board (VERIFIED/REJECTED/PENDING...). Rejection => replan.
  const rejections = board.filter((t) => t.revisionState === 'REJECTED' || t.verificationState === 'REJECTED').length
  const observedRevisions = board.filter((t) => t.revisionNo && t.revisionNo > 0).length
  const missionsAgg = {
    total: missions.length,
    active: missions.filter((m) => m.state === 'ACTIVE' || m.state === 'MUTATING' || m.state === 'VERIFYING' || m.state === 'PLANNING' || m.state === 'CAPTURING_EVIDENCE' || m.state === 'REPLANNING').length,
    verified: missions.filter((m) => m.state === 'VERIFIED_10_10').length,
    blocked: missions.filter((m) => m.state === 'BLOCKED_EXTERNAL' || m.state === 'CANCELLED').length,
    replanning: missions.filter((m) => m.state === 'REPLANNING').length,
  }
  const gateTotal = gateBuckets.pass + gateBuckets.fail
  // Cycle-time / cost telemetry (derived from the live control-plane timestamps;
  // honest proxies since the missions feed has no explicit created_at):
  // - verifiedAge: how long ago the most recent VERIFIED_10_10 mission verified
  //   (measures "are we actually closing tickets?").
  // - oldestActive: age of the stalest in-progress mission (a stall signal).
  // - avgTicketGates: mean gates evaluated per ticket (an estimate of the
  //   deterministic verification effort spent — the "cost" of trusting a PASS).
  const nowMs = Date.now()
  const verifiedAges = missions.filter((m) => m.state === 'VERIFIED_10_10').map((m) => {
    const t = new Date(m.verified_at ?? m.verifiedAt ?? '').getTime()
    return Number.isFinite(t) ? nowMs - t : null
  }).filter((x): x is number => x !== null)
  const oldestActive = missions
    .filter((m) => m.state && ['ACTIVE', 'MUTATING', 'VERIFYING', 'REPLANNING', 'PLANNING', 'CAPTURING_EVIDENCE'].includes(m.state))
    .map((m) => { const t = new Date(m.updated_at ?? m.updatedAt ?? '').getTime(); return Number.isFinite(t) ? nowMs - t : null })
    .filter((x): x is number => x !== null)
    .sort((a, b) => b - a)[0] ?? null
  const gateEvals = gateBuckets.pass + gateBuckets.fail + gateBuckets.unverified
  const avgTicketGates = board.length ? gateEvals / board.length : 0
  return {
    missions: missionsAgg,
    tickets,
    gates: { ...gateBuckets, passRate: gateTotal ? gateBuckets.pass / gateTotal : 0 },
    rework: {
      rejected: rejections,
      totalRevisions: observedRevisions,
      reworkFraction: observedRevisions ? rejections / observedRevisions : 0,
    },
    cycle: {
      verifiedAgeMs: verifiedAges.length ? Math.min(...verifiedAges) : null,
      oldestActiveMs: oldestActive,
      avgTicketGates,
    },
    health,
    generatedAt: new Date().toISOString(),
    updatedAgoMs: missionFreshnessMs(missions),
  }
}

/** Long-poll loader: fetch the real board + missions + health once. */
export async function loadMetricsSnapshot(health: boolean | 'unknown'): Promise<MetricsSnapshot> {
  const [board, missions] = await Promise.all([getMissionBoard(), listColonyMissions()])
  return aggregateMetrics(board, missions, health)
}

/** Humanize an age (ms -> "3.2s", "12m", "1d") for a freshness pulse. */
export function fmtAge(ms: number | null): string {
  if (ms === null) return '–'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

/** Inline SVG sparkline — zero-dependency mini trend for a KPI card. */
export function Sparkline({ w = 120, h = 30, points, color = 'var(--accent)' }: { w?: number; h?: number; points: number[]; color?: string }) {
  if (!points.length) return <svg width={w} height={h} aria-hidden />
  const max = Math.max(...points, 1)
  const min = Math.min(...points, 0)
  const span = max - min || 1
  const step = w / Math.max(points.length - 1, 1)
  const coords = points.map((p, i) => `${(i * step).toFixed(1)},${(h - ((p - min) / span) * (h - 4) - 2).toFixed(1)}`)
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }} aria-hidden>
      <polyline points={coords.join(' ')} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/** Deterministic 0-100 for a compact pulse fill (pure CSS bars). */
export function pct(n: number): string {
  return `${Math.round((n || 0) * 100).toFixed(0)}%`
}