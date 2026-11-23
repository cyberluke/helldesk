import { describe, it, expect } from 'bun:test';
import { isProjectedDupe, mergeLocalMissionState, missionBoardStatus, missionStateToStatus, projectMissionsIntoBoard } from './mission-reconcile';
import type { Ticket } from '../types';

function localTicket(id: string, missionId?: string): Ticket {
  return {
    ticket_id: id,
    type: 'issue',
    status: 'open',
    title: id,
    body: null,
    workstation_id: 'workstation-local',
    parent_ticket_id: null,
    assignee_agent_ticket_id: null,
    priority: 'medium',
    labels: [],
    metadata: missionId ? { local_mission: { missionId, submission: 'accepted' } } : {},
    created_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    closed_at: null,
    dispatch_attempts: 0,
    last_dispatch_attempt_at: null,
  } as Ticket;
}

function projected(row: { id: string; missionId: string; childOf?: string | null }): Ticket {
  return {
    ticket_id: row.id,
    type: 'shift',
    status: 'in_progress',
    title: row.id,
    body: null,
    workstation_id: null,
    parent_ticket_id: row.childOf ?? null,
    assignee_agent_ticket_id: null,
    priority: 'medium',
    labels: [],
    metadata: { is_mission: true, local_mission: { missionId: row.missionId, submission: 'accepted' } },
    created_by: 'engine',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    closed_at: null,
    dispatch_attempts: 0,
    last_dispatch_attempt_at: null,
  } as Ticket;
}

describe('isProjectedDupe — no-split-brain task dedup', () => {
  const ids = (rows: Ticket[]) => new Set(rows.map(r => r.ticket_id));

  it('folds the projected mission root when the local ticket is bound to that mission', () => {
    const local = [localTicket('d81473e8-1234', 'mis_c943')];
    const root = projected({ id: 'mis_c943', missionId: 'mis_c943' });
    expect(isProjectedDupe(root, local, ids([root]))).toBe(true);
  });

  it("folds a projected mission CHILD ticket bound to the same mission as a local ticket", () => {
    const local = [localTicket('d81473e8-1234', 'mis_c943')];
    const child = projected({ id: 'ticket_e14b', missionId: 'mis_c943', childOf: 'mis_c943' });
    expect(isProjectedDupe(child, local, ids([child, projected({ id: 'mis_c943', missionId: 'mis_c943' })]))).toBe(true);
  });

  it('folds a projected CHILD ticket into its projected mission ROOT (pure engine mission)', () => {
    const local: Ticket[] = [];
    const root = projected({ id: 'mis_c943', missionId: 'mis_c943' });
    const child = projected({ id: 'ticket_e14b', missionId: 'mis_c943', childOf: 'mis_c943' });
    const all = ids([root, child]);
    expect(isProjectedDupe(root, local, all)).toBe(false); // root stays
    expect(isProjectedDupe(child, local, all)).toBe(true);  // child folds
  });

  it('keeps a projected mission when there is NO local ticket bound to it (pure engine mission)', () => {
    const local = [localTicket('d81473e8-1234', 'mis_999')]; // different mission
    const other = projected({ id: 'mis_engine_only', missionId: 'mis_engine_only' });
    expect(isProjectedDupe(other, local, ids([other]))).toBe(false);
  });

  it('drops a projected row whose ticket_id collides exactly with a local ticket', () => {
    const local = [localTicket('same-id', 'mis_c943')];
    const sameId = projected({ id: 'same-id', missionId: 'mis_c943' });
    expect(isProjectedDupe(sameId, local, ids([sameId]))).toBe(true);
  });

  it('keeps a projected row with NO mission binding, no id collision, and no projected parent', () => {
    const local = [localTicket('d81473e8-1234', 'mis_c943')];
    const noBinding = {
      ...projected({ id: 'plain', missionId: 'mis_c943' }),
      metadata: { is_mission: true },
    };
    expect(isProjectedDupe(noBinding, local, ids([noBinding]))).toBe(false);
  });
});

