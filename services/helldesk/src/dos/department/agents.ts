/**
 * Agent CRUD, hook management (GUPP), and name allocation for the Department DO.
 *
 * After the tickets-centric refactor (#441), agents are tickets with type='agent'
 * joined with agent_metadata for operational state.
 */

import { z } from 'zod';
import { tickets, TicketRecord, AgentTicketRecord } from '../../db/tables/tickets.table';
import { agent_metadata } from '../../db/tables/agent-metadata.table';
import { query } from '../../util/query.util';
import { generateId, now } from '../../util/id.util';
import { logTicketEvent, getTicket, deleteTicket } from './tickets';
import { readAndDeliverMemo } from './memo';
import type {
  RegisterAgentInput,
  AgentFilter,
  Agent,
  AgentRole,
  PrimeContext,
  Ticket,
} from '../../types';

// Soul name pool (20 names, used in allocation order)
const SOUL_NAME_POOL = [
  'Toast',
  'Maple',
  'Birch',
  'Shadow',
  'Clover',
  'Ember',
  'Sage',
  'Dusk',
  'Flint',
  'Coral',
  'Slate',
  'Reed',
  'Thorn',
  'Pike',
  'Moss',
  'Wren',
  'Blaze',
  'Gale',
  'Drift',
  'Lark',
];

/** Map a parsed AgentTicketRecord to the Agent API type. */
function toAgent(row: AgentTicketRecord): Agent {
  return {
    id: row.ticket_id,
    workstation_id: row.workstation_id,
    role: row.role,
    name: row.title,
    identity: row.identity,
    status: row.status,
    current_hook_ticket_id: row.current_hook_ticket_id,
    dispatch_attempts: row.dispatch_attempts,
    last_activity_at: row.last_activity_at,
    checkpoint: row.checkpoint,
    created_at: row.created_at,
    agent_status_message: row.agent_status_message,
    agent_status_updated_at: row.agent_status_updated_at,
  };
}

/**
 * SQL fragment for joining tickets + agent_metadata.
 * Uses SELECT ${tickets}.* so all ticket columns are available, then selects
 * the agent_metadata columns explicitly (since status conflicts).
 * agent_metadata.status is aliased to avoid colliding with tickets.status.
 */
const AGENT_JOIN = /* sql */ `
  SELECT ${tickets}.*,
         ${agent_metadata.role}, ${agent_metadata.identity},
         ${agent_metadata.container_process_id},
         ${agent_metadata.status} AS status,
         ${agent_metadata.current_hook_ticket_id},
         ${agent_metadata.dispatch_attempts}, ${agent_metadata.last_activity_at},
         ${agent_metadata.checkpoint},
         ${agent_metadata.agent_status_message}, ${agent_metadata.agent_status_updated_at}
  FROM ${tickets}
  INNER JOIN ${agent_metadata} ON ${tickets.ticket_id} = ${agent_metadata.ticket_id}
`;

export function initAgentTables(_sql: SqlStorage): void {
  // Agent tables are now initialized in tickets.initTicketTables()
  // (tickets table + agent_metadata satellite)
}

