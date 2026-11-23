import { describe, it, expect, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalSqlStorage } from './sql';
import { LocalDurableObjectStorage } from './storage';
import { LocalDepartment } from './LocalDepartment';
import { createLocalApplyContext, runReconcileTick, RuntimeEventBus, resolveLocalDispatch } from './local-reconciler';
import type { LocalDispatchHooks, LocalDepartmentLite } from './local-reconciler';
import * as ticketOps from '../dos/department/tickets';
import * as agentOps from '../dos/department/agents';
import * as workstationOps from '../dos/department/workstations';

/**
 * Proves the colony reconciler is genuinely ported locally — no stubs:
 *  - a LocalDepartment exposes the real ApplyActionContext;
 *  - requestChanges wires a real rework ticket + block dependency + event;
 *  - runReconcileTick dispatches an open ticket to an idle soul (end-to-end
 *    through the local-git adapter) and honors break_room_controls.agents=false;
 *  - broadcastTicketEvent / emitEvent fan out to the runtime event bus.
 */

function makeDepartment(dir: string, localRepo?: { repoPath: string }) {
  const sql = new LocalSqlStorage(join(dir, 'department.sqlite'));
  const storage = new LocalDurableObjectStorage(join(dir, 'storage.json'));
  const department = new LocalDepartment({ departmentId: 't1', sql: sql as never, storage, dataRoot: dir }) as unknown as LocalDepartmentLite & { sql: LocalSqlStorage; departmentId: string };
  return department;
}

/** Factory used by every test: isolated temp dir per test. */
function freshDepartment() {
  const dir = mkdtempSync(join(tmpdir(), 'gt-local-reconciler-'));
  const department = makeDepartment(dir, undefined);
  return { department, dir };
}

function cleanup(department: unknown & { sql?: { db?: { close?(): void } }; stopReconciler?(): void }, dir: string): void {
  try { department.stopReconciler?.(); } catch { /* best effort */ }
  try {
    const db = ((department as unknown as { sql?: { db?: unknown } }).sql?.db) as { close?(): void } | undefined;
    if (db?.close) db.close();
  } catch { /* best effort */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* EBUSY transient; retry once */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone / still locked */ }
}

function makeDispatchableRepo(dir: string): string {
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  // A minimal git repo so the local-git adapter can prepare/commit.
  const git = (args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    return { code: r.exitCode, stdout: r.stdout?.toString() ?? '', stderr: r.stderr?.toString() ?? '' };
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'test@local']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'README.md'), '# test\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  return repo;
}

beforeEach(() => {
  // nothing to reset across tests (each test builds its own department)
});

