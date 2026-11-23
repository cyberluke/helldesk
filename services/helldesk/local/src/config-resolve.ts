import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

/**
 * Effective Kilo configuration resolution for the control plane.
 *
 * Kilo DEEP-MERGES multiple config sources in a defined precedence order and
 * NEVER picks by file LastWriteTime. We mirror that: merge `kilo.json` then
 * `kilo.jsonc` under a config dir by source order (json first, jsonc later in
 * the global-dir merge), like the documented loader. Model selection remains
 * fail-closed and never guesses `code`/`kilo`.
 */

export interface MergedGlobalConfig {
  model?: string;
  default_agent?: string;
  provider?: Record<string, unknown>;
  mcp?: Record<string, unknown>;
  plugin?: string[];
  permission?: Record<string, unknown> | 'allow' | 'ask' | 'deny';
  [key: string]: unknown;
}

/** Deep merge: plain objects merge recursion; arrays are replaced (later wins);
 *  scalars take the later (b) value. Mirrors Kilo's source-ordered merge. */
export function deepMerge<T>(a: T, b: T): T {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (a === null || b === null) return b as T;
  if (Array.isArray(a) || Array.isArray(b)) return (Array.isArray(b) ? b : a) as T;
  if (typeof a === 'object' && typeof b === 'object') {
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const k of Object.keys(b as Record<string, unknown>)) {
      if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
      const av = (a as Record<string, unknown>)[k];
      const bv = (b as Record<string, unknown>)[k];
      out[k] = deepMerge(av, bv);
    }
    return out as unknown as T;
  }
  return b as T;
}

/** JSONC->JSON stripper (comments + true trailing commas). Used to read
 *  `kilo.jsonc`, which allows comments. */
export function stripJsoncComments(text: string): string {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; if (i >= text.length) throw new Error('Unterminated JSONC comment'); i += 2; out += ' '; continue; }
    out += c;
    i++;
  }
  // A second string-aware pass permits a trailing comma followed by comments.
  let clean = ''; inStr = false;
  for (let n = 0; n < out.length; n++) {
    const c = out[n];
    if (inStr) { clean += c; if (c === '\\') clean += out[++n] ?? ''; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    if (c === ',') { let k = n + 1; while (/\s/.test(out[k] ?? '') && k < out.length) k++; if (out[k] === '}' || out[k] === ']') continue; }
    clean += c;
  }
  return clean.replace(/^\uFEFF/, '');
}

const GlobalSchema = z.object({ model: z.string().max(512).optional(), default_agent: z.string().optional(), provider: z.record(z.string(), z.unknown()).optional(), mcp: z.record(z.string(), z.unknown()).optional(), plugin: z.array(z.string()).optional(), permission: z.union([z.record(z.string(), z.unknown()), z.enum(['allow', 'ask', 'deny'])]).optional() }).passthrough();
export interface ConfigSource { path: string; present: boolean; bytes?: number }
export interface ConfigIssue { path: string; code: string; message: string }
export function globalConfigDirectories(extraDirs: string[] = []): string[] {
  return [...new Set([join(process.env.USERPROFILE || homedir(), '.config', 'kilo'), process.env.KILO_CONFIG_DIR || '', ...extraDirs].filter(Boolean).map(dir => resolve(dir)))];
}
const lastGood = new Map<string, MergedGlobalConfig>();
const lastGoodPluginBase = new Map<string, string>();
export function resolveGlobalConfig(extraDirs: string[] = []) {
  const directories = globalConfigDirectories(extraDirs), files: ConfigSource[] = [], errors: ConfigIssue[] = [];
  let merged: MergedGlobalConfig = {};
  let pluginBaseDirectory = directories[0] || process.cwd();
  for (const directory of directories) for (const name of ['kilo.json', 'kilo.jsonc']) {
    const file = join(directory, name);
    if (!existsSync(file)) { files.push({ path: file, present: false }); continue; }
    try {
      const bytes = statSync(file).size; files.push({ path: file, present: true, bytes });
      if (bytes > 4 * 1024 * 1024) { errors.push({ path: file, code: 'CONFIG_TOO_LARGE', message: 'Configuration exceeds the 4 MiB discovery limit' }); continue; }
      const parsed = GlobalSchema.safeParse(JSON.parse(stripJsoncComments(readFileSync(file, 'utf8'))));
      if (!parsed.success) { errors.push({ path: file, code: 'INVALID_CONFIG', message: 'Configuration fields do not match the Kilo config shape' }); continue; }
      merged = deepMerge(merged, parsed.data);
      if (parsed.data.plugin !== undefined) pluginBaseDirectory = directory;
    } catch { errors.push({ path: file, code: 'UNREADABLE_CONFIG', message: 'Cannot read or parse configuration; no configuration values were logged' }); }
  }
  const key = directories.join('\n');
  if (!errors.length) { lastGood.set(key, merged); lastGoodPluginBase.set(key, pluginBaseDirectory); }
  return { directories, files, errors, config: errors.length ? lastGood.get(key) ?? null : merged, pluginBaseDirectory: errors.length ? lastGoodPluginBase.get(key) || pluginBaseDirectory : pluginBaseDirectory, retainedLastGood: errors.length > 0 && lastGood.has(key) };
}

