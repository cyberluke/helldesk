/**
 * Local HELLDESK — dispatch adapters.
 *
 * AAF-federated plugin seam: instead of Docker containers, the local HELLDESK
 * dispatches agents onto a **local filesystem git repo** per project/workstation.
 *
 * The adapter implements a single `dispatchAgent` contract; `LocalDepartment` picks
 * the adapter from the department/workstation `local_repo` config (`adapter: 'local-git'`).
 * This is the "container-agent execution" delta replaced by the local-git-way.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type DispatchAdapterName = 'local-git' | 'none';

export interface DispatchResult {
  ok: boolean;
  /** Branch the agent finished on. */
  branch?: string;
  /** Commit SHA produced by the agent step, if any. */
  commit?: string | null;
  /** Human summary for the dashboard. */
  summary?: string;
  error?: string;
}

export interface DispatchAdapterConfig {
  /** Directory to clone/check the repo into for agent work. */
  workdir: string;
  /** THE PROJECT WORKSPACE (input repo) agents operate on. */
  repoPath: string;
  /** Optional cross-repo target for deltas (new or existing). When set, the
   *  completed change is federated into this repo too. */
  outputRepo?: { repoPath: string; branch?: string; bareRemote?: string; initIfMissing?: boolean };
  /** Read-only source repos to clone into `workdir/sources/<id>` (input sources). */
  sourceRepos?: Array<{ id: string; path: string; label?: string; branch?: string }>;
  /** Optional bare remote to push finished work to. */
  bareRemote?: string;
  branch: string;
  allowCommit: boolean;
}

export interface DispatchAdapter {
  name: DispatchAdapterName;
  /** Prepare the working copy so the agent step can operate on it. */
  prepare(cfg: DispatchAdapterConfig): Promise<void>;
  /** Record an agent result (commit + optional push) against the local repo. */
  commit(cfg: DispatchAdapterConfig, message: string): Promise<DispatchResult>;
}

/** A stateless no-op adapter (adapter disabled or department uses 'none'). */
export const noneAdapter: DispatchAdapter = {
  name: 'none',
  prepare: async () => {},
  commit: async () => ({ ok: false, summary: 'dispatch adapter is none' }),
};

