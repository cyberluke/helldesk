import { createHash } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { createKilo } from '@kilocode/sdk';
import { FluentGit } from './git-async';
import { writableKiloConfiguration } from './config-discovery';
import { deepMerge } from './config-resolve';
import { z } from 'zod';

/**
 * MUTATION ACTUATORS (Ender loop P0-C).
 *
 * Honest runtime-identity reporting: there is NO distinct real "ChatGPT Codex"
 * transport in this codebase today. The actual actuator is the SAME local
 * headless Kilo runtime (`@kilocode/sdk` createKilo) that the reviewers use —
 * but on a SEPARATE, WRITABLE boundary so reviewers stay read-only.
 *
 * Trust boundary (Phase 6/7):
 *
 *   Mutation Worker → changes workspace → Evidence Materializer
 *   → immutable snapshot → ExcellenceGovernor (read-only reviewer → Quality Oracle)
 *
 * The mutation worker may say "implementation complete" but ONLY the
 * independent ExcellenceGovernor + Quality Oracle can produce VERIFIED_10_10. It never
 * self-verifies.
 *
 * Naming policy (GATE 3): we DO NOT label the Kilo-headless transport as
 * "ChatGPT Codex". The default implementation is `KiloMutationRunner`. A future
 * real ChatGPT Codex integration must land in `CodexMutationRunner` (an explicit
 * adapter) — it must not be faked by renaming an agent to `codex-mutator`.
 */

export type MutationOutcome =
  | 'CHANGED'
  | 'NO_CHANGE'
  | 'SCRATCH_ONLY'    // delta is only probe/scratch/diagnostic files, NOT the deliverable
  | 'BLOCKED_EXTERNAL'
  | 'FAILED_TRANSIENT'
  | 'FAILED_PLAN';

/** Classify a changed file as "diagnostic probe / scratch reporter" (NOT a real
 *  deliverable). Used to break the vicious cycle where the mutation agent writes
 *  throwaway `_probe.cmd`/`_run_test.cmd`/`*.log` helpers instead of the named
 *  package source, the reviewer rejects it ("no framework deliverable exists"),
 *  and the mission replans forever (the observed 4614-revision runaway).
 *  Heuristic on basename — conservative: only unambiguous probe/scratch shapes. */
export function isScratchOnlyFile(filePath: string): boolean {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath
  const name = base.toLowerCase()
  if (name.startsWith('_') && name.endsWith('.cmd')) return true          // _probe.cmd, _run_test.cmd
  if (name.startsWith('_') && name.endsWith('.ps1')) return true          // _probe.ps1
  if (name.endsWith('.log') || name.endsWith('.out')) return true          // diagnostic dumps
  if (/probe/.test(name) && /\.(cmd|ps1|sh|bat|ts|js|mjs)$/.test(name)) return true
  return false
}

export interface MutationRunner {
  execute(request: RepairRequest, signal: AbortSignal): Promise<RepairResult>;
  readonly transport: string; // truthful transport identity
  readonly provider: string;
  readonly model: string;
  readonly agent: string;
  readonly writeCapability: boolean;
  readonly shellCapability: boolean;
}

export interface RepairRequest {
  missionId: string;
  ticketId: string;
  revisionId: string;
  workspacePath: string;
  objective: string;
  currentFindings: string[];
  failedQualityGateKeys: string[];
  verifiedScientificFacts: string[];
  activeHypotheses: string[];
  falsifiedHypotheses: string[];
  previousFailureSignature?: string;
  allowedCapabilities: string[];
  /** Task-specific acceptance gates the mutation MUST satisfy before returning
   *  (e.g. zero_division_contract, coercion_semantics, boundary_tests). These
   *  turn replan into a monotonic repair process instead of a blind retry. */
  acceptanceGates?: string[];
}

export interface RepairResult {
  outcome: MutationOutcome;
  changedFiles: string[];
  commandsExecuted: string[];
  artifactsProduced: string[];
  workspaceFingerprintBefore: string;
  workspaceFingerprintAfter: string;
  blocker?: { type: string; description: string; requiredAction: string };
  error?: string;
}

/** Content fingerprint of the workspace: SHA-256 over the git working-tree diff
 *  (tracked modifications + deletions) AND the untracked-file contents, plus HEAD.
 *  This detects a REAL byte-level content change even when `git status --porcelain`
 *  is identical (e.g. a file already modified before a mutation whose content the
 *  agent changes further). Returns a stable hex digest.
 */
/** Content fingerprint of a workspace: HEAD + working-tree diff + untracked bytes.
 *  ASYNC / non-blocking: uses FluentGit so the daemon's event loop never freezes
 *  on a git child (keep-alive/SSE survive). Mutates the workspace hash fluently. */
export async function fingerprintWorkspace(workspacePath: string): Promise<string> {
  // 1. HEAD id anchors the base; a committed change moves it.
  const head = (await FluentGit.in(workspacePath).run(['rev-parse', 'HEAD'])).trim();
  // 2. The working-tree diff (tracked modifications + deletions) — byte-exact.
  const diff = await FluentGit.in(workspacePath).run(['--no-pager', 'diff']);
  // 3. Untracked files: hash their bytes so a newly-introduced file is a change.
  const untrackedOut = await FluentGit.in(workspacePath).run(['ls-files', '--others', '--exclude-standard']);
  const untrackedPaths = untrackedOut.split('\n').filter((p: string) => p.length > 0);
  const hash = createHash('sha256');
  hash.update('head=').update(head);
  hash.update('\ndiff=').update(diff);
  for (const p of untrackedPaths) {
    try {
      hash.update('\nU:').update(p).update(':').update(readFileSync(join(workspacePath, p)));
    } catch {
      hash.update('\nU:').update(p).update(':MISSING');
    }
  }
  return hash.digest('hex');
}

/**
 * The REAL actuator in this codebase: a WRITABLE Kilo headless session over the
 * installed `@kilocode/sdk` createKilo transport — the same underlying transport
 * as the reviewers, but on a separate boundary with mutation tools ENABLED
 * against the mission's writable workspace.
 *
 * The SDK contract is exactly what the (working) receiver path uses
 * (`kilo-headless.ts`): `createKilo({ port: 0, config })` → `created.client`
 * → `client.session.create({ query: { directory } })` →
 * `client.session.prompt({ path: { id }, query: { directory }, body })`. The
 * mutation agent's session is created over `request.workspacePath`, and its SDK
 * config grants real edit/bash/code permissions (unlike the read-only reviewer).
 *
 * Truthful metadata: transport = `@kilocode/sdk` createKilo (headless Kilo), NOT
 * ChatGPT Codex. Provider/model are the configured model route (e.g.
 * litellm-edge/differential_sseproxy); `agent` is the configured writable agent.
 */
export class KiloMutationRunner implements MutationRunner {
  readonly transport = '@kilocode/sdk' + '.createKilo';
  readonly writeCapability = true;
  readonly shellCapability = true;
  provider: string;
  model: string;
  readonly agent: string;

  constructor(private readonly opts: {
    codexBin: string;      // path to the `kilo` headless server binary
    providerID: string;
    modelID: string;
    baseURL: string;
    apiKey?: string;
    system?: string;
  }) {
    this.provider = opts.providerID || 'inherit';
    this.model = opts.modelID || 'inherit';
    this.agent = 'kilo-mutator';
  }

  /** How many operator plugins (satin memory + gates + continuity hooks) the last
   *  buildSdkConfig wired into this mutation session. Exposed for observability —
   *  the engine depends on a NON-ZERO value; a zero here is a hard invariant failure. */
  mutationPluginCount = 0;

