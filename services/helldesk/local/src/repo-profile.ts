import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Bounded, READ-ONLY repository profiling for the Task Studio prompt enhancer.
 *
 * This module never writes, never touches the network, and never returns raw
 * file bytes: it exposes git metadata, manifest facts, bounded doc excerpts and
 * per-directory source line counts. Every excerpt that leaves this module is
 * redacted for `TOKEN=` / `API_KEY=` / `SECRET=` / `PASSWORD=` assignments, and
 * secret-like paths (`.env*`, `*.pem`, `*.key`, `secrets*`) are skipped
 * entirely.
 *
 * Output is intentionally bounded (entries, files, bytes, excerpt chars) so a
 * huge checkout cannot blow the enhancer's prompt or runtime budget.
 */

const GIT_TIMEOUT_MS = 15_000;
const MAX_TRACKED_ENTRIES = 20_000;
const MAX_FILES_SCANNED = 2_500;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_EXCERPT_CHARS = 2_000;
const MAX_DOCS = 4;
const MAX_TOP_LEVEL = 40;
const MAX_DIRS = 40;
const MAX_SCRIPTS = 40;
const MAX_RENDER_CHARS = 12_000;
const MAX_DEPTH = 2;

/** Directories that never contribute source facts or line counts. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  'build',
  'coverage',
  '.turbo',
  '.cache',
  '.local',
]);

/** Extensions counted as source for per-directory file/line stats. */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.rs',
  '.go',
  '.py',
  '.pyi',
  '.cs',
  '.fs',
  '.java',
  '.kt',
  '.kts',
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hh',
  '.hpp',
  '.swift',
  '.rb',
  '.php',
  '.lua',
  '.vue',
  '.svelte',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.html',
  '.htm',
  '.sql',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.yml',
  '.yaml',
  '.toml',
  '.ex',
  '.exs',
  '.erl',
  '.clj',
  '.cljs',
  '.dart',
  '.scala',
  '.sol',
  '.zig',
]);

/** Doc/manifest files whose bounded, redacted excerpt helps the enhancer. */
const DOC_NAMES: readonly string[] = ['README.md', 'README', 'AGENTS.md', 'AGENTS', 'tsconfig.json'];

/** Notable top-level file names surfaced to the enhancer (names only). */
const KEY_FILE_NAMES: readonly string[] = [
  'package.json',
  'tsconfig.json',
  'README.md',
  'README',
  'AGENTS.md',
  'AGENTS',
  'CONTRIBUTING.md',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'Makefile',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'vite.config.js',
  'vite.config.ts',
  'vite.config.mts',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
];

