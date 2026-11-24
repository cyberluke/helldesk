/**
 * export-evidence.ts — turn one HELLDESK live mission into a sanitized,
 * content-addressed evidence bundle that an outsider can audit without this
 * machine.
 *
 * The bundle is intentionally dumb and explicit:
 *
 *   bundle.json          — the full machine-readable record (mission, tickets,
 *                          revisions, gate executions, review jobs/attempts,
 *                          snapshots, evidence artifacts, certification claim)
 *   artifacts/           — every referenced byte (gate result/stdout/stderr,
 *                          browser screenshots, snapshot manifests/diffs/files,
 *                          reviewer outputs, reports)
 *   README.md            — the human summary of what happened and what it proves
 *
 * Rules:
 *  - Absolute operator paths are replaced with ${REPO}, ${DATA}, ${WORKSPACE},
 *    ${HOME}; the bundle must be readable elsewhere.
 *  - Every copied artifact is recorded with its sha256 + byte length. The
 *    verifier recomputes both; a bundle with a missing or altered byte fails.
 *  - The certification claim is recorded separately from the mission state.
 *    A VERIFIED_10_10 mission whose gate candidate != the workspace tree at
 *    verification is exported as certificationValid=false, never as a success.
 *
 * Usage:
 *   bun run benchmarks/m6/export-evidence.ts \
 *     --db .local/benchmark/m6/live-data/helldesk.db \
 *     --run-id m6a \
 *     --workspace .local/benchmark/m6/live-workspace \
 *     --out benchmarks/m6/evidence/m6a
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

interface Args {
  db: string;
  runId: string;
  workspace: string;
  out: string;
  mission?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const db = get('--db');
  const runId = get('--run-id');
  const workspace = get('--workspace');
  const out = get('--out');
  if (!db || !runId || !workspace || !out) {
    throw new Error('required: --db <path> --run-id <id> --workspace <path> --out <dir>');
  }
  return { db: resolve(db), runId, workspace: resolve(workspace), out: resolve(out), mission: get('--mission') };
}

function sha256Buf(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function sha256File(path: string): string {
  return sha256Buf(readFileSync(path));
}

function slash(p: string): string {
  return p.replace(/\\/g, '/');
}

function repoRootOf(start: string): string {
  try {
    return execFileSync('git', ['-C', start, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return start;
  }
}

function git(workspace: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function isFile(path: string | null | undefined): path is string {
  if (!path) return false;
  try { return statSync(path).isFile(); } catch { return false; }
}

function isDir(path: string | null | undefined): path is string {
  if (!path) return false;
  try { return statSync(path).isDirectory(); } catch { return false; }
}

class Exporter {
  readonly args: Args;
  readonly d: Database;
  readonly repoRoot: string;
  readonly homeDir = process.env.USERPROFILE ?? process.env.HOME ?? '';
  readonly dataDir: string;
  readonly artifacts: Array<{
    id: string;
    kind: string;
    source: string;
    bundlePath: string;
    sha256: string;
    bytes: number;
    sourceSha256?: string | null;
    missing?: boolean;
  }> = [];
  private artifactSeq = 0;

  constructor(args: Args) {
    this.args = args;
    this.d = new Database(args.db, { readonly: true });
    this.repoRoot = repoRootOf(args.workspace);
    this.dataDir = dirname(args.db);
  }

  /** Replace machine-specific absolute paths with stable tokens. */
  sanitize(input: string): string {
    let out = input;
    const maps: Array<[string, string]> = [
      [this.args.workspace, '${WORKSPACE}'],
      [this.dataDir, '${DATA}'],
      [this.repoRoot, '${REPO}'],
    ];
    if (this.homeDir) maps.push([this.homeDir, '${HOME}']);
    // Case-insensitive: JSON/manifest sources may lowercase the drive or vary
    // the user casing (`c:\\Users\\lukes.COREI9\\...`). Handle raw and
    // JSON-escaped (double-backslash) forms with a regex, not case variants.
    const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const [abs, token] of maps) {
      for (const variant of new Set([abs, slash(abs), abs.replace(/\\/g, '\\\\')])) {
        out = out.replace(new RegExp(escapeRegExp(variant), 'gi'), token);
      }
    }
    // Generic Windows home scrub: reviewers quote attachment paths using the
    // 8.3 short username (`C:\Users\LUKES~1.COR\...`) which the long USERPROFILE
    // map cannot match. Replace any drive:\Users\<user> prefix, raw or
    // JSON-escaped, with ${HOME}.
    out = out.replace(/[A-Za-z]:\\+Users\\+[^\\/"\s]+/gi, '${HOME}');
    return out;
  }

  sanitizeDeep<T>(value: T): T {
    if (typeof value === 'string') return this.sanitize(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => this.sanitizeDeep(v)) as unknown as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = this.sanitizeDeep(v);
      return out as T;
    }
    return value;
  }

  private nextId(prefix: string): string {
    this.artifactSeq += 1;
    return `${prefix}-${String(this.artifactSeq).padStart(4, '0')}`;
  }

  /**
   * Copy one artifact into the bundle. JSON/text is sanitized; binary is copied
   * byte-for-byte. Records the ORIGINAL sha256 (what the DB/engine saw) and the
   * BUNDLE sha256 (what the verifier reads), so sanitization is auditable.
   */
  copyArtifact(
    kind: string,
    sourcePath: string,
    bundleRel: string,
    opts?: { text?: boolean; required?: boolean },
  ): string | null {
    const id = this.nextId(kind);
    const target = join(this.args.out, bundleRel);
    mkdirSync(dirname(target), { recursive: true });
    if (!isFile(sourcePath)) {
      if (opts?.required !== false) {
        this.artifacts.push({
          id, kind, source: this.sanitize(sourcePath), bundlePath: slash(bundleRel),
          sha256: '', bytes: 0, missing: true,
        });
      }
      return null;
    }
    const original = readFileSync(sourcePath);
    const originalSha = sha256Buf(original);
    let written: Buffer;
    if (opts?.text !== false && /\.(json|txt|md|log|diff|css|js|mjs|ts|tsx|html)$/i.test(sourcePath)) {
      const text = this.sanitize(original.toString('utf8'));
      written = Buffer.from(text, 'utf8');
    } else {
      written = original;
    }
    writeFileSync(target, written);
    this.artifacts.push({
      id,
      kind,
      source: this.sanitize(sourcePath),
      bundlePath: slash(bundleRel),
      sha256: sha256Buf(written),
      bytes: written.byteLength,
      sourceSha256: originalSha,
    });
    return slash(bundleRel);
  }

  /** Write a derived JSON/text document into the bundle. */
  writeDoc(bundleRel: string, content: string, kind: string, source: string): string {
    const id = this.nextId(kind);
    const target = join(this.args.out, bundleRel);
    mkdirSync(dirname(target), { recursive: true });
    const buf = Buffer.from(this.sanitize(content), 'utf8');
    writeFileSync(target, buf);
    this.artifacts.push({
      id, kind, source: this.sanitize(source), bundlePath: slash(bundleRel),
      sha256: sha256Buf(buf), bytes: buf.byteLength,
    });
    return slash(bundleRel);
  }

  run(): void {
    rmSync(this.args.out, { recursive: true, force: true });
    mkdirSync(this.args.out, { recursive: true });

    const mission = this.pickMission();
    const missionId = mission.mission_id as string;

    const tickets = this.d.query('SELECT * FROM mission_tickets WHERE mission_id=? ORDER BY created_at').all(missionId) as any[];
    const revisions = this.d.query(
      `SELECT r.* FROM ticket_revisions r
       JOIN mission_tickets t ON t.ticket_id = r.ticket_id
       WHERE t.mission_id=? ORDER BY r.created_at`,
    ).all(missionId) as any[];

    const revisionRecords: any[] = [];
    for (const rev of revisions) {
      const gates = this.d.query(
        'SELECT * FROM gate_executions WHERE revision_id=? ORDER BY started_at',
      ).all(rev.revision_id) as any[];
      const gateRows = this.d.query(
        'SELECT * FROM quality_gate_results WHERE revision_id=?',
      ).all(rev.revision_id) as any[];
      const evidence = this.d.query(
        'SELECT * FROM evidence_artifacts WHERE revision_id=? ORDER BY artifact_id',
      ).all(rev.revision_id) as any[];
      const snapshot = rev.snapshot_id
        ? (this.d.query('SELECT * FROM snapshots WHERE snapshot_id=?').get(rev.snapshot_id) as any)
        : null;
      const job = rev.review_job_id
        ? (this.d.query('SELECT * FROM review_jobs WHERE job_id=?').get(rev.review_job_id) as any)
        : null;
      const attempts = job
        ? (this.d.query('SELECT * FROM review_attempts WHERE job_id=? ORDER BY attempt_no').all(job.job_id) as any[])
        : [];
      const runs = job
        ? (this.d.query('SELECT * FROM agent_runs WHERE job_id=? ORDER BY started_at').all(job.job_id) as any[])
        : [];
      const plan = this.d.query('SELECT * FROM repair_plans WHERE revision_id=?').get(rev.revision_id) as any;

      const gateRecords: any[] = [];
      for (const g of gates) {
        const resultPath = this.artifactPathOf(evidence, g.evidence_artifact_id);
        const gateDir = resultPath ? dirname(resultPath) : '';
        const relBase = `artifacts/gates/${rev.revision_id}/${g.gate_key}-${String(g.started_at).replace(/[:.]/g, '-')}`;
        const resultRel = resultPath
          ? this.copyArtifact('gate-result', resultPath, `${relBase}/result.json`)
          : null;
        const logs: Record<string, string | null> = {};
        for (const name of ['stdout.log', 'stderr.log', 'actual.png', 'full.png', 'diff.png', 'ratio.txt']) {
          const p = gateDir ? join(gateDir, name) : '';
          if (p && isFile(p)) logs[name] = this.copyArtifact('gate-output', p, `${relBase}/${name}`);
        }
        gateRecords.push({
          gate_key: g.gate_key,
          candidate_hash: g.candidate_hash,
          status: g.status,
          exit_code: g.exit_code,
          duration_ms: g.duration_ms,
          command: this.sanitize(g.command ?? ''),
          evidence_artifact_id: g.evidence_artifact_id,
          result_sha256: evidence.find((e) => e.artifact_id === g.evidence_artifact_id)?.sha256 ?? null,
          result_path: resultRel,
          stdout_sha256: g.stdout_sha256,
          stderr_sha256: g.stderr_sha256,
          started_at: g.started_at,
          finished_at: g.finished_at,
          outputs: logs,
        });
      }

      // Snapshot: manifest + diff + captured files + prompts + reviewer results.
      let snapRecord: any = null;
      if (snapshot) {
        const snapDir = join(this.dataDir, 'snapshots', snapshot.snapshot_id);
        const manifestPath = join(this.dataDir, 'snapshots', `${snapshot.snapshot_id}.manifest.json`);
        const diffPath = join(this.dataDir, 'snapshots', `${snapshot.snapshot_id}.diff`);
        const relBase = `artifacts/snapshots/${snapshot.snapshot_id}`;
        const capturedFiles: Array<{ path: string; sha256: string; bytes: number; bundlePath: string | null }> = [];
        const filesDir = join(snapDir, 'files');
        if (isDir(filesDir)) {
          for (const name of readdirSync(filesDir)) {
            const p = join(filesDir, name);
            if (!isFile(p)) continue;
            const rel = this.copyArtifact('snapshot-file', p, `${relBase}/files/${name}`);
            capturedFiles.push({ path: name.replace(/__/g, '/'), sha256: sha256File(p), bytes: statSync(p).size, bundlePath: rel });
          }
        }
        const prompts: Record<string, string | null> = {};
        const promptsDir = join(snapDir, 'prompts');
        if (isDir(promptsDir)) {
          for (const name of readdirSync(promptsDir)) {
            const p = join(promptsDir, name);
            if (isFile(p)) prompts[name] = this.copyArtifact('review-prompt', p, `${relBase}/prompts/${name}`);
          }
        }
        const results: Record<string, string | null> = {};
        const resultsDir = join(snapDir, 'results');
        if (isDir(resultsDir)) {
          for (const name of readdirSync(resultsDir)) {
            const p = join(resultsDir, name);
            if (isFile(p)) results[name] = this.copyArtifact('review-result', p, `${relBase}/results/${name}`);
          }
        }
        snapRecord = {
          snapshot_id: snapshot.snapshot_id,
          subject_kind: snapshot.subject_kind,
          base_hash: snapshot.base_hash,
          head_hash: snapshot.head_hash,
          dirty_hash: snapshot.dirty_hash,
          untracked_hash: snapshot.untracked_hash,
          content_hash: snapshot.content_hash,
          manifest_hash: snapshot.manifest_hash,
          created_at: snapshot.created_at,
          manifest: manifestPath ? this.copyArtifact('snapshot-manifest', manifestPath, `${relBase}/manifest.json`) : null,
          diff: diffPath ? this.copyArtifact('snapshot-diff', diffPath, `${relBase}/diff.patch`) : null,
          capturedFiles,
          prompts,
          results,
        };
      }

      // Report files for this job (immutable JSON + markdown).
      const reportFiles: Record<string, string | null> = {};
      if (job) {
        for (const ext of ['json', 'md']) {
          const p = join(this.dataDir, 'reports', `${job.job_id}.${ext}`);
          if (isFile(p)) reportFiles[ext] = this.copyArtifact('review-report', p, `artifacts/reviews/${job.job_id}/report.${ext}`);
        }
      }

      const candidateHashes = [...new Set(gateRecords.map((g) => g.candidate_hash).filter(Boolean))];
      revisionRecords.push({
        revision_id: rev.revision_id,
        revision_no: rev.revision_no,
        ticket_id: rev.ticket_id,
        state: rev.state,
        created_at: rev.created_at,
        completed_at: rev.completed_at,
        failure_signature: rev.failure_signature,
        snapshot_id: rev.snapshot_id,
        review_job_id: rev.review_job_id,
        workspace_fingerprint_before: rev.workspace_fingerprint_before,
        workspace_fingerprint_after: rev.workspace_fingerprint_after,
        gate_candidates: candidateHashes,
        gate_candidates_consistent: candidateHashes.length <= 1,
        gates: gateRecords,
        quality_gate_rows: gateRows,
        evidence: evidence.map((e) => ({
          artifact_id: e.artifact_id,
          kind: e.kind,
          path: this.sanitize(e.path ?? ''),
          sha256: e.sha256,
          bytes: e.bytes,
          producer: e.producer,
        })),
        snapshot: snapRecord,
        review: job ? {
          job_id: job.job_id,
          state: job.state,
          result: job.result,
          requested_at: job.requested_at,
          completed_at: job.completed_at,
          coverage: job.coverage,
          attempts: attempts.map((a) => ({ attempt_no: a.attempt_no, state: a.state, started_at: a.started_at, finished_at: a.finished_at })),
          runs: runs.map((r) => ({
            role: r.role, status: r.status, provider_id: r.provider_id, model_id: r.model_id,
            started_at: r.started_at, finished_at: r.finished_at,
            tokens_in: r.tokens_in, tokens_out: r.tokens_out,
          })),
          files: reportFiles,
        } : null,
        repair_plan: plan ? {
          plan_id: plan.plan_id,
          reason: plan.reason ?? null,
          hypothesis_key: plan.hypothesis_key,
          failure_signature: plan.failure_signature,
          plan_json: this.sanitize(plan.plan_json ?? ''),
        } : null,
      });
    }

    // ── Workspace identity at export time + the certification claim ─────────
    const head = git(this.args.workspace, ['rev-parse', 'HEAD']);
    const headTree = head ? git(this.args.workspace, ['show', '-s', '--format=%T', head]) : '';
    const treeNow = this.computeWorkspaceTree();
    const statusPorcelain = git(this.args.workspace, ['status', '--porcelain']);
    const headSubject = git(this.args.workspace, ['log', '-1', '--format=%s']);
    const headTime = git(this.args.workspace, ['log', '-1', '--format=%cI']);
    // Reflog is the durable witness of WHEN each HEAD landed. It lets the
    // bundle prove what the workspace head was at the exact verification
    // instant, even though the workspace keeps moving after the run.
    const reflogRows = git(this.args.workspace, ['reflog', '--date=iso', '--format=%H%x09%ci%x09%gs'])
      .split('\n')
      .map((line) => {
        const [commit, time, subject] = line.split('\t');
        return commit && time ? { commit, time, subject: subject ?? '' } : null;
      })
      .filter((r): r is { commit: string; time: string; subject: string } => r !== null);

    const verifiedRevisions = revisionRecords.filter((r) => r.state === 'VERIFIED_10_10');
    const certification = this.certificationClaim(mission, revisionRecords, {
      head, headTree, treeNow, statusPorcelain, headSubject, headTime, reflogRows,
    });

    const bundle = {
      schema: 'helldesk.m6.evidence.v1',
      runId: this.args.runId,
      generatedAt: new Date().toISOString(),
      generator: 'benchmarks/m6/export-evidence.ts',
      engine: {
        repoHead: git(this.repoRoot, ['rev-parse', 'HEAD']),
        repoBranch: git(this.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
      },
      mission: {
        mission_id: mission.mission_id,
        workspace_id: mission.workspace_id,
        objective: this.sanitize(mission.objective ?? ''),
        state: mission.state,
        verified_at: mission.verified_at,
        created_at: mission.created_at,
        updated_at: mission.updated_at,
        policy_version: mission.policy_version,
        task_gates: mission.task_gates_json ? JSON.parse(mission.task_gates_json) : [],
        gate_commands: mission.gate_commands_json ? this.sanitize(mission.gate_commands_json) : '{}',
        engine_matrix: mission.engine_matrix_json ? JSON.parse(mission.engine_matrix_json) : {},
        baseline: mission.baseline_json ? this.sanitize(mission.baseline_json) : null,
        human_acceptance: mission.human_acceptance ?? null,
      },
      tickets: tickets.map((t) => ({
        ticket_id: t.ticket_id,
        title: t.title,
        objective: this.sanitize(t.objective ?? ''),
        execution_state: t.execution_state,
        verification_state: t.verification_state,
        active_revision_id: t.active_revision_id,
      })),
      revisions: revisionRecords,
      workspaceAtExport: {
        head,
        head_tree: headTree,
        head_subject: headSubject,
        head_committed_at: headTime,
        tree: treeNow,
        status_porcelain: this.sanitize(statusPorcelain),
        reflog: reflogRows.map((r) => ({ ...r, subject: this.sanitize(r.subject) })),
      },
      certification,
      artifacts: this.artifacts,
    };

    const bundleRel = 'bundle.json';
    writeFileSync(join(this.args.out, bundleRel), JSON.stringify(bundle, null, 2));

    writeFileSync(join(this.args.out, 'README.md'), this.renderReadme(bundle));

    console.log(`[export] ${this.args.out}`);
    console.log(`[export] mission ${mission.mission_id} state=${mission.state}`);
    console.log(`[export] revisions=${revisionRecords.length} artifacts=${this.artifacts.length}`);
    console.log(`[export] certificationValid=${certification.certificationValid} (${certification.reason})`);
    this.d.close();
  }

  private pickMission(): any {
    const rows = this.args.mission
      ? (this.d.query('SELECT * FROM autonomy_missions WHERE mission_id=?').all(this.args.mission) as any[])
      : (this.d.query('SELECT * FROM autonomy_missions ORDER BY created_at DESC').all() as any[]);
    if (!rows.length) throw new Error('no mission rows in DB');
    if (rows.length > 1 && !this.args.mission) {
      console.log(`[export] WARN: ${rows.length} missions; using newest ${rows[0].mission_id} (pass --mission to choose)`);
    }
    return rows[0];
  }

  private artifactPathOf(evidence: any[], artifactId: string): string | null {
    const row = evidence.find((e) => e.artifact_id === artifactId);
    if (!row?.path) return null;
    return isAbsolute(row.path) ? row.path : join(this.dataDir, row.path);
  }

  private computeWorkspaceTree(): string {
    // Same identity the gate runner binds to: temp index + git add -A + write-tree.
    const scratch = join(this.dataDir, `.export-tree-${Date.now()}`);
    try {
      mkdirSync(join(scratch, 'objects'), { recursive: true });
      const gitDirRaw = git(this.args.workspace, ['rev-parse', '--git-dir']);
      const gitDir = gitDirRaw
        ? (isAbsolute(gitDirRaw) ? gitDirRaw : resolve(this.args.workspace, gitDirRaw))
        : '';
      if (!gitDir) return '';
      const env = {
        ...process.env,
        GIT_INDEX_FILE: join(scratch, 'index'),
        GIT_OBJECT_DIRECTORY: join(scratch, 'objects'),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(gitDir, 'objects'),
      };
      execFileSync('git', ['-C', this.args.workspace, 'add', '-A'], { env, stdio: 'ignore' });
      return execFileSync('git', ['-C', this.args.workspace, 'write-tree'], { env, encoding: 'utf8' }).trim();
    } catch {
      return '';
    } finally {
      try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  /**
   * The claim this bundle makes. A mission may be VERIFIED_10_10 and still be an
   * INVALID certification: the only valid claim is "the workspace tree that was
   * stamped equals the tree the host gates executed".
   *
   * Provable from the record:
   *  - gate candidate tree (recorded on every gate execution),
   *  - the revision's own commit (snapshot head / captured evidence),
   *  - the workspace HEAD + commit time.
   * When the verified revision's gate candidate != the verified workspace tree,
   * the bundle records certificationValid=false with the evidence.
   */
  private certificationClaim(
    mission: any,
    revisions: any[],
    ws: {
      head: string; headTree: string; treeNow: string; statusPorcelain: string;
      headSubject: string; headTime: string;
      reflogRows: Array<{ commit: string; time: string; subject: string }>;
    },
  ): any {
    if (mission.state !== 'VERIFIED_10_10') {
      return {
        certified: false,
        certificationValid: false,
        reason: `mission state is ${mission.state}, not VERIFIED_10_10`,
        verifiedRevisions: [],
      };
    }
    const verified = revisions.filter((r) => r.state === 'VERIFIED_10_10');
    const details: any[] = [];
    let valid = verified.length > 0;
    let reason = 'ok';
    for (const rev of verified) {
      const candidates = rev.gate_candidates as string[];
      const gateCandidate = candidates.length === 1 ? candidates[0] : null;
      const verifiedAt = rev.completed_at ?? rev.review?.completed_at ?? null;
      // What was HEAD at the certification instant? The reflog is newest-first;
      // the first entry at/before the verification time is the head the engine
      // saw. Its tree is the tree that had to equal the gate candidate.
      const headAtVerification = verifiedAt
        ? (ws.reflogRows.find((r) => Date.parse(r.time) <= Date.parse(verifiedAt)) ?? null)
        : null;
      const headTreeAtVerification = headAtVerification
        ? git(this.args.workspace, ['show', '-s', '--format=%T', headAtVerification.commit])
        : '';
      // The engine persists the exact tree its drift guard accepted at
      // verification (`tree:<hash>`). That is authoritative for a DIRTY
      // (uncommitted) delta, where the HEAD tree is the baseline, not the
      // candidate. Fall back to the reflog head tree for older revisions.
      const recordedTree = typeof rev.workspace_fingerprint_after === 'string'
        && rev.workspace_fingerprint_after.startsWith('tree:')
        ? rev.workspace_fingerprint_after.slice('tree:'.length)
        : '';
      const treeAtVerification = recordedTree || headTreeAtVerification;
      const treeSource = recordedTree ? 'revision.workspace_fingerprint_after' : 'git-reflog-head-tree';
      const treeMatchesAtVerification = gateCandidate && treeAtVerification
        ? treeAtVerification === gateCandidate
        : null;
      const treeMatchesNow = gateCandidate ? ws.treeNow === gateCandidate : null;
      const headTreeMatchesNow = gateCandidate && ws.headTree ? ws.headTree === gateCandidate : null;
      const revValid = Boolean(gateCandidate)
        && treeMatchesAtVerification !== false
        && (treeMatchesAtVerification === true || headTreeMatchesNow === true || treeMatchesNow === true);
      if (!revValid) valid = false;
      if (!gateCandidate) reason = `verified revision ${rev.revision_id} has no single gate candidate`;
      else if (!revValid) {
        reason = `verified revision ${rev.revision_id} gate candidate ${gateCandidate} != the tree at verification `
          + `(head ${headAtVerification?.commit ?? ws.head} tree=${treeAtVerification || '(unavailable)'}; `
          + `head@export tree=${ws.headTree || '-'}, worktree@export=${ws.treeNow || '-'})`;
      }
      details.push({
        revision_id: rev.revision_id,
        gate_candidate: gateCandidate,
        gate_candidates: candidates,
        verified_at: verifiedAt,
        head_at_verification: headAtVerification ?? null,
        tree_at_verification: treeAtVerification || null,
        tree_source: treeSource,
        tree_at_verification_equals_gate_candidate: treeMatchesAtVerification,
        workspace_head_at_export: ws.head,
        workspace_head_tree_at_export: ws.headTree,
        workspace_tree_at_export: ws.treeNow,
        snapshot_head: rev.snapshot?.head_hash ?? null,
        head_tree_equals_gate_candidate_at_export: headTreeMatchesNow,
        worktree_equals_gate_candidate_at_export: treeMatchesNow,
        valid: revValid,
      });
    }
    return {
      certified: true,
      certificationValid: valid,
      reason,
      verifiedRevisions: details,
      note: 'A valid certification requires the workspace tree at the verification instant to equal the tree the host gates executed. The bundle records the exact hashes + the git reflog; it does not take the engine verdict on trust.',
    };
  }

  private renderReadme(bundle: any): string {
    const lines: string[] = [];
    const c = bundle.certification;
    lines.push(`# HELLDESK M6 evidence — \`${bundle.runId}\``);
    lines.push('');
    lines.push(`Generated ${bundle.generatedAt} by \`${bundle.generator}\` from \`bundle.json\`-recorded state.`);
    lines.push('');
    lines.push('## Mission');
    lines.push('');
    lines.push(`- **id:** \`${bundle.mission.mission_id}\``);
    lines.push(`- **state:** \`${bundle.mission.state}\``);
    lines.push(`- **objective:** ${bundle.mission.objective}`);
    lines.push(`- **engine matrix:** \`${JSON.stringify(bundle.mission.engine_matrix)}\``);
    lines.push('');
    lines.push('## Revisions');
    lines.push('');
    for (const r of bundle.revisions) {
      lines.push(`### Revision ${r.revision_no} — \`${r.revision_id}\` — **${r.state}**`);
      lines.push('');
      lines.push(`- created: ${r.created_at}${r.completed_at ? `, completed: ${r.completed_at}` : ''}`);
      lines.push(`- gate candidates: ${r.gate_candidates.length ? r.gate_candidates.map((h: string) => `\`${h}\``).join(', ') : '(none)'}${r.gate_candidates_consistent ? '' : ' — **INCONSISTENT**'}`);
      for (const g of r.gates) {
        lines.push(`  - \`${g.gate_key}\`: **${g.status}** exit=${g.exit_code ?? '-'} ${g.duration_ms}ms candidate=\`${g.candidate_hash}\``);
      }
      if (r.review) {
        lines.push(`- review job \`${r.review.job_id}\`: **${r.review.state}** / ${r.review.result ?? '-'}`);
      }
      if (r.snapshot) {
        lines.push(`- snapshot \`${r.snapshot.snapshot_id}\` (${r.snapshot.subject_kind}) base=\`${r.snapshot.base_hash ?? '-'}\` head=\`${r.snapshot.head_hash ?? '-'}\``);
      }
      lines.push('');
    }
    lines.push('## Certification claim');
    lines.push('');
    lines.push(`- **certified:** ${c.certified}`);
    lines.push(`- **valid:** ${c.certificationValid}`);
    lines.push(`- **reason:** ${c.reason}`);
    if (Array.isArray(c.verifiedRevisions) && c.verifiedRevisions.length) {
      lines.push('');
      lines.push('| revision | gate candidate | head at verification | tree at verification | tree@export | valid |');
      lines.push('|---|---|---|---|---|---|');
      for (const v of c.verifiedRevisions) {
        lines.push(`| \`${v.revision_id}\` | \`${v.gate_candidate ?? '-'}\` | \`${v.head_at_verification?.commit ?? '-'}\` | \`${v.tree_at_verification ?? '-'}\` | \`${v.workspace_tree_at_export ?? '-'}\` | ${v.valid} |`);
      }
    }
    lines.push('');
    lines.push('## Audit');
    lines.push('');
    lines.push(`Every file under \`artifacts/\` is listed in \`bundle.json\` with its sha256 and byte length. Verify with:`);
    lines.push('');
    lines.push('```');
    lines.push(`bun run benchmarks/m6/verify-bundle.ts benchmarks/m6/evidence/${bundle.runId}`);
    lines.push('```');
    lines.push('');
    lines.push('The verifier recomputes every hash and re-evaluates the certification claim from the recorded hashes. It exits non-zero if any byte is missing/altered **or** if a VERIFIED_10_10 mission is not bound to the gate candidate.');
    lines.push('');
    return lines.join('\n');
  }
}

const exporter = new Exporter(parseArgs(process.argv.slice(2)));
exporter.run();