export function registerAgent(sql: SqlStorage, input: RegisterAgentInput): Agent {
  const id = generateId();
  const timestamp = now();

  query(
    sql,
    /* sql */ `
      INSERT INTO ${tickets} (
        ${tickets.columns.ticket_id}, ${tickets.columns.type}, ${tickets.columns.status},
        ${tickets.columns.title}, ${tickets.columns.body}, ${tickets.columns.workstation_id},
        ${tickets.columns.parent_ticket_id}, ${tickets.columns.assignee_agent_ticket_id},
        ${tickets.columns.priority}, ${tickets.columns.labels}, ${tickets.columns.metadata},
        ${tickets.columns.created_by}, ${tickets.columns.created_at}, ${tickets.columns.updated_at},
        ${tickets.columns.closed_at}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      'agent',
      'open',
      input.name,
      null,
      input.workstation_id ?? null,
      null,
      null,
      'medium',
      '[]',
      '{}',
      null,
      timestamp,
      timestamp,
      null,
    ]
  );

  query(
    sql,
    /* sql */ `
      INSERT INTO ${agent_metadata} (
        ${agent_metadata.columns.ticket_id}, ${agent_metadata.columns.role},
        ${agent_metadata.columns.identity}, ${agent_metadata.columns.container_process_id},
        ${agent_metadata.columns.status}, ${agent_metadata.columns.current_hook_ticket_id},
        ${agent_metadata.columns.dispatch_attempts}, ${agent_metadata.columns.checkpoint},
        ${agent_metadata.columns.last_activity_at}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [id, input.role, input.identity, null, 'idle', null, 0, null, null]
  );

  const agent = getAgent(sql, id);
  if (!agent) throw new Error('Failed to create agent');
  return agent;
}

export function getAgent(sql: SqlStorage, agentId: string): Agent | null {
  const rows = [...query(sql, /* sql */ `${AGENT_JOIN} WHERE ${tickets.ticket_id} = ?`, [agentId])];
  if (rows.length === 0) return null;
  return toAgent(AgentTicketRecord.parse(rows[0]));
}

export function getAgentByIdentity(sql: SqlStorage, identity: string): Agent | null {
  const rows = [
    ...query(sql, /* sql */ `${AGENT_JOIN} WHERE ${agent_metadata.identity} = ?`, [identity]),
  ];
  if (rows.length === 0) return null;
  return toAgent(AgentTicketRecord.parse(rows[0]));
}

export function listAgents(sql: SqlStorage, filter?: AgentFilter): Agent[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        ${AGENT_JOIN}
        WHERE (? IS NULL OR ${agent_metadata.role} = ?)
          AND (? IS NULL OR ${agent_metadata.status} = ?)
          AND (? IS NULL OR ${tickets.workstation_id} = ?)
        ORDER BY ${tickets.created_at} ASC
      `,
      [
        filter?.role ?? null,
        filter?.role ?? null,
        filter?.status ?? null,
        filter?.status ?? null,
        filter?.workstation_id ?? null,
        filter?.workstation_id ?? null,
      ]
    ),
  ];
  return AgentTicketRecord.array().parse(rows).map(toAgent);
}

export function updateAgentStatus(sql: SqlStorage, agentId: string, status: string): void {
  // Set stalled_at when transitioning into `stalled`, clear it when transitioning
  // out. The reconciler uses stalled_at (not last_activity_at) to measure how
  // long an agent has been stalled, so the 2.5h recovery window is anchored to
  // the stall event rather than the last heartbeat (which keeps arriving while
  // the container is still running post-GUPP force-stop).
  query(
    sql,
    /* sql */ `
      UPDATE ${agent_metadata}
      SET ${agent_metadata.columns.status} = ?,
          ${agent_metadata.columns.stalled_at} = CASE
            WHEN ? = 'stalled' THEN COALESCE(${agent_metadata.columns.stalled_at}, ?)
            ELSE NULL
          END
      WHERE ${agent_metadata.ticket_id} = ?
    `,
    [status, status, now(), agentId]
  );
}

export function deleteAgent(sql: SqlStorage, agentId: string): void {
  // Clear assignee on terminal tickets (closed/failed) without reopening them.
  query(
    sql,
    /* sql */ `
      UPDATE ${tickets}
      SET ${tickets.columns.assignee_agent_ticket_id} = NULL,
          ${tickets.columns.updated_at} = ?
      WHERE ${tickets.assignee_agent_ticket_id} = ?
        AND ${tickets.columns.status} IN ('closed', 'failed')
    `,
    [now(), agentId]
  );

  // Reopen non-terminal tickets assigned to this agent so the reconciler
  // can re-dispatch them.
  query(
    sql,
    /* sql */ `
      UPDATE ${tickets}
      SET ${tickets.columns.assignee_agent_ticket_id} = NULL,
          ${tickets.columns.status} = 'open',
          ${tickets.columns.updated_at} = ?
      WHERE ${tickets.assignee_agent_ticket_id} = ?
        AND ${tickets.columns.status} NOT IN ('closed', 'failed')
    `,
    [now(), agentId]
  );

  // deleteTicket cascades to agent_metadata, ticket_events, ticket_dependencies, etc.
  deleteTicket(sql, agentId);
}

/** Ticket types that are system-managed and should never be hooked to an agent. */
const UNHOOKABLE_TICKET_TYPES = new Set(['escalation', 'shift', 'agent', 'message']);

export function hookTicket(sql: SqlStorage, agentId: string, ticketId: string): void {
  const agent = getAgent(sql, agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const ticket = getTicket(sql, ticketId);
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);

  // Prevent hooking to system-managed ticket types that no agent should
  // work on directly. Escalation tickets are resolved by triage, shift
  // tickets are containers, agent/message tickets are metadata records.
  if (UNHOOKABLE_TICKET_TYPES.has(ticket.type)) {
    throw new Error(`Cannot hook agent to ticket ${ticketId}: type '${ticket.type}' is not workable`);
  }

  // Triage request tickets are resolved by the triage agent via
  // gt_triage_resolve, not by hooking. Prevent souls from
  // accidentally picking these up.
  if (ticket.labels.includes('gt:triage-request')) {
    throw new Error(
      `Cannot hook agent to ticket ${ticketId}: triage requests are resolved via gt_triage_resolve`
    );
  }

  // Already hooked to this ticket — idempotent
  if (agent.current_hook_ticket_id === ticketId) return;

  // Agent already has a different hook — caller must unhook first
  if (agent.current_hook_ticket_id) {
    throw new Error(
      `Agent ${agentId} is already hooked to ticket ${agent.current_hook_ticket_id}. Unhook first.`
    );
  }

  // Mutual exclusion: unhook any other agents already hooked to this ticket.
  // This prevents multi-agent assignment when reconcileTickets Rule 1 fires
  // while an idle agent still holds a stale hook from a previous cycle.
  const staleHooks = z
    .object({ ticket_id: z.string() })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
        SELECT ${agent_metadata.ticket_id}
        FROM ${agent_metadata}
        WHERE ${agent_metadata.current_hook_ticket_id} = ?
          AND ${agent_metadata.ticket_id} != ?
      `,
        [ticketId, agentId]
      ),
    ]);
  for (const stale of staleHooks) {
    console.warn(
      `[agents] hookTicket: unhooking stale agent ${stale.ticket_id} from ticket ${ticketId} (replaced by ${agentId})`
    );
    unhookTicket(sql, stale.ticket_id);
  }

  query(
    sql,
    /* sql */ `
      UPDATE ${agent_metadata}
      SET ${agent_metadata.columns.current_hook_ticket_id} = ?,
          ${agent_metadata.columns.status} = 'idle',
          ${agent_metadata.columns.last_activity_at} = ?,
          ${agent_metadata.columns.agent_status_message} = NULL,
          ${agent_metadata.columns.agent_status_updated_at} = NULL
      WHERE ${agent_metadata.ticket_id} = ?
    `,
    [ticketId, now(), agentId]
  );

  // Assign the agent to the ticket but keep the ticket as 'open'.
  // The ticket transitions to 'in_progress' only when the agent's
  // container process actually starts (in dispatchAgent).
  query(
    sql,
    /* sql */ `
      UPDATE ${tickets}
      SET ${tickets.columns.assignee_agent_ticket_id} = ?,
          ${tickets.columns.updated_at} = ?
      WHERE ${tickets.ticket_id} = ?
    `,
    [agentId, now(), ticketId]
  );

  logTicketEvent(sql, {
    ticketId,
    agentId,
    eventType: 'hooked',
    newValue: agentId,
  });
}