/** Dependency -> human label, applied in a stable order. */
const FRAMEWORK_DEPS: ReadonlyArray<readonly [string, string]> = [
  ['next', 'Next.js'],
  ['react', 'React'],
  ['react-dom', 'React'],
  ['vue', 'Vue'],
  ['nuxt', 'Nuxt'],
  ['svelte', 'Svelte'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['@angular/core', 'Angular'],
  ['solid-js', 'Solid'],
  ['astro', 'Astro'],
  ['electron', 'Electron'],
  ['react-native', 'React Native'],
  ['express', 'Express'],
  ['fastify', 'Fastify'],
  ['koa', 'Koa'],
  ['hono', 'Hono'],
  ['elysia', 'Elysia'],
  ['three', 'Three.js'],
  ['@react-three/fiber', 'React Three Fiber'],
  ['vite', 'Vite'],
  ['webpack', 'Webpack'],
  ['tailwindcss', 'Tailwind CSS'],
  ['zod', 'Zod'],
  ['typescript', 'TypeScript'],
  ['vitest', 'Vitest'],
  ['jest', 'Jest'],
  ['mocha', 'Mocha'],
  ['@playwright/test', 'Playwright'],
  ['playwright', 'Playwright'],
  ['drizzle-orm', 'Drizzle ORM'],
  ['prisma', 'Prisma'],
  ['@tanstack/react-query', 'TanStack Query'],
];

export interface RepoDoc {
  name: string;
  excerpt: string;
}

export interface RepoDirStat {
  path: string;
  files: number;
  lines: number;
}

export interface RepoProfileSummary {
  path: string;
  kind: 'git' | 'folder' | 'missing';
  head: string | null;
  branch: string | null;
  /** Count of `git status --porcelain` entries; null when unknown/unavailable. */
  dirtyFiles: number | null;
  /** Count of tracked files from `git ls-files`; null when unknown/unavailable. */
  trackedCount: number | null;
  topLevel: string[];
  frameworks: string[];
  scripts: Record<string, string>;
  keyFiles: string[];
  dirs: RepoDirStat[];
  docs: RepoDoc[];
  notes: string[];
}

export interface RepoProfileOptions {
  gitTimeoutMs?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  maxExcerptChars?: number;
}

const PackageJsonSchema = z
  .object({
    name: z.string().max(300).optional(),
    scripts: z.record(z.string(), z.string().max(20_000)).optional(),
    dependencies: z.record(z.string(), z.string().max(300)).optional(),
    devDependencies: z.record(z.string(), z.string().max(300)).optional(),
    peerDependencies: z.record(z.string(), z.string().max(300)).optional(),
  })
  .passthrough();

type PackageJson = z.infer<typeof PackageJsonSchema>;

interface GitResult {
  ok: boolean;
  out: string;
}

/** Run one bounded, read-only git observation in `cwd`. Never throws. */
function git(cwd: string, args: string[], timeoutMs: number): GitResult {
  try {
    const result = spawnSync('git', ['--no-optional-locks', '-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) return { ok: false, out: '' };
    return { ok: true, out: typeof result.stdout === 'string' ? result.stdout : '' };
  } catch {
    return { ok: false, out: '' };
  }
}

/** True for paths that must never be read or quoted (env/secrets/key files). */
function isSecretLike(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('.env') || lower.endsWith('.pem') || lower.endsWith('.key') || lower.startsWith('secrets');
}

/** Redact `TOKEN=` / `API_KEY=` / `SECRET=` / `PASSWORD=` assignment values. */
export function redactSecrets(text: string): string {
  const assignment = /\b(TOKEN|API_KEY|SECRET|PASSWORD)(\s*[=:]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi;
  return text.replace(assignment, (_match, key: string, separator: string) => `${key}${separator}***redacted***`);
}

function countLines(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  // A trailing newline terminates the last line; it does not open a new one.
  if (text.endsWith('\n')) lines -= 1;
  return lines;
}

function safeStat(file: string): Stats | null {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}

function looksBinary(text: string): boolean {
  const probe = text.length > 8192 ? text.slice(0, 8192) : text;
  return probe.includes('\u0000');
}

/**
 * Read a bounded UTF-8 text file. Returns null for missing/unreadable,
 * oversized, or binary files. Never throws.
 */
function readBoundedText(file: string, maxBytes: number): string | null {
  const stat = safeStat(file);
  if (!stat || !stat.isFile() || stat.size > maxBytes) return null;
  try {
    const text = readFileSync(file, 'utf8');
    return looksBinary(text) ? null : text;
  } catch {
    return null;
  }
}

function readExcerpt(file: string, maxChars: number, maxBytes: number): string | null {
  const text = readBoundedText(file, maxBytes);
  if (text === null) return null;
  const redacted = redactSecrets(text);
  if (redacted.length <= maxChars) return redacted;
  const marker = '\n… [excerpt truncated]';
  return redacted.slice(0, Math.max(0, maxChars - marker.length)) + marker;
}

interface TopLevelListing {
  dirs: string[];
  files: string[];
}

function listTopLevel(root: string): TopLevelListing {
  try {
    const entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => !SKIP_DIRS.has(entry.name) && !isSecretLike(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      dirs: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).slice(0, MAX_TOP_LEVEL),
      files: entries.filter((entry) => entry.isFile()).map((entry) => entry.name).slice(0, MAX_TOP_LEVEL * 10),
    };
  } catch {
    return { dirs: [], files: [] };
  }
}

function readPackageJson(root: string): { pkg: PackageJson | null; note?: string } {
  const file = join(root, 'package.json');
  if (!existsSync(file)) return { pkg: null };
  try {
    const parsed = PackageJsonSchema.safeParse(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
    return parsed.success ? { pkg: parsed.data } : { pkg: null, note: 'package.json does not match the expected shape' };
  } catch {
    return { pkg: null, note: 'package.json could not be parsed' };
  }
}

function detectFrameworks(root: string, pkg: PackageJson | null, topFiles: ReadonlySet<string>): string[] {
  const found: string[] = [];
  const add = (label: string): void => {
    if (!found.includes(label)) found.push(label);
  };
  const deps: Record<string, unknown> = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
    ...(pkg?.peerDependencies ?? {}),
  };
  for (const [dep, label] of FRAMEWORK_DEPS) {
    if (Object.prototype.hasOwnProperty.call(deps, dep)) add(label);
  }
  if (topFiles.has('tsconfig.json') || existsSync(join(root, 'tsconfig.json'))) add('TypeScript');
  if (topFiles.has('Cargo.toml')) add('Rust');
  if (topFiles.has('go.mod')) add('Go');
  if (topFiles.has('pyproject.toml') || topFiles.has('requirements.txt')) add('Python');
  if (topFiles.has('pom.xml')) add('Maven');
  if (topFiles.has('build.gradle') || topFiles.has('build.gradle.kts')) add('Gradle');
  if (
    topFiles.has('Dockerfile') ||
    topFiles.has('docker-compose.yml') ||
    topFiles.has('docker-compose.yaml') ||
    topFiles.has('compose.yml')
  ) {
    add('Docker');
  }
  if (topFiles.has('bun.lock') || topFiles.has('bun.lockb')) add('Bun');
  for (const name of topFiles) {
    if (name.endsWith('.csproj') || name.endsWith('.fsproj')) {
      add('.NET');
      break;
    }
  }
  if (
    topFiles.has('next.config.js') ||
    topFiles.has('next.config.mjs') ||
    topFiles.has('next.config.ts')
  ) {
    add('Next.js');
  }
  if (
    topFiles.has('vite.config.ts') ||
    topFiles.has('vite.config.js') ||
    topFiles.has('vite.config.mts')
  ) {
    add('Vite');
  }
  if (topFiles.has('deno.json') || topFiles.has('deno.jsonc')) add('Deno');
  return found;
}

interface DirStatsResult {
  dirs: RepoDirStat[];
  notes: string[];
}

/**
 * Per top-level directory, count source files and lines at depth <= 2.
 * Bounded by file count and per-file bytes; skips binary and secret-like files.
 */
function collectDirStats(root: string, maxFiles: number, maxFileBytes: number): DirStatsResult {
  const notes: string[] = [];
  const dirs: RepoDirStat[] = [];
  let scanned = 0;
  let skippedLarge = 0;
  let skippedBinary = 0;

  let topEntries: Dirent[];
  try {
    topEntries = readdirSync(root, { withFileTypes: true });
  } catch {
    return { dirs, notes: ['repository root could not be read'] };
  }

  const topDirs = topEntries
    .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !isSecretLike(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const dir of topDirs.slice(0, MAX_DIRS)) {
    let files = 0;
    let lines = 0;

    const walk = (absPath: string, depth: number): void => {
      if (depth > MAX_DEPTH || scanned >= maxFiles) return;
      let children: Dirent[];
      try {
        children = readdirSync(absPath, { withFileTypes: true });
      } catch {
        return;
      }
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        if (scanned >= maxFiles) return;
        if (SKIP_DIRS.has(child.name) || isSecretLike(child.name)) continue;
        const childPath = join(absPath, child.name);
        if (child.isDirectory()) {
          if (depth < MAX_DEPTH) walk(childPath, depth + 1);
          continue;
        }
        if (!child.isFile()) continue;
        if (!SOURCE_EXTENSIONS.has(extname(child.name).toLowerCase())) continue;
        scanned += 1;
        const stat = safeStat(childPath);
        if (!stat) {
          skippedBinary += 1;
          continue;
        }
        if (stat.size > maxFileBytes) {
          skippedLarge += 1;
          continue;
        }
        const text = readBoundedText(childPath, maxFileBytes);
        if (text === null) {
          skippedBinary += 1;
          continue;
        }
        files += 1;
        lines += countLines(text);
      }
    };

    walk(join(root, dir.name), 1);
    if (files > 0) dirs.push({ path: dir.name, files, lines });
  }

  if (scanned >= maxFiles) notes.push(`source file scan truncated at ${maxFiles} files`);
  if (skippedLarge > 0) notes.push(`skipped ${skippedLarge} oversized source file(s)`);
  if (skippedBinary > 0) notes.push(`skipped ${skippedBinary} binary/unreadable source file(s)`);
  return { dirs, notes };
}

function countNonEmptyLines(text: string): number {
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length > 0) count += 1;
  }
  return count;
}

