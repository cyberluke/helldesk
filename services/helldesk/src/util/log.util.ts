/**
 * Structured logging powered by workers-tagged-logger.
 *
 * Uses AsyncLocalStorage so tags (departmentId, workstationId, userId, etc.) propagate
 * to all downstream functions without explicit parameter passing.
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

import { WorkersLogger, withLogTags } from 'workers-tagged-logger';

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

export const logger = new WorkersLogger<LogTags>();
export { withLogTags };