  /** Build the SDK Config for ONE writable mutation agent (write+shell+code tools
   *  ALLOWED — the opposite of the read-only reviewer). Provider routing is
   *  identical to kilo-headless so the same model route serves both. */
  private buildSdkConfig(directory: string): Record<string, unknown> {
    const inherited = writableKiloConfiguration();
    // INVARIANT (operator critical): the autonomous mutation session MUST inherit
    // the operator's full plugin set — satin memory (the lamp), gate plugins, and
    // every continuity/recovery hook. The engine depends on these for cross-restart
    // memory continuity and for the same quality discipline the interactive session
    // is under. If writableKiloConfiguration returns no plugins, a silently-stripped
    // hook is the EXACT failure that leaves an agent context-memory-lost and loops
    // forever (observed 4614-revision runaway). Fail loudly, never mutate with a
    // hobbled memory/gate runtime.
    const pluginList = (inherited.plugin as unknown[] | undefined) ?? []
    if (!pluginList.length) {
      throw new Error('mutation-session-no-plugins: writableKiloConfiguration returned zero plugins — the autonomous mutation agent would run WITHOUT satin-memory/gate hooks. Refusing to mutate: restore the operator plugin config (~/.config/kilo/plugin) before re-dispatching.')
    }
    this.mutationPluginCount = pluginList.length
    const route = inherited.model || `${this.opts.providerID}/${this.opts.modelID}`;
    const slash = route.indexOf('/');
    if (slash < 1 || slash === route.length - 1) throw new Error('Kilo requires a configured provider/model route');
    const providerID = route.slice(0, slash);
    const modelID = route.slice(slash + 1);
    this.provider = providerID; this.model = modelID;
    const modelRef = `${providerID}/${modelID}`;
    const agents = z.record(z.string(), z.unknown()).safeParse(inherited.agent);
    const baseAgent = z.object({ prompt: z.string().optional(), permission: z.union([z.record(z.string(), z.unknown()), z.enum(['allow', 'ask', 'deny'])]).optional() }).passthrough().safeParse(agents.success ? agents.data[inherited.default_agent || 'natural'] : undefined);
    const permissions = (value: unknown): Record<string, unknown> => typeof value === 'string' ? { '*': value } : z.record(z.string(), z.unknown()).safeParse(value).data || {};
    // Writable agents inherit the operator's tools and instructions. Independent
    // reviewers remain read-only in kilo-headless.ts; this does not broaden them.
    const operatorPermissions = { ...permissions(inherited.permission), ...permissions(baseAgent.success ? baseAgent.data.permission : undefined) };
    const writePermission: Record<string, unknown> = {
      edit: 'allow',
      bash: 'allow',
      todo: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      read: 'allow',
      read_file: 'allow',
      write: 'allow',
      task: 'allow',
      mcp: 'allow',
      webfetch: 'allow',
      external_directory: 'allow',
      notebook: 'allow',
      notebook_read: 'allow',
      notebook_edit: 'allow',
      notebook_execute: 'allow',
      websearch: 'allow',
    };
    if (['allow', 'ask', 'deny'].includes(String(operatorPermissions['*'])))
      for (const key of Object.keys(writePermission)) writePermission[key] = operatorPermissions['*'];
    Object.assign(writePermission, operatorPermissions);
    return deepMerge<Record<string, unknown>>(inherited, {
      model: modelRef,
      enabled_providers: providerID ? [providerID] : [],
      default_agent: this.agent,
      agent: {
        [this.agent]: {
          ...(baseAgent.success ? baseAgent.data : {}),
          model: modelRef,
          tools: {
            edit: { enabled: true },
            bash: { enabled: true },
          },
          permission: writePermission,
          prompt: [
            baseAgent.success ? baseAgent.data.prompt || '' : '',
            'You are a precise code mutation agent for an autonomous repair loop.',
            'You have EDIT, BASH, FILE-READ/WRITE, TEST, and local git-commit capabilities.',
            'Use the configured MCP tools, plugins, AAF discovery and reusable assets. Tool availability follows the operator configuration.',
            'Working directory: ' + directory,
            'Complete the full objective and every acceptance requirement. Do not silently narrow scope, substitute a slice or defer difficult integration details.',
            'The operator steers asynchronously. Continue authorized work without waiting for routine approval; honor explicit stop/cancel instructions.',
            'Before reporting done, verify your change (compile/test if available).',
            'Do NOT self-verify against review gates — an independent read-only ExcellenceGovernor does that separately.',
          ].join('\n'),
          cwd: directory,
        },
      },
      provider: providerID === this.opts.providerID && this.opts.baseURL && !inherited.provider?.[providerID]
        ? {
            [providerID]: {
              npm: '@ai-sdk/openai-compatible',
              options: {
                baseURL: this.opts.baseURL.replace(/\/+$/, ''),
                ...(this.opts.apiKey ? { apiKey: this.opts.apiKey } : {}),
              },
              models: {
                [modelID]: {
                  id: modelID,
                  name: modelID,
                  tool_call: true,
                  reasoning: true,
                  limit: { context: 131072, output: 32000 },
                  modalities: { input: ['text'], output: ['text'] },
                },
              },
            },
          }
        : {},
    });
  }

