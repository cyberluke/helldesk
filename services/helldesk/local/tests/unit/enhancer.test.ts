import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ENHANCER_OUTPUT_JSON_SCHEMA,
  EnhanceRequestSchema,
  EnhancedTaskSchema,
  checkEnhanceWorkspace,
  enhanceTask,
  type EnhancerModelCall,
  type EnhancerModelRunner,
} from '../../src/enhancer';

const FIXTURE_ROOT = join(import.meta.dir, '..', 'fixtures', 'repo-profile');

/** The model contract shape; taskType/writeTarget/delivery are intentionally ignored. */
const MODEL_OUTPUT = {
  title: 'Implement the requested slice',
  taskType: 'engine',
  writeTarget: 'output_repo',
  delivery: 'startup',
  spec: '## Objective\nImplement the slice.\n\n## Done\n- It works.',
  assumptions: ['No network access.'],
  questions: [],
  minimumProof: [
    { claim: 'Behavior works', test: 'bun test tests/unit/behavior.test.ts', evidence: 'exit 0' },
  ],
  notDoneIf: ['Do not claim done if the behavior test fails.'],
  risks: ['Hidden edge cases.'],
};

const QA_PASS = {
  verdict: 'PASS',
  summary: 'The spec preserves the brief and is implementation-ready.',
  findings: [],
};

const QA_REVISE = {
  verdict: 'REVISE',
  summary: 'The spec silently narrows the product to a demo.',
  findings: [
    {
      severity: 'blocker',
      issue: 'The spec accepts a 2D demo as the engine deliverable.',
      evidence: 'The brief asks for an AI-first game engine, not a demo.',
      requiredChange: 'Require the engine surfaces and a real 3D proof.',
    },
  ],
};

type FakeResponse = string | { error: string };

function recordingRunner(responses: FakeResponse[]): {
  runner: EnhancerModelRunner;
  calls: EnhancerModelCall[];
} {
  const calls: EnhancerModelCall[] = [];
  const runner: EnhancerModelRunner = {
    async run(call) {
      calls.push(call);
      const index = Math.min(calls.length - 1, responses.length - 1);
      const response = responses[index]!;
      if (typeof response === 'string') return { ok: true, text: response };
      return { ok: false, text: '', error: response.error };
    },
  };
  return { runner, calls };
}

function qaPassRunner(): EnhancerModelRunner {
  return recordingRunner([JSON.stringify(QA_PASS)]).runner;
}

describe('EnhanceRequestSchema', () => {
  it('rejects an empty/invalid body and accepts a minimal repos request', () => {
    expect(EnhanceRequestSchema.safeParse({ mode: 'text', title: '', spec: '', workspace: '' }).success).toBe(false);
    expect(EnhanceRequestSchema.safeParse({ mode: 'bogus', title: 't', spec: 's', workspace: 'w' }).success).toBe(false);
    expect(
      EnhanceRequestSchema.safeParse({
        mode: 'repos',
        title: 't',
        spec: 's',
        workspace: 'w',
        sources: [{ id: 'fixture', path: 'p' }],
      }).success
    ).toBe(true);
  });
});

describe('ENHANCER_OUTPUT_JSON_SCHEMA', () => {
  it('is strict: every object lists all properties and forbids extras', () => {
    const schema = ENHANCER_OUTPUT_JSON_SCHEMA as {
      type?: unknown;
      required?: unknown;
      additionalProperties?: unknown;
      properties?: Record<string, Record<string, unknown>>;
    };
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required as string[]).toEqual(
      expect.arrayContaining(['title', 'spec', 'assumptions', 'questions', 'minimumProof', 'notDoneIf', 'risks'])
    );
    const proof = schema.properties?.minimumProof;
    const items = proof?.items as { type?: unknown; required?: unknown; additionalProperties?: unknown } | undefined;
    expect(items?.type).toBe('object');
    expect(items?.additionalProperties).toBe(false);
    expect(items?.required as string[]).toEqual(expect.arrayContaining(['claim', 'test', 'evidence']));
  });
});

