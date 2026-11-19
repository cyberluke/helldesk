import { tool } from '@kilocode/plugin';
import type { NafClient } from '@cyberluke/nai-lattice-client';

/**
 * Local HELLDESK plugin tools accessible inside the Kilo workspace session.
 * All of them are thin NAF capability calls to the native NAI-Lattice host
 * (`helldesk.admin.health`, `helldesk.review.*`, `helldesk.config.*`). No shell, no
 * Git, no service logic lives here. Tool names are preserved for compatibility.
 *
 * The client is provided as a GETTER because the bridge connects lazily (async);
 * each tool resolves it at execute time and fails open (JSON error) if the host
 * is not reachable, so a missing fabric never blocks the developer.
 */

function nafJson(out: { ok: boolean; status: number; error?: string }): Record<string, unknown> {
  return { ok: out.ok, status: out.status, error: out.error ?? '' };
}

export function createLocalTools(getClient: () => NafClient | null) {
  const requireClient = (): NafClient => {
    const c = getClient();
    if (!c) throw new Error('HELLDESK host not connected (fabric pipe down). Fail-open; no config/review surfaced.');
    return c;
  };

  return {
    gt_local_status: tool({
      description:
        'Report the health of the NAI-Lattice Local HELLDESK host and current queue depth. ' +
        'Use to confirm the reviewer engine is running and how many reviews are queued/in flight.',
      args: {},
      async execute() {
        const client = requireClient();
        const health = await client.dispatch('helldesk.admin.health', {});
        const jobs = await client.dispatch('helldesk.review.list_jobs', {});
        let healthBody = {} as Record<string, unknown>;
        let jobsList: unknown[] = [];
        if (health.ok) { try { healthBody = JSON.parse(Buffer.from(health.body).toString()); } catch { /* noop */ } }
        if (jobs.ok) {
          try {
            const parsed = JSON.parse(Buffer.from(jobs.body).toString());
            jobsList = Array.isArray(parsed) ? parsed : (parsed.jobs ?? []);
          } catch { /* noop */ }
        }
        const queueDepth = (arr: unknown[]): Record<string, number> => {
          const s = arr.map((j) => (j as { state?: string }).state ?? '');
          return {
            queued: s.filter((x) => x.includes('Queued')).length,
            inflight: s.filter((x) => x.includes('Reviewer') || x.includes('Adjudic')).length,
            completed: s.filter((x) => x.includes('Completed')).length,
          };
        };
        return JSON.stringify(
          {
            daemon: nafJson(health),
            native: { serviceAlive: healthBody.service_alive ?? false, watermark: healthBody.watermark ?? 0 },
            queueDepth: queueDepth(jobsList),
            recentJobs: jobsList.slice(0, 10),
          },
          null,
          2
        );
      },
    }),

    gt_local_review: tool({
      description:
        'Enqueue a review of the current task/commit in the native NAI-Lattice HELLDESK host. ' +
        'The host owns the immutable snapshot and runs reviewers/adjudicator. Returns the jobId; ' +
        'poll gt_local_status / gt_local_report for the outcome.',
      args: {
        requirements: tool.schema
          .string()
          .describe('Optional acceptance criteria / requirements the implementation must satisfy')
          .optional(),
        workspace: tool.schema
          .string()
          .describe('Optional canonical workspace id. When omitted the host uses its current session mapping.')
          .optional(),
      },
      async execute(args) {
        const client = requireClient();
        const idem = `gt-review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const out = await client.dispatch(
          'helldesk.review.enqueue_explicit',
          {
            job_id: idem,
            workspace_canonical: args.workspace ?? '',
            source_manifest_hash: 'host-owned',
            review_policy_version: 1,
            requirements: args.requirements ?? '',
          },
          idem
        );
        if (!out.ok) {
          return JSON.stringify({ ok: false, error: out.error }, null, 2);
        }
        const body = JSON.parse(Buffer.from(out.body).toString());
        return JSON.stringify({ ok: true, jobId: body.job_id ?? idem, duplicate: body.duplicate ?? false }, null, 2);
      },
    }),

    gt_local_report: tool({
      description: 'Fetch the final immutable report for a review job from the native host.',
      args: { job_id: tool.schema.string().describe('The review job id returned by gt_local_review') },
      async execute(args) {
        const client = requireClient();
        const out = await client.dispatch('helldesk.review.job_status', { job_id: args.job_id });
        if (!out.ok) return JSON.stringify({ ok: false, error: out.error }, null, 2);
        return JSON.stringify({ ok: true, job: JSON.parse(Buffer.from(out.body).toString()) }, null, 2);
      },
    }),

    gt_local_findings: tool({
      description: 'List current review jobs / findings known to the native HELLDESK host.',
      args: {},
      async execute() {
        const client = requireClient();
        const out = await client.dispatch('helldesk.review.list_jobs', {});
        if (!out.ok) return JSON.stringify({ ok: false, error: out.error }, null, 2);
        return JSON.stringify({ ok: true, jobs: JSON.parse(Buffer.from(out.body).toString()) }, null, 2);
      },
    }),

    gt_local_rework: tool({
      description: 'Request a re-run / retry of a review job on the native host.',
      args: { job_id: tool.schema.string().describe('The review job id to retry') },
      async execute(args) {
        const client = requireClient();
        const out = await client.dispatch('helldesk.review.retry', { job_id: args.job_id });
        if (!out.ok) return JSON.stringify({ ok: false, error: out.error }, null, 2);
        return JSON.stringify({ ok: true, job: JSON.parse(Buffer.from(out.body).toString()) }, null, 2);
      },
    }),

    gt_local_config: tool({
      description:
        'Read or change the Local HELLDESK runtime configuration (daemon concurrency, review policy/' +
        'runner model, autonomy enable/mutation route, workspace inclusion). Public/effective view is redacted; ' +
        'the host validates and persists changes to config.json. Fields that require a restart (bind/port/token/' +
        'state dirs) are persisted and reported as applies_on_restart. Use gt_local_config with no patch to GET, ' +
        'or pass {patch:{...}} to change.',
      args: {
        patch: tool.schema
          .any()
          .optional()
          .describe('Omit to read. Otherwise a partial {daemon?,policy?,autonomy?,workspaces?} update to apply live.'),
      },
      async execute(args) {
        const client = requireClient();
        if (args.patch) {
          const out = await client.dispatch('helldesk.config.patch', { patch: args.patch });
          if (!out.ok) return JSON.stringify({ ok: false, error: out.error }, null, 2);
          const body = JSON.parse(Buffer.from(out.body).toString());
          return JSON.stringify({ ok: true, ...body }, null, 2);
        }
        const out = await client.dispatch('helldesk.config.get', {});
        if (!out.ok) return JSON.stringify({ ok: false, error: out.error }, null, 2);
        const body = JSON.parse(Buffer.from(out.body).toString());
        return JSON.stringify({ ok: true, config: body.config, meta: body.meta, path: body.path }, null, 2);
      },
    }),
  };
}