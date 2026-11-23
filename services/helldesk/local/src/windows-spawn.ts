import { createRequire } from 'node:module';

/**
 * Windows console hygiene for headless children.
 *
 * `@kilocode/sdk`'s `createKiloServer` spawns `kilo serve` WITHOUT `windowsHide`,
 * so every headless session (a mutation or each detached reviewer) pops a
 * visible console window in front of the operator. The SDK exposes no option for
 * it, and its dependency cross-spawn calls `child_process.spawn(...)` AT CALL
 * TIME on the CommonJS module object — so wrapping that property (NOT the frozen
 * ESM namespace) hides every child (bun worker + kilo serve) without patching
 * node_modules.
 *
 * Idempotent; no-op off Windows. Never changes argv/stdio/permissions.
 */
let installed = false;

export function ensureHiddenChildSpawns(): void {
  if (installed || process.platform !== 'win32') return;
  const require = createRequire(import.meta.url);
  let cp: { spawn: (...args: unknown[]) => unknown } | null = null;
  try {
    cp = require('node:child_process') as { spawn: (...args: unknown[]) => unknown };
  } catch {
    try { cp = require('child_process') as { spawn: (...args: unknown[]) => unknown }; } catch { return; }
  }
  if (!cp || typeof cp.spawn !== 'function') return;
  installed = true;
  const original = cp.spawn;
  cp.spawn = function patchedSpawn(command: unknown, argsOrOptions?: unknown, maybeOptions?: unknown): unknown {
    // Legacy callback form: spawn(command, callback)
    if (typeof argsOrOptions === 'function') return original(command, argsOrOptions);
    // spawn(command, args, options)
    if (Array.isArray(argsOrOptions)) {
      return original(command, argsOrOptions, { windowsHide: true, ...((maybeOptions as object) ?? {}) });
    }
    // spawn(command, options)
    return original(command, { windowsHide: true, ...((argsOrOptions as object) ?? {}) });
  };
}
