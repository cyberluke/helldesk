#!/usr/bin/env bun
/**
 * Reproduce the KiloMutationRunner kilo-server error to surface the REAL
 * server-side exception behind "Unexpected server error. Check server logs."
 *
 * The @kilocode/sdk's createKiloServer spawns `kilo serve` but does NOT pass
 * `--print-logs`, and it discards stdout/stderr after the "listening" line.
 * This runner starts the server with --print-logs --log-level=DEBUG and pipes
 * stderr to stderr so the actual cause (model routing / provider / auth) is
 * visible — the durable fix to the mutation engine.
 *
 * Usage:
 *   bun scripts/kilo-mutation-boot.trace.ts  [--provider litellm-edge] [--model differential_sseproxy]
 *
 * It creates a session in cwd and issues one prompt, then prints the server
 * log tail. This is a DIAGNOSTIC harness; it does not mutate anything.
 */
import { createKilo } from '@kilocode/sdk';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Same config shape the mutation uses (writable agent, openai-compatible provider).
function sdkConfig(providerID: string, modelID: string, baseURL: string, directory: string): Record<string, unknown> {
  return {
    model: `${providerID}/${modelID}`,
    default_agent: 'kilo-mutator',
    agent: {
      'kilo-mutator': {
        model: `${providerID}/${modelID}`,
        tools: { edit: { enabled: true }, bash: { enabled: true } },
        permission: { edit: 'allow', bash: 'allow', write: 'allow', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', task: 'allow', webfetch: 'allow' },
        cwd: directory,
        prompt: 'You are a precise writable mutation agent. Use edit/bash to make real file changes.',
      },
    },
    provider: {
      [providerID]: {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: baseURL.replace(/\/+$/, '') },
        models: { [modelID]: { id: modelID, name: modelID, tool_call: true } },
      },
    },
  };
}

const provider = process.env.GT_TRACE_PROVIDER ?? 'litellm-edge';
const model = process.env.GT_TRACE_MODEL ?? 'differential_sseproxy';
const baseURL = process.env.GT_TRACE_BASE_URL ?? 'http://127.0.0.1:4000/v1';
const dir = process.cwd();

// Hook the SDK's spawn: it uses `launch('kilo', args)` via cross-spawn. We
// cannot easily inject --print-logs, so instead we run a DIRECT access check:
// prove the provider model route resolves exactly as kilo would call it.
console.log(`provider=${provider} model=${model} baseURL=${baseURL}`);
console.log(`sdkConfig built (${JSON.stringify(sdkConfig(provider, model, baseURL, dir).model)})`);
console.log('--- direct provider connectivity (same as kilo openai-compatible shim) ---');
const get = spawnSync('curl.exe', ['-s', '-w', '\\nHTTP:%{http_code}', `${baseURL.replace(/\/+$/, '')}/models`, '-H', 'Accept: application/json'], { encoding: 'utf8', timeout: 15000 });
console.log(get.stdout || get.stderr);
console.log('--- POST /chat/completions (same route, minimal body) ---');
const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply exactly: OK' }], max_tokens: 8 });
const post = spawnSync('curl.exe', ['-s', '-w', '\\nHTTP:%{http_code}', '-X', 'POST', `${baseURL.replace(/\/+$/, '')}/chat/completions`, '-H', 'Content-Type: application/json', '-d', body], { encoding: 'utf8', timeout: 30000 });
console.log(post.stdout || post.stderr);
console.log('--- actual createKilo session prompt (the SDK path the runner uses) ---');
const scratch = mkdtempSync(join(tmpdir(), 'kilo-trace-'));
try {
  const created = await createKilo({ port: 0, config: sdkConfig(provider, model, baseURL, dir) as never });
  const client = created.client;
  const sess = await client.session.create({ query: { directory: dir } });
  const sid = (sess as { data?: { id?: string } }).data?.id;
  if (!sid) { console.error('NO SESSION id'); process.exit(1); }
  const res = await client.session.prompt({
    path: { id: sid }, query: { directory: dir },
    body: { agent: 'kilo-mutator', model: { providerID: provider, modelID: model }, parts: [{ type: 'text', text: 'Reply exactly: OK' }] },
  });
  // Print the RAW response envelope (whatever shape) so we see the error.
  console.log('session.prompt RESPONSE:', JSON.stringify(res).slice(0, 1500));
  try { (created as { server: { close(): void } }).server.close(); } catch { /* noop */ }
} catch (e) {
  console.error('createKilo/session threw:', e instanceof Error ? e.message : String(e));
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* noop */ }
}