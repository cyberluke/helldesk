import { describe, expect, it } from 'bun:test';
import { canonicalWorkspaceKey, isScratchWorkspacePath } from '../../federated/shim/lib/workspace-path';

describe('Commits workspace dropdown identity', () => {
  it('treats Windows drive casing, slash style and trailing separators as one repo', () => {
    const key = canonicalWorkspaceKey('D:\\_SATIN_AI\\NAI-OS\\NAI_Game_Framework');
    expect(canonicalWorkspaceKey('d:/_SATIN_AI/NAI-OS/NAI_Game_Framework')).toBe(key);
    expect(canonicalWorkspaceKey('D:\\_SATIN_AI\\NAI-OS\\NAI_Game_Framework\\')).toBe(key);
    expect(canonicalWorkspaceKey('C:/src/kilo-gastown-local')).toBe(
      canonicalWorkspaceKey('C:\\src\\kilo-gastown-local'),
    );
  });

  it('flags scratch/test checkouts but not operator repositories', () => {
    expect(isScratchWorkspacePath('C:\\src\\kilo-gastown-local\\.local\\git-ws-abc')).toBe(true);
    expect(isScratchWorkspacePath('C:\\src\\kilo-gastown-local\\services\\helldesk\\local-live\\ui\\.local\\smoke-1')).toBe(true);
    expect(isScratchWorkspacePath('D:\\_SATIN_AI\\NAI-OS\\NAI_Game_Framework')).toBe(false);
    expect(isScratchWorkspacePath('C:\\src\\kilo-gastown-local')).toBe(false);
  });

  it('does not merge different repositories', () => {
    const key = canonicalWorkspaceKey('D:\\_SATIN_AI\\NAI-OS\\NAI_Game_Framework');
    expect(canonicalWorkspaceKey('D:\\_SATIN_AI\\NAI-OS\\NAI_Game_Framework_Extra')).not.toBe(key);
    expect(canonicalWorkspaceKey('/opt/Repo')).toBe('/opt/Repo');
    expect(canonicalWorkspaceKey('/opt/repo')).not.toBe(canonicalWorkspaceKey('/opt/Repo'));
  });
});
