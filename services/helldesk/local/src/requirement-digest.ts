/**
 * Generic requirement distillation — TASK-AGNOSTIC.
 *
 * The reviewer/adjudicator must judge the task's OWN requirements, not a
 * hardcoded notion of what a good change looks like. This module turns any
 * mission objective into a compact, checkable checklist by reading its structure
 * (sections, numbered deliverables, constraints, definition of done). It never
 * knows or cares what the domain is (framework extraction, bug fix, refactor,
 * data migration, …).
 *
 * Deterministic, no model call: the same objective always yields the same
 * checklist, and the checklist is part of the frozen review requirements.
 */

export interface RequirementDigest {
  /** "Must produce" items (numbered/bulleted deliverables, definition of done). */
  deliverables: string[];
  /** Prohibitions/limits ("must not", "never", "do not", "only", non-goals). */
  constraints: string[];
  /** Explicit acceptance criteria / done-when items. */
  definitionOfDone: string[];
  /** Deliverables + DoD, ready to be checked against frozen evidence. */
  checklist: string[];
}

const MAX_ITEM = 320;
const MAX_ITEMS = 24;

type Section = 'deliverable' | 'constraint' | 'done' | 'other';

const DELIVERABLE_HEADING = /\b(deliverable|required|requirements?|goal|scope|what to (?:build|do)|output|artifacts?)\b/i;
const CONSTRAINT_HEADING = /\b(constraints?|non[- ]?goals?|limits?|prohibitions?|rules?)\b/i;
const DONE_HEADING = /\b(definition of done|done when|acceptance criteria|success criteria|verified when|completion criteria)\b/i;
const ITEM = /^\s*(?:\d+[.)]|[-*•])\s+(.+)$/;
const CONSTRAINT_LINE = /\b(do not|don't|must not|must never|never|forbidden|non[- ]?goal|only|no (?:probe|scratch|log|diagnostic|placeholder))\b/i;
const REQUIREMENT_PROSE = /\b(create|build|implement|add|refactor|extract|migrate|fix|ensure|must|shall|provide|write|keep|wire|test)\b/i;

function clip(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= MAX_ITEM ? text : `${text.slice(0, MAX_ITEM - 1)}…`;
}

function push(arr: string[], seen: Set<string>, value: string): void {
  const item = clip(value);
  if (!item) return;
  const key = item.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  if (arr.length < MAX_ITEMS) arr.push(item);
}

/**
 * Distill an objective into deliverables / constraints / definition of done.
 * Works for any domain; falls back gracefully when the objective has no headings.
 */
export function digestRequirements(objective: string): RequirementDigest {
  const lines = (objective ?? '').replace(/\r\n?/g, '\n').split('\n');
  const deliverables: string[] = [];
  const constraints: string[] = [];
  const definitionOfDone: string[] = [];
  const seen = new Set<string>();
  let section: Section = 'other';
  const prose: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // A heading without a bullet resets the section context. Headings are SHORT
    // labels ("Constraints:", "Definition of done:") — a prose sentence that
    // merely contains a keyword ("…This is the only deliverable.") is not one.
    const item = ITEM.exec(line);
    if (!item) {
      const headingLike = line.length <= 80 && (line.endsWith(':') || line.length <= 40);
      if (headingLike && DONE_HEADING.test(line)) section = 'done';
      else if (headingLike && CONSTRAINT_HEADING.test(line)) section = 'constraint';
      else if (headingLike && DELIVERABLE_HEADING.test(line)) section = 'deliverable';
      else prose.push(line);
      continue;
    }

    const body = item[1] ?? '';
    prose.push(body);
    if (!body) continue;
    if (CONSTRAINT_LINE.test(body) || section === 'constraint') push(constraints, seen, body);
    else if (section === 'done') push(definitionOfDone, seen, body);
    else push(deliverables, seen, body); // deliverable + fallback for unlabelled lists
  }

  // FALLBACK for flat/prose objectives (no bullets): split into SENTENCES so a
  // requirement and a prohibition in the same paragraph are classified apart.
  const sentences = prose.flatMap((p) => p.split(/(?<=[.!?])\s+/)).map((s) => s.trim()).filter(Boolean);
  if (deliverables.length === 0 && definitionOfDone.length === 0) {
    for (const sentence of sentences) {
      if (CONSTRAINT_LINE.test(sentence)) push(constraints, seen, sentence);
      else if (REQUIREMENT_PROSE.test(sentence)) push(deliverables, seen, sentence);
    }
  } else {
    for (const sentence of sentences) {
      if (CONSTRAINT_LINE.test(sentence)) push(constraints, seen, sentence);
    }
  }

  const checklist = [...deliverables, ...definitionOfDone];
  return { deliverables, constraints, definitionOfDone, checklist };
}

/** Render the distilled requirements as a reviewer-facing block. */
export function renderRequirementChecklist(digest: RequirementDigest): string {
  const out: string[] = [];
  if (digest.checklist.length) {
    out.push('ACCEPTANCE CHECKLIST (distilled from the task; verify EACH item against the frozen evidence, cite an artifact per item, and do not PASS a gate while an item is unproven):');
    for (const item of digest.checklist) out.push(`  - [ ] ${item}`);
  }
  if (digest.constraints.length) {
    out.push('TASK CONSTRAINTS (a violation is at least a HIGH finding; a scope/security violation is a BLOCKER):');
    for (const item of digest.constraints) out.push(`  - ${item}`);
  }
  return out.join('\n');
}
