import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { resolveGlobalConfig, type ConfigIssue, type MergedGlobalConfig } from './config-resolve';

export interface DiscoveredPlugin { id: string; source: 'configured' | 'directory'; location: string; available: boolean; loadedOnNewSession?: boolean; sha256?: string }
export interface KiloDiscovery {
  scannedAt: string; revision: string; status: 'ready' | 'degraded' | 'unavailable'; retainedLastGood: boolean;
  model: string | null; defaultAgent: string | null; providerNames: string[];
  sources: Array<{ path: string; present: boolean; bytes?: number }>;
  pluginDirectories: string[]; plugins: DiscoveredPlugin[];
  mcp: Array<{ name: string; type: string; enabled: boolean }>;
  errors: ConfigIssue[];
  application: { mode: 'next-session'; runningSessions: 'unchanged'; message: string };
}
const McpSchema = z.object({ type: z.string().optional(), enabled: z.boolean().optional() }).passthrough();
let current: KiloDiscovery | undefined;
let effective: MergedGlobalConfig | undefined;
let effectiveDirectories = '';

function safeReference(value: string): string {
  // Remote plugin references may contain private registry auth; only disclose
  // origin/path. Never return URL query, fragment, credentials or MCP arguments.
  try { const url = new URL(value); if (url.protocol === 'file:') return fileURLToPath(url); return url.origin + url.pathname; } catch { return value; }
}
function localPlugin(value: string, directory: string): string | null {
  try {
    if (value.startsWith('file:')) return fileURLToPath(value);
    if (isAbsolute(value)) return value;
    if (value.startsWith('./') || value.startsWith('../')) return resolve(directory, value);
  } catch { return null; }
  return null;
}

/** Metadata-only scan. No plugin import, subprocess, MCP connection or download. */
export function reloadKiloDiscovery(extraDirs: string[] = []): KiloDiscovery {
  const scan = resolveGlobalConfig(extraDirs), errors = [...scan.errors];
  const key = scan.directories.join('\n');
  if (effectiveDirectories !== key) { effective = undefined; effectiveDirectories = key; }
  const plugins: DiscoveredPlugin[] = [], pluginDirectories: string[] = [], autoLoad: string[] = [];
  const seen = new Set<string>();
  const config = scan.config;
  function addFile(file: string, source: DiscoveredPlugin['source'], load = true) {
    const absolute = resolve(file), key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    if (seen.has(key)) return;
    seen.add(key);
    const entry: DiscoveredPlugin = { id: pathToFileURL(absolute).href, source, location: absolute, available: false, loadedOnNewSession: load };
    try {
      const stat = statSync(absolute);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('size');
      entry.sha256 = createHash('sha256').update(readFileSync(absolute)).digest('hex'); entry.available = true;
      if (load) autoLoad.push(pathToFileURL(realpathSync(absolute)).href);
    } catch { errors.push({ path: absolute, code: 'PLUGIN_UNAVAILABLE', message: 'Plugin file is missing, unreadable or exceeds 2 MiB; the previous session configuration remains intact' }); }
    plugins.push(entry);
  }
  for (const ref of config?.plugin || []) {
    const file = localPlugin(ref, scan.pluginBaseDirectory);
    if (file) addFile(file, 'configured');
    else plugins.push({ id: safeReference(ref), source: 'configured', location: safeReference(ref), available: true });
  }
  for (const root of scan.directories) for (const name of ['plugin', 'plugins']) {
    const directory = join(root, name); pluginDirectories.push(directory);
    if (!existsSync(directory)) continue;
    let visited = 0;
    const walk = (folder: string, depth: number) => {
      if (depth > 4) { errors.push({ path: directory, code: 'PLUGIN_SCAN_LIMIT', message: 'Plugin discovery is bounded to 512 entries and four directory levels' }); return; }
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (++visited > 512) { errors.push({ path: directory, code: 'PLUGIN_SCAN_LIMIT', message: 'Plugin discovery exceeded 512 entries' }); return; }
        if (['node_modules', '.git', 'dist', 'test', 'tests'].includes(entry.name)) continue;
        const file = join(folder, entry.name);
        if (lstatSync(file).isSymbolicLink()) continue;
        if (entry.isDirectory()) { walk(file, depth + 1); continue; }
        // Nested files are discoverable support modules, not implicitly plugin
        // entrypoints. They execute only if imported by an entrypoint/configured.
        // Directory discovery is metadata only. Kilo owns native directory
        // loading; injecting these again can initialize hooks twice.
        if (/\.(?:[cm]?js|ts)$/.test(extname(file)) && !/\.(?:test|spec)\.[^.]+$/.test(file) && !file.endsWith('.d.ts')) addFile(file, 'directory', false);
      }
    };
    try { walk(directory, 0); } catch { errors.push({ path: directory, code: 'PLUGIN_SCAN_FAILED', message: 'Cannot enumerate plugin directory' }); }
  }
  const mcp: KiloDiscovery['mcp'] = [];
  for (const [name, raw] of Object.entries(config?.mcp || {})) {
    const result = McpSchema.safeParse(raw);
    if (!result.success) { errors.push({ path: 'mcp/' + name, code: 'INVALID_MCP_ENTRY', message: 'MCP entry must be an object' }); continue; }
    mcp.push({ name, type: result.data.type || 'unspecified', enabled: result.data.enabled !== false });
  }
  if (!errors.length && config) effective = { ...config, plugin: [...new Set([...(config.plugin || []).filter(ref => !localPlugin(ref, scan.pluginBaseDirectory)), ...autoLoad])] };
  const retained = errors.length > 0 && !!effective;
  const next: KiloDiscovery = {
    scannedAt: new Date().toISOString(), revision: '', status: errors.length ? (effective ? 'degraded' : 'unavailable') : 'ready', retainedLastGood: retained,
    model: config?.model || null, defaultAgent: config?.default_agent || null, providerNames: Object.keys(config?.provider || {}),
    sources: scan.files, pluginDirectories, plugins, mcp, errors,
    application: { mode: 'next-session', runningSessions: 'unchanged', message: 'Reload scans configuration now. New writable Kilo sessions inherit the last valid configuration and plugin files; running sessions retain their loaded modules. No agents are interrupted. Read-only reviewers retain their restricted role.' },
  };
  next.revision = createHash('sha256').update(JSON.stringify({ config, sources: next.sources, plugins, mcp })).digest('hex').slice(0, 16);
  current = next;
  return next;
}
export function getKiloDiscovery(): KiloDiscovery { return current || reloadKiloDiscovery(); }
/** Internal only: contains provider credentials. Never serialize to an API/log. */
export function writableKiloConfiguration(): MergedGlobalConfig {
  reloadKiloDiscovery();
  if (!effective) throw new Error('Kilo configuration/plugin discovery failed; correct the reported discovery issues before launching a new session');
  return structuredClone(effective);
}
