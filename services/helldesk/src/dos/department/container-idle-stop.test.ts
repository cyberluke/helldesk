import { describe, it, expect, vi } from 'vitest';
import {
  stopContainerIfIdle,
  CONTAINER_IDLE_STOP_THRESHOLD_MS,
  CONTAINER_IDLE_STOP_THROTTLE_MS,
  type IdleStopDeps,
} from './container-idle-stop';

function makeFrontDesk(overrides: Partial<{ status: string; last_activity_at: string }> = {}) {
  return {
    id: 'front-desk-1',
    workstation_id: null,
    role: 'frontDesk' as const,
    name: 'FrontDesk',
    identity: 'FrontDesk@test',
    status: overrides.status ?? 'idle',
    current_hook_ticket_id: null,
    dispatch_attempts: 0,
    last_activity_at: overrides.last_activity_at ?? new Date().toISOString(),
    checkpoint: null,
    created_at: new Date().toISOString(),
    agent_status_message: null,
    agent_status_updated_at: null,
  };
}

type TestDeps = IdleStopDeps & {
  _stopFn: ReturnType<typeof vi.fn>;
  _getStateFn: ReturnType<typeof vi.fn>;
  _store: Map<string, number>;
  _events: Array<{ event: string; departmentId: string; reason: string; error?: string }>;
};

function makeDeps(overrides: Partial<IdleStopDeps> = {}): TestDeps {
  const stopFn = vi.fn().mockResolvedValue(undefined);
  const getStateFn = vi.fn().mockResolvedValue({ status: 'running' });
  const store = new Map<string, number>();
  const events: Array<{ event: string; departmentId: string; reason: string; error?: string }> = [];

  return {
    hasRunningAgents: overrides.hasRunningAgents ?? (() => false),
    isDraining: overrides.isDraining ?? (() => false),
    getFrontDesk: overrides.getFrontDesk ?? (() => null),
    getDepartmentId: overrides.getDepartmentId ?? (() => 'department-1'),
    getLastIdleStopAt:
      overrides.getLastIdleStopAt ?? (() => Promise.resolve(store.get('container:lastIdleStopAt'))),
    setLastIdleStopAt:
      overrides.setLastIdleStopAt ??
      ((value: number) => {
        store.set('container:lastIdleStopAt', value);
        return Promise.resolve();
      }),
    getContainerStub:
      overrides.getContainerStub ??
      (() => ({
        getState: getStateFn,
        stop: stopFn,
      })),
    writeEventFn:
      overrides.writeEventFn ??
      (data => {
        events.push(data);
      }),
    now: overrides.now ?? (() => Date.now()),
    _stopFn: stopFn,
    _getStateFn: getStateFn,
    _store: store,
    _events: events,
  } as TestDeps;
}

