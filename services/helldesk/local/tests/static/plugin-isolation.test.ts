import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * STATIC-01 — HELLDESK-authored plugin modules must never execute OS processes
 * or own orchestration from a Kilo hook.
 *
 * Constructs the transitive import graph through HELLDESK-authored production
 * plugin modules reachable from the installed `local-helldesk.ts` shim and the
 * plugin's hooks (`plugin/index.ts`). Asserts zero reachable first-party
 * references to `child_process`, Bun shell, `fs.*Sync`, Git execution,
 * daemon start/stop and engine/scheduler/worker modules. A hidden subprocess is
 * a failure regardless of visual output.
 *
 * Independent third-party Kilo internals (`@kilocode/*`) and test-only modules
 * are intentionally NOT in this graph.
 */

const LOCAL = join(__dirname, '..', '..');
const PLUGIN = join(LOCAL, 'plugin');
const SHIM = 'C:/Users/lukes.COREI9/.config/kilo/plugin/local-helldesk.ts';

const FORBIDDEN = [
  /child_process/,
  /node:child_process/,
  /execSync/,
  /execFileSync/,
  /spawnSync|spawn\s*\(/,
  /Bun\.\$|\b\$`|shell\s*:\s*true/,
  /fs\.\w*Sync|\bfs\b.*\bSync\b|readFileSync|writeFileSync|appendFileSync|mkdirSync/,
  /captureGitSnapshot|gitHead\(|runGit\(|git rev-parse/,
  /from ['"].*src\/(engine|worker-supervisor|scheduler|main)['"]/,
  /daemon-lifecycle|createKiloRunner|TaskCompletionStateMachine/,
];

/** Resolve a relative import from a source file to its target file. */
function resolveImport(dir: string, spec: string): string | null {
  if (spec.startsWith('.') && !spec.endsWith('.ts')) {
    const base = join(dir, spec);
    for (const cand of [base + '.ts', base + '.tsx', join(base, 'index.ts')]) {
      try { if (requireResolveExists(cand)) return cand; } catch {}
    }
    return null;
  }
  return null;
}
function requireResolveExists(p: string): boolean {
  try { readFileSync(p); return true; } catch { return false; }
}

function walk(rootTs: string, graph: Set<string>): void {
  if (!requireResolveExists(rootTs)) return;
  if (graph.has(rootTs)) return;
  graph.add(rootTs);
  const src = readFileSync(rootTs, 'utf-8');
  const re = /import[^\n]*?from\s+['"]([^'"]+)['"]|import\(['"]([^'"]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1] ?? m[2];
    if (!spec) continue;
    const target = resolveImport(join(rootTs, '..'), spec);
    if (target && !FORBIDDEN.some((f) => f.test(target)) && isFirstParty(target)) {
      // Only walk first-party HELLDESK modules (not @kilocode/*, node:, builtin).
      if (isFirstParty(target)) walk(target, graph);
    }
  }
}
function isFirstParty(p: string): boolean {
  return p.includes('helldesk\\local\\') || p.includes('helldesk/local/') || (!p.includes('node_modules') && !p.startsWith('@'));
}

describe('STATIC-01 plugin production isolation (no OS/process/state in hooks)', () => {
  it('plugin production graph has zero forbidden refs', () => {
    // Graph = plugin/index.ts + everything it (transitively) imports that is first-party.
    const graph = new Set<string>();
    walk(join(PLUGIN, 'index.ts'), graph);
    // Include the shim itself.
    graph.add(SHIM);
    // Only assert on HELLDESK-authored production modules present on disk.
    const ga = [...graph].filter((f) => requireResolveExists(f) && (f.endsWith('.ts')));
    let violations: string[] = [];
    for (const f of ga) {
      const content = readFileSync(f, 'utf-8');
      for (const re of FORBIDDEN) {
        if (re.test(content)) {
          // Ignore benign doc-comment mentions inside comments only.
          const lineHits = content.split('\n').map((l, i) => ({ l, i })).filter((x) => re.test(x.l));
          const real = lineHits.filter((x) => !/^\s*(\/\/|\*|\/\*)/.test(x.l));
          if (real.length && real[0]?.l) violations.push(`${f}: ${real[0].l.trim().slice(0, 90)}`);
        }
      }
    }
    expect(violations, 'plugin module leaks forbidden OS/process/state refs').toEqual([]);
    // Sanity: the bridge + index modules must actually be in the graph.
    expect(ga.some((f) => f.endsWith('plugin\\index.ts')) || ga.some((f) => f.endsWith('plugin/index.ts'))).toBe(true);
  }, 20000);
});