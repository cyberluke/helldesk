/**
 * agile-metrics.ts — Kanban/Agile metrics derived from durable engine tables.
 *
 * WHAT WE ACTUALLY HAVE
 * ---------------------
 * HELLDESK has no story-point estimates. `mission_tickets.priority` is 0 for
 * every ticket, so inventing "points" would be fiction. The honest unit is a
 * TICKET (and a MISSION as the sprint/portfolio item). Charts therefore use:
 *
 *   - mission-scoped burndown (ticket counts, hourly for short missions)
 *   - portfolio burnup / remaining work (scope growth visible)
 *   - throughput (missions/tickets verified per day or hour)
 *   - cycle time (created → verified) as p50/p85/p95
 *   - workstation velocity (verified missions/tickets per workspace)
 *   - review latency (requested → verdict) and PASS/FINDINGS mix
 *   - current WIP, separating "awaiting acceptance" from active work
 *
 * No value is synthesized. Empty history yields empty arrays/null, never a
 * zero-filled line that looks like a trend.
 */
import { basename } from 'node:path';
import type { Db } from './db';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WINDOW_DAYS = 30;
const WINDOW_HOURS = 168; // 7 days of hourly granularity; AI delivery moves in hours

export interface AgileBurndownPoint {
  at: string;
  label: string;
  /** Ticket-count series (always available). */
  created: number;
  verified: number;
  remaining: number;
  ideal: number | null;
  /** Story-point series (sized tickets only; coverage is reported separately). */
  createdPoints: number;
  verifiedPoints: number;
  remainingPoints: number;
  idealPoints: number | null;
}

export interface AgileMission {
  missionId: string;
  objective: string;
  state: string;
  workspaceId: string;
  workspaceName: string;
  createdAt: string;
  verifiedAt: string | null;
  humanAcceptance: string | null;
  tickets: number;
  verifiedTickets: number;
  remainingTickets: number;
  storyPoints: number;
  verifiedStoryPoints: number;
  remainingStoryPoints: number;
  sizedTickets: number;
  sizingCoverage: number;
  cycleTimeMs: number | null;
  burndown: AgileBurndownPoint[];
}

export interface AgileThroughputBucket {
  key: string;
  label: string;
  missionsCreated: number;
  missionsVerified: number;
  ticketsCreated: number;
  ticketsVerified: number;
  storyPointsCreated: number;
  storyPointsVerified: number;
}

export interface AgileCyclePercentiles {
  count: number;
  p50Ms: number | null;
  p85Ms: number | null;
  p95Ms: number | null;
}

export interface AgileWorkstation {
  workspaceId: string;
  workspaceName: string;
  verifiedMissions: number;
  activeMissions: number;
  verifiedTickets: number;
  verifiedStoryPoints: number;
  tickets: number;
}

export interface AgileReviewLatencyBucket {
  key: string;
  label: string;
  completed: number;
  avgMs: number | null;
  p85Ms: number | null;
  pass: number;
  findings: number;
  inconclusive: number;
}

export interface AgileMetrics {
  generatedAt: string;
  windowDays: number;
  windowHours: number;
  missions: AgileMission[];
  throughputDaily: AgileThroughputBucket[];
  throughputHourly: AgileThroughputBucket[];
  cycleTime: {
    missions: AgileCyclePercentiles;
    tickets: AgileCyclePercentiles;
  };
  workstations: AgileWorkstation[];
  reviewLatencyDaily: AgileReviewLatencyBucket[];
  reviewLatencyHourly: AgileReviewLatencyBucket[];
  wip: {
    open: number;
    inProgress: number;
    inReview: number;
    blocked: number;
    done: number;
    cancelled: number;
    awaitingAcceptance: number;
  };
  sizing: {
    sizedTickets: number;
    totalTickets: number;
    /** 0..1; the UI switches to points only when this is complete for a scope. */
    coverage: number;
  };
}