export function unhookTicket(sql: SqlStorage, agentId: string): void {
  const agent = getAgent(sql, agentId);
  if (!agent || !agent.current_hook_ticket_id) return;

  const ticketId = agent.current_hook_ticket_id;

  // Clear checkpoint when unhooking — the agent is done with this ticket
  // and the checkpoint (if any) should not leak into the next dispatch.
  query(
    sql,
    /* sql */ `
      UPDATE ${agent_metadata}
      SET ${agent_metadata.columns.current_hook_ticket_id} = NULL,
          ${agent_metadata.columns.status} = 'idle',
          ${agent_metadata.columns.checkpoint} = NULL
      WHERE ${agent_metadata.ticket_id} = ?
    `,
    [agentId]
  );

  logTicketEvent(sql, {
    ticketId,
    agentId,
    eventType: 'unhooked',
    oldValue: agentId,
  });
}

export function getHookedTicket(sql: SqlStorage, agentId: string): Ticket | null {
  const agent = getAgent(sql, agentId);
  if (!agent?.current_hook_ticket_id) return null;
  return getTicket(sql, agent.current_hook_ticket_id);
}

/**
 * Allocate a unique soul name from the pool.
 * Names are department-global (agents belong to the department, not workstations) so we
 * check all existing souls across every workstation.
 */
export function allocateSoulName(sql: SqlStorage): string {
  const usedNames = new Set(
    TicketRecord.pick({ title: true })
      .array()
      .parse([
        ...query(
          sql,
          /* sql */ `
            SELECT ${tickets.title} FROM ${tickets}
            INNER JOIN ${agent_metadata} ON ${tickets.ticket_id} = ${agent_metadata.ticket_id}
            WHERE ${agent_metadata.role} = 'soul'
          `,
          []
        ),
      ])
      .map(r => r.title)
  );

  for (const name of SOUL_NAME_POOL) {
    if (!usedNames.has(name)) return name;
  }

  // Fallback: sequential numbering beyond the 20-name pool
  return `soul-${usedNames.size + 1}`;
}