/** Run a git command asynchronously (flush with the async daemon). */
function git(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolvePromise({ code: err ? (err as { code?: number }).code ?? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * Local-git adapter: operates on a local filesystem repo checkout.
 * - `prepare`: ensure the workdir exists; if `repoPath` is a git repo, clone or
 *   open a working copy (or make a local bare mirror + clone if `bareRemote`).
 *   Also mounts any `source_repos` into `<workdir>/sources/<id>` (read-only
 *   INPUT reads) and, when an `outputRepo` is configured, prepares
 *   `<workdir>/output` (init a NEW repo if missing, or clone an EXISTING one)
 *   so a completed delta can be federated cross-repo.
 * - `commit`: stage, commit, and optionally push to `bareRemote`, then — when
 *   an outputRepo is set — copy the changed files into the output checkout and
 *   commit them there too (AAF federation of the delta between two repos).
 */
export const localGitAdapter: DispatchAdapter = {
  name: 'local-git',

  async prepare(cfg) {
    if(cfg.outputRepo){
      const destination=resolve(cfg.outputRepo.repoPath).toLowerCase();
      const sources=[cfg.repoPath,...(cfg.sourceRepos||[]).map(source=>source.path)];
      if(sources.some(source=>resolve(source).toLowerCase()===destination))throw Error('Output repository must be distinct from every read-source repository');
    }
    mkdirSync(cfg.workdir, { recursive: true });
    const target = join(cfg.workdir, 'repo');
    const source = resolve(cfg.repoPath);
    if (existsSync(join(target, '.git'))) {
      // Workspace already prepared. Still (re)prepare sources + output so a
      // first-time source/output gets mounted even on a warm workspace.
      await mountSources(cfg, join(cfg.workdir, 'sources'));
      await prepareOutput(cfg);
      return;
    }

    if (!existsSync(source)) {
      throw Error('Input repository does not exist; refusing to create or modify a read source');
    }

    // Clone the local repo into the workdir (file:// or absolute path).
    const res = await git(['clone', '--quiet', source, target], cfg.workdir);
    if (res.code !== 0) {
      throw Error('Input checkout failed: ' + res.stderr);
    }
    if (cfg.branch) {
      await git(['checkout', '-B', cfg.branch], target);
    }

    // Mount read-only source repos + prepare the optional output repo.
    await mountSources(cfg, join(cfg.workdir, 'sources'));
    await prepareOutput(cfg);
  },

  async commit(cfg, message) {
    const target = cfg.outputRepo ? resolve(cfg.outputRepo.repoPath) : join(cfg.workdir, 'repo');
    await this.prepare(cfg);
    await git(['add', '--all'], target);
    const staged = await git(['diff', '--cached', '--quiet'], target);
    let head = '';
    if (staged.code === 1) {
      const committed = await git(['commit', '--quiet', '-m', message], target);
      if (committed.code !== 0) return { ok: false, error: `commit failed: ${committed.stderr}` };
    }
    head = (await git(['rev-parse', '--short', 'HEAD'], target)).stdout.trim();
    const remote = cfg.outputRepo ? cfg.outputRepo.bareRemote : cfg.bareRemote;
    if (remote) {
      const pushed = await git(['push', '--quiet', remote, cfg.outputRepo?.branch || cfg.branch || 'HEAD'], target);
      if (pushed.code !== 0) return { ok: false, error: 'Reviewed commit exists locally but push failed: ' + pushed.stderr };
    }

    // Extraction missions write the configured output directly. Never copy an
    // entire source tree over a reviewed destination or swallow landing errors.
    const federated = cfg.outputRepo ? target : null;

    let branch: string | undefined;
    const branchRes = await git(['rev-parse', '--abbrev-ref', 'HEAD'], target);
    if (branchRes.code === 0) branch = branchRes.stdout.trim();
    return {
      ok: true,
      branch,
      commit: head || null,
      summary: `committed to ${branch ?? 'HEAD'}${cfg.bareRemote ? ` (pushed to ${cfg.bareRemote})` : ''}${federated ? ` · federated → ${federated}` : ''}`,
    };
  },
};

/**
 * Prepare the optional OUTPUT repo (cross-repo delta target) into
 * `<workdir>/output`. A MISSING path — or an existing path that is not yet a
 * git repository (e.g. an empty directory created before dispatch) — is
 * initialised as a NEW repo; an existing repo is cloned. Idempotent — a warm
 * output checkout is left alone.
 *
 * Bug fixed: the old guard only initialised when the path did NOT exist, so a
 * directory that existed but was never `git init`'d fell through to
 * `rev-parse HEAD` / empty-commit, which failed with "Could not initialize
 * output HEAD", wedging the ticket in a dispatch_failed loop.
 */
async function prepareOutput(cfg: DispatchAdapterConfig): Promise<void> {
  const out = cfg.outputRepo;
  if (!out) return;
  const target = join(cfg.workdir, 'output');
  mkdirSync(cfg.workdir, { recursive: true });
  const outPath = resolve(out.repoPath);
  const isInitializedRepo = existsSync(outPath) && existsSync(join(outPath, '.git'));
  if (!isInitializedRepo) {
    if (out.initIfMissing !== false) {
      const initialized = await git(['init', '--quiet', outPath], cfg.workdir);
      if (initialized.code !== 0) throw Error('Output repository initialization failed');
    } else {
      throw Error('Output repository is missing and initialization is disabled');
    }
  }
  const initialHead = await git(['rev-parse', '--verify', 'HEAD'], outPath);
  if (initialHead.code !== 0) {
    const seed = await git(['-c', 'user.name=HELLDESK', '-c', 'user.email=helldesk@localhost', 'commit', '--allow-empty', '-m', 'Initialize output workspace'], outPath);
    if (seed.code !== 0) throw Error('Could not initialize output HEAD');
  }
  const alreadyPresent = existsSync(join(target, '.git'));
  if (alreadyPresent) {
    // STALE-CHECKOUT RECONCILE (fix): a pre-existing workdir/output checkout can
    // be EMPTY or stale (cloned before the durable output repo gained content),
    // which wedges the agent in an endless `no-change`. Reconcile it to the
    // durable output repo's current HEAD so the agent always edits the latest
    // baseline — never an empty/stale snapshot. Fetch + fetch --all, then hard
    // reset to the remote HEAD (recreate the target branch).
    const fetched = await git(['fetch', '--all', '--quiet'], target);
    if (fetched.code === 0) {
      await git(['fetch', '--all', '--tags'], target);
      // Point the target branch at the durable output repo's HEAD (origin or the
      // same-name branch) and reset the working tree to it.
      const remote = await git(['remote', 'get-url', 'origin'], target);
      if (remote.code === 0) {
        const remBranch = out.branch && out.branch !== 'HEAD' ? out.branch : 'main';
        const reset = await git(['reset', '--hard', `origin/${remBranch}`], target);
        if (reset.code !== 0) {
          // no origin/<branch>; fall back to the default branch
          await git(['reset', '--hard', 'origin/HEAD'], target);
        }
        if (out.branch && out.branch !== 'HEAD') await git(['checkout', '-B', out.branch], target);
      }
    }
    return;
  }
  const res = await git(['clone', '--quiet', outPath, target], cfg.workdir);
  if (res.code !== 0) {
    throw Error('Output checkout failed: ' + res.stderr);
  }
  if (out.branch) {
    await git(['checkout', '-B', out.branch], target);
  }
}

/**
 * Clone each configured source repo into `<workdir>/sources/<id>` so an agent
 * building the destination can READ it. Mounts are idempotent (a source already
 * cloned is left alone). A source that fails to clone is skipped, never fatal —
 * a missing read root must not block the writable destination.
 */
async function mountSources(cfg: DispatchAdapterConfig, root: string): Promise<void> {
  for (const src of cfg.sourceRepos ?? []) {
    const target = join(root, src.id || 'source');
    if (existsSync(join(target, '.git'))) continue; // already mounted
    mkdirSync(root, { recursive: true });
    const sourcePath = resolve(src.path);
    if (!existsSync(sourcePath)) {
      throw Error('Read source does not exist: ' + sourcePath);
    }
    const res = await git(['clone', '--quiet', sourcePath, target], root);
    if (res.code !== 0) {
      throw Error('Read source checkout failed: ' + res.stderr);
    }
    if (src.branch) {
      await git(['checkout', '-B', src.branch], target);
    }
  }
}

export function resolveAdapter(name: DispatchAdapterName): DispatchAdapter {
  if (name === 'local-git') return localGitAdapter;
  return noneAdapter;
}
