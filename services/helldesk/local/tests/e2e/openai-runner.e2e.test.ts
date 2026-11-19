import { describe, expect, it, afterAll } from 'bun:test';
import { serve } from '../../src/main';
import { makeGitFixture } from '../helpers';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Json = Record<string, any>;

/**
 * Provenance of the direct OpenAI-compatible provider path against a local
 * deterministic mock endpoint (the spec's "deterministic test Kilo-compatible
 * mock inference endpoint"). This proves scheduler->engine->provider flow
 * works for arbitrary local/cloud OpenAI-compatible providers, not just the
 * in-memory fake runner.
 */

async function runOnce() {
  // 1. Stand up a tiny OpenAI-compatible /chat/completions server.
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 });
      const body = (await req.json()) as { messages?: Array<{ role?: string; content?: string }> };
      const messages = body.messages ?? [];
      const user = messages.find((m: { role?: string }) => m.role === 'user')?.content ?? '';
      // Deterministic "reviewer" output: if the diff/context mentions math.js,
      // report a high finding, else PASS. Mirrors what a real model would do.
      const hasFile = user.includes('math.js');
      const text = JSON.stringify({
        result: hasFile ? 'FINDINGS' : 'PASS',
        coverage: { changedFiles: hasFile ? 1 : 0, inspectedFiles: hasFile ? 1 : 0, uncoveredPaths: [] },
        findings: hasFile
          ? [
              {
                id: 'mock-1',
                severity: 'HIGH',
                confidence: 'VERIFIED',
                title: 'mock reviewer: scope regression in compute()',
                file: 'math.js',
                lineStart: 2,
                lineEnd: 4,
                revision: 'snap',
                evidence: 'negative-operand handling dropped in mock math.js snapshot',
                counterexample: 'compute(-1, 1) returns wrong value',
                requirement: 'mathematical correctness preserved',
                verification: 'review the math.js blob in the frozen snapshot',
                reviewerIds: ['A', 'B'],
                adjudicated: true,
                adjudication: 'accepted',
              },
            ]
          : [],
        models: [],
      });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    },
  });
  const port = server.port;

  // 2. Build a config using the openai runner pointing at the mock.
  const dataDir = mkdtempSync(join(tmpdir(), 'gt-openai-'));
  const configPath = join(dataDir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      daemon: { bind: '127.0.0.1', port: 4796, dataDir },
      policy: {
        runner: 'openai',
        provider: undefined,
        providers: {
          mock: { kind: 'openai-compatible', baseURL: `http://127.0.0.1:${port}/v1`, apiKey: '', modelID: 'mock-model' },
        },
        reviewerModel: { providerID: 'mock', modelID: 'mock-model' },
        strictCoverage: true,
      },
      workspaces: [],
    })
  );

  // 3. Boot a daemon with the openai runner (real HTTP inference path).
  const rt = await serve({ configPath });
  const g = makeGitFixture();
  const reg = await fetch(`http://127.0.0.1:4796/v1/workspaces/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rt.token}` },
    body: JSON.stringify({ path: g.dir }),
  });
  const { workspace } = await (reg.json() as Promise<Json>);
  const enq = await fetch(`http://127.0.0.1:4796/v1/reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rt.token}` },
    body: JSON.stringify({
      workspaceId: workspace.workspaceId,
      subject: { workspaceId: workspace.workspaceId, subjectKind: 'git-head', source: 'api' },
    }),
  });
  const { jobId } = await (enq.json() as Promise<Json>);

  // 4. Wait for completion.
  let final: { state: string; result: string | null } | null = null;
  for (let i = 0; i < 50; i++) {
    const j = await fetch(`http://127.0.0.1:4796/v1/jobs/${jobId}`).then((r) => r.json() as Promise<Json>);
    if (['COMPLETED_PASS', 'COMPLETED_FINDINGS', 'INCONCLUSIVE', 'FAILED_TERMINAL'].includes(j.job.state)) {
      final = j.job;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  // 5. Verify report persisted and findings came from the mock model.
  const repRes = await fetch(`http://127.0.0.1:4796/v1/reports/${jobId}`);
  const { report } = await (repRes.json() as Promise<Json>);

  rt.close();
  server.stop();
  return { final, report };
}

describe('openai-compatible provider path (local mock endpoint)', () => {
  it('runs a real review through direct provider HTTP and persists a report', async () => {
    const { final, report } = await runOnce();
    expect(final).not.toBeNull();
    expect(['COMPLETED_PASS', 'COMPLETED_FINDINGS']).toContain(final!.state);
    expect(report.jobId).toBeTruthy();
    expect(report.coverage.changedFiles).toBeGreaterThan(0);
    expect(report.findings.length).toBeGreaterThan(0);
  });
});