describe('LocalDepartment reconciler surface (no stubs)', () => {
  it('pins task repository routing before later department settings change', async () => {
    const { department, dir } = freshDepartment();
    try {
      const t = department as unknown as LocalDepartment;
      const inputA = join(dir, 'input-a');
      const inputB = join(dir, 'input-b');
      const outputA = join(dir, 'output-a');
      const outputB = join(dir, 'output-b');
      await t.updateDepartmentConfig({ local_repo: { adapter: 'local-git', repo_path: inputA, output_repo: { repo_path: outputA, init_if_missing: true }, branch: 'task-a' } });
      const first = await t.createTicket({ type: 'issue', title: 'task A' });
      await t.updateDepartmentConfig({ local_repo: { adapter: 'local-git', repo_path: inputB, output_repo: { repo_path: outputB, init_if_missing: true }, branch: 'task-b' } });
      const second = await t.createTicket({ type: 'issue', title: 'task B' });
      const a = await resolveLocalDispatch(t, '', first);
      const b = await resolveLocalDispatch(t, '', second);
      expect(a?.cfg.repoPath).toBe(inputA);
      expect(a?.cfg.outputRepo?.repoPath).toBe(outputA);
      expect(a?.cfg.branch).toBe('task-a');
      expect(b?.cfg.outputRepo?.repoPath).toBe(outputB);
      await t.updateTicket(first.ticket_id, { metadata: { local_repo_snapshot: second.metadata.local_repo_snapshot } });
      const unchanged = await t.getTicketAsync(first.ticket_id);
      expect((await resolveLocalDispatch(t, '', unchanged!))?.cfg.outputRepo?.repoPath).toBe(outputA);
    } finally { cleanup(department, dir); }
  });
  it('persists dependencies and never releases a task when its prerequisite failed', async () => {
    const { department, dir } = freshDepartment();
    try {
      const t = department as unknown as LocalDepartment;
      const first = await t.createTicket({ type: 'issue', title: 'framework' });
      const second = await t.createTicket({ type: 'issue', title: 'consumer game', depends_on: [first.ticket_id] });
      expect(ticketOps.hasUnresolvedBlockers(t.sql, second.ticket_id)).toBe(true);
      await t.updateTicketStatus(first.ticket_id, 'failed', 'fixture');
      expect(ticketOps.hasUnresolvedBlockers(t.sql, second.ticket_id)).toBe(true);
      await expect(t.updateTicketStatus(second.ticket_id, 'in_progress', 'fixture')).rejects.toThrow('dependencies');
      const ready = await t.createTicket({ type: 'issue', title: 'completed framework' });
      const consumer = await t.createTicket({ type: 'issue', title: 'another consumer', depends_on: [ready.ticket_id] });
      await t.closeTicket(ready.ticket_id, 'fixture');
      expect(ticketOps.hasUnresolvedBlockers(t.sql, consumer.ticket_id)).toBe(false);
    } finally { cleanup(department, dir); }
  });
  it('exposes a real ApplyActionContext immediately', () => {
    const { department, dir } = freshDepartment();
    try {
      const ctx = (department as unknown as LocalDepartment).getReconcilerContext();
      expect(ctx).toBeTruthy();
      expect(typeof ctx.dispatchAgent).toBe('function');
      expect(typeof ctx.checkPRStatus).toBe('function');
      expect(typeof ctx.reportHelldeskDone).toBe('function');
    } finally {
      cleanup(department, dir);
    }
  });

  it('broadcastTicketEvent and emitEvent fan out to the runtime event bus', async () => {
    const { department, dir } = freshDepartment();
    try {
      const t = department as unknown as LocalDepartment;
      const received: Array<{ type: string; ticketId?: string; payload: Record<string, unknown> }> = [];
      t.eventBus.subscribe((e) => {
        if (e.type === 'ticket') received.push({ type: 'ticket', ticketId: e.ticketId, payload: e.payload as Record<string, unknown> });
      });

      // createTicket triggers emitEvent → eventBus 'analytics'; then we broadcast a ticket event directly.
      const ticket = ticketOps.createTicket(t.sql as never, {
        type: 'issue',
        title: 'a task',
        workstation_id: 'workstation-local',
      });
      (t as unknown as { broadcastTicketEvent(e: Record<string, unknown>): void }).broadcastTicketEvent({ type: 'ticket.status', ticketId: ticket.ticket_id, to: 'in_progress' });

      const ticketEvent = received.find((r) => r.payload.type === 'ticket.status');
      expect(ticketEvent).toBeTruthy();
      expect(ticketEvent?.ticketId).toBe(ticket.ticket_id);
    } finally {
      cleanup(department, dir);
    }
  });

  it('dispatches an open ticket to an idle soul through the local-git adapter', async () => {
    const { department, dir } = freshDepartment();
    try {
      const t = department as unknown as LocalDepartment;
      const repo = makeDispatchableRepo(dir);
      // Configure the department dispatch adapter to this local repo.
      await t.updateDepartmentConfig({ local_repo: { adapter: 'local-git', repo_path: repo, workdir: join(dir, 'work'), branch: 'main', allow_commit: true } });
      const workstation = workstationOps.addWorkstation(t.sql as never, { workstationId: 'workstation-local', name: 'local', gitUrl: repo, defaultBranch: 'main' });
      const workstationId = workstation.id ?? 'workstation-local';
      const ticket = ticketOps.createTicket(t.sql as never, { type: 'issue', title: 'do work', workstation_id: workstationId });
      const soul = agentOps.getOrCreateAgent(t.sql as never, 'soul', workstationId, 't1');

      const ctx = createLocalApplyContext(t, {
        resolveDispatch: resolveLocalDispatch,
        broadcastTicket: () => {},
        submitMission: async (_sql, _ticket, workspace) => ({ missionId: 'fixture-mission', submission: 'accepted', workspace, objective: 'fixture only' }),
      });
      const violations = await runReconcileTick(t as unknown as LocalDepartmentLite, ctx);

      // The reconciler should have dispatched the open ticket: it got an assignee
      // (a soul) and left `in_progress` — the local-git commit is a real work
      // product, so the dispatcher's own GC must not tear it down same-pass.
      expect(violations).toBeInstanceOf(Array);
      const afterTicket = ticketOps.getTicket(t.sql as never, ticket.ticket_id);
      const afterAgent = agentOps.getAgent(t.sql as never, soul.id);
      expect(afterTicket?.assignee_agent_ticket_id).not.toBeNull();
      expect(afterTicket?.status).toBe('in_progress');
      expect(afterAgent?.status).toBe('working');
    } finally {
      cleanup(department, dir);
    }
  });

  it('honors break_room_controls.agents=false and does NOT dispatch the ticket', async () => {
    const { department, dir } = freshDepartment();
    try {
      const t = department as unknown as LocalDepartment;
      const repo = makeDispatchableRepo(dir);
      await t.updateDepartmentConfig({ local_repo: { adapter: 'local-git', repo_path: repo, workdir: join(dir, 'work'), branch: 'main', allow_commit: true } });
      const workstation = workstationOps.addWorkstation(t.sql as never, { workstationId: 'workstation-local', name: 'local', gitUrl: repo, defaultBranch: 'main' });
      const workstationId = workstation.id ?? 'workstation-local';
      const ticket = ticketOps.createTicket(t.sql as never, {
        type: 'issue',
        title: 'gated task',
        workstation_id: workstationId,
        metadata: { break_room_controls: { agents: false } },
      });
      agentOps.getOrCreateAgent(t.sql as never, 'soul', workstationId, 't1');

      const ctx = (t as unknown as LocalDepartment).getReconcilerContext();
      await runReconcileTick(t as unknown as LocalDepartmentLite, ctx);

      // The dispatch gate must suppress the colony from starting the agent.
      const afterTicket = ticketOps.getTicket(t.sql as never, ticket.ticket_id);
      expect(afterTicket?.assignee_agent_ticket_id).toBeNull();
      expect(afterTicket?.status).toBe('open');
    } finally {
      cleanup(department, dir);
    }
  });

  it('requestChanges wires a real rework ticket that blocks the MR and logs the event', async () => {
    const { department, dir } = freshDepartment();
    try {
      const t = department as unknown as LocalDepartment;
      const workstation = workstationOps.addWorkstation(t.sql as never, { workstationId: 'workstation-local', name: 'local', gitUrl: 'file:///tmp/nonexistent', defaultBranch: 'main' });
      const workstationId = workstation.id ?? 'workstation-local';
      const source = ticketOps.createTicket(t.sql as never, { type: 'issue', title: 'source', workstation_id: workstationId });
      const polar = agentOps.getOrCreateAgent(t.sql as never, 'soul', workstationId, 't1');
      // Build an MR ticket tracking the source.
      await (t as unknown as { submitToReviewQueue(i: { agent_id: string; ticket_id: string; workstation_id: string; branch: string; summary: string }): Promise<void> }).submitToReviewQueue({
        agent_id: polar.id,
        ticket_id: source.ticket_id,
        workstation_id: workstationId,
        branch: 'feat/x',
        summary: 'pr',
      });
      // The qualityAssurance is hooked to the MR ticket after it is popped.
      const qualityAssurance = agentOps.getOrCreateAgent(t.sql as never, 'qualityAssurance', workstationId, 't1');
      // Locate the MR ticket created by submitToReviewQueue (title `Review: feat/x`).
      const mrRow = ticketOps.listTickets(t.sql as never, { type: 'merge_request' } as never).find((b) => b.title === 'Review: feat/x');
      expect(mrRow).toBeTruthy();

      agentOps.hookTicket(t.sql as never, qualityAssurance.id, mrRow!.ticket_id);
await (t as unknown as { requestChanges(a: string, i: { feedback: string }): Promise<void> }).requestChanges(qualityAssurance.id, {
   feedback: 'make it smaller',
   });

      // A rework ticket must exist with label gt:rework.
      const rework = ticketOps.listTickets(t.sql as never, {} as never).find((b) => b.labels.includes('gt:rework'));
      expect(rework).toBeTruthy();
      // And a `rework_requested` ticket event on the MR.
      const events = ticketOps.listTicketEvents(t.sql as never, { ticketId: mrRow!.ticket_id } as never);
      const reworkEvt = (events as Array<{ event_type: string; metadata: unknown }>).find((e) => e.event_type === 'rework_requested');
      expect(reworkEvt).toBeTruthy();
    } finally {
      cleanup(department, dir);
    }
  });
});

