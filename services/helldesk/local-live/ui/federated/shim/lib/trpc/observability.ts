/**
 * Observability contract for the federated console.
 *
 * Mirrors the engine's `/v1/observability` snapshot (services/helldesk/local/src/
 * observability.ts). Every field is a measured value from the durable journal or
 * a domain table; optional metrics are `null` when the engine has no samples —
 * never zero-filled to look healthy.
 */
import { z } from 'zod';

export const ObservabilityEventSchema = z.object({
  seq: z.number(),
  eventType: z.string(),
  jobId: z.string().nullable(),
  missionId: z.string().nullable(),
  ticketId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  createdAt: z.string(),
  payload: z.unknown(),
});

export const AgileBurndownPointSchema = z.object({
  at: z.string(),
  label: z.string(),
  created: z.number(),
  verified: z.number(),
  remaining: z.number(),
  ideal: z.number().nullable(),
  createdPoints: z.number(),
  verifiedPoints: z.number(),
  remainingPoints: z.number(),
  idealPoints: z.number().nullable(),
});

export const AgileMissionSchema = z.object({
  missionId: z.string(),
  objective: z.string(),
  state: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  createdAt: z.string(),
  verifiedAt: z.string().nullable(),
  humanAcceptance: z.string().nullable(),
  tickets: z.number(),
  verifiedTickets: z.number(),
  remainingTickets: z.number(),
  storyPoints: z.number(),
  verifiedStoryPoints: z.number(),
  remainingStoryPoints: z.number(),
  sizedTickets: z.number(),
  sizingCoverage: z.number(),
  cycleTimeMs: z.number().nullable(),
  burndown: z.array(AgileBurndownPointSchema),
});

export const AgileThroughputBucketSchema = z.object({
  key: z.string(),
  label: z.string(),
  missionsCreated: z.number(),
  missionsVerified: z.number(),
  ticketsCreated: z.number(),
  ticketsVerified: z.number(),
  storyPointsCreated: z.number(),
  storyPointsVerified: z.number(),
});

export const AgileCyclePercentilesSchema = z.object({
  count: z.number(),
  p50Ms: z.number().nullable(),
  p85Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
});

export const AgileWorkstationSchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string(),
  verifiedMissions: z.number(),
  activeMissions: z.number(),
  verifiedTickets: z.number(),
  verifiedStoryPoints: z.number(),
  tickets: z.number(),
});

export const AgileReviewLatencyBucketSchema = z.object({
  key: z.string(),
  label: z.string(),
  completed: z.number(),
  avgMs: z.number().nullable(),
  p85Ms: z.number().nullable(),
  pass: z.number(),
  findings: z.number(),
  inconclusive: z.number(),
});

export const AgileMetricsSchema = z.object({
  generatedAt: z.string(),
  windowDays: z.number(),
  windowHours: z.number(),
  missions: z.array(AgileMissionSchema),
  throughputDaily: z.array(AgileThroughputBucketSchema),
  throughputHourly: z.array(AgileThroughputBucketSchema),
  cycleTime: z.object({
    missions: AgileCyclePercentilesSchema,
    tickets: AgileCyclePercentilesSchema,
  }),
  workstations: z.array(AgileWorkstationSchema),
  reviewLatencyDaily: z.array(AgileReviewLatencyBucketSchema),
  reviewLatencyHourly: z.array(AgileReviewLatencyBucketSchema),
  wip: z.object({
    open: z.number(),
    inProgress: z.number(),
    inReview: z.number(),
    blocked: z.number(),
    done: z.number(),
    cancelled: z.number(),
    awaitingAcceptance: z.number(),
  }),
  sizing: z.object({
    sizedTickets: z.number(),
    totalTickets: z.number(),
    coverage: z.number(),
  }),
});

export const ObservabilitySnapshotSchema = z.object({
  generatedAt: z.string(),
  engine: z.object({
    live: z.boolean(),
    queue: z.object({ queued: z.number(), running: z.number(), inFlight: z.number() }),
  }),
  events: z.object({
    total: z.number(),
    last24h: z.number(),
    lastHour: z.number(),
    byType24h: z.array(z.object({ eventType: z.string(), count: z.number() })),
    perHour24h: z.array(z.object({ hour: z.string(), count: z.number() })),
    byWorkspace24h: z.array(
      z.object({ workspaceId: z.string().nullable(), workspaceName: z.string(), count: z.number() })
    ),
    latest: z.array(ObservabilityEventSchema),
  }),
  missions: z.object({
    total: z.number(),
    active: z.number(),
    blocked: z.number(),
    verified: z.number(),
    verified24h: z.number(),
    byState: z.array(z.object({ state: z.string(), count: z.number() })),
  }),
  reviews: z.object({
    total: z.number(),
    open: z.number(),
    completed24h: z.number(),
    pass24h: z.number(),
    findings24h: z.number(),
    inconclusive24h: z.number(),
    avgTimeToVerdictMs: z.number().nullable(),
    oldestOpenAgeMs: z.number().nullable(),
    byState: z.array(z.object({ state: z.string(), count: z.number() })),
  }),
  findings: z.object({
    total: z.number(),
    bySeverity: z.array(z.object({ severity: z.string(), count: z.number() })),
  }),
  gates: z.object({
    total: z.number(),
    byStatus: z.array(z.object({ status: z.string(), count: z.number() })),
    byGate: z.array(
      z.object({
        gateKey: z.string(),
        pass: z.number(),
        fail: z.number(),
        unverified: z.number(),
        blocked: z.number(),
      })
    ),
  }),
  workers: z.object({
    total: z.number(),
    running: z.number(),
    recentFailures24h: z.number(),
    byStatus: z.array(z.object({ status: z.string(), count: z.number() })),
    active: z.array(
      z.object({
        workerId: z.string(),
        jobId: z.string(),
        role: z.string().nullable(),
        status: z.string(),
        providerId: z.string().nullable(),
        modelId: z.string().nullable(),
        pid: z.number().nullable(),
        startedAt: z.string().nullable(),
        ageMs: z.number().nullable(),
      })
    ),
  }),
  usage: z.object({
    runs: z.number(),
    tokensIn: z.number(),
    tokensOut: z.number(),
    cost: z.number(),
    avgRunDurationMs: z.number().nullable(),
  }),
  recovery: z.object({
    requeued24h: z.number(),
    retried24h: z.number(),
    recovered24h: z.number(),
    replanned24h: z.number(),
    blocked24h: z.number(),
    failedRepairs24h: z.number(),
  }),
  recentJobs: z.array(
    z.object({
      jobId: z.string(),
      workspaceId: z.string(),
      workspaceName: z.string(),
      state: z.string(),
      requestedAt: z.string(),
      completedAt: z.string().nullable(),
      attemptCount: z.number(),
      durationMs: z.number().nullable(),
    })
  ),
  agile: AgileMetricsSchema,
});

export type ObservabilityEvent = z.output<typeof ObservabilityEventSchema>;
export type ObservabilitySnapshot = z.output<typeof ObservabilitySnapshotSchema>;
export type AgileMetrics = z.output<typeof AgileMetricsSchema>;
export type AgileMission = z.output<typeof AgileMissionSchema>;
export type AgileThroughputBucket = z.output<typeof AgileThroughputBucketSchema>;
export type AgileReviewLatencyBucket = z.output<typeof AgileReviewLatencyBucketSchema>;
export type AgileWorkstation = z.output<typeof AgileWorkstationSchema>;
