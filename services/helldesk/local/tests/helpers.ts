import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { openDb } from '../src/db';
import { loadConfigLegacy } from './config-factory';

/** Build a throwaway git fixture repo with real history. */
export function makeGitFixture(opts?: {
  commits?: Array<{ msg: string; files: Record<string, string> }>;
}): { dir: string; head: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gt-git-'));
  execSync(`git init -q`, { cwd: dir });
  execSync(`git config user.email test@localhost`, { cwd: dir });
  execSync(`git config user.name test`, { cwd: dir });
  const commits = opts?.commits ?? [
    {
      msg: 'feat: baseline feature',
      files: { 'math.js': 'function compute(a, b) { return a + b; }\nmodule.exports = compute;\n' },
    },
    {
      msg: 'fix: add zero handling',
      files: {
        'math.js':
          'function compute(a, b) {\n  if (b === 0) return 0; // BUG: scope regression, negative ops mishandled\n  return a + b;\n}\nmodule.exports = compute;\n',
      },
    },
  ];
  for (const c of commits) {
    for (const [name, content] of Object.entries(c.files)) {
      const full = join(dir, name);
      mkdirSync(dir.slice(0, dir.length), { recursive: true });
      writeFileSync(full, content);
    }
    execSync(`git add -A && git commit -qm "${c.msg}"`, { cwd: dir });
  }
  const head = execSync(`git rev-parse HEAD`, { cwd: dir }).toString().trim();
  const base = execSync(`git rev-parse HEAD~1`, { cwd: dir }).toString().trim();
  return { dir, head, base };
}

/** Build a plain folder (no git) fixture. */
export function makeFsFixture(files: Record<string, string>): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gt-fs-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(dir, rel.split(/[\\/]/).slice(0, -1).join('/')) || dir, { recursive: true });
    writeFileSync(full, content);
  }
  return { dir };
}

export type Opens = ReturnType<typeof makeTestDb>;

/** Temporary SQLite DB + config for a test. */
export function makeTestDb(overrides?: { runner?: 'fake' | 'openai'; reportDir?: string; dataDir?: string }): {
  d: ReturnType<typeof openDb>;
  dataDir: string;
  snapshotStore: string;
  reportDir: string;
  cfg: ReturnType<typeof loadConfigLegacy>;
  close(): void;
} {
  const dataDir = overrides?.dataDir ?? mkdtempSync(join(tmpdir(), 'gt-state-'));
  const reportDir = overrides?.reportDir ?? join(dataDir, 'reports');
  const snapshotStore = join(dataDir, 'snapshots');
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(snapshotStore, { recursive: true });
  const dbPath = overrides?.dataDir ? join(dataDir, 'helldesk.db') : join(dataDir, 'helldesk.db');
  const d = openDb(dbPath);
  d.runMigration();
  const cfg = loadConfigLegacy(overrides?.runner ?? 'fake');
  return { d, dataDir, snapshotStore, reportDir, cfg, close: () => d.close() };
}