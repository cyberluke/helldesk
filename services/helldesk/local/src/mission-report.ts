/**
 * mission-report.ts — one durable, evidence-bearing completion record for a
 * mission. It joins the mission, its tickets/revisions, the FINAL review job
 * (including the review policy that actually ran), the per-role model/token
 * accounting, gates, evidence artifacts, commit range and human acceptance.
 *
 * Read-only. The UI uses this instead of scraping chat text.
 */
import type { Db } from './db';
import {
  getMission,
  listTickets,
  getRevision,
  getQualityGates,
  listEvidence,
  listMissionAcceptanceEvents,
  isAwaitingHumanAcceptance,
  type HumanAcceptanceDecision,
  type MissionAcceptanceEvent,
  type MissionRow,
} from './mission-repository';
import { describeReviewPolicy, effectiveReviewStages, parseReviewControls, type ReviewControls } from './review-controls';
import { computeTokenCost } from './pricing';
import type { PricingConfig } from './config';

export interface MissionReportTicket {
  ticketId: string;
  title: string;
  executionState: string;
  verificationState: string;
  revisionId: string | null;
  revisionNo: number | null;
  revisionState: string | null;
  reviewJobId: string | null;
  reviewJobState: string | null;
  reviewResult: string | null;
  storyPoints: number | null;
  tshirtSize: string | null;
  sizeConfidence: string | null;
  sizeRationale: string | null;
  sizingState: string | null;
}

export interface MissionReportRole {
  role: string;
  providerID: string | null;
  modelID: string | null;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  cost: number | null;
  /** Which pricing rule produced `cost` ('' reported by the runner). */
  costRule?: string | null;
  costSource?: 'reported' | 'calculated' | null;
}

export interface MissionReportFinding {
  severity: string;
  confidence: string;
  title: string;
  file: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  evidence: string;
  reviewerIds: string[];
  adjudicated: number;
  adjudication: string | null;
}

export interface MissionReportGate {
  gateKey: string;
  status: string;
  evaluator: string | null;
  checkedAt: string;
  evidenceRefs: unknown;
}

export interface MissionReportEvidence {
  artifactId: string;
  kind: string;
  path: string | null;
  sha256: string;
  bytes: number;
  producer: string | null;
  command: string | null;
  exitCode: number | null;
  createdAt: string;
}

export interface MissionReport {
  mission: {
    missionId: string;
    state: string;
    objective: string;
    createdAt: string;
    updatedAt: string;
    verifiedAt: string | null;
    controls: ReviewControls;
    humanAcceptance: HumanAcceptanceDecision | null;
    humanAcceptedAt: string | null;
    humanAcceptanceNote: string | null;
    humanAcceptedBy: string | null;
    awaitingHumanAcceptance: boolean;
  };
  tickets: MissionReportTicket[];
  review: {
    jobId: string | null;
    state: string | null;
    result: string | null;
    requestedAt: string | null;
    completedAt: string | null;
    revisionId: string | null;
    revisionNo: number | null;
    ticketId: string | null;
    policy: {
      controls: ReviewControls;
      summary: string;
      reviewerA: boolean;
      reviewerB: boolean;
      governor: boolean;
    } | null;
    roles: MissionReportRole[];
    findings: MissionReportFinding[];
    tokens: { input: number; output: number; total: number; cost: number | null; costPartial?: boolean };
  };
  gates: MissionReportGate[];
  evidence: MissionReportEvidence[];
  commits: { baseHash: string | null; headHash: string | null };
  acceptanceHistory: MissionAcceptanceEvent[];
}

interface ReviewJobRow {
  job_id: string;
  state: string;
  result: string | null;
  requested_at: string;
  completed_at: string | null;
  meta: string | null;
  revision_id: string;
  revision_no: number;
  revision_state: string;
  ticket_id: string;
  ticket_title: string;
}