  async execute(request: RepairRequest, signal: AbortSignal): Promise<RepairResult> {
    const before = await fingerprintWorkspace(request.workspacePath);
    const commands: string[] = [];
    const artifacts: string[] = [];
    const changed: string[] = [];
    // The mutation agent operates on the mission's REAL writable workspace,
    // not a throwaway dir. Require it to exist so we never mutate nothing.
    if (!request.workspacePath) {
      return { outcome: 'FAILED_PLAN', changedFiles: [], commandsExecuted: [], artifactsProduced: [], workspaceFingerprintBefore: before, workspaceFingerprintAfter: before, error: 'mutation workspace path is empty' };
    }
    // Match kilo-headless PATH prepend so a non-PATH `kilo` binary is found.
    // ROOT-CAUSE FIX: the SDK's createKiloServer spawns `kilo` from PATH ONLY.
    // If the kilo bin dir is not on PATH, createKilo throws `spawn kilo ENOENT`,
    // which the SDK wraps as UnknownError "Unexpected server error" — the silent
    // cause of raw `no-change` across every mutation. Resolve to an ABSOLUTE path
    // (or derive from PATH) and ALWAYS prepend its dir before createKilo, then
    // fail loudly with a precise `kilo-binary` diagnosis instead of the opaque wrap.
    const bin = this.opts.codexBin || 'kilo';
    const resolvedBin = bin.includes('/') || bin.includes('\\')
      ? bin
      : (process.env.PATH?.split(';').map((d) => join(d, 'kilo.exe')).find((p) => existsSync(p)) ?? bin);
    const binDir = resolvedBin.slice(0, Math.max(resolvedBin.lastIndexOf('/'), resolvedBin.lastIndexOf('\\')));
    if (binDir) {
      const priorPath = process.env.PATH ?? '';
      if (!priorPath.split(';').map((d) => d.toLowerCase()).includes(binDir.toLowerCase())) process.env.PATH = `${binDir};${priorPath}`;
    }
    if (!existsSync(binDir ? join(binDir, 'kilo.exe') : 'kilo.exe')) {
      return { outcome: 'FAILED_PLAN', changedFiles: [], commandsExecuted: [], artifactsProduced: [], workspaceFingerprintBefore: before, workspaceFingerprintAfter: before, error: `kilo-binary-on-path: kilo server binary not found (codexBin=${this.opts.codexBin || '(empty → tried PATH)'}). The @kilocode/sdk spawns 'kilo' from PATH; ensure the kilo bin dir is on PATH or codexBin points at the kilo.exe file.` };
    }
    let runtime: { server?: { close(): void } } | null = null;
    try {
      const sdkConfig = this.buildSdkConfig(request.workspacePath);
      let created: { client: unknown; server?: { close(): void } };
      try {
        created = await createKilo({ port: 0, config: sdkConfig as never }) as { client: unknown; server?: { close(): void } };
      } catch (bootErr) {
        const bm = bootErr instanceof Error ? bootErr.message : String(bootErr);
        if (/ENOENT/i.test(bm)) {
          return { outcome: 'FAILED_TRANSIENT', changedFiles: [], commandsExecuted: [], artifactsProduced: [], workspaceFingerprintBefore: before, workspaceFingerprintAfter: before, error: `kilo-binary-enoent: createKilo could not spawn kilo on PATH: ${bm} (resolvedBin=${resolvedBin})` };
        }
        return { outcome: 'FAILED_TRANSIENT', changedFiles: [], commandsExecuted: [], artifactsProduced: [], workspaceFingerprintBefore: before, workspaceFingerprintAfter: before, error: `createKilo boot failed: ${bm}` };
      }
      runtime = created as { server?: { close(): void } };
      const metadata = {
        transport: this.transport,
        agent: this.agent,
        providerID: this.provider,
        modelID: this.model,
        workspace: request.workspacePath,
        capabilities: (request.allowedCapabilities ?? ['code', 'git-commit-local']).join(','),
      };
      commands.push('kilo.createKilo');
      const client = created.client as unknown as {
        mcp: {
          status(options: { query: { directory: string } }): Promise<{ data?: Record<string, { status?: string }> }>;
        };
        session: {
          create(options: { query: { directory: string } }): Promise<{ data?: { id?: string } }>;
          prompt(options: {
            path: { id: string };
            query: { directory: string };
            body: {
              agent: string;
              model: { providerID: string; modelID: string };
              system?: string;
              parts: Array<{ type: string; text: string }>;
            };
          }): Promise<Record<string, unknown>>;
          abort(options: { path: { id: string } }): Promise<unknown>;
        };
      };
      // Match the VSIX Agent Manager startup contract: touching MCP status for
      // this exact directory eagerly initializes the configured MCP set before
      // the first prompt. Without this, headless sessions can race first-turn
      // tool discovery and look "stuck" while the editor path works.
      try {
        const mcp = await client.mcp.status({ query: { directory: request.workspacePath } });
        const states = Object.entries(mcp.data ?? {}).map(([name, value]) => `${name}:${value?.status ?? 'unknown'}`);
        commands.push(`kilo.mcp.status[${states.join(',')}]`);
      } catch (mcpErr) {
        const mm = mcpErr instanceof Error ? mcpErr.message : String(mcpErr);
        return { outcome: 'FAILED_TRANSIENT', changedFiles: [], commandsExecuted: [...commands, 'kilo.mcp.status'], artifactsProduced: [], workspaceFingerprintBefore: before, workspaceFingerprintAfter: before, error: `kilo-mcp-warmup-failed: ${mm}` };
      }

      const createdSession = await client.session.create({ query: { directory: request.workspacePath } });
      const sessionID = createdSession.data?.id;
      if (!sessionID) throw new Error('headless Kilo failed to create a mutation session');
      commands.push('kilo.session.create');

      const prompt = [
        `MUTATION TASK (writable boundary; reviewers are separate and read-only).`,
        `Mission ${request.missionId} ticket ${request.ticketId} revision ${request.revisionId}.`,
        `Objective: ${request.objective}`,
        request.currentFindings.length ? `Current reviewer findings:\n- ${request.currentFindings.join('\n- ')}` : '',
        request.failedQualityGateKeys.length ? `Failed quality gates: ${request.failedQualityGateKeys.join(', ')}` : '',
        request.verifiedScientificFacts.length ? `Verified facts:\n- ${request.verifiedScientificFacts.join('\n- ')}` : '',
        request.falsifiedHypotheses.length ? `Do NOT repeat falsified hypotheses:\n- ${request.falsifiedHypotheses.join('\n- ')}` : '',
        request.previousFailureSignature ? `Previous failure signature: ${request.previousFailureSignature}` : '',
        request.acceptanceGates?.length ? `ACCEPTANCE GATES (MUST satisfy all before returning):\n- ${request.acceptanceGates.join('\n- ')}\nFor each gate, implement the contract explicitly, cover edge cases (coercive zeros, "0", false, null, NaN, Infinity where applicable), execute tests, and capture test output as evidence.` : '',
        `Allowed capabilities: ${request.allowedCapabilities.join(', ')}`,
        `Work in ${request.workspacePath}. Complete the full objective AND every acceptance gate without scope cuts. Reuse existing components and build the missing deltas. Record every command you run and every artifact you produce.`,
        `HARD RULE: the delta MUST be the real deliverable (the framework/scene/entity/persistence/renderer/Tauri source under the objective's target directories), committed as your working-tree/files in ${request.workspacePath}. Diagnostic probe/scratch helpers (e.g. _probe.cmd, _run_test.cmd, _probe2.cmd, *.log dumps, throwaway scripts) are NOT a valid delta and will be rejected as "no framework deliverable". Inspect the layout if you must, but the files you WRITE must be the actual package/module source the objective names — not scripts that inspect them. If only probe/scratch files were created, you have not completed the task: keep writing the real modules.`,
      ].filter(Boolean).join('\n\n');

      // Abort handling: tie the session to the caller's AbortSignal so a cancel
      // actually stops the mutation run (best-effort — session.abort).
      const abort = () => { void client.session.abort({ path: { id: sessionID } }); };
      signal.addEventListener('abort', abort, { once: true });
      const responses: string[] = [];
      try {
        // ITERATIVE WRITE CHASE: a single-shot prompt on a long-horizon task
        // (e.g. "build a framework repo") naturally returns a plan/narrative, not
        // committed files. The old code discarded that response and only looked at
        // the workspace fingerprint, so a narrative-only reply registered as
        // NO_CHANGE even though the agent understood the task. Chase a real delta:
        // if a pass returns no workspace change, re-prompt the SAME session to
        // actually create files, until the workspace changes or we hit a hard cap.
        const MAX_WRITE_PASSES = 3;
        let after = before;
        let changedNow: string[] = [];
        for (let pass = 0; pass < MAX_WRITE_PASSES; pass++) {
          const passPrompt = pass === 0
            ? prompt
            : `${prompt}\n\n[Follow-up ${pass}] You have made NO file changes yet. The task requires a concrete, committed (or at minimum working-tree) delta in ${request.workspacePath}. STOP describing and START creating: write the real framework package files (renderer/scene/entity/persistence skeleton, renderer backend abstraction, tauri-v2 scaffold, and any configs), then commit them with git. Even a partial first delta is required before you report done.`;
          const res = await client.session.prompt({
            path: { id: sessionID },
            query: { directory: request.workspacePath },
            body: {
              agent: this.agent,
              model: { providerID: this.provider, modelID: this.model },
              system: this.opts.system,
              parts: [{ type: 'text', text: passPrompt }],
            },
          });
          commands.push(`kilo.session.prompt(pass${pass + 1})`);
          // CAPTURE the agent's reply AND any provider/model error so a NO_CHANGE
          // (or a silent failure) is diagnosible — we no longer discard the
          // response. The SDK can return an ERROR-SHAPED object (top-level keys
          // error/request/response) with NO data/info/parts — earlier this was
          // swallowed as "no text". Pull the error text out and surface it.
          const raw = res as {
            error?: unknown;
            request?: unknown;
            response?: unknown;
            data?: { parts?: Array<{ type?: string; text?: string }>; info?: { error?: unknown }; messages?: Array<{ content?: Array<{ text?: string; type?: string }> | string }> };
            parts?: Array<{ type?: string; text?: string }>;
            info?: { error?: unknown };
          };
          // Pull raw text from the most likely shapes (parts / data.parts /
          // data.messages / data.response / response).
          const parts = raw?.data?.parts ?? raw?.parts ?? [];
          const text = parts.filter((p) => p?.type === 'text').map((p) => p?.text ?? '').join('\n').trim();
          const info = (raw as { data?: { info?: { error?: unknown } } })?.data?.info ?? (raw as { info?: { error?: unknown } })?.info;
          // NEW: read a TOP-LEVEL `error` — the SDK's `{error,request,response}`
          // envelope — which the old parser completely ignored.
          const topError = raw?.error;
          if (text) {
            responses.push(`pass${pass + 1}: ${text.slice(0, 2000)}`);
          } else if (topError != null) {
            const errTxt = typeof topError === 'string' ? topError : JSON.stringify(topError);
            responses.push(`pass${pass + 1} [error]: ${errTxt.slice(0, 2000)}`);
          } else if (info?.error != null) {
            const errTxt = typeof info.error === 'string' ? info.error : JSON.stringify(info.error);
            responses.push(`pass${pass + 1} [info.error]: ${errTxt.slice(0, 2000)}`);
          } else if (raw?.response != null) {
            const respTxt = typeof raw.response === 'string' ? raw.response : JSON.stringify(raw.response).slice(0, 2000);
            responses.push(`pass${pass + 1} [response]: ${respTxt}`);
          } else {
            let shape = 'non-object';
            try {
              const rr = res as Record<string, unknown>;
              if (rr && typeof rr === 'object') shape = `keys=[${Object.keys(rr).join(',')}]`;
            } catch { shape = String(res).slice(0, 300); }
            responses.push(`pass${pass + 1}: (no text, no error) raw=${shape}`);
          }

          after = await fingerprintWorkspace(request.workspacePath);
          changedNow = changedFilesSince(request.workspacePath);
          if (after !== before) break; // real delta landed
        }
        void metadata;
        if (after !== before) {
          changed.push(...changedNow);
          // SCRATCH-ONLY GUARD (war fix): if the produced delta is only diagnostic
          // probe/run/scratch helpers (e.g. `_probe.cmd`, `_run_test.cmd`, `*.log`
          // dumps, throwaway `_*.cmd`), it is NOT a real deliverable. The A/B
          // reviewer would reject it as "no framework deliverable exists," which
          // is the observed 4614-revision vicious cycle. So classify it explicitly
          // instead of routing a doomed review: the controller surfaces this as a
          // probe-only stall and the write-chase keeps pressing for real modules.
          const scratchOnly = changedNow.length > 0 && changedNow.every(isScratchOnlyFile);
          if (scratchOnly) {
            const replyLog = responses.length ? `agent responses: ${responses.join(' | ')}` : 'no assistant response captured';
            return {
              outcome: 'SCRATCH_ONLY',
              changedFiles: changed,
              commandsExecuted: commands,
              artifactsProduced: artifacts,
              workspaceFingerprintBefore: before,
              workspaceFingerprintAfter: after,
              error: `scratch-only-delta (${changedNow.join(', ')}): the mutation produced only diagnostic probe/run helpers, not the real deliverable — ${replyLog}`,
            };
          }
          return {
            outcome: 'CHANGED',
            changedFiles: changed,
            commandsExecuted: commands,
            artifactsProduced: artifacts,
            workspaceFingerprintBefore: before,
            workspaceFingerprintAfter: after,
          };
        }
        // No delta after all passes. Surface WHY: include the agent's actual replies
        // in `error` so the diagnosis stream is not a blind `no-change`. This is the
        // key observability fix for a narrative-but-no-files agent.
        const replyLog = responses.length
          ? `agent responses: ${responses.join(' | ')}`
          : 'no assistant response captured from session.prompt';
        return {
          outcome: 'NO_CHANGE',
          changedFiles: [],
          commandsExecuted: commands,
          artifactsProduced: [],
          workspaceFingerprintBefore: before,
          workspaceFingerprintAfter: after,
          error: `no-change (${MAX_WRITE_PASSES} write passes, no workspace delta) — ${replyLog}`,
        };
      } finally {
        signal.removeEventListener('abort', abort);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { outcome: 'FAILED_TRANSIENT', changedFiles: [], commandsExecuted: commands, artifactsProduced: [], workspaceFingerprintBefore: before, workspaceFingerprintAfter: before, error: msg };
    } finally {
      try { runtime?.server?.close(); } catch { /* best effort */ }
    }
  }
}

/** Codex code-mode host executable name (the write/command tooling codex needs
 *  to mutate a workspace durably). Missing host → agent reads but cannot write. */
function codeModeHostName(): string {
  return process.platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host';
}

/** Resolve the installed Codex CLI binary path, honouring an explicit override. */
export function resolveCodexBin(override?: string): string {
  if (override && override.trim().length > 0) return override.trim();
  // Default to the managed app-server / sandbox codex binary when available.
  const fmt = (p: string) => p.replace(/\\/g, sep);
  // Preferred: the COMPLETE ChatGPT Codex install (ships codex-code-mode-host.exe
  // + command-runner + sandbox-setup). The partial `.sandbox-bin` copy lacks the
  // code-mode host, so its agent can READ but cannot WRITE durably — a codex
  // mutation against it would silently revert every change (false NO_CHANGE).
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const defaultComplete = join(process.env.LOCALAPPDATA ?? homedir(), 'OpenAI', 'Codex', 'bin');
  const defaultSandbox = join(homedir(), '.codex', '.sandbox-bin', exe);
  const defaultManaged = join(homedir(), '.codex', 'packages', 'app-server-daemon', 'current', 'bin', exe);
  // Scan the codex bin dir for a release dir containing the full tool set.
  const completeBin = (() => {
    try {
      if (!existsSync(defaultComplete)) return null;
      const hits = readdirSync(defaultComplete).filter((d) => {
        const dir = join(defaultComplete, d);
        if (!statSync(dir).isDirectory()) return false;
        try { return existsSync(join(dir, exe)) && existsSync(join(dir, codeModeHostName())); } catch { return false; }
      });
      const best = hits.length ? [...hits].sort().at(-1) : undefined;
      return best ? join(defaultComplete, best, exe) : null;
    } catch { return null; }
  })();
  const candidates: string[] = [process.env.CODEX_BIN ?? '', completeBin ?? '', defaultSandbox, defaultManaged]
    .filter((p) => p.length > 0);
  for (const c of candidates) {
    const p = fmt(c);
    try { if (existsSync(p)) return p; } catch { /* keep scanning */ }
  }
  const onPath = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], { encoding: 'utf8', timeout: 5_000 });
  const onPathOut = String(onPath.stdout ?? '');
  if (onPath.status === 0 && onPathOut.trim().length > 0) return onPathOut.trim().split(/\r?\n/)[0] ?? defaultComplete;
  return completeBin ?? defaultSandbox;
}

