/**
 * Display-level workspace identity.
 *
 * Windows paths are case-insensitive for the drive and accept both `\` and `/`,
 * so `D:\_SATIN_AI\NAI-OS\NAI_Game_Framework`, `d:\...` and `D:/...` are the
 * same repository. Legacy engine databases can contain two registered workspace
 * rows for one folder (ids were hashed from the raw spelling); the Commits
 * dropdown must not render the same repo twice.
 *
 * This is a UI fallback only — the engine registry and commit API also canonicalize
 * so every consumer gets one identity. Only the drive letter is lowercased; the
 * rest of the path keeps its case because POSIX volumes may be case-sensitive.
 */
/** Scratch/test checkouts are real repos but not operator projects. */
export function isScratchWorkspacePath(input: string): boolean {
  const path = input.replace(/\\/g, '/').toLowerCase();
  return (
    path.includes('/.local/') ||
    path.includes('/appdata/local/temp/') ||
    /\/gt-git-|\/git-ws-|\/chat-scratch-|\/smoke-/.test(path)
  );
}

export function canonicalWorkspaceKey(input: string): string {
  const raw = input.trim();
  if (!raw) return '';
  const isWindows = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\');
  if (!isWindows) {
    return raw.replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1');
  }
  let normalized = raw.replace(/\//g, '\\').replace(/\\{2,}/g, '\\');
  if (/^[a-zA-Z]:/.test(normalized)) {
    normalized = normalized[0]!.toLowerCase() + normalized.slice(1);
  }
  if (normalized.length > 3 && normalized.endsWith('\\')) {
    normalized = normalized.replace(/\\+$/, '');
  }
  return normalized;
}
