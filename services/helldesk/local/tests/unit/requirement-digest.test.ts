import { describe, expect, it } from 'bun:test';
import { digestRequirements, renderRequirementChecklist } from '../../src/requirement-digest';

/**
 * The reviewer must judge the TASK'S OWN requirements. This distiller is
 * domain-agnostic: it reads structure (sections, numbered items, prohibitions,
 * done-when) and never hardcodes a domain's acceptance criteria.
 */
describe('task-agnostic requirement digest', () => {
  it('distills a structured objective (deliverables / constraints / DoD)', () => {
    const objective = [
      'Extract a reusable framework from the game code.',
      'Read-only source: X. Never modify it.',
      'Required deliverable:',
      '1. docs/EXTRACTION.md — map each module to its source.',
      '2. src/core/ — world model.',
      'Constraints:',
      '- Do NOT copy the whole tree.',
      '- No probe or scratch scripts.',
      'Definition of done:',
      '- Tests pass.',
      '- The example runs the framework.',
    ].join('\n');
    const digest = digestRequirements(objective);
    expect(digest.deliverables).toContain('docs/EXTRACTION.md — map each module to its source.');
    expect(digest.deliverables).toContain('src/core/ — world model.');
    expect(digest.constraints.some((c) => c.includes('Do NOT copy the whole tree'))).toBe(true);
    expect(digest.constraints.some((c) => c.includes('No probe or scratch scripts'))).toBe(true);
    expect(digest.definitionOfDone).toEqual(['Tests pass.', 'The example runs the framework.']);
    expect(digest.checklist).toEqual([...digest.deliverables, ...digest.definitionOfDone]);

    const rendered = renderRequirementChecklist(digest);
    expect(rendered).toContain('- [ ] docs/EXTRACTION.md');
    expect(rendered).toContain('TASK CONSTRAINTS');
  });

  it('distills a flat prose objective without headings (sentence fallback)', () => {
    const digest = digestRequirements(
      'Create src/math.ts with exactly two exported functions sum and product. Do not create probe, scratch, log, or diagnostic files. This is the only deliverable.'
    );
    expect(digest.deliverables.some((x) => x.startsWith('Create src/math.ts'))).toBe(true);
    expect(digest.constraints.some((x) => x.includes('Do not create probe'))).toBe(true);
    expect(renderRequirementChecklist(digest)).toContain('ACCEPTANCE CHECKLIST');
  });

  it('returns an empty digest for an empty objective', () => {
    expect(digestRequirements('')).toEqual({ deliverables: [], constraints: [], definitionOfDone: [], checklist: [] });
  });
});
