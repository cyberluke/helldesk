/**
 * excellenceGovernor.handler.ts — the "new repo + specs → NAI ExcellenceGovernor convergence
 * observed in HELLDESK" integration.
 *
 * Bridges the HELLDESK dashboard to the canonical NAI ExcellenceGovernor governor:
 *   1. createSpecProject(): onboards a new empty repo + a docs/spec markdown
 *      into the engine as a HELLDESK project (`gt.project.create`, `import`),
 *      starts the primary ticket (`gt.project.add_primary`) with task-specific
 *      quality gates, so the auto-excellence-governor `process_hook_events` fires on
 *      convergence (ticket completion → onQualityGate) toward a verified 10/10.
 *   2. getExcellenceGovernor(): proxies the engine's token-gated `/excellenceGovernor` so the
 *      HELLDESK dashboard can observe the verdict / verified facts / gates /
 *      history — NOT a split screen, but the same durable ExcellenceGovernor state.
 *
 * Loopback-only; the control token is read from control.token, never logged.
 */
import { assetToken, engineJsonRpc, engineRaw } from '../fabric/engine-client';
import { z } from 'zod';

const SpecProjectSchema = z.object({
  name: z.string().trim().min(1).default('spec-project'), repoPath: z.string().default(''),
  objective: z.string().optional(), spec: z.string().default(''), workstationId: z.string().optional(),
  gates: z.array(z.object({ id: z.string().min(1), status: z.literal('UNVERIFIED').optional(), evidence: z.string().optional() })).optional(),
  sourceRepos: z.array(z.object({ id: z.string(), path: z.string(), label: z.string().optional(), branch: z.string().optional() })).optional(),
  outputRepo: z.object({ repo_path: z.string(), branch: z.string().optional(), bare_remote: z.string().optional(), init_if_missing: z.boolean().optional() }).optional(),
});

/** Minimal structural context the handler touches (Hono Context satisfies it).
 *  `json` returns a web Response so Hono's handler overload type-checks. */
export type Ctx = {
  req: { json(): Promise<unknown> };
  json: (body: unknown, status?: number | undefined) => Response;
};

export interface SpecProjectInput {
  name: string;
  repoPath: string;
  objective: string;
  /** The docs/spec markdown to import (e.g. docs/SPEC.md contents). */
  spec: string;
  /** Optional per-task acceptance gates (defaults to the engine's P0-D set). */
  gates?: Array<{ id: string; status?: string; evidence?: string }>;
  workstationId?: string;
  /** Extra read-only input repos the task may read (beyond the workspace). */
  sourceRepos?: Array<{ id: string; path: string; label?: string; branch?: string }>;
  /** Optional cross-repo delta target (new or existing). When set, the completed
   *  change is federated into this repo as well as the workspace. */
  outputRepo?: { repo_path: string; branch?: string; bare_remote?: string; init_if_missing?: boolean };
}

/** Optional department-binding hook so one call wires BOTH brains (ExcellenceGovernor project
 *  AND the department `local_repo` the kanban dispatchers read). When absent, only
 *  the engine project is created (no split-brain change on the department side). */
export interface SpecProjectDeps {
  /** Set the department's local_repo to the same workspace/input + optional sources
   *  and output repo (cross-repo delta target). */
  bindDepartmentRepo?: (input: {
    repoPath: string;
    workdir?: string;
    sourceRepos?: Array<{ id: string; path: string; label?: string; branch?: string }>;
    outputRepo?: { repo_path: string; branch?: string; bare_remote?: string; init_if_missing?: boolean };
  }) => Promise<void>;
}

