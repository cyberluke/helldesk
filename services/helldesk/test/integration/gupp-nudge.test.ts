/**
 * Integration tests for GUPP nudge spam fix (#1412).
 *
 * Two bugs:
 * 1. send_nudge INSERT used SQLite's default datetime('now') format (space separator)
 *    while hasRecentNudge compared against JS toISOString() (T separator). The string
 *    comparison always failed, so every alarm tick emitted a new nudge.
 * 2. reconcileGUPP didn't exclude frontDesk agents. FrontDesk are permanently 'working' but
 *    only produce SDK events when the user chats, so they always triggered GUPP warn.
 */

import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getDepartmentStub(name = 'test-department') {
  const id = env.department.idFromName(name);
  return env.department.get(id);
}

describe('reconcileGUPP nudge fixes (#1412)', () => {
  let department: ReturnType<typeof getDepartmentStub>;
  let departmentName: string;

  beforeEach(async () => {
    departmentName = `gupp-nudge-${crypto.randomUUID()}`;
    department = getDepartmentStub(departmentName);
    await department.setDepartmentId(departmentName);
    await department.addWorkstation({
      workstationId: 'workstation-1',
      name: 'main-workstation',
      gitUrl: 'https://github.com/test/repo.git',
      defaultBranch: 'main',
    });
  });

  describe('frontDesk exclusion from GUPP', () => {
    it('should NOT nudge a frontDesk even when last_event_at is stale', async () => {
      // sendFrontDeskMessage auto-creates a frontDesk agent, but we can also use
      // ensureFrontDesk to get the frontDesk agent ID without needing a full container.
      const { agentId: frontDeskId } = await department.ensureFrontDesk();

      await department.updateAgentStatus(frontDeskId, 'working');

      // Set last_event_at to 20 min ago (exceeds 15-min warn threshold)
      const staleTimestamp = new Date(Date.now() - 20 * 60_000).toISOString();
      await department.touchAgentHeartbeat(frontDeskId, {
        lastEventType: 'assistant_message',
        lastEventAt: staleTimestamp,
        activeTools: [],
      });

      // Run alarm — reconciler should skip the frontDesk in GUPP
      await runDurableObjectAlarm(department);

      const nudges = await department.getPendingNudges(frontDeskId);
      const guppNudges = nudges.filter(n => n.source.startsWith('reconciler:'));
      expect(guppNudges).toHaveLength(0);
    });
  });

  describe('nudge dedup after timestamp fix', () => {
    it('should nudge a stale soul once, not on every alarm tick', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `gupp-dedup-${departmentName}`,
        workstation_id: 'workstation-1',
      });

      const ticket = await department.createTicket({
        type: 'issue',
        title: 'GUPP dedup test',
        workstation_id: 'workstation-1',
      });

      await department.hookTicket(agent.id, ticket.ticket_id);
      await department.updateAgentStatus(agent.id, 'working');

      // Set last_event_at to 20 min ago (exceeds 15-min warn threshold)
      const staleTimestamp = new Date(Date.now() - 20 * 60_000).toISOString();
      await department.touchAgentHeartbeat(agent.id, {
        lastEventType: 'tool_use',
        lastEventAt: staleTimestamp,
        activeTools: [],
      });

      // First alarm — should produce exactly one warn nudge
      await runDurableObjectAlarm(department);

      const nudgesAfterFirst = await department.getPendingNudges(agent.id);
      const warnNudges1 = nudgesAfterFirst.filter(n => n.source === 'reconciler:warn');
      expect(warnNudges1).toHaveLength(1);

      // Second alarm — hasRecentNudge should find the existing nudge and skip
      await runDurableObjectAlarm(department);

      const nudgesAfterSecond = await department.getPendingNudges(agent.id);
      const warnNudges2 = nudgesAfterSecond.filter(n => n.source === 'reconciler:warn');
      expect(warnNudges2).toHaveLength(1); // Still 1, not 2
    });
  });
});
