/**
 * Tests for the "orphaned ticket_cancelled events retried forever" bug.
 *
 * Two independent fixes compose to eliminate the failure:
 *   Fix 1: deleteTicket / deleteTickets purge department_events rows that reference
 *          the deleted ticket (by ticket_id or agent_id), so the drain loop
 *          never sees them.
 *   Fix 2a: reconciler.applyEvent('ticket_cancelled') tolerates the ticket
 *          being missing (returns early, logs warn — does not throw).
 *   Fix 2b: the Department.do.ts drain loop recognises "Ticket/Agent ... not
 *          found" terminal errors and marks the offending event
 *          processed so it is not retried forever.
 */

import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getDepartmentStub(name: string) {
  return env.department.get(env.department.idFromName(name));
}

describe('department_events cleanup on ticket deletion (#fix-1)', () => {
  let department: ReturnType<typeof getDepartmentStub>;
  let departmentName: string;

  beforeEach(async () => {
    departmentName = `evcleanup-${crypto.randomUUID()}`;
    department = getDepartmentStub(departmentName);
    await department.setDepartmentId(departmentName);
    await department.addWorkstation({
      workstationId: 'workstation-1',
      name: 'main-workstation',
      gitUrl: 'https://github.com/test/repo.git',
      defaultBranch: 'main',
    });
  });

  it('deleteTicket removes pending department_events referencing the ticket by ticket_id', async () => {
    const ticket = await department.createTicket({
      type: 'issue',
      title: 'To be deleted',
      workstation_id: 'workstation-1',
    });

    // Transitioning to a terminal status enqueues a ticket_cancelled event.
    await department.updateTicketStatus(ticket.ticket_id, 'failed', 'system');

    const pendingBefore = (await department.debugDepartmentEvents()) as Array<{
      ticket_id: string | null;
      processed_at: string | null;
    }>;
    expect(
      pendingBefore.filter(e => e.ticket_id === ticket.ticket_id && e.processed_at === null).length
    ).toBeGreaterThan(0);

    await department.deleteTicket(ticket.ticket_id);

    const pendingAfter = (await department.debugDepartmentEvents()) as Array<{
      ticket_id: string | null;
      agent_id: string | null;
    }>;
    expect(pendingAfter.some(e => e.ticket_id === ticket.ticket_id || e.agent_id === ticket.ticket_id)).toBe(
      false
    );
  });

  it('deleteTicket also removes events referencing the ticket as agent_id (agents are tickets)', async () => {
    const agent = await department.registerAgent({
      role: 'soul',
      name: 'P1',
      identity: `ev-agent-${departmentName}`,
      workstation_id: 'workstation-1',
    });

    // Upsert a container_status event keyed by agent_id — this is the shape
    // of events that hang off an agent's ticket row.
    await department.debugRecordContainerStatus(agent.id, { status: 'running' });

    const beforeRows = (await department.debugDepartmentEvents()) as Array<{ agent_id: string | null }>;
    expect(beforeRows.some(e => e.agent_id === agent.id)).toBe(true);

    // deleteTicket is used for agents too (agents are tickets).
    await department.deleteTicket(agent.id);

    const afterRows = (await department.debugDepartmentEvents()) as Array<{ agent_id: string | null }>;
    expect(afterRows.some(e => e.agent_id === agent.id)).toBe(false);
  });

  it('deleteTickets bulk path removes events for every deleted ticket', async () => {
    const a = await department.createTicket({ type: 'issue', title: 'A', workstation_id: 'workstation-1' });
    const b = await department.createTicket({ type: 'issue', title: 'B', workstation_id: 'workstation-1' });

    await department.updateTicketStatus(a.ticket_id, 'failed', 'system');
    await department.updateTicketStatus(b.ticket_id, 'failed', 'system');

    const before = (await department.debugDepartmentEvents()) as Array<{ ticket_id: string | null }>;
    expect(before.filter(e => e.ticket_id === a.ticket_id).length).toBeGreaterThan(0);
    expect(before.filter(e => e.ticket_id === b.ticket_id).length).toBeGreaterThan(0);

    await department.deleteTickets([a.ticket_id, b.ticket_id]);

    const after = (await department.debugDepartmentEvents()) as Array<{ ticket_id: string | null }>;
    expect(after.some(e => e.ticket_id === a.ticket_id)).toBe(false);
    expect(after.some(e => e.ticket_id === b.ticket_id)).toBe(false);
  });
});

describe('applyEvent tolerance + drain loop marks missing-entity events processed (#fix-2)', () => {
  let department: ReturnType<typeof getDepartmentStub>;
  let departmentName: string;

  beforeEach(async () => {
    departmentName = `evtolerate-${crypto.randomUUID()}`;
    department = getDepartmentStub(departmentName);
    await department.setDepartmentId(departmentName);
    await department.addWorkstation({
      workstationId: 'workstation-1',
      name: 'main-workstation',
      gitUrl: 'https://github.com/test/repo.git',
      defaultBranch: 'main',
    });
  });

  it('drain loop marks a ticket_cancelled event processed when the ticket is gone', async () => {
    // Simulate the historical orphan: enqueue a ticket_cancelled event whose
    // ticket has been deleted (or never existed). Before Fix 2, applyEvent
    // would throw `Ticket <id> not found` forever on every alarm tick.
    await department.debugInsertDepartmentEvent({
      event_type: 'ticket_cancelled',
      ticket_id: '00000000-0000-4000-8000-000000000001',
      payload: { cancel_status: 'failed' },
    });

    const beforeDrain = (await department.debugDepartmentEvents()) as Array<{
      event_type: string;
      ticket_id: string | null;
      processed_at: string | null;
    }>;
    const orphan = beforeDrain.find(
      e => e.event_type === 'ticket_cancelled' && e.ticket_id === '00000000-0000-4000-8000-000000000001'
    );
    expect(orphan?.processed_at).toBeNull();

    await runDurableObjectAlarm(department);

    // After the alarm, the orphan event should be processed — not retried.
    const afterDrain = (await department.debugDepartmentEvents()) as Array<{
      event_type: string;
      ticket_id: string | null;
      processed_at: string | null;
    }>;
    const orphanAfter = afterDrain.find(
      e => e.event_type === 'ticket_cancelled' && e.ticket_id === '00000000-0000-4000-8000-000000000001'
    );
    // If retention GC already pruned it, that's also acceptable — the key
    // invariant is that it is no longer pending.
    if (orphanAfter) {
      expect(orphanAfter.processed_at).not.toBeNull();
    }
  });

  it('drain loop marks an agent-missing event processed too', async () => {
    await department.debugInsertDepartmentEvent({
      event_type: 'agent_done',
      agent_id: '00000000-0000-4000-8000-0000000000aa',
      payload: { branch: 'gt/ghost' },
    });

    await runDurableObjectAlarm(department);

    const after = (await department.debugDepartmentEvents()) as Array<{
      event_type: string;
      agent_id: string | null;
      processed_at: string | null;
    }>;
    const orphanAfter = after.find(
      e => e.event_type === 'agent_done' && e.agent_id === '00000000-0000-4000-8000-0000000000aa'
    );
    if (orphanAfter) {
      expect(orphanAfter.processed_at).not.toBeNull();
    }
  });
});