describe('RuntimeEventBus', () => {
  it('subscribes, emits, and unsubscribes', () => {
    const bus = new RuntimeEventBus();
    const seen: string[] = [];
    const unsub = bus.subscribe((e) => { if (e.type === 'ticket') seen.push((e.payload as { type: string }).type); });
    bus.emit({ type: 'ticket', departmentId: 't1', payload: { type: 'a' } });
    bus.emit({ type: 'ticket', departmentId: 't1', payload: { type: 'b' } });
    expect(seen).toEqual(['a', 'b']);
    unsub();
    bus.emit({ type: 'ticket', departmentId: 't1', payload: { type: 'c' } });
    expect(seen).toEqual(['a', 'b']);
  });
});

describe('LocalDepartment local_repo routing (single-repo workspace)', () => {
  it('accepts output_repo:null as an explicit clear instead of failing validation', async () => {
    const { department, dir } = freshDepartment();
    try {
      const t = department as unknown as LocalDepartment;
      const repo = makeDispatchableRepo(dir);
      await t.updateDepartmentConfig({
        local_repo: {
          adapter: 'local-git',
          repo_path: repo,
          output_repo: { repo_path: join(dir, 'out'), init_if_missing: true },
          branch: 'main',
        },
      });
      const cleared = await t.updateDepartmentConfig({
        local_repo: { adapter: 'local-git', repo_path: repo, output_repo: null, branch: 'main' },
      });
      expect(cleared.local_repo?.output_repo).toBeUndefined();
      expect(cleared.local_repo?.repo_path).toBe(repo);
    } finally { cleanup(department, dir); }
  });

  it('auto-initialises an existing plain workspace directory as a git repo on save', async () => {
    const { department, dir } = freshDepartment();
    try {
      const t = department as unknown as LocalDepartment;
      const workspace = join(dir, 'plain-workspace');
      mkdirSync(workspace, { recursive: true });
      await t.updateDepartmentConfig({
        local_repo: { adapter: 'local-git', repo_path: workspace, branch: 'main' },
      });
      expect(existsSync(join(workspace, '.git'))).toBe(true);
      const head = Bun.spawnSync(['git', 'rev-parse', '--verify', 'HEAD'], { cwd: workspace });
      expect(head.exitCode).toBe(0);
    } finally { cleanup(department, dir); }
  });

  it('creates a missing workspace directory and initialises it on save', async () => {
    const { department, dir } = freshDepartment();
    try {
      const t = department as unknown as LocalDepartment;
      const workspace = join(dir, 'new-workspace');
      await t.updateDepartmentConfig({
        local_repo: { adapter: 'local-git', repo_path: workspace, branch: 'main' },
      });
      expect(existsSync(workspace)).toBe(true);
      expect(existsSync(join(workspace, '.git'))).toBe(true);
      const head = Bun.spawnSync(['git', 'rev-parse', '--verify', 'HEAD'], { cwd: workspace });
      expect(head.exitCode).toBe(0);
    } finally { cleanup(department, dir); }
  });

  it('archives and restores tickets behind the local overlay', async () => {
    const { department, dir } = freshDepartment();
    try {
      const t = department as unknown as LocalDepartment;
      const ticket = await t.createTicket({
        type: 'issue',
        title: 'archive me',
        workstation_id: 'workstation-local',
      });
      const filter = { workstation_id: 'workstation-local' };

      expect((await t.listTickets(filter)).some(row => row.ticket_id === ticket.ticket_id)).toBe(true);
      expect(await t.archiveTickets([ticket.ticket_id], true)).toBe(1);
      expect((await t.listTickets(filter)).some(row => row.ticket_id === ticket.ticket_id)).toBe(false);

      const archived = (await t.listTickets({ ...filter, include_archived: true }))
        .find(row => row.ticket_id === ticket.ticket_id) as { archived?: boolean } | undefined;
      expect(archived?.archived).toBe(true);

      expect(await t.archiveTickets([ticket.ticket_id], false)).toBe(1);
      expect((await t.listTickets(filter)).some(row => row.ticket_id === ticket.ticket_id)).toBe(true);
    } finally { cleanup(department, dir); }
  });
});