/**
 * Profile one repository/path READ-ONLY. Never throws: unreadable, missing or
 * non-directory paths degrade to a `missing` profile with an explanatory note.
 */
export function profileRepo(inputPath: string, options: RepoProfileOptions = {}): RepoProfileSummary {
  const gitTimeoutMs = options.gitTimeoutMs ?? GIT_TIMEOUT_MS;
  const maxFiles = options.maxFiles ?? MAX_FILES_SCANNED;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const maxExcerptChars = options.maxExcerptChars ?? MAX_EXCERPT_CHARS;

  const path = resolve(inputPath || '.');
  const profile: RepoProfileSummary = {
    path,
    kind: 'folder',
    head: null,
    branch: null,
    dirtyFiles: null,
    trackedCount: null,
    topLevel: [],
    frameworks: [],
    scripts: {},
    keyFiles: [],
    dirs: [],
    docs: [],
    notes: [],
  };

  if (!existsSync(path)) return { ...profile, kind: 'missing', notes: ['path does not exist'] };
  const stat = safeStat(path);
  if (!stat || !stat.isDirectory()) return { ...profile, kind: 'missing', notes: ['path is not a directory'] };

  // ── git metadata (read-only; a non-git folder stays kind='folder') ───────
  const topLevelGit = git(path, ['rev-parse', '--show-toplevel'], gitTimeoutMs);
  const gitRoot = topLevelGit.ok ? topLevelGit.out.trim() : '';
  if (gitRoot) {
    profile.kind = 'git';
    if (resolve(gitRoot) !== path) profile.notes.push(`git root: ${gitRoot}`);

    const head = git(path, ['rev-parse', 'HEAD'], gitTimeoutMs);
    if (head.ok && head.out.trim()) profile.head = head.out.trim();

    const branch = git(path, ['rev-parse', '--abbrev-ref', 'HEAD'], gitTimeoutMs);
    if (branch.ok && branch.out.trim()) profile.branch = branch.out.trim();

    const status = git(path, ['status', '--porcelain'], gitTimeoutMs);
    if (status.ok) profile.dirtyFiles = countNonEmptyLines(status.out);
    else profile.notes.push('git status unavailable');

    const tracked = git(path, ['ls-files'], gitTimeoutMs);
    if (tracked.ok) {
      const entries = tracked.out.split(/\r?\n/).filter((line) => line.length > 0);
      profile.trackedCount = entries.length;
      if (entries.length > MAX_TRACKED_ENTRIES) {
        profile.notes.push(`tracked file listing truncated at ${MAX_TRACKED_ENTRIES} entries`);
      }
    } else {
      profile.notes.push('git ls-files unavailable');
    }
  } else {
    profile.notes.push('not a git repository; profiling as a plain folder');
  }

  // ── manifests / frameworks / scripts ─────────────────────────────────────
  const listing = listTopLevel(path);
  profile.topLevel = listing.dirs;
  const topFiles = new Set(listing.files);
  const keyFiles = KEY_FILE_NAMES.filter((name) => topFiles.has(name) || existsSync(join(path, name)));
  profile.keyFiles = keyFiles;

  const pkgRead = readPackageJson(path);
  if (pkgRead.note) profile.notes.push(pkgRead.note);
  if (pkgRead.pkg?.scripts) {
    const scriptEntries = Object.entries(pkgRead.pkg.scripts);
    for (const [name, command] of scriptEntries.slice(0, MAX_SCRIPTS)) {
      profile.scripts[name] = redactSecrets(command);
    }
    if (scriptEntries.length > MAX_SCRIPTS) profile.notes.push(`scripts truncated at ${MAX_SCRIPTS}`);
  }
  profile.frameworks = detectFrameworks(path, pkgRead.pkg, topFiles);

  // ── bounded source dir stats + doc excerpts ──────────────────────────────
  const dirStats = collectDirStats(path, maxFiles, maxFileBytes);
  profile.dirs = dirStats.dirs;
  profile.notes.push(...dirStats.notes);

  for (const name of DOC_NAMES) {
    if (profile.docs.length >= MAX_DOCS) break;
    const file = join(path, name);
    if (!existsSync(file)) continue;
    const excerpt = readExcerpt(file, maxExcerptChars, maxFileBytes);
    if (excerpt === null) {
      profile.notes.push(`${name} skipped (binary, oversized, or unreadable)`);
      continue;
    }
    profile.docs.push({ name, excerpt });
  }

  return profile;
}

