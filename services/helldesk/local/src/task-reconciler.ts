import type { Db } from './db';
import { now } from './ids';
import { observe, type GitSnapshot } from './git-observer';

/**
 * Service-owned Task Reconcile Engine.
 *
 * Authoritative owner of task epochs, completion eligibility and review
 * dispatch. Consumes event-journal entries (already durably accepted) and
 * drives the `task_epochs` table. NEVER runs in the Kilo plugin.
 *
 * Rules (all persisted in SQLite so a daemon/IDE crash never erases state):
 *  1. `chat.message`/`turn.started` starts/refreshes a task epoch + Git baseline.
 *  2. `file.edited`/`tool.execute.after`/`session.diff` mark work observed and
 *     refresh the activity clock.
 *  3. `tool.execute.before` opens a tool slot; `tool.execute.after` closes it.
 *  4. `session.status` with `status==='idle'` (or `session.idle`) is advisory
 *     only; eligibility requires workSeen AND assistantDelivered AND no running
 *     tools AND a bounded quiet period with no further activity.
 *  5. Enqueue is deduped on (taskEpochId, snapshotFingerprint, policyVersion)
 *     via a single SQLite transaction; a duplicate returns the existing job.
 */

export interface ReconcileOptions {
  debounceMs: number;
  /** Live-deref'd quiet window: a number, or a getter so a runtime config change
   *  takes effect on the next quiet-eligibility evaluation without a restart. */
  quietMs: number | (() => number);
  policyVersion: string;
  enqueue: (meta: {
    sessionId: string;
    epochId: string;
    workspaceRoot: string;
    baselineHead?: string;
    dirtyHash?: string;
    source: string;
  }) => Promise<{ jobId: string } | undefined>;
}

export class TaskReconciler {
  private opts: ReconcileOptions;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private sessionQueues = new Map<string, Promise<void>>();

  constructor(opts: ReconcileOptions) {
    this.opts = opts;
  }

  /** Resolve the live quiet-window value. */
  private quietMs(): number {
    return typeof this.opts.quietMs === 'function' ? this.opts.quietMs() : this.opts.quietMs;
  }