/**
 * REAL ChatGPT Codex adapter boundary. This spawns the installed Codex CLI
 * (`codex exec -m <model>`) against the writable workspace in `workspace-write`
 * sandbox mode. This is the genuine ChatGPT/Codex transport — the same engine
 * that the ChatGPT desktop app drives — NOT a Kilo-headless session and NOT a
 * renamed agent. The model is the configured route (default `gpt-6-luna`, which
 * the local codex config.toml maps as its default model).
 *
 * This runner runs INSIDE the isolated mutation child (`codex-mutation-child.ts`),
 * mirroring the OpenAI child — a writable model call is never hosted in the
 * mission daemon. It does not self-verify; the independent ExcellenceGovernor + Quality
 * Oracle produce VERIFIED_10_10.
 */
export class CodexMutationRunner implements MutationRunner {
  readonly transport = 'chatgpt-codex-cli' as const;
  readonly writeCapability = true;
  readonly shellCapability = true;
  readonly provider: string;
  readonly model: string;
  readonly agent = 'codex';

  constructor(private readonly opts: {
    codexBin?: string;
    modelID?: string;
    timeoutMs?: number;
  }) {
    this.provider = 'codex';
    this.model = opts.modelID || 'gpt-6-luna';
  }

  async execute(request: RepairRequest, signal: AbortSignal): Promise<RepairResult> {
    const ws = request.workspacePath;
    if (!ws) {
      const before = await fingerprintWorkspace('.');
      return { outcome: 'FAILED_PLAN', changedFiles: [], commandsExecuted: [], artifactsProduced: [], workspaceFingerprintBefore: before, workspaceFingerprintAfter: before, error: 'mutation workspace path is empty' };
    }
    const before = await fingerprintWorkspace(ws);
    const bin = resolveCodexBin(this.opts.codexBin);
    const model = this.model;

    const promptLines = [
      `You are a precise code mutation agent for an autonomous repair loop.`,
      `Mission: ${request.missionId}`,
      `Ticket: ${request.ticketId}  Revision: ${request.revisionId}`,
      ``,
      `OBJECTIVE:`,
      request.objective,
    ];
    const gates = request.failedQualityGateKeys.length ? `\nFAILED QUALITY GATES (must fix): ${request.failedQualityGateKeys.join(', ')}\n` : '';
    if (gates) promptLines.push(gates);
    if (request.currentFindings.length) promptLines.push(`\nCURRENT FINDINGS:\n- ${request.currentFindings.join('\n- ')}`);
    if (request.activeHypotheses.length) promptLines.push(`\nACTIVE HYPOTHESES:\n- ${request.activeHypotheses.join('\n- ')}`);
    // ACCEPTANCE CONSTRAINTS (P0/CTO directive): tasks must be judged by their own
    // acceptance gates, and the mutation must treat them as MUST-satisfy before
    // returning — turning replan into a monotonic repair process, not a retry.
    if (request.acceptanceGates?.length) {
      promptLines.push(
        ``,
        `ACCEPTANCE GATES — you MUST satisfy ALL of these before returning:`,
        request.acceptanceGates.map((g) => `  MUST: ${g}`).join('\n'),
        `For each gate, implement the contract explicitly, cover edge cases (including coercive zeros / "0" / false / null / NaN / Infinity where applicable),`,
        `execute the tests, and leave the test output as a captured evidence artifact. Do NOT return while any acceptance gate is unmet.`,
      );
    }
    promptLines.push(
      ``,
      `Working directory: ${ws}`,
      `You have WRITE + SHELL capabilities scoped to this directory (workspace-write sandbox).`,
      `Make the smallest correct change that satisfies the objective and ALL acceptance gates.`,
      `Before reporting done, verify your change (run tests/typecheck if available) using the shell AND capture the proof:`,
      `  - Run the test (e.g. \`node test.mjs\`), capture BOTH the command's stdout/stderr AND the exit code.`,
      `  - Write them to a workspace file \`test-evidence.txt\` so the ExcellenceGovernor has a real content artifact to verify the pass.`,
      `  - The file MUST reflect the ACTUAL command output and a clear exit-code-0 line — do not fabricate it.`,
      `Do NOT self-verify against review gates — an independent read-only ExcellenceGovernor does that separately.`,
    );

    const prompt = promptLines.join('\n');
    const timeoutMs = (this.opts.timeoutMs ?? 180_000) + 30_000;

    return await new Promise<RepairResult>((resolvePromise) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL'); } catch { /* best effort */ }
        void fingerprintWorkspace(ws).then((after) => resolvePromise({ outcome: 'FAILED_TRANSIENT', changedFiles: [], commandsExecuted: [], artifactsProduced: [], workspaceFingerprintBefore: before, workspaceFingerprintAfter: after, error: `codex mutation timed out after ${timeoutMs}ms and was killed` }));
      }, timeoutMs);