/** Onboard a new repo + spec as a HELLDESK project and start convergence. */
export async function handleCreateSpecProject(c: Ctx, params: { departmentId: string }, deps?: SpecProjectDeps) {
  let input: SpecProjectInput;
  try {
    const body = SpecProjectSchema.parse(await c.req.json());
    input = {
      name: body.name || 'spec-project',
      repoPath: body.repoPath || '',
      objective: body.objective || body.spec || 'Implement the complete project specification with independent adversarial review',
      spec: body.spec ?? '',
      gates: body.gates,
      workstationId: body.workstationId,
      sourceRepos: body.sourceRepos,
      outputRepo: body.outputRepo,
    };
  } catch {
    return c.json({ success: false, error: 'invalid JSON body' }, 400);
  }
  if (!input.spec.trim() && !input.repoPath.trim()) {
    return c.json({ success: false, error: 'spec (markdown) or repoPath is required' }, 400);
  }

  // 1) Create the project, importing the spec as markdown context messages.
  const create = await engineJsonRpc('gt.project.create', {
    name: input.name,
    repo_path: input.repoPath,
    objective: input.objective,
    context_text: input.spec,
    resource_roots: input.repoPath ? [input.repoPath] : [],
  });
  if (create?.ok !== true || typeof create.project_id !== 'string' || !create.project_id) {
    return c.json({ success: false, error: create?.error ?? 'project create failed' }, 500);
  }
  const projectId = create.project_id;

  // 1b) Bind the department's local_repo to the SAME destination + read sources so the
  //     kanban/soul brain and the ExcellenceGovernor brain agree (no split-brain).
  if (deps?.bindDepartmentRepo && input.repoPath) {
    try {
      await deps.bindDepartmentRepo({
        repoPath: input.repoPath,
        sourceRepos: input.sourceRepos,
        outputRepo: input.outputRepo,
      });
    } catch (err) {
      return c.json({ success: false, error: 'Project created but repository binding failed; no primary task started', stage: 'bind_repository', project_id: projectId }, 409);
    }
  }

  // 2) Start the primary ticket with task-specific quality gates so the
  //    auto-excellence-governor loop converges on the real task, not infra self-tests.
  const add = await engineJsonRpc('gt.project.add_primary', {
    project_id: projectId,
    title: `Implement ${input.name}`,
    objective: input.objective,
    workstation_id: input.workstationId ?? 'workstation-local',
    gates: input.gates ?? [
      { id: 'spec_parity', status: 'UNVERIFIED', evidence: 'deliverable matches the docs/spec requirements' },
      { id: 'works_10_10', status: 'UNVERIFIED', evidence: 'all acceptance gates PASS under the Quality Oracle' },
      { id: 'evidence_real', status: 'UNVERIFIED', evidence: 'results verified from source/runtime, no fabrication' },
    ],
  });

  if (add?.ok !== true || typeof add.ticket_id !== 'string' || !add.ticket_id) {
    return c.json({ success: false, error: add?.error || 'Project exists but primary task creation failed', stage: 'add_primary', project_id: projectId }, 502);
  }

  return c.json({
    success: true,
    data: {
      project_id: projectId,
      ticket_id: add?.ticket_id,
      shift_id: add?.shift_id,
      mode: 'nai-excellence-governor',
      production_acceptance: 'CTO_ONLY',
    },
  });
}

/** Proxy the engine's token-gated `/excellenceGovernor` so HELLDESK sees the verdict. */
export async function handleGetExcellenceGovernor(c: Ctx, params: { departmentId: string }) {
  const token = assetToken();
  const res = await engineRaw('/excellenceGovernor', { method: 'GET', token });
  return c.json({ success: true, data: res });
}

/**
 * Toggle a Kanban ticket's per-task behavior controls on the fly:
 *   { excellenceGovernor?: boolean, reviewer?: boolean, agents?: boolean,
 *     review_mode?: 'ReviewThenLand' | 'ReviewAndMerge' }
 * Persists to the primary ticket's metadata.break_room_controls (engine read side
 * gates ExcellenceGovernor governor + reviewer + department-agent dispatch per task).
 */
export async function handleSetTicketControls(
  c: Ctx,
  params: { departmentId: string; ticketId: string }
) {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ success: false, error: 'invalid JSON body' }, 400);
  }
  const pick = (k: string): boolean | undefined =>
    typeof body[k] === 'boolean' ? (body[k] as boolean) : undefined;
  const args: Record<string, unknown> = { ticket_id: params.ticketId };
  const inq = pick('excellenceGovernor');
  const rev = pick('reviewer');
  const ag = pick('agents');
  const mode = typeof body['review_mode'] === 'string' ? (body['review_mode'] as string) : undefined;
  if (inq === undefined && rev === undefined && ag === undefined && mode === undefined) {
    return c.json({ success: false, error: 'at least one of {excellenceGovernor, reviewer, agents, review_mode} is required' }, 400);
  }
  if (inq !== undefined) args['excellenceGovernor'] = inq;
  if (rev !== undefined) args['reviewer'] = rev;
  if (ag !== undefined) args['agents'] = ag;
  if (mode !== undefined) args['review_mode'] = mode;

  const res = await engineJsonRpc('gt.project.set_ticket_controls', args);
  if (res['ok'] !== true) {
    return c.json({ success: false, error: res['error'] ?? 'set_ticket_controls failed' }, 500);
  }
  return c.json({ success: true, data: { ticket_id: params.ticketId, break_room_controls: res['break_room_controls'] ?? args } });
}