  /** Feed a durable event (journal row) into the reconciler. Serialized per-session. */
  async ingest(d: Db, ev: {
    hostId: string;
    sessionId?: string;
    eventId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const sessionId = ev.sessionId;
    if (!sessionId) return;
    const key = ev.hostId + ':' + sessionId;
    const prev = this.sessionQueues.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      await this.applyEvent(d, ev.hostId, sessionId, key, ev.eventType, ev.payload);
    }).catch((err) => {
      // Never let one bad event poison the session queue.
      console.error(`[helldesk-reconciler] ${ev.eventType} ${sessionId} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.sessionQueues.set(key, next);
    await next;
  }

  private async applyEvent(d: Db, hostId: string, sessionId: string, key: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
    if (eventType === 'chat.message' || eventType === 'turn.started') {
      await this.beginTurn(d, hostId, sessionId, key, payload);
    } else if (eventType === 'file.edited') {
      await this.observeActivity(d, hostId, sessionId, key, true);
    } else if (eventType === 'tool.execute.before' || eventType === 'tool.started') {
      // Canonical v1 vocabulary is tool.execute.*. Accept the legacy aliases
      // during rolling upgrades so an older plugin cannot strand an epoch.
      await this.toolOpen(d, hostId, sessionId, key);
    } else if (eventType === 'tool.execute.after' || eventType === 'tool.completed') {
      await this.toolClose(d, hostId, sessionId, key);
    } else if (eventType === 'session.diff') {
      await this.observeActivity(d, hostId, sessionId, key, false);
    } else if (eventType === 'session.status' || eventType === 'session.idle') {
      const status = String(payload.status ?? '').toLowerCase();
      const isIdle = eventType === 'session.idle' || status === 'idle';
      await this.observeIdle(d, hostId, sessionId, key, isIdle);
    }
  }

  private async beginTurn(d: Db, hostId: string, sessionId: string, key: string, payload: Record<string, unknown>): Promise<void> {
    // Find current open epoch; new prompt after quiet = new epoch.
    const open = d.db
      .query<{ epoch_id: string; epoch_no: number; last_activity_at: string | null; state: string }, [string, string]>(
        `SELECT epoch_id, epoch_no, last_activity_at, state FROM task_epochs
         WHERE host_id=? AND session_id=? AND state IN ('open','running','quiet')
         ORDER BY epoch_no DESC LIMIT 1`
      )
      .get(hostId, sessionId);
    const nowIso = now();
    const quietMs = this.quietMs();
    let startNew = true;
    if (open) {
      const lastAct = open.last_activity_at ? Date.parse(open.last_activity_at) : 0;
      if (open.state === 'open' && nowIso && (isNaN(lastAct) || Date.now() - lastAct < quietMs)) {
        startNew = false;
      }
    }
    if (!startNew && open) {
      d.db.query(`UPDATE task_epochs SET last_activity_at=?, source='chat.message' WHERE epoch_id=?`).run(nowIso, open.epoch_id);
      return;
    }
    const epochNo = (open?.epoch_no ?? 0) + 1;
    const epochId = `${hostId}:${sessionId}:${epochNo}`;
    const workspaceRoot = String(payload.workspaceRoot ?? '');
    // Insert epoch synchronously (never await Git on the ingest hot path);
    // baseline fills in async via the cached Git observer.
    d.db
      .query(
        `INSERT OR IGNORE INTO task_epochs (epoch_id, host_id, session_id, epoch_no, baseline_head, baseline_taken_at, state, work_observed, last_activity_at, source, workspace_root)
         VALUES (?, ?, ?, ?, NULL, NULL, 'open', 0, ?, 'chat.message', ?)`
      )
      .run(epochId, hostId, sessionId, epochNo, nowIso, workspaceRoot || null);
    // Async baseline capture (cached observer; does not block the event path).
    const snap = workspaceRoot ? await observe(workspaceRoot).catch(() => undefined) : undefined;
    if (snap?.head) {
      d.db.query(`UPDATE task_epochs SET baseline_head=?, baseline_taken_at=? WHERE epoch_id=?`).run(snap.head, nowIso, epochId);
    }
  }

  private async observeActivity(d: Db, hostId: string, sessionId: string, key: string, isFileEdit: boolean): Promise<void> {
    const ep = this.openEpoch(d, hostId, sessionId);
    if (!ep) return;
    const nowIso = now();
    d.db
      .query(`UPDATE task_epochs
              SET work_observed=1, state='running', last_activity_at=?,
                  assistant_delivered=0, quiet_deadline_at=NULL
              WHERE epoch_id=?`)
      .run(nowIso, ep.epoch_id);
    this.cancelTimer(key);
  }

  private async toolOpen(d: Db, hostId: string, sessionId: string, key: string): Promise<void> {
    const ep = this.openEpoch(d, hostId, sessionId);
    if (!ep) return;
    d.db.query(`UPDATE task_epochs
                SET tools_running=tools_running+1, state='running',
                    last_activity_at=?, quiet_deadline_at=NULL
                WHERE epoch_id=?`).run(now(), ep.epoch_id);
    this.cancelTimer(key);
  }

  private async toolClose(d: Db, hostId: string, sessionId: string, key: string): Promise<void> {
    const ep = this.openEpoch(d, hostId, sessionId);
    if (!ep) return;
    d.db.query(`UPDATE task_epochs
                SET tools_running=MAX(0,tools_running-1), assistant_delivered=1,
                    state='running', last_activity_at=?, quiet_deadline_at=NULL
                WHERE epoch_id=?`).run(now(), ep.epoch_id);
    this.cancelTimer(key);
  }

  private openEpoch(d: Db, hostId: string, sessionId: string): { epoch_id: string } | undefined {
    const r = d.db
      .query<{ epoch_id: string }, [string, string]>(
        `SELECT epoch_id FROM task_epochs WHERE host_id=? AND session_id=? AND state IN ('open','running','quiet')
         ORDER BY epoch_no DESC LIMIT 1`
      )
      .get(hostId, sessionId);
    return r ?? undefined;
  }

  private async observeIdle(d: Db, hostId: string, sessionId: string, key: string, isIdle: boolean): Promise<void> {
    const ep = this.openEpoch(d, hostId, sessionId);
    if (!ep) return;
    const row = d.db
      .query<{ work_observed: number; tools_running: number; assistant_delivered: number; state: string }, [string]>(
        `SELECT work_observed, tools_running, assistant_delivered, state FROM task_epochs WHERE epoch_id=?`
      )
      .get(ep.epoch_id);
    if (!row) return;
    const quietMs = this.quietMs();
    if (isIdle) {
      const quietDeadline = new Date(Date.now() + quietMs).toISOString();
      d.db.query(`UPDATE task_epochs
                  SET state='quiet', last_activity_at=?, quiet_deadline_at=?,
                      eligibility_state='pending'
                  WHERE epoch_id=?`).run(now(), quietDeadline, ep.epoch_id);
    }
    this.cancelTimer(key);
    this.timers.set(key, setTimeout(() => {
      void this.maybeEnqueue(d, ep.epoch_id, hostId, sessionId, key);
    }, quietMs));
  }

  private cancelTimer(key: string): void { const t = this.timers.get(key); if (t) { clearTimeout(t); this.timers.delete(key); } }

  private async maybeEnqueue(d: Db, epochId: string, hostId: string, sessionId: string, key: string): Promise<void> {
    this.timers.delete(key);
    const row = d.db
      .query<{
        work_observed: number; tools_running: number; assistant_delivered: number;
        state: string; last_activity_at: string | null; baseline_head: string | null; workspace_root: string | null;
      }, [string]>(`SELECT work_observed, tools_running, assistant_delivered, state, last_activity_at, baseline_head, workspace_root FROM task_epochs WHERE epoch_id=?`)
      .get(epochId);
    if (!row || row.state !== 'quiet') return;

    const eligible = row.work_observed === 1 && row.assistant_delivered === 1 && row.tools_running === 0;
    if (!eligible) {
      d.db.query(`UPDATE task_epochs
                  SET eligibility_state='pending', eligibility_at=?
                  WHERE epoch_id=?`).run(now(), epochId);
      return;
    }

    // Claim this enqueue attempt before any async filesystem/Git work. The
    // periodic reconciler and the in-memory timer may race; only one wins.
    const claimed = d.db.query(
      `UPDATE task_epochs
       SET eligibility_state='enqueuing', eligibility_at=?
       WHERE epoch_id=? AND state='quiet'
         AND COALESCE(eligibility_state, 'pending') != 'enqueuing'`
    ).run(now(), epochId);
    if (Number(claimed.changes) !== 1) return;

    const workspaceRoot = row.workspace_root ?? '';
    try {
      const snap = workspaceRoot ? await observe(workspaceRoot) : undefined;
      await this.opts.enqueue({
        sessionId,
        epochId,
        workspaceRoot,
        baselineHead: row.baseline_head ?? undefined,
        source: 'session-idle',
      });
      void snap;

      // Completion is committed only AFTER a durable review job exists.
      d.db.query(`UPDATE task_epochs
                  SET state='complete', eligibility_state='eligible',
                      eligibility_at=?, complete_at=?, quiet_deadline_at=NULL
                  WHERE epoch_id=? AND state='quiet'`).run(now(), now(), epochId);
    } catch (err) {
      // Never convert an enqueue failure into a completed epoch. Persist a
      // retry deadline so daemon restart can resume the exact same task.
      const retryAt = new Date(Date.now() + Math.max(this.quietMs(), 5_000)).toISOString();
      d.db.query(`UPDATE task_epochs
                  SET eligibility_state='attribution_uncertain',
                      eligibility_at=?, quiet_deadline_at=?
                  WHERE epoch_id=? AND state='quiet'`).run(now(), retryAt, epochId);
      console.error(`[helldesk-reconciler] enqueue ${epochId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Durable retry sweep for quiet epochs whose enqueue timer was lost to a
   * process restart or whose previous enqueue attempt failed transiently. */
  async reconcilePending(d: Db): Promise<void> {
    // A process can die after claiming an epoch but before enqueue returns.
    // Re-open stale claims so crash recovery cannot strand the task forever.
    const staleClaimBefore = new Date(
      Date.now() - Math.max(this.quietMs() * 4, 30_000)
    ).toISOString();
    d.db.query(
      `UPDATE task_epochs
       SET eligibility_state='attribution_uncertain',
           quiet_deadline_at=COALESCE(quiet_deadline_at, ?)
       WHERE state='quiet'
         AND eligibility_state='enqueuing'
         AND (eligibility_at IS NULL OR eligibility_at <= ?)`
    ).run(now(), staleClaimBefore);

    const due = d.db
      .query<{ epoch_id: string; host_id: string; session_id: string }, [string]>(
        `SELECT epoch_id, host_id, session_id
         FROM task_epochs
         WHERE state='quiet'
           AND COALESCE(eligibility_state, 'pending') IN ('pending','eligible','attribution_uncertain')
           AND (quiet_deadline_at IS NULL OR quiet_deadline_at <= ?)
         ORDER BY COALESCE(quiet_deadline_at, last_activity_at) ASC
         LIMIT 100`
      )
      .all(now());
    for (const ep of due) {
      const key = ep.host_id + ':' + ep.session_id;
      await this.maybeEnqueue(d, ep.epoch_id, ep.host_id, ep.session_id, key);
    }
  }

  dispose(): void { for (const [, t] of this.timers) clearTimeout(t); this.timers.clear(); }
}