/**
 * Find an idle agent of the given role, or create one.
 * For singleton roles (frontDesk), reuse existing.
 * For souls, create a new one.
 */
export function getOrCreateAgent(
  sql: SqlStorage,
  role: AgentRole,
  workstationId: string,
  departmentId: string
): Agent {
  // department-wide singletons: one per department, not tied to a workstation.
  const departmentSingletonRoles = ['frontDesk'];
  // Per-workstation singletons: one per workstation (the qualityAssurance processes reviews
  // sequentially, so there should never be two for the same workstation).
  const workstationSingletonRoles = ['qualityAssurance'];

  if (departmentSingletonRoles.includes(role)) {
    const existing = listAgents(sql, { role });
    if (existing.length > 0) return existing[0];
  } else if (workstationSingletonRoles.includes(role)) {
    // Return the existing agent regardless of status. The caller is
    // responsible for checking whether it's idle before dispatching.
    const existing = [
      ...query(
        sql,
        /* sql */ `
          ${AGENT_JOIN}
          WHERE ${agent_metadata.role} = ?
            AND ${tickets.workstation_id} = ?
          LIMIT 1
        `,
        [role, workstationId]
      ),
    ];
    if (existing.length > 0) return toAgent(AgentTicketRecord.parse(existing[0]));
  } else {
    // Per-workstation agents (soul): reuse an idle one in the SAME workstation.
    // Agents are tied to a workstation's worktree/repo — reusing one from a different
    // workstation would dispatch it into the wrong repository.
    const idle = [
      ...query(
        sql,
        /* sql */ `
          ${AGENT_JOIN}
          WHERE ${agent_metadata.role} = ?
            AND ${agent_metadata.status} = 'idle'
            AND ${agent_metadata.current_hook_ticket_id} IS NULL
            AND ${tickets.workstation_id} = ?
          LIMIT 1
        `,
        [role, workstationId]
      ),
    ];
    if (idle.length > 0) return toAgent(AgentTicketRecord.parse(idle[0]));
  }

  const name = role === 'soul' ? allocateSoulName(sql) : role;
  const identity = `${name}-${role}-${workstationId.slice(0, 8)}@${departmentId.slice(0, 8)}`;

  return registerAgent(sql, { role, name, identity, workstation_id: workstationId });
}

