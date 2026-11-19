/**
 * Durable path resolver for the HELLDESK container.
 *
 * Why this exists: the container previously hard-coded POSIX `/tmp/agent-home-*`
 * and `/tmp/*` roots. On Windows, Bun resolves those into %LOCALAPPDATA%\Temp\,
 * which this workstation wipes on GPU crash / Windows restart — so every
 * agent's kilo.db, git credentials, and dashboard context were silently lost.
 *
 * This module is the SINGLE source of truth for where durable state lives.
 * Nothing Satin/HELLDESK writes may land in temp. The durable root defaults to
 * the stable, user-owned `%LOCALAPPDATA%\CyberLuke\HelldeskState` (matching the
 * existing `CyberLuke\LocalGasDepartment` convention for the local daemon), and is
 * overridable via `HELLDESK_DURABLE_ROOT`. Per-agent homes are subdirectories,
 * never fresh temp dirs.
 */
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

/** Base dir for ALL durable HELLDESK container state. Never touch this with tmpdir(). */
export function durableRoot(): string {
  const envRoot = process.env.HELLDESK_DURABLE_ROOT;
  if (envRoot && envRoot.trim().length > 0) return envRoot;
  // Windows: LOCALAPPDATA\CyberLuke\HelldeskState ; non-Windows: ~/.kilo/helldesk
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'CyberLuke', 'HelldeskState');
  }
  return join(homedir(), '.kilo', 'helldesk');
}

/** Stable per-agent home (kilo.db + XDG data live here). Survives restarts. */
export function agentHomeDir(agentId: string): string {
  return join(durableRoot(), 'agent-homes', agentId);
}

/** XDG_DATA_HOME for a kilo child — agent-scoped but durable. */
export function agentXdgDataDir(agentId: string): string {
  return join(agentHomeDir(agentId), '.local', 'share');
}

/** Where the kilo CLI writes kilo.db for an agent (under XDG_DATA_HOME/kilo). */
export function agentKiloDbDir(agentId: string): string {
  return join(agentXdgDataDir(agentId), 'kilo');
}

/** Per-workstation git credentials file, durable (not /tmp/.git-credentials-*). */
export function workstationCredentialsPath(repoKey: string): string {
  return join(durableRoot(), 'credentials', `git-${repoKey.replace(/[^a-zA-Z0-9_-]/g, '-')}`);
}

/** Directory holding all durable per-workstation git credential files. */
export function credentialsDir(): string {
  return join(durableRoot(), 'credentials');
}

/** Dashboard context file (durable, not /tmp/helldesk-dashboard-context.json). */
export function dashboardContextPath(): string {
  return join(durableRoot(), 'dashboard-context.json');
}

/** Assert we never hand out a temp path for durable state. */
export function assertDurable(path: string, label: string): void {
  if (path.startsWith(tmpdir())) {
    throw new Error(`[durable] refusing durable ${label} under temp: ${path}`);
  }
}