      // Non-interactive Codex exec, workspace-write sandbox, JSONL events.
      const args = ['exec', '-m', model, '-C', ws, '-s', 'workspace-write', '--json', '--skip-git-repo-check', prompt];
      const child = spawn(bin, args, { cwd: ws, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });

      let out = '';
      let errBuf = '';
      child.stdout?.on('data', (c) => { out += c.toString(); });
      child.stderr?.on('data', (c) => { errBuf += c.toString(); });
      child.stdin?.on('error', () => { /* EPIPE - child closed early */ });
      child.on('error', (e) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        void fingerprintWorkspace(ws).then((after) => resolvePromise({ outcome: 'FAILED_TRANSIENT', changedFiles: [], commandsExecuted: [], artifactsProduced: [], workspaceFingerprintBefore: before, workspaceFingerprintAfter: after, error: `codex spawn error: ${e.message}` }));
      });
      child.on('close', async (code) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        // Integrity check: an actual model turn produces agent_message / turn.completed events.
        const noModel = !/turn\.(started|completed)"|"agent_message"/.test(out);
        // This runner executes in an isolated CHILD process (never the daemon), so
        // the fingerprint's async git is awaited here without blocking the mission
        // loop; the child is forked precisely so a long model/git call can't freeze
        // the daemon's event loop or drop keep-alives/SSE.
        const after = await fingerprintWorkspace(ws);
        if ((code !== 0 && out.trim().length === 0) || noModel) {
          const collapsed = (out + '\n' + errBuf).slice(-800);
          return resolvePromise({ outcome: 'FAILED_TRANSIENT', changedFiles: [], commandsExecuted: [], artifactsProduced: [], workspaceFingerprintBefore: before, workspaceFingerprintAfter: after, error: `codex exec exited ${code} without a completed model turn: ${collapsed}` });
        }
        // Collect shell commands the codex agent executed (best-effort from JSONL).
        const commands: string[] = [];
        try {
          for (const line of out.split(/\r?\n/)) {
            const t = line.trim();
            if (!t || !t.startsWith('{')) continue;
            const ev = JSON.parse(t) as Record<string, unknown>;
            if (ev.item && typeof ev.item === 'object') {
              const item = ev.item as Record<string, unknown>;
              if (item.type === 'command_execution' && typeof item.command === 'string' && item.command.trim()) commands.push(item.command.trim());
              if (item.type === 'function_call' && item.name && item.arguments) commands.push(`${item.name}: ${typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments)}`);
            }
          }
        } catch { /* best effort */ }

        const changed = changedFilesSinceFull(ws, (() => { const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ws, encoding: 'utf8', timeout: 10_000 }); return r.status === 0 ? r.stdout!.trim() : ''; })());
        // CHANGED requires DURABLE file evidence. A fingerprint delta with zero
        // persistent file deltas (tracked/untracked diff or a committed advance)
        // means codex reported/observed state that did not land in the workspace
        // (e.g. the agent wrote then reverted, or read-only access failed).
        // Reporting CHANGED on a reverted/no-delta state would poison evidence
        // materialization with a phantom snapshot. NO_CHANGE is the honest result.
        if (after !== before && changed.length > 0) {
          return resolvePromise({ outcome: 'CHANGED', changedFiles: changed, commandsExecuted: commands, artifactsProduced: ['codex-exec'], workspaceFingerprintBefore: before, workspaceFingerprintAfter: after });
        }
        resolvePromise({ outcome: 'NO_CHANGE', changedFiles: changed, commandsExecuted: commands, artifactsProduced: [], workspaceFingerprintBefore: before, workspaceFingerprintAfter: after });
      });
      child.stdin?.end();
    });
  }
}

/**
 * Runs the writable CodexMutationRunner in an ISOLATED child process.
 * Mirrors ChildProcessMutationRunner: a native crash / wedge during a long Codex
 * model call kills only the child; the controller sees FAILED_TRANSIENT and
 * retries per Ender policy. No writable Codex call is ever hosted in the daemon.
 */
export class ChildProcessCodexMutationRunner implements MutationRunner {
  writeCapability = true;
  shellCapability = true;
  readonly transport = 'child-process chatgpt-codex-cli';
  readonly provider = 'codex';
  readonly model: string;
  readonly agent = 'codex-mutation-child';

  constructor(private readonly opts: {
    codexBin?: string;
    modelID?: string;
    timeoutMs?: number;
    childPath?: string;
  }) {
    this.model = opts.modelID || 'gpt-6-luna';
  }

