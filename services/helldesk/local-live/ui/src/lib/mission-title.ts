/**
 * mission-title.ts — turn a mission OBJECTIVE into the short, human-readable
 * TASK NAME the operator console shows in its header.
 *
 * A mission has no separate title column: the objective is the contract. Its
 * first meaningful sentence is the task ("Extract a reusable 2D/3D game
 * framework from the existing game code (NAI CARDS)."), so that is what the
 * operator reads — never the raw `mis_…` id.
 *
 * Pure and framework-free so every console surface (operator header, session
 * heading, future boards) names the same task the same way.
 */

/** Upper bound for the header chip; long enough for a real sentence, short
 *  enough to stay on one line at 4K and at 1280px. */
export const MISSION_TASK_NAME_MAX = 96;

/** CLI-ish / prose scaffolding that is not part of a task name. */
function cleanLine(line: string): string {
  return line
    .replace(/\r/g, '')
    .trim()
    // markdown heading / list / checkbox prefix
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*•]\s+/, '')
    .replace(/^\[[ xX]\]\s*/, '')
    .replace(/^\d+[.)]\s+/, '')
    // wrapper quotes / backticks around the whole line
    .replace(/^[`"'“”]+/, '')
    .replace(/[`"'“”]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A line that only labels the following text ("Goal:", "Deliverable:"). */
function isLabelLine(line: string): boolean {
  return /^[A-Za-z][\w /-]{0,24}:$/.test(line);
}

/**
 * A machine envelope tag, not a task name:
 *   [HELLDESK ticket 0159d0fc-…]
 *   [LEGACY-ENVELOPE 8eaf9800-…]  (historical engine records)
 * mission-dispatch deliberately prefixes the objective with the ticket id so the
 * mutation agent can find it; the operator must never read that wrapper as the
 * task name.
 */
function isMachineTagLine(line: string): boolean {
  return /^\[[^\]]+\]$/.test(line);
}

/** Bound the name at a word boundary, with a visible ellipsis. */
function bound(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.5 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/**
 * Derive the operator-facing task name from a mission objective.
 * @param objective mission objective (multi-paragraph markdown is expected)
 * @param fallback  shown when the objective is empty — normally the mission id
 */
export function missionTaskName(objective?: string | null, fallback?: string | null): string {
  const lines = (objective ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((raw) => ({ heading: /^#{1,6}\s/.test(raw.trim()), text: cleanLine(raw) }))
    // A label ("Goal:") names the section, not the task; a bracket tag is the
    // machine envelope, not the task.
    .filter((line) => line.text.length > 0 && !isLabelLine(line.text) && !isMachineTagLine(line.text));
  // A markdown heading is a document title; prefer the first prose line, and use
  // the heading only when the objective is nothing but headings.
  const name = (lines.find((line) => !line.heading) ?? lines[0])?.text ?? '';
  if (!name) return (fallback ?? '').trim() || 'Mission';
  return bound(name, MISSION_TASK_NAME_MAX);
}