describe('stopContainerIfIdle', () => {
  it('does not stop while an agent is running', async () => {
    const deps = makeDeps({ hasRunningAgents: () => true });
    await stopContainerIfIdle(deps);
    expect(deps._stopFn).not.toHaveBeenCalled();
  });

  it('does not stop when draining', async () => {
    const deps = makeDeps({ isDraining: () => true });
    await stopContainerIfIdle(deps);
    expect(deps._stopFn).not.toHaveBeenCalled();
  });

  it('does not stop when frontDesk is working', async () => {
    const deps = makeDeps({ getFrontDesk: () => makeFrontDesk({ status: 'working' }) });
    await stopContainerIfIdle(deps);
    expect(deps._stopFn).not.toHaveBeenCalled();
  });

  it('does not stop when frontDesk is stalled', async () => {
    const deps = makeDeps({ getFrontDesk: () => makeFrontDesk({ status: 'stalled' }) });
    await stopContainerIfIdle(deps);
    expect(deps._stopFn).not.toHaveBeenCalled();
  });

  it('does not stop when frontDesk last_activity_at is within threshold', async () => {
    const recentActivity = new Date(Date.now() - 60_000).toISOString();
    const deps = makeDeps({ getFrontDesk: () => makeFrontDesk({ last_activity_at: recentActivity }) });
    await stopContainerIfIdle(deps);
    expect(deps._stopFn).not.toHaveBeenCalled();
  });

  it('stops container when frontDesk idle beyond threshold and container is running', async () => {
    const oldActivity = new Date(
      Date.now() - CONTAINER_IDLE_STOP_THRESHOLD_MS - 60_000
    ).toISOString();
    const deps = makeDeps({ getFrontDesk: () => makeFrontDesk({ last_activity_at: oldActivity }) });
    await stopContainerIfIdle(deps);
    expect(deps._stopFn).toHaveBeenCalledTimes(1);
    expect(deps._events).toHaveLength(1);
    expect(deps._events[0].event).toBe('container.idle_stop');
    expect(deps._events[0].reason).toMatch(/^front_desk_idle_\d+m$/);
  });

  it('stops container when no frontDesk exists (no_active_work reason)', async () => {
    const deps = makeDeps({ getFrontDesk: () => null });
    await stopContainerIfIdle(deps);
    expect(deps._stopFn).toHaveBeenCalledTimes(1);
    expect(deps._events[0].reason).toBe('no_active_work');
  });

  it('stops container when container is healthy', async () => {
    const stopFn = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      getFrontDesk: () => null,
      getContainerStub: () => ({
        getState: vi.fn().mockResolvedValue({ status: 'healthy' }),
        stop: stopFn,
      }),
    });
    await stopContainerIfIdle(deps);
    expect(stopFn).toHaveBeenCalledTimes(1);
    expect(deps._events[0].reason).toBe('no_active_work');
  });

  it('does not stop when container is already stopped', async () => {
    const stopFn = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      getFrontDesk: () => null,
      getContainerStub: () => ({
        getState: vi.fn().mockResolvedValue({ status: 'stopped' }),
        stop: stopFn,
      }),
    });
    await stopContainerIfIdle(deps);
    expect(stopFn).not.toHaveBeenCalled();
  });

  it('throttles: calling twice within throttle window stops only once', async () => {
    const deps = makeDeps({ getFrontDesk: () => null });
    await stopContainerIfIdle(deps);
    expect(deps._stopFn).toHaveBeenCalledTimes(1);

    await stopContainerIfIdle(deps);
    expect(deps._stopFn).toHaveBeenCalledTimes(1);
  });

  it('allows stop again after throttle window passes', async () => {
    let currentTime = Date.now();
    const deps = makeDeps({
      getFrontDesk: () => null,
      now: () => currentTime,
    });
    await stopContainerIfIdle(deps);
    expect(deps._stopFn).toHaveBeenCalledTimes(1);

    currentTime += CONTAINER_IDLE_STOP_THROTTLE_MS + 1;
    await stopContainerIfIdle(deps);
    expect(deps._stopFn).toHaveBeenCalledTimes(2);
  });

  it('logs error and does not set throttle when stop() throws', async () => {
    const stopFn = vi.fn().mockRejectedValue(new Error('stop failed'));
    const deps = makeDeps({
      getFrontDesk: () => null,
      getContainerStub: () => ({
        getState: vi.fn().mockResolvedValue({ status: 'running' }),
        stop: stopFn,
      }),
    });
    await stopContainerIfIdle(deps);

    expect(deps._events).toHaveLength(1);
    expect(deps._events[0].error).toBe('stop failed');
    expect(deps._store.has('container:lastIdleStopAt')).toBe(false);
  });

  it('returns without stopping when departmentId is null', async () => {
    const deps = makeDeps({ getDepartmentId: () => null, getFrontDesk: () => null });
    await stopContainerIfIdle(deps);
    expect(deps._stopFn).not.toHaveBeenCalled();
  });

  it('returns without stopping when getState() throws', async () => {
    const stopFn = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      getFrontDesk: () => null,
      getContainerStub: () => ({
        getState: vi.fn().mockRejectedValue(new Error('rpc failed')),
        stop: stopFn,
      }),
    });
    await stopContainerIfIdle(deps);
    expect(stopFn).not.toHaveBeenCalled();
  });
});