interface MissionRow {
  mission_id: string;
  workspace_id: string;
  objective: string;
  state: string;
  created_at: string;
  verified_at: string | null;
  human_acceptance: string | null;
  workspace_path: string | null;
}

interface TicketRow {
  ticket_id: string;
  mission_id: string;
  created_at: string;
  updated_at: string;
  execution_state: string;
  verification_state: string;
  verified_at: string | null;
  story_points: number | null;
  tshirt_size: string | null;
  sizing_state: string | null;
}

interface ReviewRow {
  job_id: string;
  state: string;
  result: string | null;
  requested_at: string;
  completed_at: string;
}

interface TimeBucket {
  key: string;
  label: string;
  start: number;
  end: number;
  date?: string;
}

function localDayStart(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dayLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function hourlyBuckets(now: Date, hours: number): TimeBucket[] {
  const anchor = new Date(now);
  anchor.setMinutes(0, 0, 0);
  const out: TimeBucket[] = [];
  for (let i = hours - 1; i >= 0; i -= 1) {
    const start = new Date(anchor);
    start.setHours(start.getHours() - i);
    const end = new Date(start);
    end.setHours(end.getHours() + 1);
    out.push({
      key: start.toISOString(),
      label: start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
      start: start.getTime(),
      end: end.getTime(),
    });
  }
  return out;
}

function dailyBuckets(now: Date, days: number): TimeBucket[] {
  const today = localDayStart(now);
  const out: TimeBucket[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const start = new Date(today);
    start.setDate(start.getDate() - i);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    out.push({
      key: dayKey(start),
      label: dayLabel(start),
      start: start.getTime(),
      end: end.getTime(),
      date: dayKey(start),
    });
  }
  return out;
}

function inBucket(iso: string | null, bucket: TimeBucket): boolean {
  if (!iso) return false;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) && ts >= bucket.start && ts < bucket.end;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index]!);
}

function summarizeCycle(values: number[]): AgileCyclePercentiles {
  return {
    count: values.length,
    p50Ms: percentile(values, 50),
    p85Ms: percentile(values, 85),
    p95Ms: percentile(values, 95),
  };
}

function bucketStart(dateMs: number, bucketMs: number, hourly: boolean): number {
  const d = new Date(dateMs);
  if (hourly) {
    d.setMinutes(0, 0, 0);
  } else {
    d.setHours(0, 0, 0, 0);
  }
  return d.getTime();
}

function burndownFor(
  mission: MissionRow,
  tickets: TicketRow[],
  now: number,
): AgileBurndownPoint[] {
  const start = Date.parse(mission.created_at);
  const endRaw = mission.verified_at ? Date.parse(mission.verified_at) : now;
  if (!Number.isFinite(start) || !Number.isFinite(endRaw) || endRaw <= start) return [];
  const end = Math.max(start, Math.min(endRaw, now));
  const duration = end - start;
  const hourly = duration <= 7 * DAY_MS;
  const bucketMs = hourly ? HOUR_MS : DAY_MS;
  const totalStoryPoints = tickets.reduce((sum, ticket) => sum + (ticket.story_points ?? 0), 0);
  const first = bucketStart(start, bucketMs, hourly);
  const points: AgileBurndownPoint[] = [];
  let ts = first;
  for (;;) {
    // Always emit the exact end point even when the last full bucket starts
    // before the mission's verified timestamp (otherwise the final verification
    // is missing from the chart).
    const cursor = Math.min(ts, end);
    const createdTickets = tickets.filter((ticket) => Date.parse(ticket.created_at) <= cursor);
    const verifiedTickets = tickets.filter(
      (ticket) => ticket.verified_at != null && Date.parse(ticket.verified_at) <= cursor
    );
    const createdPoints = createdTickets.reduce((sum, ticket) => sum + (ticket.story_points ?? 0), 0);
    const verifiedPoints = verifiedTickets.reduce((sum, ticket) => sum + (ticket.story_points ?? 0), 0);
    const ideal = mission.verified_at
      ? Math.min(tickets.length, Math.max(0, tickets.length * (1 - (cursor - start) / duration)))
      : null;
    const idealPoints = mission.verified_at
      ? Math.min(totalStoryPoints, Math.max(0, totalStoryPoints * (1 - (cursor - start) / duration)))
      : null;
    const d = new Date(cursor);
    points.push({
      at: d.toISOString(),
      label: hourly
        ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      created: createdTickets.length,
      verified: verifiedTickets.length,
      remaining: Math.max(0, createdTickets.length - verifiedTickets.length),
      ideal: ideal == null ? null : Math.round(ideal * 100) / 100,
      createdPoints,
      verifiedPoints,
      remainingPoints: Math.max(0, createdPoints - verifiedPoints),
      idealPoints: idealPoints == null ? null : Math.round(idealPoints * 100) / 100,
    });
    if (cursor >= end) break;
    ts += bucketMs;
  }
  return points;
}

