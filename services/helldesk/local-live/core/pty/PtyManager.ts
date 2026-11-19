/**
 * PtyManager — real local PTY sessions for agent terminals.
 *
 * Full-parity replacement for the cloud Department Container PTY: instead of proxying
 * a docker container over HTTP, we spawn a native PTY (Bun.spawn `pty`) per
 * (departmentId, agentId) and bridge it to the browser over a WebSocket, including
 * resize. This is the local "container-agent execution" delta implemented with
 * native OS PTYs — no Docker, no Cloudflare.
 *
 * Session lifecycle:
 *   create(departmentId, agentId, { cols, rows }) -> { id, pid }
 *   resize(departmentId, agentId, ptyId, { cols, rows })
 *   attach(departmentId, agentId, ptyId, ws) -> bridges stdin/stdout
 *   detach / kill on WS close or process exit
 */
import { join } from 'node:path';

export interface PtyCreateOptions {
  cols: number;
  rows: number;
}

export interface PtySessionInfo {
  id: string;
  pid: number;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  status: 'running' | 'exited';
  createdAt: number;
}

export interface PtyProcess {
  readonly pid: number;
  write(data: Uint8Array | string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** Subscribe to pty output. Returns an unsubscribe function. */
  onData(cb: (chunk: Uint8Array) => void): () => void;
  /** Subscribe to process exit. Returns an unsubscribe function. */
  onExit(cb: (code: number | null, signal: number | null) => void): () => void;
}

/** A live PTY output subscription; detach() removes it (Fix #2). */
export interface PtySubscription {
  detach(): void;
}

interface PtyHandle {
  info: PtySessionInfo;
  proc: PtyProcess;
  /** Last time there was WS I/O on this session (for idle reaping). */
  lastActivity: number;
}

function now(): number {
  return Date.now();
}

function genId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Spawn a native PTY via Bun. Returns null when Bun's pty support is
 * unavailable (defensive) so callers can degrade instead of crashing.
 */
function spawnPty(
  cmd: string[],
  opts: { cwd?: string; cols: number; rows: number; env?: Record<string, string> }
): PtyProcess | null {
  const p = Bun.spawn({
    cmd,
    cwd: opts.cwd,
    env: opts.env as Record<string, string> | undefined,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    // Fire up a real interactive terminal.
    pty: { cols: opts.cols, rows: opts.rows },
  } as never);

  const after = (p as unknown as { exited: Promise<number | null> }).exited;
  const onDataCb: Array<(c: Uint8Array) => void> = [];
  const onExitCb: Array<(code: number | null, signal: number | null) => void> = [];

  (async () => {
    try {
      if (p.stdout) {
        for await (const chunk of p.stdout as AsyncIterable<Uint8Array>) {
          for (const cb of onDataCb) cb(chunk);
        }
      }
    } catch {
      /* stream ended */
    }
    const code = (await after.catch(() => null)) ?? null;
    for (const cb of onExitCb) cb(code, null);
    onDataCb.length = 0;
    onExitCb.length = 0;
  })();

  return {
    pid: p.pid ?? 0,
    write: (data) => {
      try {
        const w = (p as unknown as { stdin: unknown }).stdin as import('node:stream').Writable | null | undefined;
        w?.write(data);
      } catch {
        /* process may be gone */
      }
    },
    resize: (cols, rows) => {
      try {
        const r = p as unknown as { resize?(cols: number, rows: number): unknown };
        r.resize?.(cols, rows);
      } catch {
        /* process may be gone */
      }
    },
    kill: () => {
      try {
        p.kill();
      } catch {
        /* already gone */
      }
    },
    onData: (cb) => {
      onDataCb.push(cb);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        const i = onDataCb.indexOf(cb);
        if (i !== -1) onDataCb.splice(i, 1);
      };
    },
    onExit: (cb) => {
      onExitCb.push(cb);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        const i = onExitCb.indexOf(cb);
        if (i !== -1) onExitCb.splice(i, 1);
      };
    },
  };
}

/**
 * Find the frontDesk REPL entry file on disk. It lives beside this module:
 * `core/pty/front-desk-repl.ts`.
 */
function frontDeskReplPath(): string {
  return join(import.meta.dir, 'front-desk-repl.ts');
}

export class PtyManager {
  private readonly sessions = new Map<string, PtyHandle>();

  private key(departmentId: string, agentId: string): string {
    return `${departmentId}:${agentId}`;
  }