  async execute(request: RepairRequest, _signal: AbortSignal): Promise<RepairResult> {
    const before = await fingerprintWorkspace(request.workspacePath);
    const childPath = this.opts.childPath ?? join(import.meta.dir, 'codex-mutation-child.ts');
    const env = {
      ...process.env,
      GT_CODEX_BIN: resolveCodexBin(this.opts.codexBin),
      GT_CODEX_MODEL_ID: this.model,
      GT_CODEX_TIMEOUT_MS: String(this.opts.timeoutMs ?? 180_000),
    };
    const runnerBin = process.platform === 'win32' ? process.execPath : process.execPath ?? 'bun';
    const timeoutMs = (this.opts.timeoutMs ?? 180_000) + 30_000;

    try {
      const stdout = await new Promise<string>((resolvePromise, reject) => {
        const child = spawn(runnerBin, ['run', childPath], { cwd: import.meta.dir, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let errBuf = '';
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { child.kill('SIGKILL'); } catch { /* best effort */ }
          reject(new Error(`codex mutation child timed out after ${timeoutMs}ms and was killed`));
        }, timeoutMs);
        child.stdout?.on('data', (c) => { out += c.toString(); });
        child.stderr?.on('data', (c) => { errBuf += c.toString(); });
        child.on('error', (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); });
        child.on('close', (code) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          if (code !== 0 && out.trim().length === 0) {
            reject(new Error(`codex mutation child exited ${code}: ${errBuf.slice(0, 300)}`));
            return;
          }
          resolvePromise(out);
        });
        child.stdin?.on('error', () => { /* EPIPE - child closed early */ });
        child.stdin?.end(JSON.stringify(request));
      });

      const jsonStart = stdout.lastIndexOf('\n{');
      const start = jsonStart === -1 ? stdout.indexOf('{') : jsonStart + 1;
      const parsed = JSON.parse(stdout.slice(start)) as RepairResult;
      return {
        outcome: parsed.outcome ?? 'FAILED_TRANSIENT',
        changedFiles: parsed.changedFiles ?? [],
        commandsExecuted: parsed.commandsExecuted ?? [],
        artifactsProduced: parsed.artifactsProduced ?? [],
        workspaceFingerprintBefore: parsed.workspaceFingerprintBefore || before,
        workspaceFingerprintAfter: parsed.workspaceFingerprintAfter || '',
        blocker: parsed.blocker,
        error: parsed.error,
      };
    } catch (err) {
      const after = await fingerprintWorkspace(request.workspacePath);
      const msg = err instanceof Error ? err.message : String(err);
      return { outcome: 'FAILED_TRANSIENT', changedFiles: [], commandsExecuted: [], artifactsProduced: [], workspaceFingerprintBefore: before, workspaceFingerprintAfter: after, error: `codex mutation child failed: ${msg}` };
    }
  }
}

/** Parse `git status --porcelain` into changed file paths WITHOUT mangling.
 *  Porcelain v1 is `XY<space>path` (XY = 2 status chars). Paths containing
 *  spaces/`"` are quoted in porcelain; handle the common cases robustly.
 *  Renames (X='R') appear as `XY old -> new`; we return the NEW path.
 */
