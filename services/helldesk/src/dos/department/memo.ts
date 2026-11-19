/**
 * Inter-agent memo system for the Department DO.
 *
 * After the tickets-centric refactor (#441), memo messages are tickets with
 * type='message'. The recipient is assignee_agent_ticket_id, the sender
 * is stored in labels and metadata.
 */

import { tickets, TicketRecord } from '../../db/tables/tickets.table';
import { agent_metadata } from '../../db/tables/agent-metadata.table';
import { query } from '../../util/query.util';
import { generateId, now } from '../../util/id.util';
import { logTicketEvent } from './tickets';
import { getAgent } from './agents';
import type { SendMemoInput, Memo } from '../../types';

export function initMemoTables(_sql: SqlStorage): void {
  // Memo tables are now part of the tickets table (type='message').
  // Initialization happens in tickets.initTicketTables().
}

export function sendMemo(sql: SqlStorage, input: SendMemoInput): void {
  const id = generateId();
  const timestamp = now();

  const labels = JSON.stringify(['gt:message', `from:${input.from_agent_id}`]);
  const metadata = JSON.stringify({
    from_agent_id: input.from_agent_id,
    to_agent_id: input.to_agent_id,
  });

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
      'message',
      'open',
      input.subject,
      input.body,
      null,
      null,
      input.to_agent_id,
      'medium',
      labels,
      metadata,
      input.from_agent_id,
      timestamp,
      timestamp,
      null,
    ]
  );

  // Log ticket event if the recipient has a hooked ticket
  const recipient = getAgent(sql, input.to_agent_id);
  if (recipient?.current_hook_ticket_id) {
    logTicketEvent(sql, {
      ticketId: recipient.current_hook_ticket_id,
      agentId: input.from_agent_id,
      eventType: 'memo_sent',
      metadata: { subject: input.subject, to: input.to_agent_id },
    });
  }
}

/**
 * Read and deliver undelivered memo for an agent.
 * Returns the memo items and batch-closes the message tickets in a single UPDATE.
 */
export function readAndDeliverMemo(sql: SqlStorage, agentId: string): Memo[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${tickets}
        WHERE ${tickets.type} = 'message'
          AND ${tickets.assignee_agent_ticket_id} = ?
          AND ${tickets.status} = 'open'
        ORDER BY ${tickets.created_at} ASC
      `,
      [agentId]
    ),
  ];

  const memoTickets = TicketRecord.array().parse(rows);
  if (memoTickets.length === 0) return [];

  const messages: Memo[] = memoTickets.map(mb => ({
    id: mb.ticket_id,
    from_agent_id: String(mb.metadata?.from_agent_id ?? mb.created_by ?? ''),
    to_agent_id: agentId,
    subject: mb.title,
    body: mb.body ?? '',
    delivered: false,
    created_at: mb.created_at,
    delivered_at: null,
  }));

  // Batch-close all open message tickets for this agent in a single UPDATE
  const timestamp = now();
  query(
    sql,
    /* sql */ `
      UPDATE ${tickets}
      SET ${tickets.columns.status} = 'closed',
          ${tickets.columns.closed_at} = ?,
          ${tickets.columns.updated_at} = ?
      WHERE ${tickets.type} = 'message'
        AND ${tickets.assignee_agent_ticket_id} = ?
        AND ${tickets.status} = 'open'
    `,
    [timestamp, timestamp, agentId]
  );

  return messages;
}

export function checkMemo(sql: SqlStorage, agentId: string): Memo[] {
  return readAndDeliverMemo(sql, agentId);
}

/**
 * Find open memo addressed to agents that are currently working.
 * Returns a map of agentId → Memo[] so the caller can push each batch
 * to the corresponding container process.
 *
 * Calling this does NOT mark memo as delivered — the caller should call
 * `readAndDeliverMemo` after successfully pushing the messages.
 */
export function getPendingMemoForWorkingAgents(sql: SqlStorage): Map<string, Memo[]> {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${tickets}.*
        FROM ${tickets}
        INNER JOIN ${agent_metadata}
          ON ${tickets.assignee_agent_ticket_id} = ${agent_metadata.ticket_id}
        WHERE ${tickets.type} = 'message'
          AND ${tickets.status} = 'open'
          AND ${agent_metadata.status} = 'working'
        ORDER BY ${tickets.created_at} ASC
      `,
      []
    ),
  ];

  const memoTickets = TicketRecord.array().parse(rows);
  const grouped = new Map<string, Memo[]>();

  for (const mb of memoTickets) {
    const recipientId = mb.assignee_agent_ticket_id ?? '';
    if (!recipientId) continue;

    const m: Memo = {
      id: mb.ticket_id,
      from_agent_id: String(mb.metadata?.from_agent_id ?? mb.created_by ?? ''),
      to_agent_id: recipientId,
      subject: mb.title,
      body: mb.body ?? '',
      delivered: false,
      created_at: mb.created_at,
      delivered_at: null,
    };

    const existing = grouped.get(recipientId);
    if (existing) {
      existing.push(m);
    } else {
      grouped.set(recipientId, [m]);
    }
  }

  return grouped;
}