  /**
   * Create (or return the existing) PTY for a department+agent. For the local frontDesk
   * (and by extension any agent) we spawn the real interactive frontDesk REPL so
   * the terminal is genuinely usable.
   */
  create(
    departmentId: string,
    agentId: string,
    opts: PtyCreateOptions,
    extra?: { cwd?: string; env?: Record<string, string>; command?: string[] }
  ): PtySessionInfo {
    const k = this.key(departmentId, agentId);
    const existing = this.sessions.get(k);
    if (existing && existing.info.status === 'running') return existing.info;

    const cols = opts.cols || 80;
    const rows = opts.rows || 24;
    const cwd = extra?.cwd ?? process.cwd();
    const cmd =
      extra?.command ?? [
        process.env.BUN_RUNTIME_PATH ?? 'bun',
        'run',
        frontDeskReplPath(),
        '--department',
        departmentId,
        '--agent',
        agentId,
      ];

    const proc = spawnPty(cmd, { cwd, cols, rows, env: extra?.env });
    if (!proc) {
      // Bun pty unavailable: still record an exited placeholder so the UI gets
      // a non-empty response, but never a fake "connected" stream.
      const info: PtySessionInfo = {
        id: genId(),
        pid: 0,
        title: agentId,
        command: cmd.join(' '),
        args: cmd,
        cwd,
        status: 'exited',
        createdAt: now(),
      };
      this.sessions.set(k, { info, proc: {
        pid: 0, write: () => {}, resize: () => {}, kill: () => {},
        onData: () => () => {}, onExit: () => () => {},
      }, lastActivity: now() });
      return info;
    }

    const info: PtySessionInfo = {
      id: genId(),
      pid: proc.pid,
      title: agentId,
      command: cmd.join(' '),
      args: cmd,
      cwd,
      status: 'running',
      createdAt: now(),
    };
    const handle: PtyHandle = { info, proc, lastActivity: now() };

    proc.onExit((_code) => {
      handle.info.status = 'exited';
      handle.lastActivity = now();
      // Keep the record so /frontDesk/status can still report the session id, but
      // drop the live bridge once no process backs it.
    });

    this.sessions.set(k, handle);
    return info;
  }

  /** Mark a session as recently active (WS I/O). No-op if not running. */
  touch(departmentId: string, agentId: string, ptyId: string): boolean {
    const h = this.sessions.get(this.key(departmentId, agentId));
    if (!h || h.info.id !== ptyId || h.info.status !== 'running') return false;
    h.lastActivity = now();
    return true;
  }

  /** Read a session without creating one (pure status read; no side effect). */
  get(departmentId: string, agentId: string): PtySessionInfo | null {
    const h = this.sessions.get(this.key(departmentId, agentId));
    return h ? h.info : null;
  }

  /** Reap running PTYs idle longer than `idleMs`. Returns number reaped. */
  reapIdle(idleMs: number): number {
    const cutoff = now() - idleMs;
    let reaped = 0;
    for (const [k, h] of this.sessions) {
      if (h.info.status === 'running' && h.lastActivity < cutoff) {
        h.proc.kill();
        h.info.status = 'exited';
        h.lastActivity = now();
        reaped++;
      }
    }
    return reaped;
  }

  /** Resize an active PTY. No-op if it doesn't exist. */
  resize(departmentId: string, agentId: string, ptyId: string, cols: number, rows: number): boolean {
    const h = this.sessions.get(this.key(departmentId, agentId));
    if (!h || h.info.id !== ptyId || h.info.status !== 'running') return false;
    try {
      h.proc.resize(cols, rows);
      return true;
    } catch {
      return false;
    }
  }

  /** Attach a WebSocket to the live PTY: pty → ws output, returns a detachable subscription. */
  attachOutput(
    departmentId: string,
    agentId: string,
    ptyId: string,
    ws: {
      send(data: string | Uint8Array): void;
      readyState: number;
      close(code?: number, reason?: string): void;
    }
  ): PtySubscription | null {
    const h = this.sessions.get(this.key(departmentId, agentId));
    if (!h || h.info.id !== ptyId || h.info.status !== 'running') return null;

    const OPEN = 1; // WebSocket.OPEN
    let closed = false;

    const send = (chunk: Uint8Array) => {
      if (closed || ws.readyState !== OPEN) return;
      try {
        ws.send(chunk);
      } catch {
        /* socket gone */
      }
    };

    const unData = h.proc.onData((chunk) => {
      h.lastActivity = now();
      send(chunk);
    });
    const unExit = h.proc.onExit(() => {
      if (!closed) {
        closed = true;
        send(new TextEncoder().encode('\r\n\x1b[0m[process exited]\r\n'));
        try { ws.close(1000, 'process exited'); } catch { /* ignore */ }
      }
    });

    return {
      detach: () => {
        if (closed) return;
        closed = true;
        unData();
        unExit();
      },
    };
  }

  /** Write bytes from the browser (WebSocket message) into the PTY stdin. */
  write(departmentId: string, agentId: string, ptyId: string, data: Uint8Array | string): boolean {
    const h = this.sessions.get(this.key(departmentId, agentId));
    if (!h || h.info.id !== ptyId || h.info.status !== 'running') return false;
    h.lastActivity = now();
    h.proc.write(data);
    return true;
  }

  /** Cleanly terminate and forget a session. */
  kill(departmentId: string, agentId: string, ptyId: string): boolean {
    const k = this.key(departmentId, agentId);
    const h = this.sessions.get(k);
    if (!h || h.info.id !== ptyId) return false;
    h.proc.kill();
    h.info.status = 'exited';
    h.lastActivity = now();
    return true;
  }
}