export function buildAgileMetrics(d: Db, now = new Date()): AgileMetrics {
  const nowMs = now.getTime();
  const sinceDays = new Date(nowMs - WINDOW_DAYS * DAY_MS).toISOString();
  // Workstation velocity is intentionally a 7-day window: fast AI delivery makes
  // a 30-day aggregate hide the current flow.
  const sinceWorkstations = new Date(nowMs - 7 * DAY_MS).toISOString();

  const missions = d.db
    .query<MissionRow, [string]>(
      `SELECT m.mission_id, m.workspace_id, m.objective, m.state, m.created_at, m.verified_at,
              m.human_acceptance, w.path AS workspace_path
         FROM autonomy_missions m
         LEFT JOIN workspaces w ON w.workspace_id = m.workspace_id
        WHERE m.created_at >= ? OR m.state NOT IN ('VERIFIED_10_10','CANCELLED')
        ORDER BY m.created_at DESC
        LIMIT 20`
    )
    .all(sinceDays);

  const ticketRows = d.db
    .query<TicketRow, [string]>(
      `SELECT t.ticket_id, t.mission_id, t.created_at, t.updated_at, t.execution_state,
              t.verification_state, t.story_points, t.tshirt_size, t.sizing_state,
              COALESCE(v.verified_at,
                       CASE WHEN t.verification_state='VERIFIED_10_10' THEN t.updated_at END) AS verified_at
         FROM mission_tickets t
         LEFT JOIN (
           SELECT ticket_id, MAX(completed_at) AS verified_at
             FROM ticket_revisions
            WHERE state='VERIFIED_10_10' AND completed_at IS NOT NULL
            GROUP BY ticket_id
         ) v ON v.ticket_id = t.ticket_id
        WHERE t.created_at >= ? OR t.verification_state='VERIFIED_10_10'`
    )
    .all(sinceDays);

  const missionById = new Map(missions.map((mission) => [mission.mission_id, mission]));
  const ticketsByMission = new Map<string, TicketRow[]>();
  for (const ticket of ticketRows) {
    const bucket = ticketsByMission.get(ticket.mission_id) ?? [];
    bucket.push(ticket);
    ticketsByMission.set(ticket.mission_id, bucket);
  }

  const agileMissions: AgileMission[] = missions.map((mission) => {
    const tickets = ticketsByMission.get(mission.mission_id) ?? [];
    const verified = tickets.filter((ticket) => ticket.verified_at != null);
    const sized = tickets.filter((ticket) => ticket.story_points != null);
    const storyPoints = tickets.reduce((sum, ticket) => sum + (ticket.story_points ?? 0), 0);
    const verifiedStoryPoints = verified.reduce((sum, ticket) => sum + (ticket.story_points ?? 0), 0);
    const created = Date.parse(mission.created_at);
    const verifiedAt = mission.verified_at ? Date.parse(mission.verified_at) : null;
    return {
      missionId: mission.mission_id,
      objective: mission.objective,
      state: mission.state,
      workspaceId: mission.workspace_id,
      workspaceName: mission.workspace_path ? basename(mission.workspace_path) : mission.workspace_id,
      createdAt: mission.created_at,
      verifiedAt: mission.verified_at,
      humanAcceptance: mission.human_acceptance ?? null,
      tickets: tickets.length,
      verifiedTickets: verified.length,
      remainingTickets: Math.max(0, tickets.length - verified.length),
      storyPoints,
      verifiedStoryPoints,
      remainingStoryPoints: Math.max(0, storyPoints - verifiedStoryPoints),
      sizedTickets: sized.length,
      sizingCoverage: tickets.length ? sized.length / tickets.length : 0,
      cycleTimeMs:
        verifiedAt != null && Number.isFinite(created) ? Math.max(0, verifiedAt - created) : null,
      burndown: burndownFor(mission, tickets, nowMs),
    };
  });

  const daily = dailyBuckets(now, WINDOW_DAYS);
  const hourly = hourlyBuckets(now, WINDOW_HOURS);
  const throughputDaily: AgileThroughputBucket[] = daily.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    missionsCreated: missions.filter((mission) => inBucket(mission.created_at, bucket)).length,
    missionsVerified: missions.filter((mission) => inBucket(mission.verified_at, bucket)).length,
    ticketsCreated: ticketRows.filter((ticket) => inBucket(ticket.created_at, bucket)).length,
    ticketsVerified: ticketRows.filter((ticket) => inBucket(ticket.verified_at, bucket)).length,
    storyPointsCreated: ticketRows
      .filter((ticket) => inBucket(ticket.created_at, bucket))
      .reduce((sum, ticket) => sum + (ticket.story_points ?? 0), 0),
    storyPointsVerified: ticketRows
      .filter((ticket) => inBucket(ticket.verified_at, bucket))
      .reduce((sum, ticket) => sum + (ticket.story_points ?? 0), 0),
  }));
  const throughputHourly: AgileThroughputBucket[] = hourly.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    missionsCreated: missions.filter((mission) => inBucket(mission.created_at, bucket)).length,
    missionsVerified: missions.filter((mission) => inBucket(mission.verified_at, bucket)).length,
    ticketsCreated: ticketRows.filter((ticket) => inBucket(ticket.created_at, bucket)).length,
    ticketsVerified: ticketRows.filter((ticket) => inBucket(ticket.verified_at, bucket)).length,
    storyPointsCreated: ticketRows
      .filter((ticket) => inBucket(ticket.created_at, bucket))
      .reduce((sum, ticket) => sum + (ticket.story_points ?? 0), 0),
    storyPointsVerified: ticketRows
      .filter((ticket) => inBucket(ticket.verified_at, bucket))
      .reduce((sum, ticket) => sum + (ticket.story_points ?? 0), 0),
  }));

  const missionCycle = missions
    .filter((mission) => mission.verified_at != null && Date.parse(mission.verified_at) >= Date.parse(sinceDays))
    .map((mission) => Date.parse(mission.verified_at!) - Date.parse(mission.created_at))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const ticketCycle = ticketRows
    .filter((ticket) => ticket.verified_at != null && Date.parse(ticket.verified_at) >= Date.parse(sinceDays))
    .map((ticket) => Date.parse(ticket.verified_at!) - Date.parse(ticket.created_at))
    .filter((value) => Number.isFinite(value) && value >= 0);

  const workstationMap = new Map<string, AgileWorkstation>();
  for (const mission of agileMissions) {
    const row = workstationMap.get(mission.workspaceId) ?? {
      workspaceId: mission.workspaceId,
      workspaceName: mission.workspaceName,
      verifiedMissions: 0,
      activeMissions: 0,
      verifiedTickets: 0,
      verifiedStoryPoints: 0,
      tickets: 0,
    };
    const missionTickets = ticketsByMission.get(mission.missionId) ?? [];
    row.tickets += missionTickets.length;
    const verifiedInWindow = missionTickets.filter(
      (ticket) => ticket.verified_at != null && Date.parse(ticket.verified_at) >= Date.parse(sinceWorkstations)
    );
    row.verifiedTickets += verifiedInWindow.length;
    row.verifiedStoryPoints += verifiedInWindow.reduce((sum, ticket) => sum + (ticket.story_points ?? 0), 0);
    if (mission.state === 'VERIFIED_10_10' && mission.verifiedAt && Date.parse(mission.verifiedAt) >= Date.parse(sinceWorkstations)) {
      row.verifiedMissions += 1;
    }
    if (mission.state !== 'VERIFIED_10_10' && mission.state !== 'CANCELLED') row.activeMissions += 1;
    workstationMap.set(mission.workspaceId, row);
  }

  const reviewRows = d.db
    .query<ReviewRow, [string]>(
      `SELECT job_id, state, result, requested_at, completed_at
         FROM review_jobs
        WHERE completed_at IS NOT NULL AND completed_at >= ?
        ORDER BY completed_at ASC`
    )
    .all(sinceDays);

  const reviewBuckets = (buckets: TimeBucket[]): AgileReviewLatencyBucket[] =>
    buckets.map((bucket) => {
      const rows = reviewRows.filter((row) => inBucket(row.completed_at, bucket));
      const durations = rows
        .map((row) => Date.parse(row.completed_at) - Date.parse(row.requested_at))
        .filter((value) => Number.isFinite(value) && value >= 0);
      return {
        key: bucket.key,
        label: bucket.label,
        completed: rows.length,
        avgMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
        p85Ms: percentile(durations, 85),
        pass: rows.filter((row) => row.state === 'COMPLETED_PASS').length,
        findings: rows.filter((row) => row.state === 'COMPLETED_FINDINGS').length,
        inconclusive: rows.filter((row) => row.state === 'INCONCLUSIVE').length,
      };
    });

  const wip = {
    open: 0,
    inProgress: 0,
    inReview: 0,
    blocked: 0,
    done: 0,
    cancelled: 0,
    awaitingAcceptance: missions.filter(
      (mission) => mission.state === 'VERIFIED_10_10' && mission.human_acceptance !== 'accepted'
    ).length,
  };
  for (const ticket of ticketRows) {
    const mission = missionById.get(ticket.mission_id);
    if (!mission) continue;
    if (mission.state === 'CANCELLED') {
      wip.cancelled += 1;
    } else if (mission.state === 'VERIFIED_10_10') {
      if (mission.human_acceptance === 'accepted') wip.done += 1;
      else wip.inReview += 1;
    } else if (ticket.execution_state === 'CLOSED') {
      wip.done += 1;
    } else if (ticket.execution_state === 'FAILED' || ticket.execution_state === 'BLOCKED') {
      wip.blocked += 1;
    } else if (ticket.execution_state === 'AWAITING_ACCEPTANCE') {
      wip.inReview += 1;
    } else if (ticket.execution_state === 'RUNNING') {
      wip.inProgress += 1;
    } else {
      wip.open += 1;
    }
  }

  return {
    generatedAt: now.toISOString(),
    windowDays: WINDOW_DAYS,
    windowHours: WINDOW_HOURS,
    missions: agileMissions,
    throughputDaily,
    throughputHourly,
    cycleTime: {
      missions: summarizeCycle(missionCycle),
      tickets: summarizeCycle(ticketCycle),
    },
    workstations: [...workstationMap.values()]
      .filter((row) => row.tickets > 0 || row.activeMissions > 0)
      .sort((a, b) => b.verifiedTickets - a.verifiedTickets || b.verifiedMissions - a.verifiedMissions),
    reviewLatencyDaily: reviewBuckets(daily),
    reviewLatencyHourly: reviewBuckets(hourly),
    wip,
    sizing: {
      sizedTickets: ticketRows.filter((ticket) => ticket.story_points != null).length,
      totalTickets: ticketRows.length,
      coverage: ticketRows.length
        ? ticketRows.filter((ticket) => ticket.story_points != null).length / ticketRows.length
        : 0,
    },
  };
}
