/**
 * Async, non-blocking git runner used by the daemon's hot path.
 *
 * The mission loop runs in a long-lived single-threaded daemon whose event loop
 * must NEVER block (keep-alives, SSE /v1/missions progress, and tunneled
 * connections all depend on it). `spawnSync('git')` froze that loop for up to
 * the child timeout on every fingerprint/snapshot. This module provides an
 * async, Fluent API: an `IAsyncGit` gather-and-run helper returns a promise and
 * yields the event loop while the child drains.
 */
import { spawn } from 'node:child_process';

export interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Run `git <args>` in `cwd` without blocking. Resolves on exit or timeout kill. */
export function gitAsync(cwd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<GitResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<GitResult>((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout?.on('data', (c) => { stdout += c.toString(); });
    child.stderr?.on('data', (c) => { stderr += c.toString(); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
      resolve({ ok: false, code: null, stdout, stderr, error: `git ${args.slice(0, 2).join(' ')} timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.on('error', (e) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr, error: e.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

/** Fluent, non-blocking git: `.in(cwd).run(...)` → Promise<string> (empty on failure). */
export class FluentGit {
  private cwd: string;
  private constructor(cwd: string) { this.cwd = cwd; }
  static in(cwd: string): FluentGit { return new FluentGit(cwd); }
  get _() { return this; }
  /** Run args and return trimmed stdout, empty string on non-zero exit/error. */
  async run(...argsRaw: (string | string[])[]): Promise<string> {
    const args = argsRaw.flat();
    const r = await gitAsync(this.cwd, args);
    return r.ok ? r.stdout : '';
  }
  /** Run args and return the full GitResult (caller inspects status/error). */
  async raw(...argsRaw: (string | string[])[]): Promise<GitResult> {
    return gitAsync(this.cwd, argsRaw.flat());
  }
  /** Chain: `.in(dir).run('rev-parse','HEAD')` */
  static async runIn(cwd: string, ...args: string[]): Promise<string> {
    return new FluentGit(cwd).run(args);
  }
}

export { DEFAULT_TIMEOUT_MS };