import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

/** Structured JSON logging, counters and a liveness/readiness view. */

export interface Telemetry {
  log(level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>): void;
  counters: {
    jobsEnqueued: number;
    jobsCompleted: number;
    jobsFailed: number;
    reviewsStarted: number;
    reviewsCompleted: number;
    stuckLeases: number;
    lastError: string | null;
  };
  snapshot(): {
    jobsEnqueued: number;
    jobsCompleted: number;
    jobsFailed: number;
    reviewsStarted: number;
    reviewsCompleted: number;
    stuckLeases: number;
    lastError: string | null;
    lastErrorAt: string | null;
  };
}

export function createTelemetry(opts?: { logDir?: string }): Telemetry {
  let logDir = opts?.logDir;
  const counters = {
    jobsEnqueued: 0,
    jobsCompleted: 0,
    jobsFailed: 0,
    reviewsStarted: 0,
    reviewsCompleted: 0,
    stuckLeases: 0,
    lastError: null as string | null,
  };
  let lastErrorAt: string | null = null;

  const scrub = (fields: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...fields };
    for (const [k, v] of Object.entries(out)) {
      if (/token|secret|apikey|api_key|authorization|password|credential/i.test(k) && typeof v === 'string') {
        out[k] = '[REDACTED]';
      }
    }
    return out;
  };

  return {
    counters,
    log(level, event, fields) {
      const entry = {
        ts: new Date().toISOString(),
        level,
        event,
        ...scrub(fields ?? {}),
      };
      if (level === 'error') {
        counters.lastError = event;
        lastErrorAt = new Date().toISOString();
      }
      if (logDir) {
        try {
          mkdirSync(logDir, { recursive: true });
          appendFileSync(join(logDir, `helldesk-${new Date().toISOString().slice(0, 10)}.log`), JSON.stringify(entry) + '\n');
        } catch { /* log failure is non-fatal */ }
      }
      // Also emit to stdout for local daemon console.
      if (level === 'error') console.error(JSON.stringify(entry));
      else console.log(JSON.stringify(entry));
    },
    snapshot() {
      return { ...counters, lastErrorAt };
    },
  };
}