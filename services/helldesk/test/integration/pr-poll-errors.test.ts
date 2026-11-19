/**
 * Integration tests for PR poll error discrimination (#3149).
 *
 * Tests verify that the poll_pr action handler correctly handles the
 * discriminated PRStatusOutcome: immediate-fail for no_token / non-transient
 * HTTP errors, 3-strike threshold for invalid_response / unrecognized_url /
 * host_mismatch, and 10-strike threshold for transient HTTP errors (5xx, 429).
 *
 * The no-token test runs fully end-to-end through the DO alarm. HTTP error
 * scenarios are covered by unit tests (test/unit/pr-poll-*.test.ts) since
 * mocking fetch is not practical in the Cloudflare Workers test runtime.
 */

import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getDepartmentStub(name = 'test-department') {
  const id = env.department.idFromName(name);
  return env.department.get(id);
}

describe('PR poll error discrimination (#3149)', () => {
  let department: ReturnType<typeof getDepartmentStub>;
  let departmentName: string;

  beforeEach(async () => {
    departmentName = `pr-poll-${crypto.randomUUID()}`;
    department = getDepartmentStub(departmentName);
    await department.setDepartmentId(departmentName);
  });

  async function setupMrTicketWithPrUrl(prUrl: string) {
    await department.addWorkstation({
      workstationId: 'workstation-1',
      name: 'main-workstation',
      gitUrl: 'https://github.com/test/repo.git',
      defaultBranch: 'main',
    });

    const result = await department.slingShift({
      workstationId: 'workstation-1',
      shiftTitle: 'PR Poll Test',
      tasks: [{ title: 'Task 1' }],
    });

    await runDurableObjectAlarm(department);

    const ticketId = result.tickets[0].ticket.ticket_id;
    const ticket = await department.getTicketAsync(ticketId);
    const agentId = ticket!.assignee_agent_ticket_id!;
    expect(agentId).toBeTruthy();

    await department.agentDone(agentId, {
      branch: 'gt/soul/test-branch',
      summary: 'Completed task',
    });

    await runDurableObjectAlarm(department);

    const allMrs = await department.listTickets({ type: 'merge_request' });
    const mrTicket = allMrs.find(b => b.metadata?.source_ticket_id === ticketId);
    expect(mrTicket).toBeTruthy();

    // Set the PR URL and put the MR ticket back to in_progress so the
    // reconciler will schedule a poll_pr action on the next alarm tick.
    await department.updateTicket(
      mrTicket!.ticket_id,
      {
        metadata: {
          ...(mrTicket!.metadata ?? {}),
          pr_url: prUrl,
        },
      },
      'system'
    );
    await department.updateTicketStatus(mrTicket!.ticket_id, 'in_progress', 'system');

    return { ticketId, mrTicketId: mrTicket!.ticket_id, agentId, shiftId: result.shift.id };
  }

  describe('no_token: department with no GitHub token', () => {
    it('should fail the MR ticket immediately (1 strike) with failureKind "no_token"', async () => {
      // Department is set up with no git_auth, so resolveGitHubToken will return
      // { ok: false, tried: [...] } and checkPRStatus will return a no_token error.
      const { mrTicketId } = await setupMrTicketWithPrUrl('https://github.com/test/repo/pull/1');

      // Run alarm — the reconciler should generate a poll_pr action, which
      // calls checkPRStatus and gets a no_token error. Since no_token is an
      // immediate-fail error, the ticket should fail on the first poll.
      await runDurableObjectAlarm(department);

      const mrTicket = await department.getTicketAsync(mrTicketId);
      expect(mrTicket?.status).toBe('failed');
      expect(mrTicket?.metadata?.failureReason).toBe('pr_poll_failed');
      expect(mrTicket?.metadata?.failureKind).toBe('no_token');
      expect(mrTicket?.metadata?.failureMessage).toContain('No GitHub token resolved');
      expect(mrTicket?.metadata?.failureMessage).toContain('department.git_auth.github_token');
      expect(mrTicket?.metadata?.failureMessage).toContain('department.github_cli_pat');
    });
  });
});
