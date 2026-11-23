/**
 * kilo-binary.ts — discover the Kilo CLI without pinning an extension version.
 *
 * A hardcoded `...\kilocode.kilo-code-7.8.31-...\bin\kilo.exe` survives exactly
 * until the next extension update. This resolver keeps the daemon running across
 * updates:
 *
 *   1. an explicitly configured path (if it exists),
 *   2. KILO_BIN / KILO_BINARY,
 *   3. `kilo` on PATH,
 *   4. the newest installed `kilocode.kilo-code-*` extension under the common
 *      VS Code / Cursor extension roots.
 *
 * It never returns a path that is not an existing file, and it never downloads
 * or installs anything. Callers must fail closed with a clear message when the
 * result is null.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type KiloBinarySource = 'configured' | 'env' | 'path' | 'extension';

export interface KiloBinaryResolution {
  path: string;
  source: KiloBinarySource;
  /** Present for extension-discovered binaries (parsed from the directory name). */
  version?: string;
}

export interface ResolveKiloBinaryOptions {
  /** Configured path from config.json; may be empty or stale. */
  configured?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  /** Tests set true to avoid consulting the machine PATH. */
  skipPathLookup?: boolean;
  /** Tests can supply isolated extension roots. */
  extensionRoots?: string[];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function parseVersion(name: string): number[] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(name);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(a: number[] | null, b: number[] | null): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

function defaultExtensionRoots(home: string): string[] {
  return [
    join(home, '.vscode-insiders', 'extensions'),
    join(home, '.vscode', 'extensions'),
    join(home, '.cursor', 'extensions'),
    join(home, '.windsurf', 'extensions'),
  ];
}

function binaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'kilo.exe' : 'kilo';
}

function pathLookup(platform: NodeJS.Platform): string | null {
  try {
    const command = platform === 'win32' ? 'where.exe' : 'which';
    const target = binaryName(platform);
    const output = execFileSync(command, [target], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = output
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(candidate => candidate.length > 0 && isFile(candidate));
    return first ?? null;
  } catch {
    return null;
  }
}

function findExtensionBinary(
  home: string,
  platform: NodeJS.Platform,
  roots: string[],
): KiloBinaryResolution | null {
  const candidates: Array<{ path: string; version: number[] | null; versionText?: string }> = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = readdirSync(root, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('kilocode.kilo-code-')) continue;
      const bin = join(root, entry.name, 'bin', binaryName(platform));
      if (!isFile(bin)) continue;
      const version = parseVersion(entry.name);
      candidates.push({
        path: bin,
        version,
        versionText: version ? version.join('.') : undefined,
      });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => compareVersion(b.version, a.version));
  const best = candidates[0]!;
  return { path: best.path, source: 'extension', version: best.versionText };
}

export function resolveKiloBinary(
  opts: ResolveKiloBinaryOptions = {},
): KiloBinaryResolution | null {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();

  const configured = (opts.configured ?? '').trim();
  if (configured && isFile(configured)) {
    return { path: configured, source: 'configured' };
  }

  const envPath = (env.KILO_BIN ?? env.KILO_BINARY ?? '').trim();
  if (envPath && isFile(envPath)) {
    return { path: envPath, source: 'env' };
  }

  if (!opts.skipPathLookup) {
    const found = pathLookup(platform);
    if (found) return { path: found, source: 'path' };
  }

  const roots = opts.extensionRoots ?? defaultExtensionRoots(home);
  return findExtensionBinary(home, platform, roots);
}

/**
 * Resolve and apply the Kilo binary into a loaded config object. Called once at
 * daemon startup (and idempotently by serve()). Throws a precise fail-closed
 * error only when a stage that actually needs Kilo cannot find it.
 */
export function resolveAndApplyKiloBinary(config: {
  policy: { runner: string; kiloServerBin?: string };
  autonomy: { enabled?: boolean; mutationRunner?: string; kiloBin?: string };
}): { review: KiloBinaryResolution | null; mutation: KiloBinaryResolution | null } {
  let review: KiloBinaryResolution | null = null;
  let mutation: KiloBinaryResolution | null = null;

  if (config.policy.runner === 'kilo') {
    review = resolveKiloBinary({ configured: config.policy.kiloServerBin });
    if (!review) {
      throw new Error(
        'Kilo CLI not found. Install the Kilo extension or set policy.kiloServerBin / KILO_BIN. ' +
          'Searched PATH and the VS Code extension directories; no fallback was used.',
      );
    }
    config.policy.kiloServerBin = review.path;
  }

  if (config.autonomy.enabled !== false && config.autonomy.mutationRunner === 'kilo') {
    mutation = resolveKiloBinary({ configured: config.autonomy.kiloBin });
    if (!mutation) {
      throw new Error(
        'Kilo CLI not found for the mutation runner. Install the Kilo extension or set autonomy.kiloBin / KILO_BIN. ' +
          'Searched PATH and the VS Code extension directories; no fallback was used.',
      );
    }
    config.autonomy.kiloBin = mutation.path;
  }

  return { review, mutation };
}
