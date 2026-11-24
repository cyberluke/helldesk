# HELLDESK v0 fixture — counter

A deliberately tiny, repository-controlled JavaScript fixture for the M1
execution-gate proof.

- `src/counter.mjs` contains a seeded defect: `increment(n)` returns `n` instead
  of `n + 1`.
- `test/counter.test.mjs` is the authoritative check. It exits 1 on the seeded
  defect and exits 0 on a genuine repair.
- `npm test` (or `node test/counter.test.mjs`) is the exact command the host gate
  runner executes in an isolated candidate worktree.

The M1 fake-pass scenario:

1. A scripted mutator leaves the defect in place and writes
   `proof/test-output.txt` claiming `PASS`.
2. HELLDESK captures that fabricated artifact as content evidence.
3. The host gate runner executes `node test/counter.test.mjs` against the
   candidate tree and records exit code 1.
4. The revision cannot reach `VERIFIED_10_10`.
5. A corrected revision (return `n + 1`) executes with exit code 0 and verifies.
6. Revision 1's failing execution evidence remains in mission history.

The test file is protected: changing it to make the suite pass is a scope
violation (`BLOCKED`), not a pass.
