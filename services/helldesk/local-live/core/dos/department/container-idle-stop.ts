/**
 * Proactive idle-container stop logic.
 *
 * Cloudflare's sleepAfter timer resets on any port-8080 traffic (including
 * long-lived PTY WebSockets), so containers can stay awake for hours after
 * all real work finishes. This module provides the decision logic for
 * stopping the container from the DepartmentDO alarm when the department is truly idle.
 */

import { logger } from '../../util/log.util';
import type { Agent } from '../../types';

export const CONTAINER_IDLE_STOP_THRESHOLD_MS = 5 * 60_000;
export const CONTAINER_IDLE_STOP_THROTTLE_MS = 2 * 60_000;

export type IdleStopDeps = {
  hasRunningAgents: () => boolean;
  isDraining: () => boolean;
  getFrontDesk: () => Agent | null;
  getDepartmentId: () => string | null;
  getLastIdleStopAt: () => Promise<number | undefined>;
  setLastIdleStopAt: (value: number) => Promise<void>;
  getContainerStub: (departmentId: string) => {
    getState: () => Promise<{ status: string }>;
    stop: () => Promise<void>;
  };
  writeEventFn: (data: { event: string; departmentId: string; reason: string; error?: string }) => void;
  now: () => number;
};

export async function stopContainerIfIdle(deps: IdleStopDeps): Promise<void> {
  if (deps.hasRunningAgents()) return;
  if (deps.isDraining()) return;

  const frontDesk = deps.getFrontDesk();
  const frontDeskAlive = frontDesk && (frontDesk.status === 'working' || frontDesk.status === 'stalled');
  if (frontDeskAlive) return;

  if (frontDesk && frontDesk.last_activity_at != null) {
    const lastActivity = new Date(frontDesk.last_activity_at).getTime();
    if (deps.now() - lastActivity <= CONTAINER_IDLE_STOP_THRESHOLD_MS) return;
  }

  const departmentId = deps.getDepartmentId();
  if (!departmentId) return;

  const now = deps.now();
  const lastIdleStop = (await deps.getLastIdleStopAt()) ?? 0;
  if (now - lastIdleStop < CONTAINER_IDLE_STOP_THROTTLE_MS) return;

  const stub = deps.getContainerStub(departmentId);
  let state: { status: string };
  try {
    state = await stub.getState();
  } catch (err) {
    logger.warn('stopContainerIfIdle: getState() failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (state.status !== 'running' && state.status !== 'healthy') return;

  const idleMinutes =
    frontDesk?.last_activity_at != null
      ? Math.round((deps.now() - new Date(frontDesk.last_activity_at).getTime()) / 60_000)
      : 0;
  const reason = frontDesk ? `front_desk_idle_${idleMinutes}m` : 'no_active_work';

  try {
    await stub.stop();
    await deps.setLastIdleStopAt(now);
    deps.writeEventFn({ event: 'container.idle_stop', departmentId, reason });
    logger.info('stopContainerIfIdle: stopped idle container', { reason });
  } catch (err) {
    logger.warn('stopContainerIfIdle: stop() failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    deps.writeEventFn({
      event: 'container.idle_stop',
      departmentId,
      reason,
      error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    });
  }
}
