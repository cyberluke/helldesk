import { describe, it, expect } from 'bun:test';
import { missionTaskName, MISSION_TASK_NAME_MAX } from './mission-title';

const REAL_OBJECTIVE = `Extract a reusable 2D/3D game framework from the existing game code (NAI CARDS).

Read-only source (INSPECT ONLY, never modify):
- D:\\_SATIN_AI\\NAI-OS\\NAI_Cards — the current game implementation, including uncommitted files. This is the extraction source of truth.

Writable output (this mission workspace, a git repo):
- Implement the framework here. Never copy the whole input tree; federate the required capability only.
`;

describe('missionTaskName', () => {
  it('uses the first meaningful sentence of the objective — a human task name', () => {
    expect(missionTaskName(REAL_OBJECTIVE)).toBe(
      'Extract a reusable 2D/3D game framework from the existing game code (NAI CARDS).',
    );
  });

  it('skips markdown headings and label-only lines instead of showing them as the task', () => {
    expect(missionTaskName('# Extraction\n\nGoal:\nBuild the world/entity core.')).toBe(
      'Build the world/entity core.',
    );
  });

  it('cleans list/checkbox prefixes and wrapper quotes', () => {
    expect(missionTaskName('- [ ] "Wire the renderer backends."')).toBe('Wire the renderer backends.');
  });

  it('skips the mission-dispatch ticket envelope and names the task, not the id', () => {
    expect(
      missionTaskName(
        '[HELLDESK ticket 0159d0fc-3500-496c-a990-326f157110ed]\nSOL98\n\n# SOL98 — Win 98 Solitaire engine\n\n## Objective\nDeliver the engine.',
      ),
    ).toBe('SOL98');
  });

  it('skips any bracketed machine envelope, including historical engine records', () => {
    expect(
      missionTaskName('[LEGACY-ENVELOPE 8eaf9800-6fed-4d6b-a79e-791d172ca850]\nENGINE-MATRIX VERIFY'),
    ).toBe('ENGINE-MATRIX VERIFY');
  });

  it('bounds a long single-line objective at a word boundary', () => {
    const long = `Extract ${'the reusable game framework capability '.repeat(8)}end.`;
    const name = missionTaskName(long);
    expect(name.length).toBeLessThanOrEqual(MISSION_TASK_NAME_MAX);
    expect(name.endsWith('…')).toBe(true);
    expect(name.includes('  ')).toBe(false);
  });

  it('falls back to the mission id, never to an empty header', () => {
    expect(missionTaskName('   \n\n', 'mis_39748afb1d644e29a29018a0b68bceec')).toBe(
      'mis_39748afb1d644e29a29018a0b68bceec',
    );
    expect(missionTaskName(null)).toBe('Mission');
  });
});