export function prime(sql: SqlStorage, agentId: string): PrimeContext {
  const agent = getAgent(sql, agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const hookedTicket = agent.current_hook_ticket_id ? getTicket(sql, agent.current_hook_ticket_id) : null;

  const undeliveredMemo = readAndDeliverMemo(sql, agentId);

  // Open tickets (for context awareness, scoped to agent's workstation)
  const openTicketRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${tickets}
        WHERE ${tickets.status} IN ('open', 'in_progress')
          AND ${tickets.type} != 'agent'
          AND ${tickets.type} != 'message'
          AND (${tickets.workstation_id} IS NULL OR ${tickets.workstation_id} = ?)
        ORDER BY ${tickets.created_at} DESC
        LIMIT 20
      `,
      [agent.workstation_id]
    ),
  ];
  const openTickets = TicketRecord.array().parse(openTicketRows);

  let rework_context: PrimeContext['rework_context'] = null;
  if (hookedTicket?.labels.includes('gt:rework') && hookedTicket.metadata) {
    const meta = hookedTicket.metadata as Record<string, unknown>;
    const originalTicketId = typeof meta.rework_for === 'string' ? meta.rework_for : null;
    const originalTicket = originalTicketId ? getTicket(sql, originalTicketId) : null;
    rework_context = {
      feedback: hookedTicket.body ?? '',
      branch: typeof meta.branch === 'string' ? meta.branch : null,
      target_branch: typeof meta.target_branch === 'string' ? meta.target_branch : null,
      files: Array.isArray(meta.files) ? (meta.files as string[]) : [],
      original_ticket_title: originalTicket?.title ?? null,
      mr_ticket_id: typeof meta.mr_ticket_id === 'string' ? meta.mr_ticket_id : null,
    };
  }

  let pr_fixup_context: PrimeContext['pr_fixup_context'] = null;
  if (hookedTicket?.labels.includes('gt:pr-fixup') && hookedTicket.metadata) {
    const meta = hookedTicket.metadata as Record<string, unknown>;
    pr_fixup_context = {
      pr_url: typeof meta.pr_url === 'string' ? meta.pr_url : null,
      branch: typeof meta.branch === 'string' ? meta.branch : null,
      target_branch: typeof meta.target_branch === 'string' ? meta.target_branch : null,
    };
  }

  // Build PR conflict context if the hooked ticket is a PR conflict resolution request,
  // or if it is a PR feedback ticket that has also accumulated merge conflicts.
  let pr_conflict_context: PrimeContext['pr_conflict_context'] = null;
  if (hookedTicket?.labels.includes('gt:pr-conflict') && hookedTicket.metadata) {
    const meta = hookedTicket.metadata as Record<string, unknown>;
    pr_conflict_context = {
      pr_url: typeof meta.pr_url === 'string' ? meta.pr_url : null,
      branch: typeof meta.branch === 'string' ? meta.branch : null,
      target_branch: typeof meta.target_branch === 'string' ? meta.target_branch : null,
      has_feedback: meta.has_feedback === true || meta.has_feedback === 1,
    };
  } else if (hookedTicket?.labels.includes('gt:pr-feedback') && hookedTicket.metadata) {
    // A feedback ticket can also have has_conflicts: true when a conflict was detected
    // after the feedback ticket was already created. Surface the conflict context so the
    // agent resolves conflicts first, then addresses review feedback.
    const meta = hookedTicket.metadata as Record<string, unknown>;
    if (meta.has_conflicts === true || meta.has_conflicts === 1) {
      pr_conflict_context = {
        pr_url: typeof meta.pr_url === 'string' ? meta.pr_url : null,
        branch: typeof meta.branch === 'string' ? meta.branch : null,
        target_branch:
          typeof meta.conflict_target_branch === 'string' ? meta.conflict_target_branch : null,
        has_feedback: true,
      };
    }
  }

  return {
    agent,
    hooked_Ticket: hookedTicket,
    undelivered_memo: undeliveredMemo,
    open_tickets: openTickets,
    rework_context,
    pr_fixup_context,
    pr_conflict_context,
  };
}

export function writeCheckpoint(sql: SqlStorage, agentId: string, data: unknown): void {
  const serialized = data === null || data === undefined ? null : JSON.stringify(data);
  query(
    sql,
    /* sql */ `
      UPDATE ${agent_metadata}
      SET ${agent_metadata.columns.checkpoint} = ?
      WHERE ${agent_metadata.ticket_id} = ?
    `,
    [serialized, agentId]
  );
}

export function readCheckpoint(sql: SqlStorage, agentId: string): unknown {
  const agent = getAgent(sql, agentId);
  return agent?.checkpoint ?? null;
}

export function updateAgentStatusMessage(sql: SqlStorage, agentId: string, message: string): void {
  query(
    sql,
    /* sql */ `
      UPDATE ${agent_metadata}
      SET ${agent_metadata.columns.agent_status_message} = ?,
          ${agent_metadata.columns.agent_status_updated_at} = ?
      WHERE ${agent_metadata.ticket_id} = ?
    `,
    [message, now(), agentId]
  );
}

export function touchAgent(
  sql: SqlStorage,
  agentId: string,
  watermark?: {
    lastEventType?: string | null;
    lastEventAt?: string | null;
    activeTools?: string[];
  }
): void {
  // A heartbeat is proof the agent is alive in the container.
  // If the agent's status is 'idle' (e.g. due to a dispatch timeout
  // race — see #1358), restore it to 'working'. This prevents the
  // reconciler from treating the agent as lost while it's actively
  // sending heartbeats.
  query(
    sql,
    /* sql */ `
      UPDATE ${agent_metadata}
      SET ${agent_metadata.columns.last_activity_at} = ?,
          ${agent_metadata.columns.status} = CASE
            WHEN ${agent_metadata.columns.status} = 'idle' THEN 'working'
            ELSE ${agent_metadata.columns.status}
          END,
          ${agent_metadata.columns.dispatch_attempts} = 0,
          ${agent_metadata.columns.last_event_type} = COALESCE(?, ${agent_metadata.columns.last_event_type}),
          ${agent_metadata.columns.last_event_at} = COALESCE(?, ${agent_metadata.columns.last_event_at}),
          ${agent_metadata.columns.active_tools} = COALESCE(?, ${agent_metadata.columns.active_tools})
      WHERE ${agent_metadata.ticket_id} = ?
    `,
    [
      now(),
      watermark?.lastEventType ?? null,
      watermark?.lastEventAt ?? null,
      watermark?.activeTools ? JSON.stringify(watermark.activeTools) : null,
      agentId,
    ]
  );
}
