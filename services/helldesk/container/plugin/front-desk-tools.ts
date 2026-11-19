import { tool } from '@kilocode/plugin';
import type { FrontDeskHelldeskClient } from './client';
import type { UiActionInput } from './types';

const UI_ACTION_TYPES = new Set([
  'open_ticket_drawer',
  'open_shift_drawer',
  'open_agent_drawer',
  'navigate',
  'highlight_Ticket',
]);

/** Validate and narrow a parsed JSON object to UiActionInput.
 * Full schema validation happens server-side; this guards the type locally. */
function parseUiAction(value: unknown): UiActionInput {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    throw new Error('"action_json" must be a JSON object with a "type" field');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== 'string' || !UI_ACTION_TYPES.has(obj.type)) {
    throw new Error(
      `Unknown UI action type: "${String(obj.type)}". Supported: ${[...UI_ACTION_TYPES].join(', ')}`
    );
  }
  // Server-side Zod schema validates required fields per action type.
  // The cast is safe because we've verified the type discriminator.
  return value as UiActionInput;
}

/**
 * front-desk-specific tools for cross-workstation delegation.
 * These are only registered when `HELLDESK_AGENT_ROLE=frontDesk`.
 */
export function createFrontDeskTools(client: FrontDeskHelldeskClient) {
  return {
    gt_sling: tool({
      description:
        'Delegate a task to a soul agent in a specific workstation. ' +
        'Creates a ticket (work item), assigns a soul, and arms the dispatch alarm. ' +
        'The soul will be started automatically and begin working on the task. ' +
        'You must specify which workstation the work belongs to — use gt_list_workstations first if unsure.',
      args: {
        workstation_id: tool.schema.string().describe('The UUID of the workstation to assign work to'),
        title: tool.schema.string().describe('Short title describing the task'),
        body: tool.schema
          .string()
          .describe(
            'Detailed description of the work to be done. Include requirements, context, acceptance criteria.'
          )
          .optional(),
        metadata: tool.schema
          .record(tool.schema.string(), tool.schema.unknown())
          .describe(
            'Metadata object for additional context (e.g. { pr_url, branch, target_branch }). ' +
              'When the work originates from a helldesk claim, you MUST include the `helldesk` ' +
              'origin tag returned by gt_helldesk_claim, e.g. ' +
              '`{ helldesk: <planning.helldesk_origin> }`, so the ticket links back to the wanted item.'
          )
          .optional(),
        labels: tool.schema
          .array(tool.schema.string())
          .describe('Labels to attach to the ticket (e.g. ["gt:pr-fixup"])')
          .optional(),
      },
      async execute(args) {
        const result = await client.sling({
          workstation_id: args.workstation_id,
          title: args.title,
          body: args.body,
          metadata: args.metadata,
          labels: args.labels,
        });
        return [
          `Task slung successfully.`,
          `Ticket: ${result.ticket.ticket_id} — "${result.ticket.title}"`,
          `Assigned to: ${result.agent.name} (${result.agent.role}, id: ${result.agent.id})`,
          `Status: ${result.ticket.status}`,
          `The soul will be dispatched automatically by the alarm scheduler.`,
        ].join('\n');
      },
    }),

    gt_list_workstations: tool({
      description:
        'List all workstations (repositories) in your department. ' +
        'Returns the workstation ID, name, git URL, and default branch for each workstation. ' +
        'Use this to discover available workstations before delegating work with gt_sling.',
      args: {},
      async execute() {
        const workstations = await client.listWorkstations();
        if (workstations.length === 0) {
          return 'No workstations configured in this department. A workstation must be created before work can be delegated.';
        }
        return JSON.stringify(workstations, null, 2);
      },
    }),

    gt_list_tickets: tool({
      description:
        'List tickets (work items) in a specific workstation. ' +
        'Optionally filter by status (open, in_progress, in_review, closed, failed) or type (issue, message, escalation, merge_request). ' +
        'Use this to check what work exists in a workstation, what is in progress, and what has been completed.',
      args: {
        workstation_id: tool.schema.string().describe('The UUID of the workstation to list tickets from'),
        status: tool.schema
          .enum(['open', 'in_progress', 'in_review', 'closed', 'failed'])
          .describe('Filter by ticket status')
          .optional(),
        type: tool.schema
          .enum(['issue', 'message', 'escalation', 'merge_request'])
          .describe('Filter by ticket type')
          .optional(),
      },
      async execute(args) {
        const tickets = await client.listTickets(args.workstation_id, {
          status: args.status,
          type: args.type,
        });
        if (tickets.length === 0) {
          return 'No tickets found matching the filter.';
        }
        return JSON.stringify(tickets, null, 2);
      },
    }),

    gt_list_agents: tool({
      description:
        'List all agents in a specific workstation. ' +
        'Returns agent ID, role, name, status, and current hook (assigned ticket). ' +
        'Use this to see which agents are active, idle, or working on what.',
      args: {
        workstation_id: tool.schema.string().describe('The UUID of the workstation to list agents from'),
      },
      async execute(args) {
        const agents = await client.listAgents(args.workstation_id);
        if (agents.length === 0) {
          return 'No agents registered in this workstation.';
        }
        return JSON.stringify(agents, null, 2);
      },
    }),

    gt_sling_batch: tool({
      description:
        'Sling multiple tickets as a tracked shift. Use this when a task should be broken ' +
        'into parallel sub-tasks that you want to track as a group. Creates N tickets + 1 shift, ' +
        'assigns polecats, and dispatches all in one call. Use gt_list_shifts to check progress later.',
      args: {
        workstation_id: tool.schema.string().describe('The UUID of the workstation to assign work to'),
        shift_title: tool.schema
          .string()
          .describe('Title for the shift — describes the overall task being decomposed'),
        tasks: tool.schema
          .array(
            tool.schema.object({
              title: tool.schema.string().describe('Short title describing the sub-task'),
              body: tool.schema
                .string()
                .describe('Detailed requirements for the sub-task')
                .optional(),
              depends_on: tool.schema
                .array(tool.schema.number().int().min(0))
                .describe(
                  'Zero-based indices of tasks in this array that must complete before this task can start. ' +
                    'Example: [0] means this task depends on the first task. Omit or use [] for tasks with no dependencies.'
                )
                .optional(),
            })
          )
          .min(1)
          .describe('Array of sub-tasks to create as tickets in the shift'),
        merge_mode: tool.schema
          .enum(['review-then-land', 'review-and-merge'])
          .describe(
            'Controls how completed tickets are handled:\n' +
              '- "review-then-land" (default): Each ticket is reviewed by the qualityAssurance and merged into the shift feature branch. ' +
              'Only at the end of the shift does a PR or merge into main occur. Best for tightly coupled work where ' +
              'intermediate PRs would be noisy or where tasks build on each other.\n' +
              '- "review-and-merge": Each ticket goes through the full review + merge/PR cycle independently. ' +
              'Best for loosely coupled tasks where each ticket stands on its own and you want incremental merges.'
          )
          .optional(),
        parallel: tool.schema
          .boolean()
          .describe(
            'Set to true ONLY when ALL tasks are genuinely independent — they touch completely ' +
              'different files with no shared state. Without this flag, the system REQUIRES at least ' +
              'one task to declare depends_on. This prevents accidental parallel execution of tasks ' +
              'that need ordering, which causes merge conflicts and failures.'
          )
          .optional(),
        staged: tool.schema
          .boolean()
          .describe(
            'If true, creates the shift plan without dispatching agents. ' +
              'The user can review and edit before calling gt_shift_start to begin execution. ' +
              'Default: false (dispatch immediately).'
          )
          .optional(),
        metadata: tool.schema
          .record(tool.schema.string(), tool.schema.unknown())
          .describe(
            'Metadata stamped onto BOTH the shift ticket AND every task ticket. Use this to propagate ' +
              'cross-cutting context like the `helldesk` origin tag returned by gt_helldesk_claim ' +
              '(pass `{ helldesk: <planning.helldesk_origin> }`) so every descendant ticket links back ' +
              'to its source.'
          )
          .optional(),
      },
      async execute(args) {
        const result = await client.slingBatch({
          workstation_id: args.workstation_id,
          shift_title: args.shift_title,
          tasks: args.tasks,
          merge_mode: args.merge_mode,
          parallel: args.parallel,
          staged: args.staged,
          metadata: args.metadata,
        });

        const ticketLines = result.tickets.map(
          (b: { ticket: { title: string }; agent: { name: string; id: string } | null }, i: number) =>
            b.agent
              ? `  ${i + 1}. "${b.ticket.title}" → ${b.agent.name} (${b.agent.id})`
              : `  ${i + 1}. "${b.ticket.title}" (unassigned, pending gt_shift_start)`
        );
        const mode = args.merge_mode ?? 'review-then-land';
        const staged = result.shift.staged;
        return [
          `Shift ${staged ? 'staged' : 'created'}: "${result.shift.title}" (${result.shift.id})`,
          `Merge mode: ${mode}`,
          `Tracking ${result.shift.total_tickets} tickets:`,
          ...ticketLines,
          staged
            ? `Shift is staged — agents have NOT been dispatched. Call gt_shift_start with shift_id "${result.shift.id}" when ready to begin execution.`
            : mode === 'review-then-land'
              ? `Tickets will be reviewed and merged into the shift feature branch. A final PR/merge to main occurs when all tickets are done.`
              : `Each ticket will go through the full review + merge/PR cycle independently.`,
        ].join('\n');
      },
    }),

    gt_list_shifts: tool({
      description:
        'List active shifts with progress. Shows how many tickets are closed vs total for each shift. ' +
        'Use this to check on batched work or answer "how is X going?" questions.',
      args: {},
      async execute() {
        const shifts = await client.listShifts();
        if (shifts.length === 0) {
          return 'No active shifts. All batched work has either landed or none has been created.';
        }
        return JSON.stringify(shifts, null, 2);
      },
    }),

    gt_shift_status: tool({
      description:
        'Show detailed status of a shift: each tracked ticket with its status and assignee. ' +
        'Use this for a detailed progress report on a specific batch of work.',
      args: {
        shift_id: tool.schema.string().describe('The UUID of the shift to inspect'),
      },
      async execute(args) {
        const status = await client.getShiftStatus(args.shift_id);
        return JSON.stringify(status, null, 2);
      },
    }),

    gt_shift_start: tool({
      description:
        'Start a staged shift. Transitions the shift from staged (planned but not executing) ' +
        'to active: hooks agents to all tracked tickets and begins dispatch. ' +
        'Call this when the user approves a staged plan and says to start it.',
      args: {
        shift_id: tool.schema.string().describe('The UUID of the staged shift to start'),
      },
      async execute(args) {
        const result = await client.startShift(args.shift_id);
        const ticketCount = result.tickets?.length ?? 0;
        return `Shift started. ${ticketCount} ticket(s) dispatched to agents.`;
      },
    }),

    gt_memo_send: tool({
      description:
        'Send a memo message to an agent in any workstation. ' +
        'Use this for cross-workstation coordination, instructions, or status requests. ' +
        'The recipient must be identified by their agent UUID and workstation UUID.',
      args: {
        workstation_id: tool.schema.string().describe('The UUID of the workstation the recipient agent belongs to'),
        to_agent_id: tool.schema.string().describe('The UUID of the recipient agent'),
        subject: tool.schema.string().describe('Subject line for the memo'),
        body: tool.schema.string().describe('Body content of the memo'),
      },
      async execute(args) {
        await client.sendMemo({
          workstation_id: args.workstation_id,
          to_agent_id: args.to_agent_id,
          subject: args.subject,
          body: args.body,
        });
        return `Memo sent to agent ${args.to_agent_id} in workstation ${args.workstation_id}.`;
      },
    }),

    gt_ticket_update: tool({
      description: "Edit a ticket's status, title, body, priority, labels, or dependency blockers.",
      args: {
        workstation_id: tool.schema.string().describe('The UUID of the workstation the ticket belongs to'),
        ticket_id: tool.schema.string().describe('The UUID of the ticket to update'),
        title: tool.schema.string().describe('New title for the ticket').optional(),
        body: tool.schema.string().describe('New body/description for the ticket').optional(),
        status: tool.schema
          .enum(['open', 'in_progress', 'in_review', 'closed', 'failed'])
          .describe('New status for the ticket')
          .optional(),
        priority: tool.schema
          .enum(['low', 'medium', 'high', 'critical'])
          .describe('New priority for the ticket')
          .optional(),
        labels: tool.schema
          .array(tool.schema.string())
          .describe('Replacement labels array for the ticket')
          .optional(),
        depends_on: tool.schema
          .array(tool.schema.string())
          .describe(
            "Replace this ticket's blockers. Pass an array of ticket UUIDs that must be closed before this ticket can be dispatched. " +
              'Pass an empty array [] to remove all blockers. Omit to leave dependencies unchanged.'
          )
          .optional(),
      },
      async execute(args) {
        const ticket = await client.updateTicket(args.workstation_id, args.ticket_id, {
          title: args.title,
          body: args.body,
          status: args.status,
          priority: args.priority,
          labels: args.labels,
          depends_on: args.depends_on,
        });
        return `Ticket ${ticket.ticket_id} updated. Status: ${ticket.status}, Priority: ${ticket.priority}, Title: "${ticket.title}".`;
      },
    }),

    gt_ticket_reassign: tool({
      description: 'Reassign a ticket to a different agent.',
      args: {
        workstation_id: tool.schema.string().describe('The UUID of the workstation the ticket belongs to'),
        ticket_id: tool.schema.string().describe('The UUID of the ticket to reassign'),
        agent_id: tool.schema.string().describe('The UUID of the agent to assign the ticket to'),
      },
      async execute(args) {
        const ticket = await client.reassignTicket(args.workstation_id, args.ticket_id, args.agent_id);
        return `Ticket ${ticket.ticket_id} reassigned to agent ${args.agent_id}.`;
      },
    }),

    gt_ticket_delete: tool({
      description:
        'Delete one or more tickets. Use with caution — this is irreversible. Pass a single UUID string or an array of UUIDs to bulk-delete up to 5000 at once.',
      args: {
        workstation_id: tool.schema.string().describe('The UUID of the workstation the ticket(s) belong to'),
        ticket_id: tool.schema
          .union([tool.schema.string(), tool.schema.array(tool.schema.string())])
          .describe('A single ticket UUID or an array of ticket UUIDs to delete'),
      },
      async execute(args) {
        const ids = Array.isArray(args.ticket_id) ? args.ticket_id : [args.ticket_id];
        if (ids.length === 1 && ids[0]) {
          await client.deleteTicket(args.workstation_id, ids[0]);
          return `Ticket ${ids[0]} deleted.`;
        }
        const result = await client.deleteTickets(args.workstation_id, ids);
        return `Deleted ${result.deleted} tickets.`;
      },
    }),

    gt_agent_reset: tool({
      description: 'Force-reset an agent to idle, unhooking from any ticket.',
      args: {
        workstation_id: tool.schema.string().describe('The UUID of the workstation the agent belongs to'),
        agent_id: tool.schema.string().describe('The UUID of the agent to reset'),
      },
      async execute(args) {
        await client.resetAgent(args.workstation_id, args.agent_id);
        return `Agent ${args.agent_id} reset to idle.`;
      },
    }),

    gt_shift_close: tool({
      description: 'Force-close a shift and optionally its tracked tickets.',
      args: {
        shift_id: tool.schema.string().describe('The UUID of the shift to force-close'),
      },
      async execute(args) {
        await client.closeShift(args.shift_id);
        return `Shift ${args.shift_id} force-closed.`;
      },
    }),

    gt_shift_add_Ticket: tool({
      description:
        'Add an existing ticket to an existing shift. Use this after gt_sling to make a standalone ticket ' +
        "part of a shift's tracked progress and landing. The ticket will count toward the shift's " +
        'completion and will be included in the shift landing.',
      args: {
        shift_id: tool.schema.string().describe('UUID of the shift to add the ticket to'),
        ticket_id: tool.schema.string().describe('UUID of the ticket to add'),
        depends_on: tool.schema
          .array(tool.schema.string())
          .describe('Optional: ticket UUIDs that must complete before this ticket is dispatched')
          .optional(),
      },
      async execute(args) {
        const result = await client.shiftAddTicket(args.shift_id, args.ticket_id, args.depends_on);
        return `Ticket ${args.ticket_id} added to shift ${args.shift_id}. Shift now tracking ${result.total_tickets} tickets.`;
      },
    }),

    gt_shift_remove_Ticket: tool({
      description:
        'Remove a ticket from a shift. The ticket will no longer count toward shift progress or landing. ' +
        'Dependency edges between this ticket and other shift tickets are also removed. ' +
        'The ticket itself is not deleted — it becomes a standalone ticket.',
      args: {
        shift_id: tool.schema.string().describe('UUID of the shift'),
        ticket_id: tool.schema.string().describe('UUID of the ticket to remove from the shift'),
      },
      async execute(args) {
        const result = await client.shiftRemoveTicket(args.shift_id, args.ticket_id);
        return `Ticket ${args.ticket_id} removed from shift ${args.shift_id}. Shift now tracking ${result.total_tickets} tickets.`;
      },
    }),

    gt_shift_update: tool({
      description: 'Edit shift metadata (merge_mode, feature_branch).',
      args: {
        shift_id: tool.schema.string().describe('The UUID of the shift to update'),
        merge_mode: tool.schema
          .enum(['review-then-land', 'review-and-merge'])
          .describe('New merge mode for the shift')
          .optional(),
        feature_branch: tool.schema
          .string()
          .describe('New feature branch name for the shift')
          .optional(),
      },
      async execute(args) {
        await client.updateShift(args.shift_id, {
          merge_mode: args.merge_mode,
          feature_branch: args.feature_branch,
        });
        return `Shift ${args.shift_id} updated.`;
      },
    }),

    gt_escalation_acknowledge: tool({
      description: 'Acknowledge an escalation.',
      args: {
        escalation_id: tool.schema.string().describe('The UUID of the escalation to acknowledge'),
      },
      async execute(args) {
        await client.acknowledgeEscalation(args.escalation_id);
        return `Escalation ${args.escalation_id} acknowledged.`;
      },
    }),

    gt_ui_action: tool({
      description:
        "Trigger a UI action in the user's dashboard. " +
        'Lets you open drawers, navigate pages, and highlight items on behalf of the user.\n\n' +
        'Supported action types:\n' +
        '- open_ticket_drawer: Open a ticket detail drawer. Required fields: ticketId, workstationId.\n' +
        '- open_shift_drawer: Open a shift detail drawer. Required fields: shiftId, departmentId.\n' +
        '- open_agent_drawer: Open an agent detail drawer. Required fields: agentId, workstationId, departmentId.\n' +
        '- navigate: Navigate to a dashboard page. Required field: page (one of: department-overview, tickets, agents, workstations, settings).\n' +
        '- highlight_Ticket: Highlight a ticket in the list. Required fields: ticketId, workstationId.\n\n' +
        'Examples:\n' +
        '- Open ticket drawer: action_json = \'{"type":"open_ticket_drawer","ticketId":"<id>","workstationId":"<id>"}\'\n' +
        '- Navigate to tickets: action_json = \'{"type":"navigate","page":"tickets"}\'',
      args: {
        action_json: tool.schema
          .string()
          .describe('JSON-encoded UiAction object specifying the UI action to perform'),
      },
      async execute(args) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(args.action_json);
        } catch {
          throw new Error('Invalid JSON in "action_json"');
        }
        const action = parseUiAction(parsed);
        await client.broadcastUiAction(action);
        return `UI action "${action.type}" broadcast to dashboard.`;
      },
    }),

    gt_nudge: tool({
      description:
        'Send a real-time nudge to a soul agent in any workstation. Unlike gt_memo_send (which queues ' +
        "a formal persistent message), gt_nudge delivers immediately at the agent's next idle moment. " +
        'Use this for time-sensitive coordination: wake up an agent, request a status check, ' +
        'or notify of a blocking issue.',
      args: {
        workstation_id: tool.schema.string().describe('The UUID of the workstation the target agent belongs to'),
        target_agent_id: tool.schema.string().describe('UUID of the agent to nudge'),
        message: tool.schema.string().describe('The message to deliver'),
        mode: tool.schema
          .enum(['wait-idle', 'immediate', 'queue'])
          .describe(
            'Delivery mode: wait-idle (default) delivers at next idle moment; ' +
              'immediate injects mid-task; queue delivers with TTL'
          )
          .optional(),
      },
      async execute(args) {
        const result = await client.nudge({
          workstation_id: args.workstation_id,
          target_agent_id: args.target_agent_id,
          message: args.message,
          mode: args.mode ?? 'wait-idle',
        });
        return `Nudge queued: ${result.nudge_id} (mode: ${args.mode ?? 'wait-idle'})`;
      },
    }),

    // ── HELLDESK tools ─────────────────────────────────────────────────

    gt_helldesk_browse: tool({
      description:
        'Browse the wanted board of the HELLDESK this department is connected to. ' +
        'Returns a list of wanted items (tasks/bugs/features) posted to the board. ' +
        'Optionally filter by status and limit the number of results.',
      args: {
        status: tool.schema
          .enum(['open', 'claimed', 'in_review', 'completed', 'validated', 'withdrawn'])
          .describe('Filter by item status')
          .optional(),
        limit: tool.schema
          .number()
          .int()
          .min(1)
          .max(100)
          .describe('Maximum number of items to return (default: 50)')
          .optional(),
      },
      async execute(args) {
        const items = await client.helldeskBrowse({
          status: args.status,
          limit: args.limit,
        });
        if (items.length === 0) {
          const statusNote = args.status ? ` with status "${args.status}"` : '';
          return `No wanted items found${statusNote} in this helldesk.`;
        }
        return JSON.stringify(items, null, 2);
      },
    }),

    gt_helldesk_claim: tool({
      description:
        'Claim an open wanted item from the HELLDESK this department is connected to. ' +
        'Marks the item upstream as claimed and returns:\n' +
        '  - `item`: the full wanted-item record (title, description, priority, type) so you can plan.\n' +
        "  - `planning.suggested_workstation_id`: the local workstation that maps to this helldesk's upstream workstation handle.\n" +
        '  - `planning.helldesk_origin`: an opaque origin tag you MUST forward verbatim as `metadata.helldesk` ' +
        'on whatever ticket(s) you create next via gt_sling or gt_sling_batch. This links every descendant ticket ' +
        'back to the wanted item so progress is tracked end-to-end.\n' +
        'After claiming, decide whether the work is one ticket (gt_sling) or several (gt_sling_batch), then ' +
        'create them with the helldesk_origin tag attached.',
      args: {
        item_id: tool.schema.string().describe('The ID of the wanted item to claim'),
      },
      async execute(args) {
        const result = await client.helldeskClaim({
          item_id: args.item_id,
        });
        const preamble = result.item
          ? 'Claim succeeded. Plan the work using the item context below; forward `planning.helldesk_origin` verbatim as `metadata.helldesk` on every ticket you create (single via gt_sling, or multi via gt_sling_batch).'
          : 'Claim succeeded but the wanted-item details lookup failed (network or container cold start). The `planning` fields below are still valid; consider re-running gt_helldesk_browse to fetch the title/description before slinging the work.';
        return `${preamble}\n${JSON.stringify(result, null, 2)}`;
      },
    }),

    gt_helldesk_post: tool({
      description:
        'Post a new wanted item to the HELLDESK this department is connected to. ' +
        'Creates a new task, bug report, or feature request on the wanted board.',
      args: {
        title: tool.schema.string().describe('Short title for the wanted item'),
        description: tool.schema.string().describe('Detailed description of what is needed'),
        priority: tool.schema
          .enum(['low', 'medium', 'high', 'critical'])
          .describe('Priority level')
          .optional(),
        type: tool.schema
          .enum(['feature', 'bug', 'docs', 'other'])
          .describe('Type of wanted item')
          .optional(),
      },
      async execute(args) {
        const result = await client.helldeskPost({
          title: args.title,
          description: args.description,
          priority: args.priority,
          type: args.type,
        });
        if (!result.success) return `Failed to post wanted item.`;
        return [
          `Posted new wanted item: "${args.title}".`,
          `Wanted item ID: ${result.wantedId}`,
          result.pr_url ? `Pull request: ${result.pr_url}` : null,
        ]
          .filter(line => line !== null)
          .join('\n');
      },
    }),

    gt_helldesk_done: tool({
      description:
        'Mark a claimed wanted item as done with evidence. ' +
        'A DoltHub pull request is opened automatically against the upstream helldesk.',
      args: {
        item_id: tool.schema.string().describe('The ID of the wanted item to mark done'),
        evidence: tool.schema
          .string()
          .describe(
            'A single URL pointing at the proof of completion (typically a GitHub PR ' +
              'URL like https://github.com/owner/repo/pull/123, but a commit URL or ' +
              'artifact URL is also fine). Pass ONLY the URL — no surrounding prose, ' +
              'no "PR submitted:" prefix, no description. The URL is rendered as a ' +
              'clickable link in the helldesk review UI, so any extra text breaks ' +
              "reviewers' ability to navigate to the evidence."
          ),
      },
      async execute(args) {
        const result = await client.helldeskDone({
          item_id: args.item_id,
          evidence: args.evidence,
        });
        if (!result.success) return `Failed to mark item ${args.item_id} as done.`;
        return [
          `Marked item ${args.item_id} as done.`,
          result.pr_url
            ? `Pull request: ${result.pr_url}`
            : 'Pull request: pending — open later from the helldesk UI.',
        ].join('\n');
      },
    }),
  };
}
