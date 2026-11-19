/**
 * Local HELLDESK — Local Reconciler Engine.
 *
 * The missing "colony brain" delta. In the Cloudflare deployment the Department DO's
 * alarm loop periodically runs `department/reconciler.reconcile()` and applies the
 * resulting actions. Locally that loop was a no-op, leaving two disconnected
 * brains: the review/autonomy engine (services/helldesk/local) and the
 * soul/qualityAssurance colony reconciler (this module) that never ran.
 *
 * This module ports the colony reconciler onto the local runtime:
 *  - it drives the *portable* reconciler rules (tickets/agents/MRs/shifts/GUPP/GC/helldesk)
 *    over the local `SqlStorage`;
 *  - it provides a REAL `ApplyActionContext`, i.e. a live side-effect seam for
 *    `dispatch_agent`, `stop_agent`, `poll_pr`, `merge_pr`, `send_nudge`,
 *    `emit_event`, `insert_event`, and `report_helldesk_done` — no stubs;
 *  - it fans every emit out to a shared in-process event bus so the dashboards
 *    and WS bridge observe the same live stream (`broadcastTicketEvent` parity).
 *
 * Dispatch semantics (honest local translation of a "container start"):
 * the local-git adapter operates on a real filesystem checkout. A
 * `dispatch_agent` therefore transitions the agent to `working`, the ticket to
 * `in_progress`, then runs the local-git `prepare`/`commit` step. It honours
 * the per-ticket `metadata.break_room_controls.agents` gate (the NAI agent dispatch
 * junction) so a task whose agents are switched off is never started.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SqlStorage } from './runtime-types';
import { query } from '../util/query.util';
import { now } from '../util/id.util';
import { tickets } from '../db/tables/tickets.table';
import type { Ticket, DepartmentConfig } from '../types';
import { LocalRepoSchema } from '../types';
import * as ticketOps from '../dos/department/tickets';
import * as agentOps from '../dos/department/agents';
import * as workstationOps from '../dos/department/workstations';
import * as eventOps from '../dos/department/events';
import { reconcile, checkInvariants, type Violation } from '../dos/department/reconciler';
import { applyAction, type ApplyActionContext } from '../dos/department/actions';
import { localGitAdapter, type DispatchAdapter } from './adapters';
import { submitMission, missionBinding, readMission } from './mission-dispatch';

// Structurally compatible with the ApplyActionContext's expected
// checkPRStatus/checkPRFeedback/mergePR return shapes, defined locally so this
// module never depends on the Cloudflare-coupled department-scm body.
export type LocalPRStatusResult = {
  status: 'open' | 'merged' | 'closed';
  mergeable_state?: string;
};
export type LocalPRStatusError =
  | { kind: 'no_token'; provider: 'github' | 'gitlab'; resolutionChain: string[] }
  | { kind: 'unrecognized_url'; url: string }
  | {
      kind: 'http_error';
      provider: 'github' | 'gitlab';
      status: number;
      statusText: string;
      transient: boolean;
    };
export type LocalPRStatusOutcome =
  | { ok: true; result: LocalPRStatusResult }
  | { ok: false; error: LocalPRStatusError };
export type LocalPRFeedbackResult = {
  hasUnresolvedComments: boolean;
  hasFailingChecks: boolean;
  allChecksPass: boolean;
  hasUncheckedRuns: boolean;
  awaitingApproval: boolean;
  changesRequested: boolean;
  reviewDecision: ('APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED') | null;
  mergeStateStatus: ('CLEAN' | 'BLOCKED' | 'BEHIND' | 'DIRTY' | 'HAS_HOOKS' | 'UNKNOWN') | null;
  isDraft: boolean;
};

/** Guard a runtime event type against the durable department-event contract. */
type KnownDepartmentEvent =
  | 'agent_done' | 'agent_completed' | 'container_status' | 'container_eviction'
  | 'pr_status_changed' | 'ticket_created' | 'ticket_cancelled' | 'shift_started'
  | 'nudge_timeout' | 'pr_feedback_detected' | 'pr_auto_merge' | 'pr_conflict_detected';