export function changedFilesSince(workspacePath: string): string[] {
  const r = spawnSync('git', ['status', '--porcelain', '-z'], { cwd: workspacePath, encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0 || !r.stdout) return [];
  const out: string[] = [];
  // -z separates records with NUL; each record is `XY<space>path1\0` or
  // `XY<space>old\0new\0` for renames/copies.
  const records = r.stdout.split('\0').filter((s) => s.length > 0);
  for (const rec of records) {
    const statusPrefix = rec.slice(0, 3); // e.g. " M ", "?? ", "R  ", " M"
    const xy = (rec[0] ?? '') + (rec[1] ?? '');
    const isRename = xy[0] === 'R';
    if (isRename) {
      // Tabs separate the old and new names in porcelain; spaces are data.
      const tab = rec.indexOf('\t');
      const afterStatus = tab >= 0 ? rec.slice(tab + 1) : rec.slice(3);
      const tab2 = afterStatus.indexOf('\t');
      const newPath = tab2 >= 0 ? afterStatus.slice(tab2 + 1) : afterStatus;
      if (newPath) out.push(unquotePorcelain(newPath));
    } else {
      const tab = rec.indexOf('\t');
      const path = tab >= 0 ? rec.slice(tab + 1) : rec.slice(2);
      if (path && path.length > 0) out.push(unquotePorcelain(path));
    }
    void statusPrefix;
  }
  return [...new Set(out)];
}

/** Porcelain quotes paths that begin with `"` or contain special chars; unquote. */
function unquotePorcelain(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  try {
    return JSON.parse(p);
  } catch {
    return p.slice(1, -1);
  }
}

/** Changed file paths since a base HEAD, including committed changes the agent
 *  made plus uncommitted/untracked working-tree changes. Returns unique paths. */
export function changedFilesSinceFull(workspacePath: string, baseHead: string): string[] {
  const out = new Set<string>();
  const git = (args: string[]) => {
    const r = spawnSync('git', args, { cwd: workspacePath, encoding: 'utf8', timeout: 10_000 });
    return r.status === 0 ? (r.stdout || '').split('\0').filter((s) => s.length > 0) : [];
  };
  // Committed changes since the base HEAD (if the agent committed).
  if (baseHead) {
    for (const p of git(['diff', '--name-only', '-z', baseHead, 'HEAD'])) {
      if (p && !p.startsWith('"')) out.add(unquotePorcelain(p));
    }
    for (const p of git(['diff', '--name-only', '-z', baseHead])) { // uncommitted vs base
      if (p && !p.startsWith('"')) out.add(unquotePorcelain(p));
    }
  }
  // Working-tree (uncommitted) changes + untracked. Porcelain -z is `XY<space>path\0`;
  // slice(2) leaves a leading space that breaks evidence capture — strip it.
  for (const p of git(['status', '--porcelain', '-z'])) {
    const raw = p.startsWith('\t') ? p.slice(1) : p;
    const tab = raw.indexOf('\t');
    const path = tab >= 0 ? raw.slice(tab + 1) : raw.slice(2).replace(/^ /, '');
    if (path && path.length > 0) out.add(unquotePorcelain(path));
  }
  return [...out];
}

/**
 * WRITABLE mutation agent over the OpenAI-compatible `chat/completions` protocol
 * with real tool calling — the same transport that powers the (read-only)
 * reviewers, but with WRITE + SHELL + FILE tools confined to the mutation
 * workspace. This is a real tool-driven actuator (no headless-kilo binary
 * required), matching OpenAI's recommended Codex-style read/apply/shell tooling.
 *
 * Tool enforcement: every file path is resolved against the workspace root and
 * rejected on traversal; shell commands run with `cwd=workspace`. There is no
 * web/MCP/external tool here. The mutation agent may claim completion, but only
 * the independent ExcellenceGovernor + Quality Oracle can produce VERIFIED_10_10.
 */
export class OpenAiMutationRunner implements MutationRunner {
  readonly writeCapability = true;
  readonly shellCapability = true;
  readonly provider: string;
  readonly model: string;
  readonly agent: string;
  readonly transport: string;

  constructor(private readonly opts: {
    providerID: string;
    modelID: string;
    baseURL: string;
    apiKey?: string;
    timeoutMs?: number;
    system?: string;
  }) {
    this.provider = opts.providerID || 'inherit';
    this.model = opts.modelID || 'inherit';
    this.agent = 'openai-mutator';
    this.transport = 'openai-compatible /chat/completions tools';
  }

  private async chatOnce(baseURL: string, headers: Record<string, string>, body: Record<string, unknown>): Promise<{
    ok: boolean; error?: string; message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
  }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 120_000);
    try {
      const resp = await fetch(`${baseURL.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify({ model: this.opts.modelID, temperature: 0.2, ...body }), signal: controller.signal,
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        return { ok: false, error: `openai HTTP ${resp.status}: ${txt.slice(0, 300)}` };
      }
      const d = (await resp.json()) as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> };
      return { ok: true, message: d.choices?.[0]?.message };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  async execute(request: RepairRequest, signal: AbortSignal): Promise<RepairResult> {
    const before = await fingerprintWorkspace(request.workspacePath);
    const commands: string[] = [];
    const artifacts: string[] = [];
    const ws = request.workspacePath;
    const preHead = (() => { const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ws || '.', encoding: 'utf8', timeout: 10_000 }); return r.status === 0 ? r.stdout.trim() : ''; })();
    if (!ws) {
      return { outcome: 'FAILED_PLAN', changedFiles: [], commandsExecuted: [], artifactsProduced: [], workspaceFingerprintBefore: before, workspaceFingerprintAfter: before, error: 'mutation workspace path is empty' };
    }
    const baseURL = this.opts.baseURL;
    if (!baseURL) {
      return { outcome: 'FAILED_PLAN', changedFiles: [], commandsExecuted: [], artifactsProduced: [], workspaceFingerprintBefore: before, workspaceFingerprintAfter: before, error: 'openai mutation runner requires a baseURL' };
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.opts.apiKey) headers['Authorization'] = `Bearer ${this.opts.apiKey}`;

    // Writable tools confined to the workspace root (path-traversal guarded).
    const toolSpecs = [
      { type: 'function', function: { name: 'list_dir', description: 'List entries in a workspace-relative directory.', parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false } } },
      { type: 'function', function: { name: 'read_file', description: 'Read a workspace-relative file.', parameters: { type: 'object', properties: { path: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } }, required: ['path'], additionalProperties: false } } },
      { type: 'function', function: { name: 'write_file', description: 'Write UTF-8 content to a workspace-relative file (creates parent dirs).', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } } },
      { type: 'function', function: { name: 'run_shell', description: 'Run a shell command with cwd=workspace. Use for git status/diff-verify and tests.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } } },
      { type: 'function', function: { name: 'git_status', description: 'Show `git status --porcelain` for the workspace.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
    ];

    const resolveWsPath = (rel: string): string | null => {
      const cleaned = String(rel ?? '').replace(/\\/g, '/');
      const candidate = resolve(ws, cleaned);
      const rr = relative(resolve(ws), candidate);
      const within = rr === '' || (!rr.startsWith(`..${sep}`) && rr !== '..');
      return within ? candidate : null;
    };

    function callTool(name: string, args: Record<string, unknown>): string {
      switch (name) {
        case 'list_dir': {
          const dir = resolveWsPath(String(args.path ?? '.'));
          if (!dir) return '[blocked: path outside workspace]';
          if (!existsSync(dir)) return '[no such directory]';
          let out = '';
          try { out = readdirSync(dir).slice(0, 200).join('\n'); } catch (e) { out = `[error: ${e instanceof Error ? e.message : String(e)}]`; }
          return out || '(empty)';
        }
        case 'read_file': {
          const p = resolveWsPath(String(args.path ?? ''));
          if (!p) return '[blocked: path outside workspace]';
          if (!existsSync(p)) return '[no such file]';
          const st = statSync(p);
          if (st.isDirectory()) return '[is a directory]';
          try {
            const content = readFileSync(p, 'utf-8');
            const lines = content.split('\n');
            const s = typeof args.start === 'number' ? Math.max(0, args.start - 1) : 0;
            const e = typeof args.end === 'number' ? Math.min(lines.length, args.end) : lines.length;
            return lines.slice(s, e).join('\n');
          } catch (e) { return `[error: ${e instanceof Error ? e.message : String(e)}]`; }
        }
        case 'write_file': {
          const p = resolveWsPath(String(args.path ?? ''));
          if (!p) return '[blocked: path outside workspace]';
          const parent = p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')));
          try { if (parent && parent.length) mkdirSync(parent, { recursive: true }); writeFileSync(p, String(args.content ?? ''), 'utf-8'); } catch (e) { return `[write error: ${e instanceof Error ? e.message : String(e)}]`; }
          return `[wrote ${args.path} (${String(args.content ?? '').length} bytes)]`;
        }
        case 'run_shell': {
          const cmd = String(args.command ?? '');
          commands.push(cmd);
          const r = spawnSync(process.env.SHELL ?? (process.platform === 'win32' ? 'cmd.exe' : 'sh'), [process.platform === 'win32' ? '/C' : '-c', cmd], { cwd: ws, encoding: 'utf8', timeout: 30_000, windowsHide: true });
          const out = (r.stdout ?? '') + (r.stderr ?? '');
          return `exit=${r.status}\n${out.slice(0, 4000)}`;
        }
        case 'git_status': {
          const r = spawnSync('git', ['status', '--porcelain', '-z'], { cwd: ws, encoding: 'utf8', timeout: 10_000 });
          return r.status === 0 ? r.stdout || '(clean)' : `[git error: ${(r.stderr ?? '').slice(0, 300)}]`;
        }
        default:
          return `[unknown tool: ${name}]`;
      }
    }

    const prompt = [
      `MUTATION TASK (writable boundary; reviewers are separate and read-only).`,
      `Mission ${request.missionId} ticket ${request.ticketId} revision ${request.revisionId}.`,
      `Objective: ${request.objective}`,
      request.currentFindings.length ? `Current reviewer findings:\n- ${request.currentFindings.join('\n- ')}` : '',
      request.failedQualityGateKeys.length ? `Failed quality gates: ${request.failedQualityGateKeys.join(', ')}` : '',
      request.verifiedScientificFacts.length ? `Verified facts:\n- ${request.verifiedScientificFacts.join('\n- ')}` : '',
      request.falsifiedHypotheses.length ? `Do NOT repeat falsified hypotheses:\n- ${request.falsifiedHypotheses.join('\n- ')}` : '',
      request.previousFailureSignature ? `Previous failure signature: ${request.previousFailureSignature}` : '',
      request.acceptanceGates?.length ? `ACCEPTANCE GATES (MUST satisfy all before returning):\n- ${request.acceptanceGates.join('\n- ')}\nFor each gate, implement the contract explicitly, cover edge cases (coercive zeros, "0", false, null, NaN, Infinity where applicable), execute tests, and capture test output as evidence.` : '',
      `Allowed capabilities: ${request.allowedCapabilities.join(', ')}`,
      `Workspace: ${ws}. Use the write_file / apply changes via write_file + run_shell to make the smallest correct change that satisfies the objective AND every acceptance gate. Verify with git_status / run_shell (tests).`,
      `When done, report a short summary of what you changed, every command you ran, and every artifact you produced.`,
    ].filter(Boolean).join('\n\n');

    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: this.opts.system ?? 'You are a careful code mutation agent. Edit source, run/verify tests, and report what you changed and ran. Only change what the objective requires.' },
      { role: 'user', content: prompt },
    ];

    try {
      let step = 0;
      let finalText = '';
      while (step < 20) {
        if (signal.aborted) { await this.abortSession(signal); }
        step++;
        const res = await this.chatOnce(baseURL, headers, { messages, tools: toolSpecs, tool_choice: 'auto' });
        if (!res.ok) return { outcome: 'FAILED_TRANSIENT', changedFiles: [], commandsExecuted: commands, artifactsProduced: artifacts, workspaceFingerprintBefore: before, workspaceFingerprintAfter: before, error: res.error };
        const m = res.message;
        const tcs = m?.tool_calls ?? [];
        if (tcs.length === 0) { finalText = m?.content ?? ''; break; }
        messages.push({ role: 'assistant', content: m?.content ?? null, tool_calls: tcs });
        for (const tc of tcs) {
          let result: string;
          try { result = callTool(tc.function.name, JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>); }
          catch (e) { result = `[tool error: ${e instanceof Error ? e.message : String(e)}]`; }
          messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
      }
      void finalText;
      const after = await fingerprintWorkspace(ws);
      // Include BOTH uncommitted changes AND any commits the mutation made since
      // it began (the model may `git commit`). This is what the evidence
      // materializer needs so a committed fix still yields content evidence.
      const changed = changedFilesSinceFull(ws, preHead);
      if (after !== before) {
        artifacts.push('workspace-changed');
        // COMPLETION FIX: commit the delta so it becomes a durable, reviewable,
        // revision-advancing commit instead of stranded untracked files. The
        // mutation utils can `git commit` but often exit before doing so, leaving
        // revids stuck at MUTATING with the work invisible. Stage + commit here.
        try {
          const add = spawnSync('git', ['add', '-A'], { cwd: ws, encoding: 'utf8', timeout: 20_000, windowsHide: true });
          if (add.status === 0) {
            const commit = spawnSync('git', ['-c', 'user.name=HELLDESK', '-c', 'user.email=helldesk@localhost', 'commit', '-m', `helldesk mutator delta (${Date.now()})`], { cwd: ws, encoding: 'utf8', timeout: 20_000, windowsHide: true });
            if (commit.status === 0) commands.push(`git commit (auto, ${Date.now()})`);
          }
        } catch { /* commit is best-effort; a failed commit just leaves the delta uncommitted, CHANGED still counts it */ }
        return { outcome: 'CHANGED', changedFiles: changed, commandsExecuted: commands, artifactsProduced: artifacts, workspaceFingerprintBefore: before, workspaceFingerprintAfter: after };
      }
      return { outcome: 'NO_CHANGE', changedFiles: [], commandsExecuted: commands, artifactsProduced: [], workspaceFingerprintBefore: before, workspaceFingerprintAfter: after };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { outcome: 'FAILED_TRANSIENT', changedFiles: [], commandsExecuted: commands, artifactsProduced: [], workspaceFingerprintBefore: before, workspaceFingerprintAfter: before, error: msg };
    }
  }

  private async abortSession(_signal: AbortSignal): Promise<void> { /* transport has no server to abort; signal already observed */ }
}

/**
 * Runs the writable OpenAiMutationRunner in an ISOLATED child process.
 *
 * Motivation: a long/flaky OpenAI-compatible model call against some endpoints
 * occasionally triggers a native Bun crash (process exits ~-1 with no catchable
 * exception). Spawning the mutation in its own process means such a crash kills
 * only the child; the controller sees FAILED_TRANSIENT and retries per Ender
 * policy. This is also the production-correct boundary (no writable model call
 * in the mission daemon).
 */
export class ChildProcessMutationRunner implements MutationRunner {
  writeCapability = true;
  shellCapability = true;
  readonly transport: string;
  constructor(
    private readonly opts: {
      providerID: string;
      modelID: string;
      baseURL: string;
      apiKey?: string;
      timeoutMs?: number;
      childPath?: string; // path to mutation-child.ts (overridable for tests)
    },
  ) {
    this.provider = opts.providerID || 'inherit';
    this.model = opts.modelID || 'inherit';
    this.agent = 'openai-mutation-child';
    this.transport = 'child-process /chat/completions tools';
  }
  readonly provider: string;
  readonly model: string;
  readonly agent: string;

  async execute(request: RepairRequest, _signal: AbortSignal): Promise<RepairResult> {
    const before = await fingerprintWorkspace(request.workspacePath);
    const childPath = this.opts.childPath ?? join(import.meta.dir, 'mutation-child.ts');
    const env = {
      ...process.env,
      GT_MUTATION_PROVIDER_ID: this.opts.providerID,
      GT_MUTATION_MODEL_ID: this.opts.modelID,
      GT_MUTATION_BASE_URL: this.opts.baseURL,
      GT_MUTATION_API_KEY: this.opts.apiKey ?? '',
      GT_MUTATION_TIMEOUT_MS: String(this.opts.timeoutMs ?? 180_000),
    };
    const runnerBin = process.platform === 'win32' ? process.execPath : process.execPath ?? 'bun';
    const timeoutMs = (this.opts.timeoutMs ?? 180_000) + 30_000; // allow child its own full budget + margin

    // ASYNC spawn: the parent event loop stays alive (no sync block), and a
    // hard wall-clock timer KILLS the child on timeout so a wedged model call
    // can never deadlock the mission. A killed/timeout child -> FAILED_TRANSIENT.
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(runnerBin, ['run', childPath], {
          cwd: import.meta.dir,
          windowsHide: true,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { child.kill('SIGKILL'); } catch { /* best effort */ }
          reject(new Error(`mutation child timed out after ${timeoutMs}ms and was killed`));
        }, timeoutMs);
        child.stdout?.on('data', (c) => { out += c.toString(); });
        child.stderr?.on('data', (c) => { err += c.toString(); });
        child.on('error', (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); });
        child.on('close', (code, sig) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (code !== 0 && out.trim().length === 0) {
            reject(new Error(`mutation child exited ${code}${sig ? ' ' + sig : ''}: ${err.slice(0, 300)}`));
            return;
          }
          resolve(out);
        });
        child.stdin?.on('error', () => { /* EPIPE - child closed early */ });
        child.stdin?.end(JSON.stringify(request));
      });
      const idx = stdout.lastIndexOf('\n{');
      const jsonStart = idx === -1 ? stdout.indexOf('{') : idx + 1;
      const parsed = JSON.parse(stdout.slice(jsonStart)) as RepairResult;
      return {
        outcome: parsed.outcome ?? 'FAILED_TRANSIENT',
        changedFiles: parsed.changedFiles ?? [],
        commandsExecuted: parsed.commandsExecuted ?? [],
        artifactsProduced: parsed.artifactsProduced ?? [],
        workspaceFingerprintBefore: parsed.workspaceFingerprintBefore || before,
        workspaceFingerprintAfter: parsed.workspaceFingerprintAfter || '',
        blocker: parsed.blocker,
        error: parsed.error,
      };
    } catch (err) {
      // Child crashed, timed out, or produced no JSON -> transient retry.
      const msg = err instanceof Error ? err.message : String(err);
      return { outcome: 'FAILED_TRANSIENT', changedFiles: [], commandsExecuted: [], artifactsProduced: [], workspaceFingerprintBefore: before, workspaceFingerprintAfter: before, error: `mutation child failed: ${msg}` };
    }
  }
}

/** Resolve the mutation actuator by name — NEVER fake identity or silent-substitute.
 *  `kilo` → the real implemented KiloMutationRunner; `openai` → the writable
 *  tool-based OpenAiMutationRunner (isolated child); `codex` → the real ChatGPT
 *  Codex CLI transport (`codex exec -m gpt-6-luna`, isolated child). */
export function resolveMutationRunner(config: {
  mutationRunner: string;
  codexBin: string;
  providerID: string;
  modelID: string;
  baseURL: string;
  apiKey?: string;
  timeoutMs?: number;
}): MutationRunner {
  const r = config.mutationRunner.trim().toLowerCase();
  if (r === 'kilo' || r === 'kilo-headless') {
    return new KiloMutationRunner({
      codexBin: config.codexBin,
      providerID: config.providerID,
      modelID: config.modelID,
      baseURL: config.baseURL,
      apiKey: config.apiKey,
    });
  }
  if (r === 'openai' || r === 'openai-tools') {
    return new ChildProcessMutationRunner({
      providerID: config.providerID,
      modelID: config.modelID,
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
    });
  }
  if (r === 'codex') {
    // Real ChatGPT Codex CLI transport: uses the model route (default gpt-6-luna)
    // via `codex exec`, isolated in a child process. codexBin defaults to the
    // managed app-server binary (resolveCodexBin) when config.codexBin is empty.
    return new ChildProcessCodexMutationRunner({
      codexBin: config.codexBin,
      modelID: config.modelID || 'gpt-6-luna',
    });
  }
  // No silent fallback: an unknown actuator is a config error, not a substitute.
  throw new Error(`unknown mutationRunner '${config.mutationRunner}' (allowed: 'kilo', 'openai', 'codex')`);
}