describe('mergeLocalMissionState — live engine state wins over a backfilled snapshot', () => {
  it('closes a bound local ticket once the mission is human-accepted', () => {
    const local = localTicket('local-mis_1', 'mis_1');
    local.status = 'in_review';
    local.metadata = {
      local_mission: { missionId: 'mis_1', workspace: 'd:/ws', title: 'B1' },
      engine_state: 'VERIFIED_10_10',
      awaiting_human_acceptance: true,
    };
    const mission = projected({ id: 'mis_1', missionId: 'mis_1' });
    mission.status = 'closed';
    mission.metadata = {
      is_mission: true,
      local_mission: { missionId: 'mis_1', submission: 'accepted' },
      engine_state: 'VERIFIED_10_10',
      human_acceptance: 'accepted',
      human_accepted_at: '2026-11-22T00:00:00.000Z',
      awaiting_human_acceptance: false,
    };

    const [merged] = mergeLocalMissionState([local], [mission]);

    expect(merged.status).toBe('closed');
    expect((merged.metadata as Record<string, unknown>).human_acceptance).toBe('accepted');
    expect((merged.metadata as Record<string, unknown>).awaiting_human_acceptance).toBe(false);
    expect(((merged.metadata as Record<string, unknown>).local_mission as { workspace?: string }).workspace).toBe('d:/ws');
  });

  it('keeps the acceptance gate visible while the mission is unaccepted', () => {
    const local = localTicket('local-mis_2', 'mis_2');
    local.status = 'in_progress';
    const mission = projected({ id: 'mis_2', missionId: 'mis_2' });
    mission.status = 'in_review';
    mission.metadata = {
      is_mission: true,
      local_mission: { missionId: 'mis_2', submission: 'accepted' },
      engine_state: 'VERIFIED_10_10',
      awaiting_human_acceptance: true,
    };

    const [merged] = mergeLocalMissionState([local], [mission]);

    expect(merged.status).toBe('in_review');
    expect((merged.metadata as Record<string, unknown>).awaiting_human_acceptance).toBe(true);
  });

  it('leaves unbound local tickets untouched', () => {
    const local = localTicket('plain');
    expect(mergeLocalMissionState([local], [projected({ id: 'mis_9', missionId: 'mis_9' })])).toEqual([local]);
  });

  it('uses the mission ROOT projection, never a closed child ticket', () => {
    const local = localTicket('local-mis_3', 'mis_3');
    local.status = 'open';
    const root = projected({ id: 'mis_3', missionId: 'mis_3' });
    root.status = 'in_review';
    root.metadata = {
      is_mission: true,
      local_mission: { missionId: 'mis_3', submission: 'accepted' },
      engine_state: 'VERIFIED_10_10',
      awaiting_human_acceptance: true,
    };
    const child = projected({ id: 'child_3', missionId: 'mis_3', childOf: 'mis_3' });
    child.status = 'closed';

    const [merged] = mergeLocalMissionState([local], [root, child]);

    expect(merged.status).toBe('in_review');
    expect((merged.metadata as Record<string, unknown>).awaiting_human_acceptance).toBe(true);
  });
});

describe('projectMissionsIntoBoard — a seat board never inherits department missions', () => {
  const root = projected({ id: 'mis_c943', missionId: 'mis_c943' });

  it('keeps a workstation-filtered board to its own routed tickets', () => {
    const local = [localTicket('ws-ticket')];
    expect(projectMissionsIntoBoard(local, [root], { workstation_id: 'workstation-local' })).toEqual(local);
  });

  it('merges the mission projection on the department board', () => {
    const rows = projectMissionsIntoBoard([], [root], {});
    expect(rows.map(r => r.ticket_id)).toEqual(['mis_c943']);
  });

  it('still folds a mission-bound local ticket on the department board', () => {
    const local = [localTicket('d81473e8-1234', 'mis_c943')];
    expect(projectMissionsIntoBoard(local, [root], {}).map(r => r.ticket_id)).toEqual([
      'd81473e8-1234',
    ]);
  });
});

describe('missionBoardStatus — machine verification waits for human acceptance', () => {
  it('keeps VERIFIED_10_10 in review until the operator accepts', () => {
    const awaiting = missionBoardStatus({ state: 'VERIFIED_10_10', humanAcceptance: null });
    expect(awaiting.status).toBe('in_review');
    expect(awaiting.awaitingAcceptance).toBe(true);
    expect(awaiting.closed).toBe(false);
    expect(awaiting.terminal).toBe(true);
  });

  it('closes a VERIFIED mission only after acceptance', () => {
    const accepted = missionBoardStatus({ state: 'VERIFIED_10_10', humanAcceptance: 'accepted' });
    expect(accepted.status).toBe('closed');
    expect(accepted.awaitingAcceptance).toBe(false);
    expect(accepted.closed).toBe(true);
  });

  it('a change request reopens the mission (no false closed column)', () => {
    const reopened = missionBoardStatus({ state: 'ACTIVE', humanAcceptance: 'changes_requested' });
    expect(reopened.status).toBe('in_progress');
    expect(reopened.closed).toBe(false);
  });

  it('an operator overlay cannot hide awaiting acceptance', () => {
    const overlaid = missionBoardStatus({
      state: 'VERIFIED_10_10',
      humanAcceptance: null,
      operatorStatus: 'closed',
    });
    expect(overlaid.status).toBe('in_review');
    expect(overlaid.closed).toBe(false);
  });
});

describe('missionStateToStatus — every engine state is board-renderable', () => {
  it('maps blocked/failed states to the failed column (never Open)', () => {
    for (const state of ['BLOCKED', 'BLOCKED_EXTERNAL', 'FAILED_TERMINAL', 'INCONCLUSIVE', 'FAILED']) {
      expect(missionStateToStatus(state)).toBe('failed');
    }
  });
  it('maps planning/capture/verify states to in_progress', () => {
    for (const state of ['PLANNING', 'PLANNED', 'MUTATING', 'CAPTURING_EVIDENCE', 'EVIDENCE_CAPTURED', 'VERIFYING', 'REPLANNING', 'ACTIVE']) {
      expect(missionStateToStatus(state)).toBe('in_progress');
    }
  });
  it('maps review and terminal states', () => {
    expect(missionStateToStatus('FINDINGS')).toBe('in_review');
    expect(missionStateToStatus('REJECTED')).toBe('in_review');
    expect(missionStateToStatus('VERIFIED_10_10')).toBe('closed');
    expect(missionStateToStatus('CANCELLED')).toBe('closed');
    expect(missionStateToStatus(undefined)).toBe('open');
  });
});
