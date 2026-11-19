#!/usr/bin/env bun
/**
 * Isolated writable-mutation child worker.
 *
 * Runs OpenAiMutationRunner.execute in a SEPARATE process so a native Bun crash
 * during a long/flaky model call (access violation / SIGKILL) cannot kill the
 * controller/mission daemon. The caller spawns this with a RepairRequest JSON
 * on stdin and reads a RepairResult JSON on stdout; a non-zero exit or no valid
 * JSON is treated by the caller as FAILED_TRANSIENT (bounded retry).
 */
import { OpenAiMutationRunner, type RepairRequest, type RepairResult } from './mutation-runner';

async function main(): Promise<number> {
  // Read the JSON request from stdin (bounded).
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); if (Buffer.concat(chunks).length > 64 * 1024) break; }
  const input = Buffer.concat(chunks).toString('utf-8');
  let request: RepairRequest;
  try { request = JSON.parse(input) as RepairRequest; }
  catch { console.error('mutation-child: invalid RepairRequest JSON on stdin'); return 3; }

  const provider = process.env.GT_MUTATION_PROVIDER_ID ?? '';
  const model = process.env.GT_MUTATION_MODEL_ID ?? '';
  const baseURL = process.env.GT_MUTATION_BASE_URL ?? '';
  const apiKey = process.env.GT_MUTATION_API_KEY ?? '';
  const timeoutMs = Number(process.env.GT_MUTATION_TIMEOUT_MS ?? '180000');

  const runner = new OpenAiMutationRunner({ providerID: provider, modelID: model, baseURL, apiKey, timeoutMs });
  const signal = new AbortController();
  const result = await runner.execute(request, signal.signal);

  process.stdout.write(JSON.stringify(result) + '\n');
  return 0;
}

const rc = await main().catch((err) => {
  console.error('mutation-child fatal:', err instanceof Error ? (err.stack ?? err.message) : String(err));
  // Emit a FAILED_TRANSIENT so the parent can retry (never a terminal reject here).
  process.stdout.write(JSON.stringify({ outcome: 'FAILED_TRANSIENT', changedFiles: [], commandsExecuted: [], artifactsProduced: [], workspaceFingerprintBefore: '', workspaceFingerprintAfter: '', error: String(err && 'message' in err ? (err as Error).message : err) }) + '\n');
  return 2;
});
process.exit(rc === undefined ? 2 : rc);