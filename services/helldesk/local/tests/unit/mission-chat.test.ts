import { describe, expect, it } from 'bun:test';
import { openDb } from '../../src/db';
import { addMissionChatMessage, listMissionChatMessages } from '../../src/mission-chat-repository';
import { mapKiloSessionMessages, renderReviewVerdictMarkdown, reviewSpeakerLabel } from '../../src/chat-transcript';

/**
 * The operator chat must be REAL: rows derive from the mission's actual headless
 * Kilo session parts, captured idempotently so a live poller can re-read the
 * session without duplicating messages. The independent review is mirrored into
 * the same conversation from the persisted reviewer/adjudicator verdicts.
 */
describe('mission chat transcript', () => {
  it('maps real Kilo session parts and skips internals', () => {
    const messages = [
      { info: { role: 'user' }, parts: [{ id: 'u1', type: 'text', text: 'Objective: build math.ts' }] },
      {
        info: { role: 'assistant' },
        parts: [
          { id: 'r1', type: 'reasoning', text: 'Need two exported functions.' },
          { id: 't1', type: 'tool', tool: 'bash', state: { status: 'completed', input: { cmd: 'ls' }, output: 'file.ts' } },
          { id: 'x1', type: 'text', text: 'Created `src/math.ts`.' },
          { id: 's1', type: 'step-start' },
          { id: 'f1', type: 'step-finish', reason: 'stop' },
        ],
      },
    ];
    const items = mapKiloSessionMessages(messages);
    expect(items.map((i) => `${i.role}/${i.kind}`)).toEqual([
      'user/text',
      'assistant/reasoning',
      'assistant/tool_call',
      'assistant/tool_result',
      'assistant/text',
    ]);
    expect(items[2]?.toolName).toBe('bash');
    expect(items[2]?.toolInput).toContain('"cmd": "ls"');
    expect(items[3]?.toolResult).toBe('file.ts');
    expect(items[4]?.text).toBe('Created `src/math.ts`.');
  });

  it('tolerates unknown/partial payloads without throwing', () => {
    expect(mapKiloSessionMessages(null)).toEqual([]);
    expect(mapKiloSessionMessages([{ info: {}, parts: [{ id: 'z', type: 'mystery' }] }])).toEqual([]);
    expect(mapKiloSessionMessages([{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'no id' }] }])).toEqual([]);
  });

  it('persists idempotently by part id and pages by seq', () => {
    const d = openDb(':memory:');
    d.runMigration();
    try {
      const first = addMissionChatMessage(d, { missionId: 'mis_1', role: 'assistant', kind: 'text', text: 'hello', partId: 'p1' });
      expect(first?.seq).toBe(1);
      // The live poller re-reads the same session: same part id => no duplicate.
      expect(addMissionChatMessage(d, { missionId: 'mis_1', role: 'assistant', kind: 'text', text: 'hello', partId: 'p1' })).toBeNull();
      addMissionChatMessage(d, { missionId: 'mis_1', role: 'operator', kind: 'text', text: 'steer' });
      expect(listMissionChatMessages(d, 'mis_1').map((r) => r.text)).toEqual(['hello', 'steer']);
      expect(listMissionChatMessages(d, 'mis_1', { sinceSeq: 1 }).map((r) => r.text)).toEqual(['steer']);
      // Missions are isolated.
      expect(listMissionChatMessages(d, 'mis_2')).toEqual([]);
    } finally {
      d.close();
    }
  });

  it('stores speaker identity and renders mirrored review verdicts as markdown', () => {
    const d = openDb(':memory:');
    d.runMigration();
    try {
      addMissionChatMessage(d, {
        missionId: 'mis_1',
        role: 'assistant',
        kind: 'text',
        speaker: 'reviewer-a',
        text: 'verdict',
        partId: 'review:1:reviewer-a',
      });
      expect(listMissionChatMessages(d, 'mis_1')[0]?.speaker).toBe('reviewer-a');
    } finally {
      d.close();
    }
    const markdown = renderReviewVerdictMarkdown('reviewer-b', {
      result: 'FINDINGS',
      coverage: { changedFiles: 2, inspectedFiles: 2, uncoveredPaths: [] },
      findings: [
        {
          severity: 'HIGH',
          confidence: 'VERIFIED',
          title: 'No reproducible test',
          file: 'src/math.ts',
          lineStart: 3,
          evidence: 'no test file present',
          reviewerIds: ['B'],
        },
      ],
      models: [],
    });
    expect(markdown).toContain('**Reviewer B: FINDINGS**');
    expect(markdown).toContain('- **HIGH** No reproducible test (`src/math.ts`:3)');
    expect(reviewSpeakerLabel('adjudicator')).toBe('Adjudicator');
  });

  it('tail mode returns the NEWEST rows (console opens on live activity)', () => {
    const d = openDb(':memory:');
    d.runMigration();
    try {
      for (let i = 1; i <= 6; i++) {
        addMissionChatMessage(d, { missionId: 'mis_t', role: 'assistant', kind: 'text', text: `m${i}` });
      }
      expect(listMissionChatMessages(d, 'mis_t', { tail: 2 }).map((r) => r.text)).toEqual(['m5', 'm6']);
      expect(listMissionChatMessages(d, 'mis_t', { sinceSeq: 4 }).map((r) => r.text)).toEqual(['m5', 'm6']);
    } finally {
      d.close();
    }
  });
});