/** Merge the effective global config from `kilo.json` + `kilo.jsonc` under the
 *  given dirs, in source order. No file-mtime heuristics. */
export function loadMergedGlobalConfig(extraDirs: string[] = []): MergedGlobalConfig {
  const result = resolveGlobalConfig(extraDirs);
  if (!result.config) throw new Error('Kilo global configuration is invalid; correct it and reload');
  return result.config;
}

export interface KiloProviderOptions {
  baseURL: string;
  apiKey?: string;
}

/** Model context limits as declared by Kilo (`provider.<id>.models.<model>.limit`). */
export interface KiloModelLimits {
  context?: number;
  input?: number;
  output?: number;
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : undefined;
}

/**
 * Read `provider.<providerID>.models.<modelID>.limit` from an already-merged
 * Kilo configuration.
 *
 * Model keys are matched exactly first (case-insensitive as a fallback) and
 * then by the model entry's own `id` field, because the operator's active
 * route may name a profile model (`...-ctx-512k`) whose entry carries
 * `id: <base model>`. Returns null when the provider/model/limit is absent —
 * callers must then fall back to an explicit tier or the default, never guess.
 */
export function kiloModelLimitsFromConfig(
  config: unknown,
  providerID: string,
  modelID: string
): KiloModelLimits | null {
  if (!providerID || !modelID) return null;
  const providerTable = (config as { provider?: unknown } | null | undefined)?.provider;
  if (!providerTable || typeof providerTable !== 'object' || Array.isArray(providerTable)) return null;
  const provider = (providerTable as Record<string, unknown>)[providerID];
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return null;
  const models = (provider as { models?: unknown }).models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) return null;
  const table = models as Record<string, unknown>;
  let entry = table[modelID];
  if (entry === undefined) {
    const ciKey = Object.keys(table).find((k) => k.toLowerCase() === modelID.toLowerCase());
    if (ciKey) entry = table[ciKey];
  }
  if (entry === undefined) {
    const byId = Object.keys(table).find((k) => {
      const candidate = table[k];
      return !!candidate && typeof candidate === 'object' && (candidate as { id?: unknown }).id === modelID;
    });
    if (byId) entry = table[byId];
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const limit = (entry as { limit?: unknown }).limit;
  if (!limit || typeof limit !== 'object' || Array.isArray(limit)) return null;
  const raw = limit as Record<string, unknown>;
  const context = positiveInt(raw.context);
  const input = positiveInt(raw.input);
  const output = positiveInt(raw.output);
  if (context === undefined && input === undefined && output === undefined) return null;
  return { ...(context !== undefined ? { context } : {}), ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}) };
}

/** Resolve a model's declared limits from the effective kilo.json/kilo.jsonc. */
export function resolveKiloModelLimits(providerID: string, modelID: string): KiloModelLimits | null {
  try {
    return kiloModelLimitsFromConfig(loadMergedGlobalConfig(), providerID, modelID);
  } catch {
    return null;
  }
}

/**
 * Resolve an OpenAI-compatible provider's endpoint options from the merged
 * effective Kilo configuration (`provider.<id>.options`).
 *
 * HELLDESK follows the operator's live provider configuration instead of
 * hardcoding an endpoint, so switching the default provider/model in Kilo
 * (`~/.config/kilo/kilo.jsonc`) refreshes the review + mutation routes without
 * editing `config.json`. `policy.providers` keeps precedence when it defines
 * the provider explicitly.
 *
 * Returns null when the provider is absent or has no baseURL. A returned
 * `apiKey` is a credential: never log or serialize this object.
 */
export function resolveKiloProviderOptions(providerID: string): KiloProviderOptions | null {
  if (!providerID) return null;
  try {
    const merged = loadMergedGlobalConfig();
    const providers = z.record(z.string(), z.unknown()).safeParse(merged.provider);
    if (!providers.success) return null;
    const entry = z
      .object({
        options: z
          .object({ baseURL: z.string().min(1).optional(), apiKey: z.string().min(1).optional() })
          .passthrough(),
      })
      .passthrough()
      .safeParse(providers.data[providerID]);
    if (!entry.success) return null;
    const baseURL = entry.data.options.baseURL?.trim();
    if (!baseURL) return null;
    return { baseURL, ...(entry.data.options.apiKey ? { apiKey: entry.data.options.apiKey } : {}) };
  } catch {
    return null;
  }
}
