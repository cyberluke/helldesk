#!/usr/bin/env bun
/**
 * Isolated writable-mutation child worker for the real ChatGPT Codex CLI transport.
 *
 * Runs CodexMutationRunner.execute (which spawns `codex exec -m <model>`) in a
 * SEPARATE process so a native crash or wedge during a long Codex model call
 * cannot kill the controller/mission daemon. The caller spawns this with a
 * RepairRequest JSON on stdin and reads a RepairResult JSON on stdout; a
 * non-zero exit or no valid JSON is treated by the caller as FAILED_TRANSIENT
 * (bounded retry).
 *
 * The model defaults to `gpt-6-luna` (the local codex config.toml default); it
 * can be overridden with GT_CODEX_MODEL_ID.
 */
import { CodexMutationRunner, type RepairRequest, type RepairResult } from './mutation-runner';

async function main(): Promise<number> {
  // Read the JSON request from stdin (bounded).
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 64 * 1024) break;
  }
  const input = Buffer.concat(chunks).toString('utf-8');
  let request: RepairRequest;
  try { request = JSON.parse(input) as RepairRequest; }
  catch { console.error('codex-mutation-child: invalid RepairRequest JSON on stdin'); return 3; }

  const codexBin = process.env.GT_CODEX_BIN ?? '';
  const model = process.env.GT_CODEX_MODEL_ID ?? 'gpt-6-luna';
  const timeoutMs = Number(process.env.GT_CODEX_TIMEOUT_MS ?? '180000');

  const runner = new CodexMutationRunner({ codexBin: codexBin || undefined, modelID: model, timeoutMs });
  const signal = new AbortController();
  const result = await runner.execute(request, signal.signal);

  process.stdout.write(JSON.stringify(result) + '\n');
  return 0;
}

const rc = await main().catch((err) => {
  console.error('codex-mutation-child fatal:', err instanceof Error ? (err.stack ?? err.message) : String(err));
  // Emit a FAILED_TRANSIENT so the parent can retry (never a terminal reject here).
  process.stdout.write(JSON.stringify({ outcome: 'FAILED_TRANSIENT', changedFiles: [], commandsExecuted: [], artifactsProduced: [], workspaceFingerprintBefore: '', workspaceFingerprintAfter: '', error: String(err && 'message' in err ? (err as Error).message : err) }) + '\n');
  return 2;
});
process.exit(rc === undefined ? 2 : rc);