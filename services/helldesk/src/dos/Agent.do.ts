/**
 * AgentDO — Per-agent event storage.
 *
 * One instance per agent (keyed by agentId). Owns the high-volume
 * agent_events table, isolating it from the Department DO's 10GB budget.
 * The Department DO writes events here as they flow through; clients query
 * here for backfill when joining a stream late.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  workstation_agent_events,
  WorkstationAgentEventRecord,
  createTableWorkstationAgentEvents,
  getIndexesWorkstationAgentEvents,
} from '../db/tables/workstation-agent-events.table';
import { query } from '../util/query.util';
import { reconstructConversation, formatTranscriptForPrompt } from './department/conversation';

const AGENT_DO_LOG = '[Agent.do]';

export class AgentDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private initPromise: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    void ctx.blockConcurrencyWhile(async () => {
      await this.ensureInitialized();
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initializeDatabase();
    }
    await this.initPromise;
  }

  private async initializeDatabase(): Promise<void> {
    query(this.sql, createTableWorkstationAgentEvents(), []);
    for (const idx of getIndexesWorkstationAgentEvents()) {
      query(this.sql, idx, []);
    }
  }

  /**
   * Append an event. Returns the auto-incremented event ID.
   */
  async appendEvent(eventType: string, data: unknown): Promise<number> {
    await this.ensureInitialized();
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data ?? {});
    const timestamp = new Date().toISOString();

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${workstation_agent_events} (
          ${workstation_agent_events.columns.agent_id},
          ${workstation_agent_events.columns.event_type},
          ${workstation_agent_events.columns.data},
          ${workstation_agent_events.columns.created_at}
        ) VALUES (?, ?, ?, ?)
      `,
      [this.ctx.id.name ?? '', eventType, dataStr, timestamp]
    );

    // Return the last inserted rowid
    const rows = [...this.sql.exec('SELECT last_insert_rowid() as id')];
    const insertedId = Number(rows[0]?.id ?? 0);

    // Prune old events if count exceeds 10000
    query(
      this.sql,
      /* sql */ `
        DELETE FROM ${workstation_agent_events}
        WHERE ${workstation_agent_events.columns.id} NOT IN (
          SELECT ${workstation_agent_events.columns.id} FROM ${workstation_agent_events}
          ORDER BY ${workstation_agent_events.columns.id} DESC
          LIMIT 10000
        )
      `,
      []
    );

    return insertedId;
  }

  /**
   * Query events for backfill. Returns events with id > afterId, up to limit.
   */
  async getEvents(afterId = 0, limit = 500): Promise<WorkstationAgentEventRecord[]> {
    await this.ensureInitialized();
    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${workstation_agent_events}
          WHERE ${workstation_agent_events.columns.id} > ?
          ORDER BY ${workstation_agent_events.columns.id} ASC
          LIMIT ?
        `,
        [afterId, limit]
      ),
    ];
    return WorkstationAgentEventRecord.array().parse(rows);
  }

  /**
   * Reconstruct the conversation transcript from persisted events.
   * Returns a formatted string for prompt injection, or empty string
   * if no conversation history exists.
   *
   * Runs inside the AgentDO so the DepartmentDO doesn't bear the cost of
   * fetching and reducing potentially thousands of events.
   */
  async reconstructConversation(): Promise<string> {
    await this.ensureInitialized();
    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${workstation_agent_events}
          ORDER BY ${workstation_agent_events.columns.id} ASC
          LIMIT 10000
        `,
        []
      ),
    ];
    const events = WorkstationAgentEventRecord.array().parse(rows);
    const turns = reconstructConversation(events);
    return formatTranscriptForPrompt(turns);
  }

  /**
   * Delete all events. Called when the agent is deleted from the Department DO.
   */
  async destroy(): Promise<void> {
    console.log(`${AGENT_DO_LOG} destroy: clearing all storage`);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async ping(): Promise<{ ok: true }> {
    return { ok: true };
  }
}

export function getAgentDOStub(env: Env, agentId: string) {
  return env.AGENT.get(env.AGENT.idFromName(agentId));
}