function safeParse(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function latestMissionReview(d: Db, missionId: string): ReviewJobRow | null {
  return (
    d.db
      .query<ReviewJobRow, [string]>(
        `SELECT j.job_id, j.state, j.result, j.requested_at, j.completed_at, j.meta,
                r.revision_id, r.revision_no, r.state AS revision_state,
                t.ticket_id, t.title AS ticket_title
           FROM review_jobs j
           JOIN ticket_revisions r ON r.review_job_id = j.job_id
           JOIN mission_tickets t ON t.ticket_id = r.ticket_id
          WHERE t.mission_id=?
          ORDER BY j.rowid DESC LIMIT 1`
      )
      .get(missionId) ?? null
  );
}

export function getMissionReport(
  d: Db,
  missionId: string,
  costConfig?: { pricing?: PricingConfig; runner?: string | null },
): MissionReport | null {
  const mission: MissionRow | undefined = getMission(d, missionId);
  if (!mission) return null;

  const tickets: MissionReportTicket[] = listTickets(d, missionId, false).map((ticket) => {
    const revision = ticket.active_revision_id ? getRevision(d, ticket.active_revision_id) : undefined;
    let reviewJobState: string | null = null;
    let reviewResult: string | null = null;
    if (revision?.review_job_id) {
      const job = d.db
        .query<{ state: string; result: string | null }, [string]>(
          `SELECT state, result FROM review_jobs WHERE job_id=?`
        )
        .get(revision.review_job_id);
      reviewJobState = job?.state ?? null;
      reviewResult = job?.result ?? null;
    }
    return {
      ticketId: ticket.ticket_id,
      title: ticket.title,
      executionState: ticket.execution_state,
      verificationState: ticket.verification_state,
      revisionId: revision?.revision_id ?? null,
      revisionNo: revision?.revision_no ?? null,
      revisionState: revision?.state ?? null,
      reviewJobId: revision?.review_job_id ?? null,
      reviewJobState,
      reviewResult,
      storyPoints: ticket.story_points ?? null,
      tshirtSize: ticket.tshirt_size ?? null,
      sizeConfidence: ticket.size_confidence ?? null,
      sizeRationale: ticket.size_rationale ?? null,
      sizingState: ticket.sizing_state ?? null,
    };
  });

  const finalReview = latestMissionReview(d, missionId);
  const controls = parseReviewControls(mission.controls_json);
  const stages = effectiveReviewStages(controls);
  const reviewMeta = safeParse(finalReview?.meta ?? null);
  const jobControls = parseReviewControls(reviewMeta.controls ?? controls);
  const jobStages = effectiveReviewStages(jobControls);

  const allRoles = finalReview
    ? d.db
        .query<MissionReportRole, [string]>(
          `SELECT role, provider_id AS providerID, model_id AS modelID, status,
                  started_at AS startedAt, finished_at AS finishedAt, duration_ms AS durationMs,
                  tokens_in AS tokensIn, tokens_out AS tokensOut, cost
             FROM agent_runs WHERE job_id=? ORDER BY rowid`
        )
        .all(finalReview.job_id)
        .map((role) => {
          const calculated = role.cost != null
            ? null
            : computeTokenCost(costConfig?.pricing, {
                providerID: role.providerID,
                modelID: role.modelID,
                runner: costConfig?.runner,
                tokensIn: role.tokensIn,
                tokensOut: role.tokensOut,
              });
          return {
            ...role,
            durationMs:
              role.durationMs ??
              (role.startedAt && role.finishedAt
                ? Math.max(0, Date.parse(role.finishedAt) - Date.parse(role.startedAt))
                : null),
            cost: role.cost ?? calculated?.cost ?? null,
            costRule: role.cost != null ? 'reported' : calculated?.rule ?? null,
            costSource: role.cost != null ? ('reported' as const) : calculated?.cost != null ? ('calculated' as const) : null,
          };
        })
    : [];
  // Legacy detached runs could persist the SAME stage twice (worker accept +
  // engine persist): one row with tokens, one without. Keep the richer row per
  // role; a real multi-attempt role with usage on both rows is preserved.
  const rolesWithUsage = new Set(
    allRoles.filter((role) => role.tokensIn != null || role.tokensOut != null).map((role) => role.role)
  );
  const roles = allRoles.filter(
    (role) => role.tokensIn != null || role.tokensOut != null || !rolesWithUsage.has(role.role)
  );
  const tokensIn = roles.reduce((sum, role) => sum + (role.tokensIn ?? 0), 0);
  const tokensOut = roles.reduce((sum, role) => sum + (role.tokensOut ?? 0), 0);
  const costs = roles.map((role) => role.cost).filter((cost): cost is number => typeof cost === 'number');
  const usageRoles = roles.filter((role) => role.tokensIn != null || role.tokensOut != null);
  const costPartial = usageRoles.length > 0 && usageRoles.some((role) => role.cost == null);

  const findings: MissionReportFinding[] = finalReview
    ? d.db
        .query<
          {
            severity: string;
            confidence: string;
            title: string;
            file: string | null;
            line_start: number | null;
            line_end: number | null;
            evidence: string;
            reviewer_ids: string;
            adjudicated: number;
            adjudication: string | null;
          },
          [string]
        >(
          `SELECT severity, confidence, title, file, line_start, line_end, evidence,
                  reviewer_ids, adjudicated, adjudication
             FROM findings WHERE job_id=? ORDER BY rowid`
        )
        .all(finalReview.job_id)
        .map((finding) => ({
          severity: finding.severity,
          confidence: finding.confidence,
          title: finding.title,
          file: finding.file,
          lineStart: finding.line_start,
          lineEnd: finding.line_end,
          evidence: finding.evidence,
          reviewerIds: (() => {
            try {
              const ids = JSON.parse(finding.reviewer_ids) as unknown;
              return Array.isArray(ids) ? ids.map(String) : [];
            } catch {
              return [];
            }
          })(),
          adjudicated: finding.adjudicated,
          adjudication: finding.adjudication,
        }))
    : [];

  const revisionId = finalReview?.revision_id ?? null;
  const gates: MissionReportGate[] = revisionId
    ? getQualityGates(d, revisionId).map((gate) => ({
        gateKey: gate.gate_key,
        status: gate.status,
        evaluator: gate.evaluator ?? null,
        checkedAt: gate.checked_at,
        evidenceRefs: safeParseValue(gate.evidence_refs_json),
      }))
    : [];
  const evidence: MissionReportEvidence[] = revisionId
    ? listEvidence(d, revisionId).map((item) => ({
        artifactId: item.artifact_id,
        kind: item.kind,
        path: item.path,
        sha256: item.sha256,
        bytes: item.bytes,
        producer: item.producer,
        command: item.command,
        exitCode: item.exit_code,
        createdAt: item.created_at,
      }))
    : [];

  return {
    mission: {
      missionId: mission.mission_id,
      state: mission.state,
      objective: mission.objective,
      createdAt: mission.created_at,
      updatedAt: mission.updated_at,
      verifiedAt: mission.verified_at,
      controls,
      humanAcceptance: mission.human_acceptance ?? null,
      humanAcceptedAt: mission.human_accepted_at ?? null,
      humanAcceptanceNote: mission.human_acceptance_note ?? null,
      humanAcceptedBy: mission.human_accepted_by ?? null,
      awaitingHumanAcceptance: isAwaitingHumanAcceptance(mission),
    },
    tickets,
    review: {
      jobId: finalReview?.job_id ?? null,
      state: finalReview?.state ?? null,
      result: finalReview?.result ?? null,
      requestedAt: finalReview?.requested_at ?? null,
      completedAt: finalReview?.completed_at ?? null,
      revisionId,
      revisionNo: finalReview?.revision_no ?? null,
      ticketId: finalReview?.ticket_id ?? null,
      policy: finalReview
        ? {
            controls: jobControls,
            summary: describeReviewPolicy(jobControls),
            reviewerA: jobStages.reviewerA,
            reviewerB: jobStages.reviewerB,
            governor: jobStages.governor,
          }
        : {
            controls,
            summary: describeReviewPolicy(controls),
            reviewerA: stages.reviewerA,
            reviewerB: stages.reviewerB,
            governor: stages.governor,
          },
      roles,
      findings,
      tokens: {
        input: tokensIn,
        output: tokensOut,
        total: tokensIn + tokensOut,
        cost: costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : null,
        costPartial,
      },
    },
    gates,
    evidence,
    commits: {
      baseHash: typeof reviewMeta.baseHash === 'string' ? reviewMeta.baseHash : null,
      headHash: typeof reviewMeta.headHash === 'string' ? reviewMeta.headHash : null,
    },
    acceptanceHistory: listMissionAcceptanceEvents(d, missionId),
  };
}

function safeParseValue(raw: string | null): unknown {
  if (!raw) return [];
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
}
