'use client';

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { canonicalWorkspaceKey, isScratchWorkspacePath } from '@/lib/workspace-path';
import { useDrawerStack } from '@/components/helldesk/DrawerStack';
import type {
  CommitDetail,
  CommitFile,
  CommitFileDiff,
  CommitProvenance,
  CommitSummary,
  CommitWorkspace,
} from '@/lib/trpc/commits';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderGit2,
  GitBranch,
  GitMerge,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
} from '@/lib/icons';
import { format, formatDistanceToNow } from 'date-fns';

// Stable empty defaults keep query/memo dependencies from changing every render.
const EMPTY_WORKSPACES: CommitWorkspace[] = [];
const EMPTY_COMMITS: CommitSummary[] = [];

// ── formatting ───────────────────────────────────────────────────────────────

function relative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '—';
  return formatDistanceToNow(new Date(ts), { addSuffix: true });
}

function absolute(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '—';
  return format(new Date(ts), 'yyyy-MM-dd HH:mm:ss');
}

const STATUS_STYLE: Record<CommitFile['status'], { badge: string; label: string }> = {
  A: { badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20', label: 'A' },
  M: { badge: 'bg-amber-500/15 text-amber-400 border-amber-500/20', label: 'M' },
  D: { badge: 'bg-red-500/15 text-red-400 border-red-500/20', label: 'D' },
  R: { badge: 'bg-sky-500/15 text-sky-400 border-sky-500/20', label: 'R' },
  C: { badge: 'bg-violet-500/15 text-violet-400 border-violet-500/20', label: 'C' },
  T: { badge: 'bg-white/10 text-white/50 border-white/10', label: 'T' },
  U: { badge: 'bg-orange-500/15 text-orange-400 border-orange-500/20', label: 'U' },
  X: { badge: 'bg-white/10 text-white/50 border-white/10', label: 'X' },
};

function StatusBadge({ status }: { status: CommitFile['status'] }) {
  const style = STATUS_STYLE[status] ?? STATUS_STYLE.M;
  return (
    <span className={`inline-flex size-4 shrink-0 items-center justify-center rounded border font-mono text-[9px] font-semibold ${style.badge}`}>
      {style.label}
    </span>
  );
}

function StatPair({ additions, deletions }: { additions: number | null; deletions: number | null }) {
  return (
    <span className="shrink-0 font-mono text-[9px]">
      {additions === null ? (
        <span className="text-white/25">bin</span>
      ) : (
        <>
          <span className="text-emerald-400/80">+{additions}</span>{' '}
          <span className="text-red-400/80">−{deletions ?? 0}</span>
        </>
      )}
    </span>
  );
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard permissions can be denied; do not pretend it copied.
  }
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={`Copy ${label}`}
      onClick={async () => {
        await copyText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="inline-flex items-center gap-1 rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white/70"
    >
      {copied ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
      {copied ? 'copied' : label}
    </button>
  );
}

// ── syntax highlighting (lightweight, dependency-free) ───────────────────────

const KEYWORDS = new Set([
  'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally',
  'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'instanceof', 'interface',
  'keyof', 'let', 'new', 'null', 'of', 'private', 'protected', 'public', 'readonly', 'return',
  'satisfies', 'set', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'type',
  'typeof', 'undefined', 'var', 'void', 'while', 'yield',
]);

function languageOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'ts';
  if (['json', 'jsonc'].includes(ext)) return 'json';
  if (['css', 'scss', 'less'].includes(ext)) return 'css';
  if (['html', 'htm'].includes(ext)) return 'html';
  if (['c', 'h', 'cc', 'cpp', 'hpp'].includes(ext)) return 'cpp';
  if (['sh', 'bash', 'ps1'].includes(ext)) return 'sh';
  if (['md', 'mdx'].includes(ext)) return 'md';
  return 'text';
}

const TOKEN_RE = /(\/\/[^\n]*|\/\*[^\n]*?\*\/|#[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;

function highlightLine(text: string, language: string): ReactNode {
  if (language === 'text' || language === 'md') return text;
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    let className = '';
    if (token.startsWith('//') || token.startsWith('/*') || (token.startsWith('#') && language !== 'css')) {
      className = 'text-white/30 italic';
    } else if (token.startsWith("'") || token.startsWith('"') || token.startsWith('`')) {
      className = language === 'json' ? 'text-emerald-300/80' : 'text-amber-300/80';
    } else if (/^\d/.test(token)) {
      className = 'text-sky-300/80';
    } else if (KEYWORDS.has(token)) {
      className = 'text-violet-300/90';
    } else if (/^[A-Z]/.test(token) && language !== 'json') {
      className = 'text-cyan-300/80';
    }
    nodes.push(
      className ? (
        <span key={`t${key++}`} className={className}>{token}</span>
      ) : (
        <Fragment key={`t${key++}`}>{token}</Fragment>
      )
    );
    last = index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// ── diff parsing / rendering ─────────────────────────────────────────────────

type LineKind = 'add' | 'del' | 'context' | 'meta';

interface DiffLine {
  kind: LineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

function parsePatch(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (!header) continue;
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      current = { header: raw, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('\\ No newline')) {
      current.lines.push({ kind: 'meta', oldLine: null, newLine: null, text: raw });
    } else if (raw.startsWith('+') && !raw.startsWith('+++')) {
      current.lines.push({ kind: 'add', oldLine: null, newLine: newLine++, text: raw.slice(1) });
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      current.lines.push({ kind: 'del', oldLine: oldLine++, newLine: null, text: raw.slice(1) });
    } else if (raw.startsWith(' ')) {
      current.lines.push({ kind: 'context', oldLine: oldLine++, newLine: newLine++, text: raw.slice(1) });
    }
  }
  return hunks;
}

interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
  meta?: string;
}

function toSplitRows(hunks: DiffHunk[]): Array<{ header: string; rows: SplitRow[] }> {
  return hunks.map(hunk => {
    const rows: SplitRow[] = [];
    let deletions: DiffLine[] = [];
    let additions: DiffLine[] = [];
    const flush = () => {
      const count = Math.max(deletions.length, additions.length);
      for (let i = 0; i < count; i += 1) {
        rows.push({ left: deletions[i] ?? null, right: additions[i] ?? null });
      }
      deletions = [];
      additions = [];
    };
    for (const line of hunk.lines) {
      if (line.kind === 'del') deletions.push(line);
      else if (line.kind === 'add') additions.push(line);
      else if (line.kind === 'meta') {
        flush();
        rows.push({ left: null, right: null, meta: line.text });
      } else {
        flush();
        rows.push({ left: line, right: line });
      }
    }
    flush();
    return { header: hunk.header, rows };
  });
}

const LINE_BG: Record<LineKind, string> = {
  add: 'bg-emerald-500/[0.08]',
  del: 'bg-red-500/[0.08]',
  context: '',
  meta: 'bg-white/[0.02]',
};

function UnifiedDiff({ hunks, language }: { hunks: DiffHunk[]; language: string }) {
  return (
    <div className="min-w-full font-mono text-[11px] leading-[1.6]">
      {hunks.map((hunk, hi) => (
        <div key={`${hunk.header}-${hi}`}>
          <div className="sticky top-0 z-10 border-y border-white/[0.06] bg-[#0b0b0b]/95 px-3 py-1 font-mono text-[10px] text-sky-300/60 backdrop-blur">
            {hunk.header}
          </div>
          {hunk.lines.map((line, li) => (
            <div key={li} className={`flex min-w-max ${LINE_BG[line.kind]}`}>
              <span className="w-11 shrink-0 select-none border-r border-white/[0.04] pr-2 text-right text-[10px] text-white/20">
                {line.oldLine ?? ''}
              </span>
              <span className="w-11 shrink-0 select-none border-r border-white/[0.04] pr-2 text-right text-[10px] text-white/20">
                {line.newLine ?? ''}
              </span>
              <span className={`w-4 shrink-0 select-none text-center ${line.kind === 'add' ? 'text-emerald-400' : line.kind === 'del' ? 'text-red-400' : 'text-white/20'}`}>
                {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : line.kind === 'meta' ? '\\' : ''}
              </span>
              <code className="whitespace-pre pr-4 text-white/70">
                {line.kind === 'meta' ? <span className="text-white/30 italic">{line.text}</span> : highlightLine(line.text, language)}
              </code>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function SideCell({ line, language, side }: { line: DiffLine | null; language: string; side: 'left' | 'right' }) {
  if (!line) {
    return <div className="h-[18px] bg-white/[0.01]" />;
  }
  const bg = side === 'left' && line.kind === 'del'
    ? 'bg-red-500/[0.08]'
    : side === 'right' && line.kind === 'add'
      ? 'bg-emerald-500/[0.08]'
      : '';
  return (
    <div className={`flex ${bg}`}>
      <span className="w-10 shrink-0 select-none border-r border-white/[0.04] pr-2 text-right text-[10px] text-white/20">
        {side === 'left' ? line.oldLine ?? '' : line.newLine ?? ''}
      </span>
      <code className="whitespace-pre px-2 text-white/70">
        {highlightLine(line.text, language)}
      </code>
    </div>
  );
}

function SplitDiff({ hunks, language }: { hunks: DiffHunk[]; language: string }) {
  const sections = useMemo(() => toSplitRows(hunks), [hunks]);
  return (
    <div className="min-w-full font-mono text-[11px] leading-[1.6]">
      {sections.map((section, si) => (
        <div key={`${section.header}-${si}`}>
          <div className="border-y border-white/[0.06] bg-[#0b0b0b]/95 px-3 py-1 font-mono text-[10px] text-sky-300/60">
            {section.header}
          </div>
          <div className="grid w-full grid-cols-2 divide-x divide-white/[0.05]">
            <div className="min-w-0 overflow-x-auto">
              {section.rows.map((row, ri) =>
                row.meta ? (
                  <div key={ri} className="px-2 text-[10px] text-white/25 italic">{row.meta}</div>
                ) : (
                  <SideCell key={ri} line={row.left} language={language} side="left" />
                )
              )}
            </div>
            <div className="min-w-0 overflow-x-auto">
              {section.rows.map((row, ri) =>
                row.meta ? (
                  <div key={ri} className="h-[18px]" />
                ) : (
                  <SideCell key={ri} line={row.right} language={language} side="right" />
                )
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── file tree ────────────────────────────────────────────────────────────────

interface DirNode {
  name: string;
  path: string;
  dirs: Map<string, DirNode>;
  files: CommitFile[];
}

function buildTree(files: CommitFile[]): DirNode {
  const root: DirNode = { name: '', path: '', dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const name = parts[i]!;
      const path = dir.path ? `${dir.path}/${name}` : name;
      const existing = dir.dirs.get(name);
      if (existing) dir = existing;
      else {
        const next: DirNode = { name, path, dirs: new Map(), files: [] };
        dir.dirs.set(name, next);
        dir = next;
      }
    }
    dir.files.push(file);
  }
  return root;
}

function FileTree({
  files,
  selectedPath,
  onSelect,
}: {
  files: CommitFile[];
  selectedPath: string | null;
  onSelect: (file: CommitFile) => void;
}) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (path: string) => {
    setCollapsed(previous => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderFile = (file: CommitFile) => {
    const name = file.path.split('/').pop() ?? file.path;
    const active = file.path === selectedPath;
    return (
      <button
        key={file.path}
        type="button"
        onClick={() => onSelect(file)}
        className={`flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[11px] transition-colors ${
          active ? 'bg-white/[0.07] text-white/85' : 'text-white/55 hover:bg-white/[0.03] hover:text-white/75'
        }`}
        title={file.path}
      >
        <StatusBadge status={file.status} />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <StatPair additions={file.additions} deletions={file.deletions} />
      </button>
    );
  };

  const renderDir = (dir: DirNode, depth: number): ReactNode => {
    const isCollapsed = collapsed.has(dir.path);
    return (
      <div key={dir.path}>
        {dir.path && (
          <button
            type="button"
            onClick={() => toggle(dir.path)}
            className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] text-white/35 hover:bg-white/[0.03] hover:text-white/60"
            style={{ paddingLeft: `${depth * 8 + 4}px` }}
          >
            {isCollapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
            <FolderGit2 className="size-3 text-white/25" />
            <span className="truncate">{dir.name}</span>
            <span className="ml-auto font-mono text-[9px] text-white/20">{dir.files.length + dir.dirs.size}</span>
          </button>
        )}
        {!isCollapsed && (
          <>
            {[...dir.dirs.values()]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map(child => renderDir(child, depth + 1))}
            {dir.files
              .slice()
              .sort((a, b) => a.path.localeCompare(b.path))
              .map(file => (
                <div key={file.path} style={{ paddingLeft: `${(depth + (dir.path ? 1 : 0)) * 8}px` }}>
                  {renderFile(file)}
                </div>
              ))}
          </>
        )}
      </div>
    );
  };

  if (files.length === 0) return <p className="px-2 py-3 text-[11px] text-white/25">No changed files</p>;
  return <div>{renderDir(tree, 0)}</div>;
}

// ── commit detail ────────────────────────────────────────────────────────────

function CommitHeader({
  commit,
  provenance,
  onOpenMission,
}: {
  commit: CommitSummary;
  provenance?: CommitProvenance;
  onOpenMission?: () => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <GitMerge className="mt-0.5 size-4 shrink-0 text-indigo-400/70" />
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold leading-snug text-white/90">{commit.subject}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-white/35">
          <span className="font-mono text-white/45">{commit.shortSha}</span>
          <span>{commit.authorName}</span>
          <span title={absolute(commit.authoredAt)}>{relative(commit.authoredAt)}</span>
          {commit.refs.map(ref => (
            <span key={ref} className="rounded border border-white/[0.08] bg-white/[0.03] px-1 py-0.5 font-mono text-[9px] text-white/45">
              {ref}
            </span>
          ))}
          {provenance ? (
            <button
              type="button"
              onClick={onOpenMission}
              className="inline-flex items-center gap-1 rounded border border-teal-300/20 bg-teal-300/[0.06] px-1.5 py-0.5 text-[9px] font-semibold text-teal-100/75 hover:bg-teal-300/10"
              title={`Open mission ${provenance.missionId}`}
            >
              <ShieldCheck className="size-2.5" />
              Mission {provenance.missionId.slice(4, 12)} · rev {provenance.revisionNo}
            </button>
          ) : null}
        </div>
      </div>
      <CopyButton text={commit.sha} label="sha" />
    </div>
  );
}

function CommitDetailPanel({
  detail,
  selectedPath,
  onSelectPath,
  provenance,
  onOpenMission,
}: {
  detail: CommitDetail;
  selectedPath: string | null;
  onSelectPath: (file: CommitFile) => void;
  provenance?: CommitProvenance;
  onOpenMission?: () => void;
}) {
  const [messageOpen, setMessageOpen] = useState(true);
  return (
    <div className="space-y-4">
      <CommitHeader commit={detail} provenance={provenance} onOpenMission={onOpenMission} />
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium tracking-wide text-white/30 uppercase">Message</span>
          <button
            type="button"
            onClick={() => setMessageOpen(open => !open)}
            className="text-[10px] text-white/30 hover:text-white/60"
          >
            {messageOpen ? 'collapse' : 'expand'}
          </button>
        </div>
        {messageOpen && (
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-white/65">
            {detail.message}
          </pre>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 text-[10px] text-white/40">
        <div className="rounded border border-white/[0.05] bg-white/[0.02] px-2 py-1.5">
          <div className="text-white/25 uppercase">Author</div>
          <div className="truncate text-white/65">{detail.authorName}</div>
          <div className="truncate text-white/30" title={absolute(detail.authoredAt)}>{absolute(detail.authoredAt)}</div>
        </div>
        <div className="rounded border border-white/[0.05] bg-white/[0.02] px-2 py-1.5">
          <div className="text-white/25 uppercase">Committer</div>
          <div className="truncate text-white/65">{detail.committerName}</div>
          <div className="truncate text-white/30" title={absolute(detail.committedAt)}>{absolute(detail.committedAt)}</div>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-white/[0.06] pt-3">
        <span className="text-[10px] font-medium tracking-wide text-white/35 uppercase">
          Files · {detail.stats.files}
        </span>
        <span className="font-mono text-[10px]">
          <span className="text-emerald-400/80">+{detail.stats.additions}</span>{' '}
          <span className="text-red-400/80">−{detail.stats.deletions}</span>
        </span>
      </div>
      <FileTree files={detail.files} selectedPath={selectedPath} onSelect={onSelectPath} />
      {detail.truncated && (
        <p className="text-[10px] text-amber-400/70">File list truncated at 400 entries.</p>
      )}
    </div>
  );
}

// ── diff pane ────────────────────────────────────────────────────────────────

function DiffPane({
  file,
  diff,
  loading,
  error,
  view,
  onViewChange,
  context,
  onContextChange,
}: {
  file: CommitFile | null;
  diff: CommitFileDiff | undefined;
  loading: boolean;
  error: Error | null;
  view: 'unified' | 'split';
  onViewChange: (view: 'unified' | 'split') => void;
  context: number;
  onContextChange: (context: number) => void;
}) {
  const language = file ? languageOf(file.path) : 'text';
  const patch = diff?.patch ?? '';
  const hunks = useMemo(() => (patch ? parsePatch(patch) : []), [patch]);

  if (!file) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-white/25">
        Select a changed file to inspect its diff
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-3 py-2">
        <StatusBadge status={file.status} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-white/70" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {file.oldPath ? `${file.oldPath} → ` : ''}{file.path}
        </span>
        <StatPair additions={file.additions} deletions={file.deletions} />
        <CopyButton text={file.path} label="path" />
        <div className="flex overflow-hidden rounded border border-white/[0.08]">
          {(['unified', 'split'] as const).map(mode => (
            <button
              key={mode}
              type="button"
              onClick={() => onViewChange(mode)}
              className={`px-2 py-0.5 text-[10px] capitalize transition-colors ${
                view === mode ? 'bg-white/[0.1] text-white/80' : 'text-white/35 hover:bg-white/[0.04] hover:text-white/60'
              }`}
            >
              {mode}
            </button>
          ))}
        </div>
        <select
          value={context}
          onChange={event => onContextChange(Number(event.target.value))}
          className="rounded border border-white/[0.08] bg-[#111] px-1.5 py-0.5 text-[10px] text-white/50 outline-none"
          title="Context lines"
        >
          {[0, 3, 10, 25].map(lines => (
            <option key={lines} value={lines}>{lines} ctx</option>
          ))}
        </select>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-[#080808]">
        {loading && (
          <div className="flex items-center gap-2 px-4 py-6 text-[11px] text-white/30">
            <Loader2 className="size-3.5 animate-spin" /> Loading diff…
          </div>
        )}
        {!loading && error && (
          <div className="m-4 rounded border border-red-500/20 bg-red-500/[0.04] px-3 py-2 text-[11px] text-red-300">
            {error.message}
          </div>
        )}
        {!loading && !error && diff?.binary && (
          <div className="flex items-center gap-2 px-4 py-6 text-[11px] text-white/40">
            <AlertTriangle className="size-4 text-amber-400/70" />
            Binary file — no textual diff. {file.additions === null ? '' : `(+${file.additions} / −${file.deletions ?? 0})`}
          </div>
        )}
        {!loading && !error && diff && !diff.binary && hunks.length === 0 && (
          <div className="px-4 py-6 text-[11px] text-white/30">
            No textual changes (mode or metadata only).
          </div>
        )}
        {!loading && !error && diff && !diff.binary && hunks.length > 0 && (
          view === 'unified'
            ? <UnifiedDiff hunks={hunks} language={language} />
            : <SplitDiff hunks={hunks} language={language} />
        )}
        {!loading && !error && diff?.truncated && (
          <div className="border-t border-amber-500/20 bg-amber-500/[0.04] px-3 py-1.5 text-[10px] text-amber-300/80">
            Diff truncated at 1,000,000 characters.
          </div>
        )}
      </div>
    </div>
  );
}

// ── commit list ──────────────────────────────────────────────────────────────

function CommitListItem({
  commit,
  selected,
  onSelect,
  provenance,
}: {
  commit: CommitSummary;
  selected: boolean;
  onSelect: () => void;
  provenance?: CommitProvenance;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full border-l-2 px-3 py-2 text-left transition-colors ${
        selected
          ? 'border-[color:oklch(95%_0.15_108_/_0.7)] bg-white/[0.05]'
          : 'border-transparent hover:bg-white/[0.025]'
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] text-white/40">{commit.shortSha}</span>
        {commit.refs.slice(0, 2).map(ref => (
          <span key={ref} className="max-w-[90px] truncate rounded border border-white/[0.08] bg-white/[0.03] px-1 py-0.5 font-mono text-[8px] text-white/40">
            {ref.replace('HEAD -> ', '')}
          </span>
        ))}
        {provenance ? (
          <span
            className="inline-flex items-center gap-0.5 rounded border border-teal-300/15 bg-teal-300/[0.06] px-1 py-0.5 text-[8px] font-semibold text-teal-100/70"
            title={`Mission ${provenance.missionId} · revision ${provenance.revisionNo} · ${provenance.state}`}
          >
            <ShieldCheck className="size-2" />
            {provenance.missionId.slice(4, 12)} · r{provenance.revisionNo}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 text-[9px] text-white/25">{relative(commit.committedAt)}</span>
      </div>
      <div className={`mt-0.5 line-clamp-2 text-[11px] leading-snug ${selected ? 'text-white/85' : 'text-white/65'}`}>
        {commit.subject}
      </div>
      <div className="mt-0.5 truncate text-[9px] text-white/30">{commit.authorName}</div>
    </button>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export function CommitsPageClient({ departmentId }: { departmentId: string }) {
  const trpc = useTRPC();
  const { open: openDrawer } = useDrawerStack();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [view, setView] = useState<'unified' | 'split'>('unified');
  const [context, setContext] = useState(3);
  const [filter, setFilter] = useState('');
  const [showScratch, setShowScratch] = useState(false);

  const workspacesQuery = useQuery({
    ...trpc.helldesk.listCommitWorkspaces.queryOptions({}),
    // The workspace selector changes rarely; the commit list stays live at 10s.
    refetchInterval: 60_000,
  });

  // Effective selection is derived, not synchronized through effects: the first
  // git workspace / newest commit / first changed file are defaults until the
  // operator picks one. This avoids cascading setState-in-effect renders.
  const workspaces = workspacesQuery.data ?? EMPTY_WORKSPACES;
  // One repository, one dropdown entry. Legacy engine rows may hold the same
  // folder under two spellings (`D:\Repo` / `d:/Repo`); dedupe by canonical path.
  const allGitWorkspaces = useMemo(() => {
    const seen = new Set<string>();
    return workspaces.filter(item => {
      if (!item.isGit) return false;
      const key = canonicalWorkspaceKey(item.path);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [workspaces]);
  // Scratch/test repositories are hidden unless the operator asks for them.
  // `scratch` comes from the engine; the path check keeps this honest against an
  // older engine that predates the field.
  const hiddenScratchCount = useMemo(
    () => allGitWorkspaces.filter(item => item.scratch === true || isScratchWorkspacePath(item.path)).length,
    [allGitWorkspaces],
  );
  const gitWorkspaces = useMemo(
    () => allGitWorkspaces.filter(item => showScratch || (!item.scratch && !isScratchWorkspacePath(item.path))),
    [allGitWorkspaces, showScratch],
  );
  const activeWorkspaces = useMemo(() => gitWorkspaces.filter(item => item.activeMissionId), [gitWorkspaces]);
  const otherWorkspaces = useMemo(() => gitWorkspaces.filter(item => !item.activeMissionId), [gitWorkspaces]);
  const selectedVisible = Boolean(workspaceId && gitWorkspaces.some(item => item.workspaceId === workspaceId));
  const effectiveWorkspaceId = (selectedVisible ? workspaceId : null) ?? gitWorkspaces[0]?.workspaceId ?? null;
  const workspace = workspaces.find(item => item.workspaceId === effectiveWorkspaceId) ?? null;

  const commitsQuery = useQuery({
    ...trpc.helldesk.listCommits.queryOptions({ workspaceId: effectiveWorkspaceId ?? '', limit: 80 }),
    enabled: Boolean(effectiveWorkspaceId),
    refetchInterval: 10_000,
  });

  const provenanceQuery = useQuery({
    ...trpc.helldesk.listCommitProvenance.queryOptions({ workspaceId: effectiveWorkspaceId ?? '' }),
    enabled: Boolean(effectiveWorkspaceId),
    refetchInterval: 30_000,
  });
  const provenance = provenanceQuery.data ?? [];
  const provenanceFor = (sha: string | null | undefined): CommitProvenance | undefined => {
    if (!sha) return undefined;
    return provenance.find(item => item.sha === sha || sha.startsWith(item.sha) || item.sha.startsWith(sha));
  };

  const commits = commitsQuery.data?.commits ?? EMPTY_COMMITS;
  const filteredCommits = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return commits;
    return commits.filter(commit =>
      commit.subject.toLowerCase().includes(query) ||
      commit.sha.toLowerCase().includes(query) ||
      commit.authorName.toLowerCase().includes(query)
    );
  }, [commits, filter]);

  const effectiveSha = selectedSha ?? commits[0]?.sha ?? null;
  const detailQuery = useQuery({
    ...trpc.helldesk.getCommit.queryOptions({ workspaceId: effectiveWorkspaceId ?? '', sha: effectiveSha ?? '' }),
    enabled: Boolean(effectiveWorkspaceId && effectiveSha),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const detail = detailQuery.data;
  const effectivePath = selectedPath ?? detail?.files[0]?.path ?? null;
  const selectedFile = detail?.files.find(file => file.path === effectivePath) ?? null;

  const diffQuery = useQuery({
    ...trpc.helldesk.getCommitFileDiff.queryOptions({
      workspaceId: effectiveWorkspaceId ?? '',
      sha: effectiveSha ?? '',
      path: effectivePath ?? '',
      oldPath: selectedFile?.oldPath ?? null,
      context,
    }),
    enabled: Boolean(effectiveWorkspaceId && effectiveSha && effectivePath),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const selectWorkspace = (nextWorkspaceId: string) => {
    setWorkspaceId(nextWorkspaceId);
    setSelectedSha(null);
    setSelectedPath(null);
    setFilter('');
  };

  const selectCommit = (sha: string) => {
    setSelectedSha(sha);
    setSelectedPath(null);
  };

  return (
    <div className="flex h-full flex-col" data-department-id={departmentId}>
      <div className="border-b border-white/[0.06] px-5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <GitBranch className="size-4 text-[color:oklch(95%_0.15_108_/_0.6)]" />
          <h1 className="text-lg font-semibold tracking-tight text-white/90">Commits</h1>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
            <span className="size-1.5 rounded-full bg-emerald-400" />
            live
          </span>
          <span className="text-[10px] text-white/25">
            read-only git history · messages, metadata, per-file diffs
          </span>
          <button
            type="button"
            onClick={() => {
              void workspacesQuery.refetch();
              void commitsQuery.refetch();
            }}
            className="ml-auto inline-flex items-center gap-1 rounded border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[10px] text-white/40 transition-colors hover:bg-white/[0.05] hover:text-white/70"
          >
            <RefreshCw className={`size-3 ${workspacesQuery.isFetching || commitsQuery.isFetching ? 'animate-spin' : ''}`} />
            refresh
          </button>
        </div>

        {workspacesQuery.isError && (
          <div className="mt-2 rounded border border-red-500/20 bg-red-500/[0.04] px-2 py-1 text-[10px] text-red-300">
            Commit history endpoint unavailable: {(workspacesQuery.error as Error).message}
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <select
            value={effectiveWorkspaceId ?? ''}
            onChange={event => selectWorkspace(event.target.value)}
            className="max-w-[420px] rounded border border-white/[0.08] bg-[#111] px-2 py-1 text-[11px] text-white/70 outline-none"
          >
            {gitWorkspaces.length === 0 && <option value="">No git workspaces</option>}
            {activeWorkspaces.length > 0 ? (
              <optgroup label="Active missions">
                {activeWorkspaces.map(item => (
                  <option key={item.workspaceId} value={item.workspaceId}>
                    {item.name}{item.branch ? ` — ${item.branch}` : ''} · mission {item.activeMissionId?.slice(4, 10)}{item.dirty ? ' •' : ''}
                  </option>
                ))}
              </optgroup>
            ) : null}
            <optgroup label={activeWorkspaces.length > 0 ? 'Other repositories' : 'Repositories'}>
              {otherWorkspaces.map(item => (
                <option key={item.workspaceId} value={item.workspaceId}>
                  {item.name}{item.branch ? ` — ${item.branch}` : ''}{item.dirty ? ' •' : ''}
                </option>
              ))}
            </optgroup>
          </select>
          {hiddenScratchCount > 0 ? (
            <label className="inline-flex items-center gap-1 text-[10px] text-white/30">
              <input
                type="checkbox"
                checked={showScratch}
                onChange={event => setShowScratch(event.target.checked)}
                className="size-3 accent-teal-300/70"
              />
              show scratch ({hiddenScratchCount})
            </label>
          ) : null}
          {workspace && (
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-[10px] text-white/30">
              <span className="max-w-[460px] truncate font-mono" title={workspace.path}>{workspace.path}</span>
              {workspace.activeMissionId ? (
                <button
                  type="button"
                  onClick={() =>
                    openDrawer({ type: 'ticket', ticketId: workspace.activeMissionId!, departmentId })
                  }
                  className="inline-flex items-center gap-1 rounded border border-teal-300/20 bg-teal-300/[0.06] px-1.5 py-0.5 text-[9px] font-semibold text-teal-100/75 hover:bg-teal-300/10"
                  title={`Open mission ${workspace.activeMissionId}`}
                >
                  <ShieldCheck className="size-2.5" /> mission {workspace.activeMissionId.slice(4, 10)}
                </button>
              ) : null}
              {workspace.branch && (
                <span className="inline-flex items-center gap-1 rounded border border-white/[0.08] bg-white/[0.02] px-1.5 py-0.5 font-mono text-white/45">
                  <GitBranch className="size-3" /> {workspace.branch}
                </span>
              )}
              {workspace.head && <span className="font-mono text-white/40">HEAD {workspace.head}</span>}
              {workspace.dirty === null ? (
                <span className="text-white/30">working-tree status unknown</span>
              ) : workspace.dirty ? (
                <span className="text-amber-400/70">working tree has changes</span>
              ) : (
                <span className="text-emerald-400/60">clean</span>
              )}
              {workspace.error && <span className="text-red-400/70">{workspace.error}</span>}
            </div>
          )}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[280px_340px_minmax(0,1fr)]">
        {/* commit list */}
        <section className="flex min-h-0 flex-col border-r border-white/[0.06]">
          <div className="border-b border-white/[0.05] p-2">
            <div className="flex items-center gap-1.5 rounded border border-white/[0.07] bg-white/[0.02] px-2 py-1">
              <Search className="size-3 text-white/25" />
              <input
                value={filter}
                onChange={event => setFilter(event.target.value)}
                placeholder="Filter commits…"
                className="w-full bg-transparent text-[11px] text-white/65 placeholder:text-white/20 outline-none"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {commitsQuery.isLoading && (
              <div className="flex items-center gap-2 px-3 py-4 text-[11px] text-white/30">
                <Loader2 className="size-3.5 animate-spin" /> Loading commits…
              </div>
            )}
            {commitsQuery.isError && (
              <p className="px-3 py-3 text-[11px] text-red-300">
                {(commitsQuery.error as Error).message}
              </p>
            )}
            {!commitsQuery.isLoading && !commitsQuery.isError && filteredCommits.length === 0 && (
              <p className="px-3 py-4 text-[11px] text-white/25">
                {commits.length === 0 ? 'No commits in this workspace yet.' : 'No commits match the filter.'}
              </p>
            )}
            {filteredCommits.map(commit => (
              <CommitListItem
                key={commit.sha}
                commit={commit}
                selected={commit.sha === effectiveSha}
                onSelect={() => selectCommit(commit.sha)}
                provenance={provenanceFor(commit.sha)}
              />
            ))}
          </div>
          <div className="border-t border-white/[0.05] px-3 py-1.5 text-[9px] text-white/20">
            {filteredCommits.length} / {commits.length} commits · newest 80
          </div>
        </section>

        {/* commit detail + files */}
        <section className="min-h-0 overflow-y-auto border-r border-white/[0.06] p-3">
          {!effectiveSha && (
            <div className="flex h-full items-center justify-center text-xs text-white/25">
              Select a commit
            </div>
          )}
          {effectiveSha && detailQuery.isLoading && (
            <div className="flex items-center gap-2 py-6 text-[11px] text-white/30">
              <Loader2 className="size-3.5 animate-spin" /> Loading commit…
            </div>
          )}
          {effectiveSha && detailQuery.isError && (
            <div className="rounded border border-red-500/20 bg-red-500/[0.04] px-3 py-2 text-[11px] text-red-300">
              {(detailQuery.error as Error).message}
            </div>
          )}
          {detail && (
            <CommitDetailPanel
              detail={detail}
              selectedPath={effectivePath}
              onSelectPath={file => setSelectedPath(file.path)}
              provenance={provenanceFor(detail.sha)}
              onOpenMission={() => {
                const link = provenanceFor(detail.sha);
                if (link) openDrawer({ type: 'ticket', ticketId: link.missionId, departmentId });
              }}
            />
          )}
        </section>

        {/* diff */}
        <section className="min-h-0 overflow-hidden">
          <DiffPane
            file={selectedFile}
            diff={diffQuery.data}
            loading={diffQuery.isFetching && Boolean(effectivePath)}
            error={diffQuery.error as Error | null}
            view={view}
            onViewChange={setView}
            context={context}
            onContextChange={setContext}
          />
        </section>
      </div>
    </div>
  );
}
