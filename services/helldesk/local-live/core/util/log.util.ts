/**
 * Structured logging.
 *
 * Uses AsyncLocalStorage so tags (departmentId, workstationId, userId, etc.) propagate
 * to all downstream functions without explicit parameter passing.
 *
 * Locally there is no `workers-tagged-logger` (a Cloudflare workers lib that
 * is not installed in this fork), so this provides a small drop-in
 * implementation with the same surface the domain uses:
 *   - `logger.setTags({ departmentId })` to tag all subsequent logs;
 *   - `logger.info/warn/error/debug` that emit a single line with tags;
 *   - `withLogTags(tags, fn)` to scope tags to an async block.
 *
 * Setup:
 *   - In the Hono worker: use `useWorkersLogger` middleware to establish context.
 *   - In DOs: wrap the entry point (alarm, RPC) with `withLogTags`.
 *   - Anywhere: call `logger.setTags({ departmentId })` to tag all subsequent logs.
 *
 * Usage:
 *   import { logger } from '../util/log.util';
 *   logger.info('configureWorkstation: stored token');
 *   logger.warn('ensureFrontDesk: no kilocodeToken', { userId });
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type LogTags = {
  source?: string;
  departmentId?: string;
  workstationId?: string;
  userId?: string;
  orgId?: string;
  agentId?: string;
  ticketId?: string;
  shiftId?: string;
};

/** Async-scoped tag store so nested calls inherit the caller's tags. */
const tagStore = new AsyncLocalStorage<Partial<LogTags>>();

function currentTags(): Partial<LogTags> {
  return tagStore.getStore() ?? {};
}

function format(level: string, message: string, meta?: unknown): string {
  const tags = currentTags();
  const tagStr = Object.keys(tags).length
    ? ' ' + JSON.stringify(tags)
    : '';
  const metaStr = meta !== undefined ? ' ' + (typeof meta === 'string' ? meta : JSON.stringify(meta)) : '';
  return `[${level}]${tagStr} ${message}${metaStr}`;
}

/**
 * Drop-in `WorkersLogger` replacing `workers-tagged-logger` locally. The
 * `setTags` call sets tags for the current async context (propagated down).
 */
export class WorkersLogger<T extends LogTags = LogTags> {
  setTags(tags: Partial<T>): this {
    tagStore.enterWith({ ...currentTags(), ...tags } as Partial<LogTags>);
    return this;
  }
  info(message: string, meta?: unknown): void { console.log(format('info', message, meta)); }
  warn(message: string, meta?: unknown): void { console.warn(format('warn', message, meta)); }
  error(message: string, meta?: unknown): void { console.error(format('error', message, meta)); }
  debug(message: string, meta?: unknown): void { console.debug(format('debug', message, meta)); }
}

/** Run an async function with an extra set of log tags applied around it. */
export function withLogTags<T>(tags: Partial<LogTags>, fn: () => Promise<T>): Promise<T>;
export function withLogTags<T>(tags: Partial<LogTags>, fn: () => T): T;
export function withLogTags<T>(tags: Partial<LogTags>, fn: () => T | Promise<T>): T | Promise<T> {
  const merged = { ...currentTags(), ...tags };
  return tagStore.run(merged, () => fn());
}

export const logger = new WorkersLogger<LogTags>();