/**
 * Map REAL headless-Kilo session messages into operator-chat transcript rows.
 *
 * `client.session.messages()` returns `Array<{ info: Message; parts: Part[] }>`
 * where info.role is the speaker and parts carry text / reasoning / tool state.
 * This mapper is pure (no I/O) so the transcript contract is unit-testable and
 * the runner can poll it live without duplicating rows (each row gets a stable
 * `partId`).
 */

import type { ReviewVerdict } from './review-contract';

export interface ChatTranscriptBase {
  missionId: string;
  ticketId?: string;
  revisionId?: string;
  sessionId: string;
}

export interface ChatTranscriptItem {
  partId: string;
  role: 'user' | 'assistant' | 'system';
  kind: 'text' | 'reasoning' | 'tool_call' | 'tool_result';
  text?: string;
  toolName?: string;
  toolInput?: string;
  toolResult?: string;
}

/** Bound tool payloads so a single `cat` cannot bloat the transcript DB. */
const MAX_TOOL_CHARS = 20_000;
/** Bound one text message; the final summary is bounded far below this. */
const MAX_TEXT_CHARS = 60_000;

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n… [${value.length - max} chars truncated]`;
}

function stringifyTool(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return clip(text, MAX_TOOL_CHARS);
  } catch {
    return clip(String(value), MAX_TOOL_CHARS);
  }
}

/**
 * Convert the raw session-message array to transcript items.
 * Unknown part types (step/snapshot/patch/file/agent/retry/compaction) are
 * skipped on purpose: the chat shows speech and tool work, not internals.
 */
export function mapKiloSessionMessages(messages: unknown): ChatTranscriptItem[] {
  if (!Array.isArray(messages)) return [];
  const out: ChatTranscriptItem[] = [];
  for (const entry of messages) {
    if (!entry || typeof entry !== 'object') continue;
    const info = (entry as { info?: { role?: unknown } }).info;
    const parts = (entry as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    const role = info?.role === 'user' ? 'user' : info?.role === 'assistant' ? 'assistant' : 'system';
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const p = part as {
        id?: unknown;
        type?: unknown;
        text?: unknown;
        tool?: unknown;
        state?: { status?: unknown; input?: unknown; output?: unknown; error?: unknown };
      };
      const id = typeof p.id === 'string' ? p.id : undefined;
      if (!id) continue;
      if (p.type === 'text') {
        const text = typeof p.text === 'string' ? p.text.trim() : '';
        if (!text) continue;
        out.push({ partId: `${id}:text`, role, kind: 'text', text: clip(text, MAX_TEXT_CHARS) });
        continue;
      }
      if (p.type === 'reasoning') {
        const text = typeof p.text === 'string' ? p.text.trim() : '';
        if (!text) continue;
        out.push({ partId: `${id}:reasoning`, role, kind: 'reasoning', text: clip(text, MAX_TEXT_CHARS) });
        continue;
      }
      if (p.type === 'tool') {
        const toolName = typeof p.tool === 'string' ? p.tool : 'tool';
        const state = p.state ?? {};
        const toolInput = stringifyTool(state.input);
        out.push({
          partId: `${id}:call`,
          role: 'assistant',
          kind: 'tool_call',
          toolName,
          ...(toolInput ? { toolInput } : {}),
        });
        const status = state.status;
        if (status === 'completed') {
          out.push({
            partId: `${id}:result`,
            role: 'assistant',
            kind: 'tool_result',
            toolName,
            ...(typeof state.output === 'string' ? { toolResult: clip(state.output, MAX_TOOL_CHARS) } : {}),
          });
        } else if (status === 'error') {
          out.push({
            partId: `${id}:result`,
            role: 'assistant',
            kind: 'tool_result',
            toolName,
            toolResult: clip(`ERROR: ${typeof state.error === 'string' ? state.error : 'tool failed'}`, MAX_TOOL_CHARS),
          });
        }
      }
    }
  }
  return out;
}

/** Human label for a mirrored review speaker. */
export function reviewSpeakerLabel(speaker: string): string {
  switch (speaker) {
    case 'reviewer-a': return 'Reviewer A';
    case 'reviewer-b': return 'Reviewer B';
    case 'adjudicator': return 'Adjudicator';
    case 'soul': return 'Soul';
    default: return speaker;
  }
}

/**
 * Render one real reviewer/adjudicator verdict as markdown for the operator
 * chat. The verdict is the SAME zod-validated object the gate logic used; this
 * only formats it, never re-interprets it.
 */
export function renderReviewVerdictMarkdown(speaker: string, verdict: ReviewVerdict): string {
  const label = reviewSpeakerLabel(speaker);
  const coverage = verdict.coverage;
  const uncovered = coverage.uncoveredPaths.length ? `; uncovered: ${coverage.uncoveredPaths.join(', ')}` : '';
  const lines: string[] = [
    `**${label}: ${verdict.result}**`,
    '',
    `Coverage: ${coverage.inspectedFiles}/${coverage.changedFiles} files inspected${uncovered}`,
  ];
  if (verdict.findings.length === 0) {
    lines.push('No findings.');
  } else {
    lines.push('', 'Findings:');
    for (const finding of verdict.findings) {
      const location = finding.file
        ? ` (\`${finding.file}\`${finding.lineStart ? `:${finding.lineStart}` : ''})`
        : '';
      lines.push(`- **${finding.severity}** ${finding.title}${location}`);
    }
  }
  return lines.join('\n');
}