describe('checkEnhanceWorkspace', () => {
  it('rejects a missing workspace with an actionable message', () => {
    const root = mkdtempSync(join(tmpdir(), 'hd-enhance-workspace-'));
    try {
      const result = checkEnhanceWorkspace(join(root, 'missing'));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('workspace_missing');
        expect(result.message).toContain('does not exist');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an existing plain directory (the CLI-hang case) instead of spawning Kilo', () => {
    const root = mkdtempSync(join(tmpdir(), 'hd-enhance-workspace-'));
    try {
      const workspace = join(root, 'plain');
      mkdirSync(workspace, { recursive: true });
      const result = checkEnhanceWorkspace(workspace);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('workspace_uninitialized');
        expect(result.message).toContain('Save repos');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts an initialised git workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'hd-enhance-workspace-'));
    try {
      const workspace = join(root, 'repo');
      mkdirSync(join(workspace, '.git'), { recursive: true });
      expect(checkEnhanceWorkspace(workspace)).toEqual({ ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('enhanceTask', () => {
  it('parses valid JSON and applies request-resolved defaults (no analysis in text mode)', async () => {
    const { runner, calls } = recordingRunner([JSON.stringify(MODEL_OUTPUT)]);
    const result = await enhanceTask(
      { mode: 'text', title: 'Add the slice', spec: 'Add the requested slice.', workspace: FIXTURE_ROOT },
      { runner, qaRunner: qaPassRunner() }
    );

    expect(EnhancedTaskSchema.safeParse(result.enhanced).success).toBe(true);
    expect(result.enhanced.title).toBe('Implement the requested slice');
    expect(result.enhanced.taskType).toBe('feature');
    expect(result.enhanced.writeTarget).toBe('workspace');
    expect(result.enhanced.delivery).toBe('startup');
    expect(result.enhanced.assumptions).toContain('No network access.');
    expect(result.enhanced.assumptions.join(' ')).toMatch(/in-place/i);
    expect(result.enhanced.minimumProof[0]?.claim).toBe('Behavior works');
    expect(result.enhanced.notDoneIf.join('\n')).toMatch(/only documentation/i);
    expect(result.analysis).toBeUndefined();
    expect(result.qa.verdict).toBe('PASS');
    expect(calls).toHaveLength(1);
    expect(result.tookMs).toBeGreaterThanOrEqual(0);
  });

  it("mode 'repos' includes read-only workspace + source profile context", async () => {
    const { runner, calls } = recordingRunner([JSON.stringify(MODEL_OUTPUT)]);
    const result = await enhanceTask(
      {
        mode: 'repos',
        title: 'Add the slice',
        spec: 'Add the requested slice.',
        workspace: FIXTURE_ROOT,
        sources: [{ id: 'fixture', path: FIXTURE_ROOT }],
      },
      { runner, qaRunner: qaPassRunner() }
    );

    expect(result.analysis?.workspace.path).toBe(resolve(FIXTURE_ROOT));
    expect(result.analysis?.workspace.kind).toBe('git');
    expect(result.analysis?.output).toBeUndefined();

    const user = calls[0]!.user;
    expect(user).toContain('## Repository context (read-only)');
    expect(user).toContain('Repository profile');
    expect(user).toContain('repo-profile');
    expect(user).toContain('### Source: fixture');
    expect(user).not.toContain('fake-token-should-be-redacted');
    expect(user.length).toBeLessThan(45_000);
  });

  it('forces writeTarget=workspace when outputRepo is empty, even if requested otherwise', async () => {
    const { runner, calls } = recordingRunner([JSON.stringify(MODEL_OUTPUT)]);
    const result = await enhanceTask(
      {
        mode: 'text',
        title: 'Extract the renderer',
        spec: 'Extract the renderer into a reusable engine.',
        workspace: FIXTURE_ROOT,
        outputRepo: '',
        writeTarget: 'output_repo',
      },
      { runner, qaRunner: qaPassRunner() }
    );

    expect(result.enhanced.taskType).toBe('extraction');
    expect(result.enhanced.writeTarget).toBe('workspace');
    expect(calls[0]!.user).toContain('Write target: workspace (in-place)');
    expect(calls[0]!.user).toContain('Output repo: (none');
    expect(calls[0]!.system).not.toMatch(/output repository is the delivery target/i);
  });

  it('defaults bugfix vs extraction from the brief and emits their required instructions', async () => {
    const bug = recordingRunner([JSON.stringify(MODEL_OUTPUT)]);
    const bugResult = await enhanceTask(
      { mode: 'text', title: 'Fix the crash', spec: 'Fix the crash when config is missing.', workspace: FIXTURE_ROOT },
      { runner: bug.runner, qaRunner: qaPassRunner() }
    );
    expect(bugResult.enhanced.taskType).toBe('bugfix');
    expect(bugResult.enhanced.writeTarget).toBe('workspace');
    expect(bugResult.enhanced.notDoneIf.join('\n')).toMatch(/regression test/i);
    expect(bug.calls[0]!.system).toContain('reproduction');
    expect(bug.calls[0]!.system).toContain('root-cause hypothesis');
    expect(bug.calls[0]!.system).toContain('one regression test');

    const extraction = recordingRunner([JSON.stringify(MODEL_OUTPUT)]);
    const extractionResult = await enhanceTask(
      {
        mode: 'text',
        title: 'Extract the renderer',
        spec: 'Extract the rendering pipeline into a reusable engine.',
        workspace: FIXTURE_ROOT,
      },
      { runner: extraction.runner, qaRunner: qaPassRunner() }
    );
    expect(extractionResult.enhanced.taskType).toBe('extraction');
    expect(extractionResult.enhanced.writeTarget).toBe('workspace');
    for (const section of ['Objective', 'Source/Output', 'Surfaces', 'Non-goals', 'Done', 'Not done if', 'Milestones']) {
      expect(extraction.calls[0]!.system).toContain(section);
    }
  });

  it('uses the canonical game-agnostic 3D engine proof only as a fallback', async () => {
    const output = { ...MODEL_OUTPUT, minimumProof: undefined };
    const { runner, calls } = recordingRunner([JSON.stringify(output)]);
    const result = await enhanceTask(
      {
        mode: 'text',
        title: 'Game-agnostic engine',
        spec: 'Build a game-agnostic 3D game engine with templates and WebGL for any game genre.',
        workspace: FIXTURE_ROOT,
        taskType: 'engine',
        delivery: 'startup',
      },
      { runner, qaRunner: qaPassRunner() }
    );

    expect(result.enhanced.taskType).toBe('engine');
    expect(result.enhanced.minimumProof).toHaveLength(5);
    const proof = result.enhanced.minimumProof.map((item) => item.claim.toLowerCase()).join('\n');
    expect(proof).toContain('boundary test');
    expect(proof).toContain('swap test');
    expect(proof).toContain('manifest validation');
    expect(proof).toContain('build/typecheck');
    expect(proof).toContain('visual frame');
    expect(result.enhanced.notDoneIf.join('\n')).toMatch(/template or genre vocabulary/i);
    expect(calls[0]!.system).toContain('one rendered frame per 3D template');
  });

  it('does not inject 3D proof into a specific 2D game engine brief', async () => {
    const solitaireProof = [
      { claim: 'Win 98 board plays end to end', test: 'Drive the real board through a scripted win.', evidence: 'Run + screenshot artifacts.' },
      { claim: 'Win cascade fires exactly once', test: 'Drive the terminal transition.', evidence: 'Exactly one handoff assertion.' },
      { claim: 'QA CTA reruns the cascade', test: 'Trigger from a fresh deal and mid-game.', evidence: 'Two captured frames.' },
      { claim: 'Build/typecheck', test: 'Run build and typecheck.', evidence: 'Both exit 0.' },
    ];
    const output = { ...MODEL_OUTPUT, minimumProof: solitaireProof };
    const { runner, calls } = recordingRunner([JSON.stringify(output)]);
    const result = await enhanceTask(
      {
        mode: 'text',
        title: 'SOL98 Solitaire',
        spec: 'Build a Win 98-style 2D Solitaire game with the classic win animation and an on-demand QA CTA. No 3D, no game-agnostic framework.',
        workspace: FIXTURE_ROOT,
        taskType: 'engine',
        delivery: 'startup',
      },
      { runner, qaRunner: qaPassRunner() }
    );

    expect(result.enhanced.minimumProof).toHaveLength(5);
    expect(result.enhanced.minimumProof.map((item) => item.claim)).toEqual([
      ...solitaireProof.map((item) => item.claim),
      'Visual frame: one rendered frame of the actual product surface.',
    ]);
    expect(JSON.stringify(result.enhanced.minimumProof)).not.toContain('3D');
    expect(result.enhanced.notDoneIf.join('\n')).not.toContain('3D');
    expect(calls[0]!.system).not.toContain('one rendered frame per 3D template');
    expect(calls[0]!.system).toContain('specific game/rules engine');
  });

  it('repairs a model that copied the canonical 3D engine proof into a specific 2D engine', async () => {
    const canonicalProof = [
      { claim: 'Boundary test: the engine builds and contains no template imports or genre vocabulary.', test: 'Grep.', evidence: 'Zero hits.' },
      { claim: 'Swap test: two different templates run on the same engine build.', test: 'Run A and B.', evidence: 'Same digest.' },
      { claim: 'Manifest validation: the game/template manifest validates against its schema.', test: 'Validate.', evidence: 'Exit 0.' },
      { claim: 'Build/typecheck: the package builds and typechecks.', test: 'Build.', evidence: 'Exit 0.' },
      { claim: 'Visual frame: one rendered frame per 3D template.', test: 'Render 3D templates.', evidence: 'Three frames.' },
    ];
    const output = {
      ...MODEL_OUTPUT,
      minimumProof: canonicalProof,
      notDoneIf: ['Do not claim done if no 3D template produced a rendered frame.'],
    };
    const { runner } = recordingRunner([JSON.stringify(output)]);
    const result = await enhanceTask(
      {
        mode: 'text',
        title: 'SOL98 Solitaire',
        spec: 'Build a Win 98-style 2D Solitaire game with a win animation and a QA CTA. No 3D, no game-agnostic framework.',
        workspace: FIXTURE_ROOT,
        taskType: 'engine',
        delivery: 'startup',
      },
      { runner, qaRunner: qaPassRunner() }
    );

    expect(result.enhanced.minimumProof).toHaveLength(4);
    expect(result.enhanced.minimumProof.some((item) => /primary user flow/i.test(item.claim))).toBe(true);
    expect(JSON.stringify(result.enhanced.minimumProof)).not.toContain('3D');
    expect(result.enhanced.notDoneIf.join('\n')).not.toMatch(/no 3D template produced/i);
  });

  it('treats "no 3D" as 2D for a game-agnostic engine fallback', async () => {
    const output = { ...MODEL_OUTPUT, minimumProof: undefined };
    const { runner, calls } = recordingRunner([JSON.stringify(output)]);
    const result = await enhanceTask(
      {
        mode: 'text',
        title: 'Game-agnostic 2D engine',
        spec: 'Build a game-agnostic 2D engine with templates for any game genre. No 3D.',
        workspace: FIXTURE_ROOT,
        taskType: 'engine',
        delivery: 'startup',
      },
      { runner, qaRunner: qaPassRunner() }
    );

    expect(result.enhanced.minimumProof).toHaveLength(5);
    expect(JSON.stringify(result.enhanced.minimumProof)).not.toContain('3D');
    expect(result.enhanced.minimumProof.some((item) => /actual product surface/i.test(item.claim))).toBe(true);
    expect(result.enhanced.notDoneIf.join('\n')).not.toMatch(/no 3D template produced/i);
    expect(calls[0]!.system).not.toContain('one rendered frame per 3D template');
  });

  it('fits the enhancer and QA prompts into a small tier budget', async () => {
    const longBrief = `Build the feature. ${'x'.repeat(20_000)}`;
    const { runner, calls } = recordingRunner([JSON.stringify(MODEL_OUTPUT)]);
    const qa = recordingRunner([JSON.stringify(QA_PASS)]);
    const budget = {
      contextWindowTokens: 16_384,
      inputBudgetTokens: 12_288,
      outputBudgetTokens: 4_096,
      promptCharBudget: 9_000,
    };
    const result = await enhanceTask(
      { mode: 'text', title: 'Small model', spec: longBrief, workspace: FIXTURE_ROOT, delivery: 'startup' },
      { runner, qaRunner: qa.runner, enhancerBudget: budget, qaBudget: budget }
    );

    expect(result.enhanced.spec).toContain('Objective');
    expect(calls[0]!.user.length).toBeLessThanOrEqual(budget.promptCharBudget - calls[0]!.system.length);
    expect(qa.calls[0]!.user.length).toBeLessThanOrEqual(budget.promptCharBudget - qa.calls[0]!.system.length);
    expect(calls[0]!.user).toContain('Return ONLY the enhancer JSON object');
    expect(qa.calls[0]!.user).toContain('Return ONLY the QA JSON object');
  });

  it('repairs exactly one invalid JSON response', async () => {
    const { runner, calls } = recordingRunner(['this is not json', JSON.stringify(MODEL_OUTPUT)]);
    const result = await enhanceTask(
      { mode: 'text', title: 'Add', spec: 'Add the behavior.', workspace: FIXTURE_ROOT },
      { runner, qaRunner: qaPassRunner() }
    );

    expect(result.enhanced.spec).toContain('Objective');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.user).toContain('## Repair required');
    expect(calls[1]!.user).toContain('Return ONLY one JSON object');
  });

  it('surfaces model call failure to the caller (HTTP 502 boundary)', async () => {
    const { runner } = recordingRunner([{ error: 'provider unreachable' }]);
    let caught: unknown;
    try {
      await enhanceTask(
        { mode: 'text', title: 'Add', spec: 'Add the behavior.', workspace: FIXTURE_ROOT },
        { runner, qaRunner: qaPassRunner() }
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('model call failed');
    expect((caught as Error).message).toContain('provider unreachable');
  });

  it('runs an independent adversarial QA pass and returns its findings', async () => {
    const { runner } = recordingRunner([JSON.stringify(MODEL_OUTPUT)]);
    const qa = recordingRunner([JSON.stringify(QA_REVISE)]);
    const result = await enhanceTask(
      { mode: 'text', title: 'Add', spec: 'Add the behavior.', workspace: FIXTURE_ROOT },
      { runner, qaRunner: qa.runner }
    );

    expect(result.qa.verdict).toBe('REVISE');
    expect(result.qa.findings[0]?.severity).toBe('blocker');
    expect(result.qa.findings[0]?.requiredChange).toContain('3D proof');
    expect(qa.calls).toHaveLength(1);
    expect(qa.calls[0]!.system).toContain('adversarial product owner');
    expect(qa.calls[0]!.user).toContain('Proposed spec (untrusted');
    expect(qa.calls[0]!.user).toContain('Add the behavior.');
  });

  it('marks QA unavailable when the QA runner fails, without losing the spec', async () => {
    const { runner } = recordingRunner([JSON.stringify(MODEL_OUTPUT)]);
    const qa = recordingRunner([{ error: 'qa provider down' }]);
    const result = await enhanceTask(
      { mode: 'text', title: 'Add', spec: 'Add the behavior.', workspace: FIXTURE_ROOT },
      { runner, qaRunner: qa.runner }
    );

    expect(result.qa.verdict).toBe('UNAVAILABLE');
    expect(result.qa.summary).toContain('qa provider down');
    expect(result.enhanced.spec).toContain('Objective');
  });

  it('retries QA once on a transient provider disconnect', async () => {
    const { runner } = recordingRunner([JSON.stringify(MODEL_OUTPUT)]);
    const qa = recordingRunner([{ error: 'Connection reset by server' }, JSON.stringify(QA_PASS)]);
    const result = await enhanceTask(
      { mode: 'text', title: 'Add', spec: 'Add the behavior.', workspace: FIXTURE_ROOT },
      { runner, qaRunner: qa.runner }
    );

    expect(result.qa.verdict).toBe('PASS');
    expect(qa.calls).toHaveLength(2);
  });

  it('passes previous QA findings into the regeneration prompt', async () => {
    const { runner, calls } = recordingRunner([JSON.stringify(MODEL_OUTPUT)]);
    await enhanceTask(
      {
        mode: 'text',
        title: 'Add',
        spec: 'Add the behavior.',
        workspace: FIXTURE_ROOT,
        qaFindings: ['Add the missing 3D proof.'],
      },
      { runner, qaRunner: qaPassRunner() }
    );

    expect(calls[0]!.user).toContain('Adversarial QA findings to address');
    expect(calls[0]!.user).toContain('Add the missing 3D proof.');
  });
});
