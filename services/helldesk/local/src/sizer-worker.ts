/**
 * sizer-worker.ts — detached structured-JSON task sizer.
 *
 * The live `kilo` runner is only usable from a detached worker process (the
 * headless Kilo SDK owns the provider auth). This tiny CLI reuses the exact same
 * `runKiloInference` path as reviewers so sizing works with the operator's real
 * provider/model, then writes one JSON result file for the daemon.
 *
 * Invoked by Engine.sizeTask; not a review job, so it does not touch workers or
 * review_jobs. The caller enforces the timeout and fails open to `unsized`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { runKiloInference, type KiloWorkerConfig } from './kilo-headless';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const resultFile = arg('resultFile');
if (!resultFile) {
  console.error('sizer-worker: --resultFile is required');
  process.exit(2);
}

function write(result: Record<string, unknown>): void {
  writeFileSync(resultFile!, JSON.stringify(result), 'utf8');
}

try {
  const modelRef = arg('model') ?? '';
  const slash = modelRef.indexOf('/');
  const providerID = slash > 0 ? modelRef.slice(0, slash) : '';
  const modelID = slash > 0 ? modelRef.slice(slash + 1) : '';
  const systemFile = arg('systemFile');
  const userFile = arg('userFile');
  const schemaFile = arg('schemaFile');
  if (!providerID || !modelID || !systemFile || !userFile) {
    throw new Error('sizer-worker: model, systemFile and userFile are required');
  }
  const schema = schemaFile
    ? (JSON.parse(readFileSync(schemaFile, 'utf8')) as Record<string, unknown>)
    : undefined;
  const contextWindowTokens = Number(arg('contextWindow') ?? 32_768);
  const maxOutputTokens = Number(arg('maxOutputTokens') ?? 4_096);
  const base: KiloWorkerConfig = {
    role: 'sizer',
    providerID,
    modelID,
    baseURL: arg('baseURL') ?? '',
    apiKey: arg('apiKey') ?? process.env.HELLDESK_SIZER_API_KEY,
    kiloBin: arg('kiloBin') ?? '',
    snapshotStore: arg('store') ?? process.cwd(),
    system: readFileSync(systemFile, 'utf8'),
    user: readFileSync(userFile, 'utf8'),
    directory: arg('directory') ?? process.cwd(),
    contextWindowTokens: Number.isFinite(contextWindowTokens) ? contextWindowTokens : 32_768,
    maxOutputTokens: Number.isFinite(maxOutputTokens) ? maxOutputTokens : 4_096,
    agentName: 'helldesk-sizer',
    agentPrompt: 'You estimate software task size. Do not modify files. Return only the JSON size object.',
  };
  // The custom OpenAI-compatible route rejects Kilo's forced StructuredOutput
  // tool with a server error, so use the strict-JSON text contract first (the
  // exact same contract the prompt states) and fall back to `format` only when
  // the provider actually supports it.
  const call = (withFormat: boolean) =>
    runKiloInference(
      withFormat && schema
        ? { ...base, format: { type: 'json_schema' as const, schema, retryCount: 2 } }
        : base,
    );
  let result = await call(false);
  if (!result.ok || (!result.text.trim() && result.structured === undefined)) {
    const fallback = await call(true);
    if (fallback.ok) result = fallback;
    else if (!result.ok) result = fallback;
  }
  write(result as unknown as Record<string, unknown>);
} catch (error) {
  write({ ok: false, error: error instanceof Error ? error.message : String(error), text: '', tookMs: 0 });
}
