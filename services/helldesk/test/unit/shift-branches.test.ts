import { describe, it, expect } from 'vitest';

/**
 * Pure reimplementation of the branch naming functions from container-dispatch.ts
 * for unit testing. Kept in sync with the actual implementation.
 */
function branchForAgent(name: string, ticketId?: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-');
  const ticketSuffix = ticketId ? `/${ticketId.slice(0, 8)}` : '';
  return `gt/${slug}${ticketSuffix}`;
}

function branchForShiftAgent(shiftFeatureBranch: string, name: string, ticketId: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-');
  // Strip /head suffix to get the shift prefix, then place the agent branch as a sibling
  const shiftPrefix = shiftFeatureBranch.replace(/\/head$/, '');
  return `${shiftPrefix}/gt/${slug}/${ticketId.slice(0, 8)}`;
}

describe('branchForAgent', () => {
  it('should generate gt/<slug>/<ticket-prefix> format', () => {
    expect(branchForAgent('Toast', 'abc12345-6789')).toBe('gt/toast/abc12345');
  });

  it('should handle names with special characters', () => {
    expect(branchForAgent('My Agent!', 'def456')).toBe('gt/my-agent-/def456');
  });

  it('should work without a ticket id', () => {
    expect(branchForAgent('frontDesk')).toBe('gt/frontDesk');
  });
});

describe('branchForShiftAgent', () => {
  it('should place agent branch as sibling of /head, not child', () => {
    expect(branchForShiftAgent('shift/add-auth/abc12345/head', 'Toast', 'ticket5678-full-id')).toBe(
      'shift/add-auth/abc12345/gt/toast/ticket5678'
    );
  });

  it('should handle feature branches with multiple slashes', () => {
    expect(branchForShiftAgent('shift/fix-bug-123/def45678/head', 'Maple', 'zzzzzzzz-9999')).toBe(
      'shift/fix-bug-123/def45678/gt/maple/zzzzzzzz'
    );
  });

  it('should sanitize agent name', () => {
    expect(branchForShiftAgent('shift/test/abc/head', 'Agent #1!', 'ticket0000-1111')).toBe(
      'shift/test/abc/gt/agent-1-/ticket0000'
    );
  });
});

describe('shift feature branch naming', () => {
  it('should follow convention: shift/<slug>/<id-prefix>/head', () => {
    // Test the naming convention used by slingShift
    const title = 'Add User Authentication';
    const shiftId = 'a1b2c3d4-5678-90ab-cdef-123456789012';
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    const featureBranch = `shift/${slug}/${shiftId.slice(0, 8)}/head`;

    expect(featureBranch).toBe('shift/add-user-authentication/a1b2c3d4/head');
  });

  it('should truncate long shift titles to 40 chars', () => {
    const title = 'This is a very long shift title that exceeds the maximum slug length we want';
    const shiftId = '12345678-abcd';
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    const featureBranch = `shift/${slug}/${shiftId.slice(0, 8)}/head`;

    expect(slug.length).toBeLessThanOrEqual(40);
    expect(featureBranch).toMatch(/^shift\/.{1,40}\/12345678\/head$/);
  });

  it('should not conflict with agent branches in git refs', () => {
    // Git refs are file-based: a ref at path X blocks refs under X/.
    // The shift feature branch ends with /head (a leaf ref), and agent
    // branches sit alongside it as siblings under the same shift prefix:
    //   shift/<slug>/<id>/head             ← feature branch (leaf)
    //   shift/<slug>/<id>/gt/<agent>/<ticket> ← agent branch (sibling)
    const featureBranch = 'shift/add-auth/a1b2c3d4/head';
    const agentBranch = branchForShiftAgent(featureBranch, 'Toast', 'ticket5678-full');

    expect(agentBranch).toBe('shift/add-auth/a1b2c3d4/gt/toast/ticket5678');
    // Agent branch must NOT start with featureBranch + '/' — that would
    // require /head to be a directory, conflicting with the /head ref file.
    expect(agentBranch.startsWith(featureBranch + '/')).toBe(false);
    // Both share the shift prefix (without /head)
    const shiftPrefix = featureBranch.replace(/\/head$/, '');
    expect(agentBranch.startsWith(shiftPrefix + '/')).toBe(true);
    expect(featureBranch.startsWith(shiftPrefix + '/')).toBe(true);
  });
});

/**
 * Pure reimplementation of the cycle detection from Department.do.ts slingShift.
 * Throws if the depends_on graph contains a cycle.
 */
function validateNoCycles(tasks: Array<{ depends_on?: number[] }>): void {
  const adj = new Map<number, number[]>();
  const inDegree = new Map<number, number>();
  for (let i = 0; i < tasks.length; i++) {
    adj.set(i, []);
    inDegree.set(i, 0);
  }
  for (let i = 0; i < tasks.length; i++) {
    for (const depIdx of tasks[i].depends_on ?? []) {
      if (depIdx < 0 || depIdx >= tasks.length || depIdx === i) continue;
      adj.get(depIdx)!.push(i);
      inDegree.set(i, (inDegree.get(i) ?? 0) + 1);
    }
  }
  const queue: number[] = [];
  for (const [node, deg] of inDegree) {
    if (deg === 0) queue.push(node);
  }
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited++;
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }
  if (visited < tasks.length) {
    throw new Error(
      `Shift dependency graph contains a cycle — ${tasks.length - visited} tasks are involved in circular dependencies`
    );
  }
}

describe('cycle detection', () => {
  it('should accept a valid DAG', () => {
    expect(() =>
      validateNoCycles([{ depends_on: [] }, { depends_on: [0] }, { depends_on: [0, 1] }])
    ).not.toThrow();
  });

  it('should accept fully parallel tasks', () => {
    expect(() => validateNoCycles([{}, {}, {}])).not.toThrow();
  });

  it('should reject a simple 2-node cycle', () => {
    expect(() => validateNoCycles([{ depends_on: [1] }, { depends_on: [0] }])).toThrow(/cycle/i);
  });

  it('should reject a 3-node cycle', () => {
    expect(() =>
      validateNoCycles([{ depends_on: [2] }, { depends_on: [0] }, { depends_on: [1] }])
    ).toThrow(/cycle/i);
  });

  it('should reject a cycle in a larger graph', () => {
    // 0 → 1 → 2 → 3 → 1 (cycle: 1→2→3→1)
    expect(() =>
      validateNoCycles([
        {},
        { depends_on: [0] },
        { depends_on: [1] },
        { depends_on: [2] },
        { depends_on: [3] }, // no cycle here, but 1→2→3 form a partial cycle
      ])
    ).not.toThrow(); // Actually this is NOT a cycle — 3 depends on 2, not 1→3→1

    // Real cycle: 1→2, 2→3, 3→1
    expect(() =>
      validateNoCycles([{}, { depends_on: [3] }, { depends_on: [1] }, { depends_on: [2] }])
    ).toThrow(/cycle/i);
  });

  it('should report the number of tasks in the cycle', () => {
    expect(() =>
      validateNoCycles([
        { depends_on: [1] },
        { depends_on: [0] },
        {}, // not in cycle
      ])
    ).toThrow('2 tasks');
  });
});
