import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { extname, join } from 'node:path';

/**
 * Collects the images a review worker should see: requirement reference
 * attachments named in the task requirements (absolute attachment-store
 * paths) plus evidence screenshots committed in the reviewed workspace.
 *
 * This is text/metadata driven on purpose: the attachment manifest block is
 * already embedded in the mission/ticket requirements, so no schema change is
 * needed to move pixels from Task Studio to reviewer/governor workers.
 */

const MAX_REVIEW_FILES = 4;
const MAX_FILE_BYTES = 6 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const EVIDENCE_DIRS = ['proof', 'artifacts', 'screenshots', 'qa', 'evidence'];
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  'target',
  '.turbo',
  '.cache',
]);

const ATTACHMENT_PATH_RE =
  /[A-Za-z]:[\\/][^\r\n"'`)]*[\\/]attachments[\\/]att_[A-Za-z0-9]+[\\/][^\s"'`)]+/g;

function imageBytes(path: string): number {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE_BYTES) return 0;
    return stat.size;
  } catch {
    return 0;
  }
}

function walkImages(dir: string, depth: number, out: string[]): void {
  if (depth > 3 || out.length >= MAX_REVIEW_FILES) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_REVIEW_FILES) return;
    const name = String(entry.name);
    const path = join(dir, name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(name.toLowerCase())) continue;
      walkImages(path, depth + 1, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!IMAGE_EXTENSIONS.has(extname(name).toLowerCase())) continue;
    if (imageBytes(path) === 0) continue;
    out.push(path);
  }
}

function priorityRank(path: string): number {
  const lower = path.toLowerCase();
  for (let index = 0; index < EVIDENCE_DIRS.length; index += 1) {
    if (lower.includes(`\\${EVIDENCE_DIRS[index]}\\`) || lower.includes(`/${EVIDENCE_DIRS[index]}/`)) {
      return index;
    }
  }
  return EVIDENCE_DIRS.length;
}

export interface CollectReviewFilesOptions {
  requirements: string;
  workspace: string;
  maxFiles?: number;
}

/** Returns absolute image paths, reference attachments first, then evidence. */
export function collectReviewFiles(opts: CollectReviewFilesOptions): string[] {
  const maxFiles = Math.max(1, Math.min(opts.maxFiles ?? MAX_REVIEW_FILES, MAX_REVIEW_FILES));
  const files: string[] = [];
  const seen = new Set<string>();

  const add = (path: string): void => {
    if (files.length >= maxFiles) return;
    if (!path || seen.has(path)) return;
    if (!IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) return;
    if (imageBytes(path) === 0) return;
    seen.add(path);
    files.push(path);
  };

  if (opts.requirements) {
    for (const match of opts.requirements.matchAll(ATTACHMENT_PATH_RE)) {
      add(match[0]);
      if (files.length >= maxFiles) break;
    }
  }

  if (files.length < maxFiles && opts.workspace && existsSync(opts.workspace)) {
    const candidates: string[] = [];
    walkImages(opts.workspace, 0, candidates);
    candidates.sort((a, b) => priorityRank(a) - priorityRank(b));
    for (const candidate of candidates) add(candidate);
  }

  return files;
}