/** Render a bounded markdown profile for an enhancer prompt. */
export function renderRepoProfile(profile: RepoProfileSummary, options: { maxChars?: number } = {}): string {
  const maxChars = Math.max(1_000, options.maxChars ?? MAX_RENDER_CHARS);
  const lines: string[] = [];
  lines.push(`# Repository profile: ${profile.path}`);
  lines.push('');
  lines.push(`- kind: ${profile.kind}`);
  lines.push(`- head: ${profile.head ?? '(none)'}`);
  lines.push(`- branch: ${profile.branch ?? '(none)'}`);
  lines.push(`- dirty files: ${profile.dirtyFiles ?? 'unknown'}`);
  lines.push(`- tracked files: ${profile.trackedCount ?? 'unknown'}`);
  lines.push(`- frameworks: ${profile.frameworks.length ? profile.frameworks.join(', ') : '(none detected)'}`);
  lines.push(`- top-level dirs: ${profile.topLevel.length ? profile.topLevel.join(', ') : '(none)'}`);
  if (profile.keyFiles.length) lines.push(`- key files: ${profile.keyFiles.join(', ')}`);

  const scriptEntries = Object.entries(profile.scripts);
  if (scriptEntries.length) {
    lines.push('- scripts:');
    for (const [name, command] of scriptEntries) lines.push(`  - ${name}: ${command}`);
  }

  if (profile.dirs.length) {
    lines.push('- source dirs (files/lines):');
    for (const dir of profile.dirs) lines.push(`  - ${dir.path}: ${dir.files} files, ${dir.lines} lines`);
  }

  if (profile.docs.length) {
    lines.push('');
    lines.push('## Docs');
    for (const doc of profile.docs) {
      lines.push('');
      lines.push(`### ${doc.name}`);
      lines.push(doc.excerpt);
    }
  }

  if (profile.notes.length) {
    lines.push('');
    lines.push('## Notes');
    for (const note of profile.notes) lines.push(`- ${note}`);
  }

  const rendered = lines.join('\n');
  if (rendered.length <= maxChars) return rendered;
  const marker = '\n… [repository profile truncated]';
  return rendered.slice(0, Math.max(0, maxChars - marker.length)) + marker;
}
