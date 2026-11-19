import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, sep, normalize } from 'node:path';
import { readSnapshotBlob } from './snapshot';
import type { Db } from './db';

/**
 * Bounded read-only evidence interface backing the reviewer tools.
 *
 * Enforcement is structural, not a "polite promise": every read is routed
 * through a pinned snapshot store or a workspace-rooted path that has been
 * validated against directory traversal and external-directory access. There
 * is no write/bash/exec surface here at all.
 */

export interface EvidenceCtx {
  snapshotId: string;
  store: string;               // snapshot store root
  workspacePath: string;      // real root (for non-git, non-blob reads when allowed)
  manifest: {
    changedFiles: string[];
    baseHash: string | null;
    headHash: string | null;
    requirements: string;
  };
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
}

/** Resolve a path relative to workspace root, guarding traversal. */
export function resolveSafePath(root: string, relPath: string): string | null {
  const clean = relPath.replace(/\\/g, '/');
  const candidate = resolve(root, clean);
  if (!isWithin(resolve(root), candidate)) return null;
  return candidate;
}

export function loadManifest(store: string, snapshotId: string): EvidenceCtx['manifest'] | null {
  const p = join(store, `${snapshotId}.manifest.json`);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as Partial<EvidenceCtx['manifest']> & { workspacePath?: string };
    return {
      changedFiles: Array.isArray(raw.changedFiles) ? raw.changedFiles : [],
      baseHash: raw.baseHash ?? null,
      headHash: raw.headHash ?? null,
      requirements: raw.requirements ?? '',
    };
  } catch {
    return null;
  }
}

export function makeEvidenceCtx(store: string, snapshotId: string, workspacePath: string): EvidenceCtx | null {
  const manifest = loadManifest(store, snapshotId);
  if (!manifest) return null;
  return { snapshotId, store, workspacePath, manifest };
}

// ── review_* evidence tools ─────────────────────────────────────────────

/** List changed files for a frozen target. */
export function reviewListChangedFiles(ctx: EvidenceCtx): string[] {
  return ctx.manifest.changedFiles;
}

/** Read the frozen diff (optionally a substring range). */
export function reviewReadDiff(ctx: EvidenceCtx, path?: string, range?: { start?: number; end?: number }): string {
  const diffPath = join(ctx.store, `${ctx.snapshotId}.diff`);
  let content = '';
  try {
    content = readFileSync(diffPath, 'utf-8');
  } catch {
    return '[no diff captured]';
  }
  if (path) {
    const block = extractHunkForFile(content, path);
    content = block ?? '';
  }
  if (range) {
    const lines = content.split('\n');
    const s = Math.max(0, (range.start ?? 1) - 1);
    const e = range.end ? Math.min(lines.length, range.end) : lines.length;
    return lines.slice(s, e).join('\n');
  }
  return content;
}

function extractHunkForFile(diff: string, file: string): string | null {
  const needle = `diff --git a/${file} b/${file}`;
  const idx = diff.indexOf(needle);
  if (idx === -1) return null;
  const next = diff.indexOf('\ndiff --git ', idx + needle.length);
  return next === -1 ? diff.slice(idx) : diff.slice(idx, next);
}

/** Read a file at a pinned revision (from the blob store), by line range. */
export function reviewReadFile(ctx: EvidenceCtx, revision: string | null, path: string, lineRange?: { start?: number; end?: number }): string {
  // Read the frozen blob captured at snapshot time.
  const blob = readSnapshotBlob(ctx.store, ctx.snapshotId, path);
  const content = blob ?? '[file not captured in snapshot; may be binary/untracked or filtered]';
  if (!lineRange) return content;
  const lines = content.split('\n');
  const s = Math.max(0, (lineRange.start ?? 1) - 1);
  const e = lineRange.end ? Math.min(lines.length, lineRange.end) : lines.length;
  return lines.slice(s, e).join('\n');
}

/** Grep within the frozen snapshot store. Bounded. */
export function reviewSearch(ctx: EvidenceCtx, query: string, pathGlob?: string, limit = 50): string {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  const dir = join(ctx.store, ctx.snapshotId, 'files');
  if (!existsSync(dir)) return '[]';
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(cur); } catch { continue; }
    for (const e of entries) {
      const full = join(cur, e);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile() && st.size < 2 * 1024 * 1024) {
        try {
          const lines = readFileSync(full, 'utf-8').split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line === undefined) break;
            if (line.includes(query)) {
              hits.push({ file: relative(dir, full), line: i + 1, text: line.slice(0, 300) });
              if (hits.length >= limit) break;
            }
          }
        } catch { /* skip */ }
      }
      if (hits.length >= limit) break;
    }
    if (hits.length >= limit) break;
  }
  return JSON.stringify(hits, null, 2);
}

export function reviewGetRequirements(ctx: EvidenceCtx): string {
  return ctx.manifest.requirements || '[no requirements provided]';
}

/** Inspect whether file path + line numbers exist in the frozen snapshot. */
export function verifyPathInSnapshot(ctx: EvidenceCtx, file: string): boolean {
  const safe = file.replace(/^[/\\]+/, '').replace(/[/\\]/g, '__');
  return existsSync(join(ctx.store, ctx.snapshotId, 'files', safe));
}

export function verifyLineRange(ctx: EvidenceCtx, file: string, lineStart: number, lineEnd: number): boolean {
  const content = reviewReadFile(ctx, null, file);
  const lines = content.split('\n').length;
  return lineStart >= 1 && lineEnd >= lineStart && lineEnd <= Math.max(lines, 1);
}

/** Stub forward for the in-repo (non-git folder) read of a source file beyond blob store. */
export function reviewReadFileFromWorkspace(
  workspacePath: string,
  relPath: string,
  lineRange?: { start?: number; end?: number }
): string {
  const safe = resolveSafePath(workspacePath, relPath);
  if (!safe) throw new Error(`Path traversal blocked: ${relPath}`);
  if (!existsSync(safe)) return `[no such file: ${relPath}]`;
  const content = readFileSync(safe, 'utf-8');
  if (!lineRange) return content;
  const lines = content.split('\n');
  const s = Math.max(0, (lineRange.start ?? 1) - 1);
  const e = lineRange.end ? Math.min(lines.length, lineRange.end) : lines.length;
  return lines.slice(s, e).join('\n');
}

/** Helper used by reviewers that need extra context not part of the snapshot. */
export function readSqlRequirement(d: Db, jobId: string): string | null {
  const row = d.db
    .query<{ meta: string | null }, [string]>(`SELECT meta FROM review_jobs WHERE job_id=?`)
    .get(jobId);
  if (!row?.meta) return null;
  try {
    const meta = JSON.parse(row.meta) as { requirements?: string };
    return meta.requirements ?? null;
  } catch {
    return null;
  }
}