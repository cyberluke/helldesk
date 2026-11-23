import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb } from '../../src/db';
import { registerWorkspace } from '../../src/workspace-registry';
import { handleRequest, type ApiContext } from '../../src/api';

const SCRATCH = resolve(import.meta.dir, '../../.local');

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function initRepo(): string {
  mkdirSync(SCRATCH, { recursive: true });
  const repo = join(SCRATCH, `commits-api-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'api@example.com']);
  git(repo, ['config', 'user.name', 'API Test']);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'first commit']);
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'second commit\n\nbody text']);
  return repo;
}

function context(d: ReturnType<typeof openDb>): ApiContext {
  return {
    d,
    engine: {} as ApiContext['engine'],
    config: {} as ApiContext['config'],
    configStore: {} as ApiContext['configStore'],
    token: 'test-token',
    queueDepth: () => ({ queued: 0, running: 0, inFlight: 0 }),
  };
}

const auth = { Authorization: 'Bearer test-token' };

describe('/v1/commits*', () => {
  test('serves workspace list, commit list, detail and per-file diff', async () => {
    const repo = initRepo();
    const d = openDb(':memory:');
    d.runMigration();
    try {
      const ws = registerWorkspace(d, { path: repo });
      const ctx = context(d);

      const unauthorized = await handleRequest(
        ctx,
        new Request('http://127.0.0.1:4790/v1/commits/workspaces'),
      );
      expect(unauthorized.status).toBe(401);

      const wsRes = await handleRequest(
        ctx,
        new Request('http://127.0.0.1:4790/v1/commits/workspaces', { headers: auth }),
      );
      expect(wsRes.status).toBe(200);
      const wsBody = (await wsRes.json()) as {
        workspaces: Array<{ workspaceId: string; isGit: boolean; branch: string | null; dirty: boolean }>;
      };
      expect(wsBody.workspaces.find(item => item.workspaceId === ws.workspaceId)).toMatchObject({
        isGit: true,
        dirty: false,
      });

      const listRes = await handleRequest(
        ctx,
        new Request(`http://127.0.0.1:4790/v1/commits?workspaceId=${ws.workspaceId}&limit=10`, { headers: auth }),
      );
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as {
        commits: Array<{ sha: string; subject: string; body: string }>;
      };
      expect(listBody.commits).toHaveLength(2);
      expect(listBody.commits[0]!.subject).toBe('second commit');
      expect(listBody.commits[0]!.body).toContain('body text');

      const detailRes = await handleRequest(
        ctx,
        new Request(`http://127.0.0.1:4790/v1/commits/${listBody.commits[0]!.sha}?workspaceId=${ws.workspaceId}`, { headers: auth }),
      );
      expect(detailRes.status).toBe(200);
      const detailBody = (await detailRes.json()) as {
        commit: {
          files: Array<{ path: string; status: string; additions: number }>;
          stats: { files: number; additions: number; deletions: number };
        };
      };
      expect(detailBody.commit.files[0]).toMatchObject({ path: 'a.txt', status: 'M', additions: 1 });
      expect(detailBody.commit.stats).toEqual({ files: 1, additions: 1, deletions: 1 });

      const fileRes = await handleRequest(
        ctx,
        new Request(
          `http://127.0.0.1:4790/v1/commits/${listBody.commits[0]!.sha}/file?workspaceId=${ws.workspaceId}&path=a.txt&context=3`,
          { headers: auth },
        ),
      );
      expect(fileRes.status).toBe(200);
      const fileBody = (await fileRes.json()) as { file: { patch: string; binary: boolean } };
      expect(fileBody.file.patch).toContain('-one');
      expect(fileBody.file.patch).toContain('+two');
      expect(fileBody.file.binary).toBe(false);
    } finally {
      d.close();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 20_000);
});