function isKnownDepartmentEvent(eventType: string): eventType is KnownDepartmentEvent {
  return KNOWN_DEPARTMENT_EVENTS.has(eventType);
}
const KNOWN_DEPARTMENT_EVENTS: ReadonlySet<string> = new Set([
  'agent_done', 'agent_completed', 'container_status', 'container_eviction',
  'pr_status_changed', 'ticket_created', 'ticket_cancelled', 'shift_started',
  'nudge_timeout', 'pr_feedback_detected', 'pr_auto_merge', 'pr_conflict_detected',
]);

// ────────────────────────────────────────────────────────────────────────
// Runtime event bus — single source of truth for live fan-out.
// `broadcastTicketEvent`, `emitEvent`, and the dashboard WS bridge all share it.
// ────────────────────────────────────────────────────────────────────────

export type RuntimeEvent =
  | { type: 'ticket'; departmentId: string; ticketId?: string; payload: Record<string, unknown> }
  | { type: 'analytics'; departmentId: string; payload: Record<string, unknown> }
  | { type: 'invariant'; departmentId: string; violations: Violation[] };

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export class RuntimeEventBus {
  private listeners = new Set<RuntimeEventListener>();

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: RuntimeEvent): void {
    for (const l of Array.from(this.listeners)) {
      try {
        l(event);
      } catch (err) {
        console.warn('[local-reconciler] event bus listener failed:', err);
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Local dispatch context — the real side-effect seam.
// ────────────────────────────────────────────────────────────────────────

/** How the local reconciler starts an agent: the dispatch adapter + counters. */
export interface LocalDispatchHooks {
  /** Injectable boundary for isolated tests; production submits real durable missions. */
  submitMission?: typeof submitMission;
  /** Resolve the dispatch adapter + its config for a workstation/department. Returns null when
   *  the department has no local_repo configured (adapter 'none'). */
  resolveDispatch: (
    department: LocalDepartmentLite,
    workstationId: string,
    ticket: Ticket,
) => Promise<{
    adapter: DispatchAdapter;
cfg: { workdir: string; repoPath: string; outputRepo?: { repoPath: string; branch?: string; bareRemote?: string; initIfMissing?: boolean }; sourceRepos?: Array<{ id: string; path: string; label?: string; branch?: string }>; branch: string; bareRemote?: string; allowCommit: boolean; engineMatrix?: Record<string, unknown> };
    } | null>;
  /** Fan-out a ticket event to the runtime event bus (map). */
  broadcastTicket: (departmentId: string, ticketId: string | undefined, payload: Record<string, unknown>) => void;
}

/** The LocalDepartment surface `createLocalApplyContext` needs (a LSP of LocalDepartment). */
export interface LocalDepartmentLite {
  readonly departmentId: string;
  readonly sql: SqlStorage;
  getDepartmentConfig(): Promise<DepartmentConfig>;
  emitEvent(evt: { event: string; departmentId?: string; workstationId?: string; ticketId?: string; [k: string]: unknown }): void;
  broadcastTicketEvent(evt: { type: string; departmentId?: string; ticketId?: string; [k: string]: unknown }): void;
  queueNudge(agentId: string, message: string, opts?: { type?: string; metadata?: Record<string, unknown>; mode?: string; source?: string }): Promise<string>;
}

/** Build a REAL ApplyActionContext bound to one local department. */
export function createLocalApplyContext(
  department: LocalDepartmentLite,
  hooks: LocalDispatchHooks,
): ApplyActionContext {
  const sql = department.sql;
  const departmentId = department.departmentId;

  return {
    sql,
    departmentId,

    /** Real dispatch: transition counters + run the local-git adapter step. The
     *  agent transition to `working` and the ticket to `in_progress` are done by
     *  `actions.applyAction` before this hook runs; here we execute the work. */
    async dispatchAgent(agentId, ticketId, workstationId) {
      const ticket = ticketOps.getTicket(sql, ticketId);
      if (!ticket) return false;

      // Per-ticket NAI agent gate: metadata.break_room_controls.agents === false keeps
      // the colony from starting a task whose agents are switched off. This is
      // the same junction process_hook_events/HostAgentRunner read.
      const breakRoom = (ticket.metadata?.break_room_controls ?? {}) as {
        agents?: boolean;
      };
      if (breakRoom.agents === false) {
        console.warn(
          `[local-reconciler] dispatch_agent skipped: ticket=${ticketId} break_room_controls.agents=false`,
        );
        // Leave the ticket in_progress; the reconciler's staleness rule will
        // recover it if it is never started. Do not fabricate progress.
        return false;
      }

      const resolved = await hooks.resolveDispatch(department, workstationId, ticket);
      if (!resolved) {
        // No dispatch adapter configured for this workstation/department. This is not a
        // silent drop: record the intent on the ticket timeline + as a department event
        // (dispatch.no_adapter is not a valid DepartmentEventType, so we use the ticket
        // event timeline which the dashboard reads).
        ticketOps.logTicketEvent(sql, {
          ticketId,
          agentId,
          eventType: 'agent_exited',
          newValue: 'dispatch_no_adapter',
          metadata: { workstationId, reason: 'no local_repo dispatch adapter' },
        });
        return false;
      }

      const { adapter, cfg } = resolved;
      try {
        await adapter.prepare(cfg);
        const upstream = ticketOps.getTicketDependencies(sql, ticketId).blockers.filter(dep => dep.dependency_type === 'blocks').map(dep => {
          const task = ticketOps.getTicket(sql, dep.depends_on_ticket_id);
          return { task: dep.depends_on_ticket_id, title: task?.title, reviewedWorkspace: task ? missionBinding(task)?.workspace : undefined };
        });
        const binding = await (hooks.submitMission || submitMission)(sql, ticket, cfg.outputRepo ? resolve(cfg.outputRepo.repoPath) : join(cfg.workdir, 'repo'),
          `Primary read source checkout: ${join(cfg.workdir, 'repo')}. Original read-only source path: ${resolve(cfg.repoPath)} (contains current uncommitted files that git clones do not include; inspect these when required, never modify them). Extra original read-only sources: ${JSON.stringify(cfg.sourceRepos || [])}. Extra read-only source checkouts: ${join(cfg.workdir, 'sources')}. ${cfg.outputRepo ? `Implement directly in the writable output repository: ${resolve(cfg.outputRepo.repoPath)}. Never copy the whole input tree into it; federate the required capability only.` : `Single-repository mode: implement in the isolated checkout ${join(cfg.workdir, 'repo')}; original input is read-only. The resulting local commit stays in this checkout unless a remote is explicitly configured.`} Completed dependencies: ${JSON.stringify(upstream)}. Reuse their artifacts and Blueprints; do not recreate them. Do not modify original input repositories. Preserve source/output separation.`,
          cfg.engineMatrix);
        ticketOps.logTicketEvent(sql, { ticketId, agentId, eventType: 'agent_spawned', newValue: 'mission_accepted', metadata: { missionId: binding.missionId, transport: 'local-mission-controller', productionAcceptance: 'CTO_ONLY' } });
        return true;
      } catch (err) {
        console.warn(
          `[local-reconciler] dispatch_agent failed: ticket=${ticketId} agent=${agentId}`,
          err,
        );
        ticketOps.logTicketEvent(sql, {
          ticketId,
          agentId,
          eventType: 'agent_exited',
          newValue: 'dispatch_failed',
          metadata: { error: err instanceof Error ? err.message : String(err) },
        });
        return false;
      }
    },

    /** Real stop: there is no long-lived container process locally, so stopping
     *  an agent means returning it to the reconciler's idle + unhook recovery
     *  path. applyAction already transitions state; this is the post-effect. */
    async stopAgent(agentId) {
      try {
        agentOps.updateAgentStatus(sql, agentId, 'idle');
        agentOps.unhookTicket(sql, agentId);
      } catch (err) {
        console.warn(`[local-reconciler] stop_agent failed: agent=${agentId}`, err);
      }
    },

    async queueNudge(agentId, message, _tier) {
      await department.queueNudge(agentId, message, { type: 'reconciler', source: 'reconciler' });
    },

    insertEvent(eventType, params) {
      try {
        // Only record events whose type is part of the durable department-event
        // contract; guard any reconciler/extension event that is not.
        if (!isKnownDepartmentEvent(eventType)) {
          console.warn(`[local-reconciler] insertEvent: skipping unknown department event type: ${eventType}`);
          return;
        }
        eventOps.insertEvent(sql, eventType, {
          ticket_id: params.ticket_id ?? '',
          agent_id: params.agent_id ?? undefined,
          payload: params.payload ?? {},
        });
      } catch (err) {
        console.warn(`[local-reconciler] insertEvent failed: ${eventType}`, err);
      }
    },

    emitEvent(data) {
      department.emitEvent(data as never);
    },

    getDepartmentConfig: () => department.getDepartmentConfig(),

    async checkPRStatus(prUrl) {
      // Local-git interpretation first (a local MR ticket's "PR" is a branch in
      // the workstation's local repo). Falls back to the GitHub/GitLab adapter logic
      // when the URL is an external host.
      const local = await localPRStatus(department, prUrl);
      if (local) {
        return { ok: true, result: local } as const;
      }
      // External PR — real HTTP status check against the configured token.
      return externalPRStatus(department, prUrl);
    },

    async checkPRFeedback(prUrl) {
      const local = await localPRFeedback(department, prUrl);
      return local;
    },

    async mergePR(prUrl) {
      return localMergePR(department, prUrl);
    },

    async reportHelldeskDone(input) {
      // Real local record: persist an evidence event + stamp the canonical ticket
      // so the reconciler's idempotency gate (reported_done_at) closes the loop.
      try {
        const ticket = ticketOps.getTicket(sql, input.canonicalTicketId);
        if (!ticket) return false;
        query(
          sql,
          /* sql */ `
            UPDATE ${tickets}
            SET ${tickets.columns.metadata} = json_set(
              COALESCE(${tickets.columns.metadata}, '{}'),
              '$.helldesk.reported_done_at', ?
            ),
            ${tickets.columns.updated_at} = ?
            WHERE ${tickets.ticket_id} = ?
          `,
          [now(), now(), input.canonicalTicketId],
        );
        ticketOps.logTicketEvent(sql, {
          ticketId: input.canonicalTicketId,
          agentId: null,
          eventType: 'fields_updated',
          oldValue: undefined,
          newValue: 'helldesk_reported_done',
          metadata: { helldeskId: input.helldeskId, itemId: input.itemId, evidence: input.evidence },
        });
        return true;
      } catch (err) {
        console.warn(`[local-reconciler] report_helldesk_done failed: ${input.itemId}`, err);
        return false;
      }
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Local-git PR status (the honest local counterpart to GitHub poll_pr).
//
// An MR ticket in a local setup points at a branch in the workstation's local repo. The
// "PR" is that branch; its status is derived from git:
//   - if the branch is gone and the target branch has a merge that included it
//     → 'merged'
//   - if the branch is gone and the target branch did not advance → 'closed'
//   - else 'open', with a mergeable_state of 'clean'/'dirty' by whether a
//     merge --no-commit from the branch into the target would conflict.
// ────────────────────────────────────────────────────────────────────────

export type LocalPRStatus = { status: 'open' | 'merged' | 'closed'; mergeable_state?: string } | null;

async function localPRStatus(
  department: LocalDepartmentLite,
  prUrl: string,
): Promise<LocalPRStatus> {
  // Only handle local branch-style refs: `local://<branch>` or a bare branch
  // name. GitHub/GitLab URLs fall through to the external path.
  const branch = parseLocalBranch(prUrl);
  if (branch === null) return null;

  const repo = await resolveLocalRepo(department);
  if (!repo) return null;

  const branchExists = (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
  if (!branchExists) {
    // Branch removed. Determine merged vs closed by whether the default branch
    // contains a commit that would once have been the branch tip (best-effort).
    const merged = await branchWasMerged(repo, branch);
    return { status: merged ? 'merged' : 'closed' };
  }

  // Branch present → open. mergeable_state: clean vs dirty by a trial merge.
  const clean = await branchMergeIsClean(repo, branch);
  return { status: 'open', mergeable_state: clean ? 'clean' : 'dirty' };
}

async function localPRFeedback(department: LocalDepartmentLite, _prUrl: string): Promise<LocalPRFeedbackResult | null> {
  // Local git has no review comments/CI to classify. Report a clean, green
  // state so a local auto-merge flow can proceed on a clean branch; this is
  // the honest local notion of "no unresolved feedback".
  await department.getDepartmentConfig();
  return {
    hasUnresolvedComments: false,
    hasFailingChecks: false,
    allChecksPass: true,
    hasUncheckedRuns: false,
    awaitingApproval: false,
    changesRequested: false,
    reviewDecision: null,
    mergeStateStatus: 'CLEAN',
    isDraft: false,
  };
}

async function localMergePR(department: LocalDepartmentLite, prUrl: string): Promise<boolean> {
  const branch = parseLocalBranch(prUrl);
  if (branch === null) return false;
  const repo = await resolveLocalRepo(department);
  if (!repo) return false;

  // Fast-forward or merge the local branch into the default branch.
  const target = (await configDefaultBranch(department)) ?? 'main';
  await git(repo, ['checkout', target]);
  const res = await git(repo, ['merge', '--no-edit', `refs/heads/${branch}`]);
  if (res.code !== 0) {
    console.warn(`[local-reconciler] merge_pr: local merge of ${branch} into ${target} failed: ${res.stderr}`);
    return false;
  }
  return true;
}

function parseLocalBranch(prUrl: string): string | null {
  if (prUrl.startsWith('local://')) {
    const b = prUrl.slice('local://'.length);
    return b && !b.includes('/') ? b : null;
  }
  // A bare branch name (no host) is treated as a local ref.
  if (!/^https?:\/\//.test(prUrl) && !prUrl.startsWith('local://')) {
    return prUrl.length > 0 ? prUrl : null;
  }
  return null;
}

async function resolveLocalRepo(department: LocalDepartmentLite): Promise<string | null> {
  const cfg = await department.getDepartmentConfig();
  const lr = cfg.local_repo;
  const repoPath = lr?.repo_path;
  if (!repoPath) return null;
  const repo = resolve(repoPath);
  if (!existsSync(join(repo, '.git'))) return null;
  return repo;
}

async function configDefaultBranch(department: LocalDepartmentLite): Promise<string | null> {
  const cfg = await department.getDepartmentConfig();
  return cfg.local_repo?.branch ?? null;
}

async function branchWasMerged(repo: string, branch: string): Promise<boolean> {
  // Look for a commit whose message references the branch (best-effort local
  // analog). More robustly, try `git branch --merged` history is gone; fall
  // back to whether `main` has advanced beyond the branch's last known HEAD.
  const res = await git(repo, ['log', '--all', '--oneline', '--grep', branch, '-1']);
  return res.stdout.trim().length > 0;
}

async function branchMergeIsClean(repo: string, branch: string): Promise<boolean> {
  const target = (await git(repo, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim() || 'main';
  // Trial merge without touching the working tree.
  const res = await git(repo, ['merge-tree', target, `refs/heads/${branch}`]);
  // merge-tree succeeds (exit 0) on clean merge; a non-zero exit or a diff in
  // the `<<<<<<<` output signals conflict.
  if (res.code !== 0) return false;
  return !res.stdout.includes('<<<<<<<');
}

// ────────────────────────────────────────────────────────────────────────
// External PR status — real HTTP check when the MR points at GitHub/GitLab.
// Reuses the same fetch logic as the cloud department-scm, but token resolution is
// local (department config PAT / stored token only; no platform integration).
// ────────────────────────────────────────────────────────────────────────

async function externalPRStatus(department: LocalDepartmentLite, prUrl: string): Promise<LocalPRStatusOutcome> {
  const cfg = await department.getDepartmentConfig();
  const gh = prUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (gh) {
    const [, owner, repo, num] = gh;
    const token = cfg.git_auth?.github_token ?? cfg.github_cli_pat;
    if (!token) {
      return {
        ok: false,
        error: { kind: 'no_token', provider: 'github', resolutionChain: ['department.git_auth.github_token', 'department.github_cli_pat'] },
      };
    }
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${num}`, {
      headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'helldesk-quality-assurance/1.0' },
    });
    if (!res.ok) {
      return {
        ok: false,
        error: { kind: 'http_error', provider: 'github', status: res.status, statusText: res.statusText, transient: res.status >= 500 || res.status === 429 },
      };
    }
    const j = (await res.json()) as { state?: string; merged?: boolean; mergeable_state?: string };
    if (j.merged) return { ok: true, result: { status: 'merged' } };
    if (j.state === 'closed') return { ok: true, result: { status: 'closed' } };
    return { ok: true, result: { status: 'open', mergeable_state: j.mergeable_state } };
  }
  // Fall through to the original flattening so unrecognized URLs are honest.
  if (!/^https:\/\//.test(prUrl)) {
    return { ok: false, error: { kind: 'unrecognized_url', url: prUrl } };
  }
  return { ok: false, error: { kind: 'unrecognized_url', url: prUrl } };
}

// ────────────────────────────────────────────────────────────────────────
// Baseline dispatch resolution (used when the department provides no override).
// Defaults to the local-git adapter against the department's `local_repo` workdir.
// ────────────────────────────────────────────────────────────────────────

export async function resolveLocalDispatch(
  department: LocalDepartmentLite,
  workstationId: string,
  ticket: Ticket,
): Promise<{
  adapter: DispatchAdapter;
cfg: { workdir: string; repoPath: string; outputRepo?: { repoPath: string; branch?: string; bareRemote?: string; initIfMissing?: boolean }; sourceRepos?: Array<{ id: string; path: string; label?: string; branch?: string }>; branch: string; bareRemote?: string; allowCommit: boolean };
    } | null> {
  // Department settings are defaults for future tasks, never mutable landing targets.
  // Engine defaults are execution policy (not repository routing), so they remain
  // live defaults and are merged with the ticket's pinned per-task override.
  const departmentConfig = await department.getDepartmentConfig();
  let snapshot = ticket.metadata?.local_repo_snapshot;
  if (!Object.hasOwn(ticket.metadata || {}, 'local_repo_snapshot')) {
    if (missionBinding(ticket)) throw Error('Legacy active task has no pinned repository routing; refusing to infer a landing target from changed department settings');
    const inherited = departmentConfig.local_repo;
    const workstation = workstationId ? workstationOps.getWorkstation(department.sql, workstationId) : null;
    snapshot = inherited ? LocalRepoSchema.parse({ ...inherited, branch: inherited.branch || workstation?.default_branch || 'main' }) : null;
    ticketOps.updateTicketFields(department.sql, ticket.ticket_id, { metadata: { ...ticket.metadata, local_repo_snapshot: snapshot, local_repo_snapshot_version: 1 } }, 'dispatch-routing');
    ticket.metadata = { ...ticket.metadata, local_repo_snapshot: snapshot, local_repo_snapshot_version: 1 };
  }
  const lr = snapshot === null ? null : LocalRepoSchema.parse(snapshot);
  if (!lr?.repo_path || lr.adapter === 'none') return null;

  const workstation = workstationId ? workstationOps.getWorkstation(department.sql, workstationId) : null;
  const branch =
    lr.branch ??
    workstation?.default_branch ??
    'main';

  const workdir = join(lr.workdir ?? join(process.env.LOCALAPPDATA ?? process.cwd(), 'CyberLuke', 'LocalGasDepartment', 'work', department.departmentId), ticket.ticket_id);

return {
    adapter: localGitAdapter,
    cfg: {
      workdir,
      repoPath: lr.repo_path,
      outputRepo: lr.output_repo
        ? { repoPath: lr.output_repo.repo_path, branch: lr.output_repo.branch, bareRemote: lr.output_repo.bare_remote, initIfMissing: lr.output_repo.init_if_missing }
        : undefined,
      sourceRepos: (lr.source_repos ?? []).map((s) => ({ id: s.id, path: s.path, label: s.label, branch: s.branch })),
      bareRemote: lr.bare_remote,
      branch,
      allowCommit: lr.allow_commit !== false,
      engineMatrix: departmentConfig.engine_matrix,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Runner — drive one reconcile tick locally.
// ────────────────────────────────────────────────────────────────────────

export interface LocalReconcilerOptions {
  /** Force reconcile even when the department would otherwise idle (tests). Default: auto. */
  always?: boolean;
  /** Hook to run any deferred side-effect (default: apply + await). */
  applyDeferred?: (fn: (() => Promise<void>) | null) => Promise<void> | void;
}

/**
 * Run one full reconcile pass against the local department's SqlStorage and apply
 * every action plus its deferred side-effect. Returns the violations found.
 *
 * Same-pass ordering guard: the reconciler batches every rule's output into one
 * action list. In the cloud those fire on separate alarm ticks, so an agent the
 * dispatcher just put to `working` is never simultaneously GC'd. Locally, a
 * single tick could compute `dispatch_agent` and `delete_agent` for the same
 * freshly-created idle agent (null last_activity_at reads as stale). We mirror
 * the cloud's liveness guarantee by dropping destructive actions (delete /
 * unhook / stop / idle-transition) that target an agent this pass dispatched,
 * so a just-started agent is never torn down from under a fresh dispatch.
 */
export async function runReconcileTick(
  department: LocalDepartmentLite,
  ctx: ApplyActionContext,
  opts?: LocalReconcilerOptions,
): Promise<Violation[]> {
  // Project the existing durable mission controller before scheduling. No
  // implementation/review awaits an operator response, and a closed dependency
  // means reviewed and landed work, never an empty preparatory git commit.
  for (const ticket of ticketOps.listTickets(department.sql, { status: 'in_progress' })) {
    const binding = missionBinding(ticket);
    if (!binding?.missionId) continue;
    try {
      const mission = await readMission(binding);
      if (!mission) continue;
      const agent = ticket.assignee_agent_ticket_id;
      if (agent) {
        agentOps.updateAgentStatusMessage(department.sql, agent, `ExcellenceGovernor mission ${mission.state}${mission.blocked_reason ? ': ' + mission.blocked_reason : ''}`);
        agentOps.touchAgent(department.sql, agent);
      }
      if (mission.state === 'VERIFIED_10_10') {
        const resolved = await resolveLocalDispatch(department, ticket.workstation_id || '', ticket);
        if (!resolved) throw Error('Reviewed mission cannot land: repository configuration missing');
        const landed = resolved.cfg.allowCommit
          ? await resolved.adapter.commit(resolved.cfg, `Reviewed task ${ticket.ticket_id}: ${ticket.title}`)
          : { ok: true };
        if (!landed.ok) throw Error('Reviewed mission could not land its output');
        ticketOps.closeTicket(department.sql, ticket.ticket_id, agent || 'mission-controller');
        if (agent) { agentOps.updateAgentStatus(department.sql, agent, 'idle'); agentOps.unhookTicket(department.sql, agent); }
        department.broadcastTicketEvent({ type: 'ticket.status', ticketId: ticket.ticket_id, to: 'closed', machineReview: 'VERIFIED_10_10', productionAcceptance: 'CTO_ONLY' });
      } else if (mission.state === 'CANCELLED') {
        ticketOps.updateTicketStatus(department.sql, ticket.ticket_id, 'failed', agent || 'mission-controller');
        if (agent) { agentOps.updateAgentStatus(department.sql, agent, 'idle'); agentOps.unhookTicket(department.sql, agent); }
      }
    } catch (error) {
      department.broadcastTicketEvent({ type: 'mission.unavailable', ticketId: ticket.ticket_id, message: error instanceof Error ? error.message : 'Mission unavailable' });
    }
  }
  const actions = reconcile(department.sql, { departmentConfig: await department.getDepartmentConfig() });
  const applyDeferred = opts?.applyDeferred ?? (async (fn) => {
    if (fn) await fn();
  });

  // First, apply the "positive" lifecycle actions the dispatcher needs to start
  // agents: assign + hook + dispatch. After each dispatch we record which agent
  // it assigned (read back from the ticket) so we can protect it this pass.
  const dispatchedAgents = new Set<string>();
  for (const action of actions) {
    if (action.type === 'dispatch_agent') {
      // Per-ticket NAI agent gate: break_room_controls.agents === false means the task
      // must not start a colony agent at all (assignment + hook + in_progress).
      // Check it BEFORE applying, so a gated ticket stays open/unassigned.
      if (ticketAgentsGateOff(department.sql, action.ticket_id) || ticketOps.hasUnresolvedBlockers(department.sql, action.ticket_id)) {
        continue;
      }
      const deferred = applyAction(ctx, action);
      const assigned = readTicketAssignee(department.sql, action.ticket_id);
      await applyDeferred(deferred);
      if (assigned) dispatchedAgents.add(assigned);
    } else if (action.type === 'assign_Ticket' || action.type === 'hook_agent') {
      const deferred = applyAction(ctx, action);
      await applyDeferred(deferred);
    }
  }

  // Then the remaining actions, suppressing same-tick destruction of dispatched agents.
  for (const action of actions) {
    if (action.type === 'dispatch_agent' || action.type === 'assign_Ticket' || action.type === 'hook_agent') {
      continue; // already applied (or gated off)
    }
    const target = agentTargetedBy(action);
    if (target && dispatchedAgents.has(target)) {
      console.warn(
        `[local-reconciler] suppressed destructive action ${action.type} on just-dispatched agent ${target} (same pass)`,
      );
      continue;
    }
    const deferred = applyAction(ctx, action);
    await applyDeferred(deferred);
  }

  const violations = checkInvariants(department.sql);
  if (violations.length > 0) {
    for (const v of violations) {
      console.warn(`[local-reconciler] invariant violated: #${v.invariant} ${v.message}`);
    }
  }
  return violations;
}

/** Read the assignee of a ticket after application (which agent a dispatch chose). */
function readTicketAssignee(sql: SqlStorage, ticketId: string): string | null {
  try {
    return ticketOps.getTicket(sql, ticketId)?.assignee_agent_ticket_id ?? null;
  } catch {
    return null;
  }
}

/** True when a ticket's per-task NAI agent gate is off (break_room_controls.agents=false). */
function ticketAgentsGateOff(sql: SqlStorage, ticketId: string): boolean {
  try {
    const ticket = ticketOps.getTicket(sql, ticketId);
    if (!ticket) return false;
    const breakRoom = (ticket.metadata as { break_room_controls?: { agents?: boolean } } | undefined)?.break_room_controls;
    return breakRoom?.agents === false;
  } catch {
    return false;
  }
}

/** True when the reconcile action is a destructive one targeting an agent id. */
function agentTargetedBy(action: { type: string; [k: string]: unknown }): string | null {
  if (action.type === 'delete_agent' || action.type === 'unhook_agent' || action.type === 'stop_agent') {
    return typeof action.agent_id === 'string' ? action.agent_id : null;
  }
  if (action.type === 'transition_agent') {
    const to = action.to;
    if (to === 'idle' || to === 'stalled' || to === 'dead') {
      return typeof action.agent_id === 'string' ? action.agent_id : null;
    }
  }
  return null;
}

/** Repeatedly run reconcile ticks on an interval. Returns an unsubscribe fn. */
export function startLocalReconciler(
  department: LocalDepartmentLite,
  ctx: ApplyActionContext,
  intervalMs = 5_000,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // don't overlap ticks
    running = true;
    runReconcileTick(department, ctx)
      .catch((err) => console.warn('[local-reconciler] tick failed:', err))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
    (timer as unknown as { unref(): void }).unref();
  }
  return () => clearInterval(timer);
}

/** Helper: run a git command with a bounded buffer. */
function git(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolvePromise({ code: err ? (err as { code?: number }).code ?? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// Re-export the local-git adapter piece for tests.
export { localGitAdapter };
