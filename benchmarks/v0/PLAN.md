# HELLDESK Adversarial Multimodal Benchmark v0 — Plan

**Status:** M1–M5 complete. Results report: `benchmarks/v0/BENCHMARK.md`; verifier: `bun run benchmarks/v0/verify-results.ts` (7/7), committed summary `benchmarks/v0/results.json`.
M1 proof: `.local/benchmark/v0/m1-proof/2026-11-23T22-06-36-163Z`.
M2 proof (BrowserOS gate): `.local/benchmark/v0/m2-proof/2026-11-24T00-21-02-322Z`.
M3 regression proof (BrowserOS gate): `.local/benchmark/v0/m3-regression-proof/2026-11-24T00-29-25-787Z`.
M3 recovery proof: `.local/benchmark/v0/m3-recovery-proof/2026-11-23T22-18-00-064Z`.
M4 dashboard demo: proof mission `mis_a1b1beb2914447ada9f00a616c3eb2bc` from the M3 regression proof above; page captures in `benchmarks/v0/dashboard/media/` (BrowserOS MCP screenshots, assembled with ffmpeg). Committed demo: 33.5s 480x270 animated GIF; the 1920x1080 source MP4 stays local (MP4 is LFS).
**Invariant (non-negotiable):**

> An agent cannot certify its own work. Only independently executed evidence can satisfy an execution gate.

**Public claim this v0 is built to earn:**

> The agent said PASS. HELLDESK executed the test. The test failed. The release was blocked.

No SWE-bench dataset. No 9 GB Docker images. One repository-controlled fixture, the real
mission/review pipeline, and a host-side execution gate.

---

## Scope

| Track | In scope | Out of scope |
|---|---|---|
| M1 | Host-executed gates, execution provenance, fake-pass rejection, repaired-revision proof, isolated benchmark config skeleton | Visual harness, dashboard video, public report |
| M1.1 | Immutable mission admission baseline; committed/uncommitted/rename/delete/symlink protected-path detection; explicit authorization | Hard CPU/memory caps (separate isolation milestone) |
| M2 | Deterministic Vite/React fixture, BrowserOS Neo functional + golden visual checks, evidence outside the workspace | External benchmark datasets, public report |
| M3 | Regression injection (visual fix + broken behavior), corrective revision; killed-agent retry across a durable DB restart | Model-quality leaderboard claims, hard CPU/memory caps |
| M4 | BrowserOS Neo dashboard session, isolated `HELLDESK_CONTROL_CONFIG` routing, Kanban mission projection, BrowserOS page-capture GIF, media | 4K HDR production video |
| M5 | Results package, `verify-results.ts`, `BENCHMARK.md`, git publish | Full public benchmark suite |

M1 and the deterministic fixture may proceed in parallel. M1 is not blocked on the
in-flight Task Studio / vision attachment work.

---

## M1 acceptance requirements

1. `gate-runner.ts` is a **production capability** in `services/helldesk/local/src`, not benchmark-specific logic.
2. Every execution is bound to an immutable candidate revision (candidate tree hash + revision id).
3. Gate definitions live on the mission (persisted out-of-band); the mutator cannot modify the authoritative commands, criteria, or expected artifacts.
4. Execution happens in an isolated candidate worktree/copy outside the source workspace, with a scrubbed environment, bounded timeout, process-tree termination, and evidence stored outside the source workspace.
5. Execution provenance records: command, exit code, duration, stdout/stderr SHA-256 + bytes, environment fingerprint, candidate revision hash, test-file hashes, protected-path scope result.
6. The Quality Oracle enforces execution evidence: a failed executable gate cannot become `PASS` because a reviewer says so.
7. Fake-pass scenario: a scripted mutator submits a plausible but false test report; HELLDESK independently runs the tests and rejects the revision.
8. Repair loop: a corrected revision passes; the original failing evidence remains in mission history.

**M1 completion gate (automated):** fabricated evidence cannot produce `VERIFIED_10_10`;
a genuinely repaired revision can.

---

## Architecture

```
mission request
  taskGates: ["functional_correctness", ...]
  gateCommands: {
    functional_correctness: { command: "node test/counter.test.mjs", timeoutMs: 30000 }
  }
        │
        ▼
autonomy_missions.gate_commands_json      ← trusted, outside the writable workspace
        │
        ▼
advanceMission (before review)
  gate-runner:
    1. materialize candidate tree (temp git index/write-tree/archive) outside source workspace
    2. compute candidate hash + test-file hashes + protected-path diff
    3. run each command with scrubbed env + timeout + process-tree kill
    4. write stdout/stderr/result.json outside the source workspace
    5. addEvidence(kind="execution", command, exit_code, sha256, bytes)
    6. insert gate_executions row bound to revision_id + candidate_hash
        │
        ▼
review hook
  - reviewer sees EXECUTED GATE results (authoritative)
  - mutator cannot fake them
        │
        ▼
Quality Oracle
  - isRevisionVerified10 requires, for every executable gate:
      latest gate_executions.status = PASS
      execution evidence resolves (kind=execution, bytes>0, sha256=64, exit_code=0)
  - a failed execution forces status FAIL regardless of reviewer verdict
        │
        ▼
VERIFIED_10_10 only when all mandatory gates + all execution gates pass
```

### Data model (migration 0021)

- `autonomy_missions.gate_commands_json TEXT NOT NULL DEFAULT '{}'`
- `gate_executions`:
  `gate_execution_id, revision_id, gate_key, candidate_hash, command, cwd, status,
   exit_code, duration_ms, stdout_sha256, stderr_sha256, stdout_bytes, stderr_bytes,
   evidence_artifact_id, env_json, test_file_hashes_json, protected_paths_json,
   started_at, finished_at`
- One row per attempt; latest row wins for verification. History is never deleted.

### Trust boundaries

- Gate commands are persisted on the mission, never read from the agent's workspace.
- Test files are protected by default (`tests/**`, `__tests__/**`, `test/**`, `*.test.*`, `*.spec.*`); a changed protected path makes the execution `BLOCKED`.
- The execution transcript is written outside the workspace; the agent cannot edit it.
- The reviewer may make a passing execution stricter (real BLOCKER/HIGH finding), but may never make a failed execution pass.
- Reviewer-only PASS with no executed evidence cannot satisfy an executable gate.

---

## File map

| Path | Change |
|---|---|
| `services/helldesk/local/src/migrations/0021_gate_executions.sql` | Execution-gate schema |
| `services/helldesk/local/src/migrations/0022_mission_baseline.sql` | Immutable admission baseline |
| `services/helldesk/local/src/db.ts` | Register migrations 21/22 |
| `services/helldesk/local/src/gate-runner.ts` | Production host execution + protected-file comparison |
| `services/helldesk/local/src/mission-baseline.ts` | Capture/compare immutable protected identities |
| `services/helldesk/local/src/mission-repository.ts` | Gate commands, executions, baseline persistence, oracle enforcement |
| `services/helldesk/local/src/mission-controller.ts` | Execute gates before review; merge execution status into gates |
| `services/helldesk/local/src/engine-review-hook.ts` | Surface executed gates; execution-authoritative merge; legacy oracle fallback |
| `services/helldesk/local/src/api.ts` | Accept/validate `gateCommands`, `protectedPaths`, `allowProtectedPaths` |
| `benchmarks/v0/fixture/` | Deterministic counter fixture (seeded bug) |
| `benchmarks/v0/visual-fixture/` | Vite/React fixture, BrowserOS Neo functional + golden visual checks |
| `benchmarks/v0/visual-gate-spec.ts` | Host-owned browser gate definition (build/preview, stage, checks, golden) |
| `benchmarks/v0/visual-fixture/scripts/capture-golden.ts` | BrowserOS golden regeneration |
| `benchmarks/v0/m1-proof.ts` | M1 end-to-end proof |
| `benchmarks/v0/m2-visual-proof.ts` | M2 visual pipeline proof |
| `benchmarks/v0/m3-regression-proof.ts` | M3 visual fix + behavior regression proof |
| `benchmarks/v0/m3-recovery-proof.ts` | M3 killed-agent durable retry proof |
| `benchmarks/v0/dashboard/` | BrowserOS Neo session recipe, isolated demo start/stop, `capture-dashboard.ts` + `assemble-video.ps1` + `make-gif.ps1`, media |
| `benchmarks/v0/verify-results.ts` | Verifies proof summaries, raw proof DBs, execution evidence, media, and the Playwright removal; writes `results.json` |
| `benchmarks/v0/BENCHMARK.md` | Public v0 results report and evidence index |
| `benchmarks/v0/results.json` | Path-free committed summary produced by the verifier |
| `services/helldesk/local-live/src/entry.ts` | `HELLDESK_CONTROL_CONFIG` dashboard routing override |
| `benchmarks/v0/config/benchmark.config.json` | Isolated benchmark daemon config |
| `services/helldesk/local/tests/integration/execution-gates.test.ts` | Fake-pass + repaired-revision proof |
| `services/helldesk/local/tests/integration/worker-recovery.test.ts` | Kill + DB restart + same-revision retry proof |
| `services/helldesk/local/tests/unit/gate-runner.test.ts` | Timeout/tree-kill, scrubbed env, protected paths, committed tamper, rename/delete, symlink, evidence location |

---

## Test matrix

| Test | Proves |
|---|---|
| fake-pass rejection | Fabricated PASS artifact is captured but the host-run test exits 1; revision cannot reach `VERIFIED_10_10`; gate row is FAIL |
| repaired revision | Corrected revision exits 0, execution evidence resolves, mission reaches `VERIFIED_10_10` |
| history retention | Revision 1 failing execution evidence still exists after revision 2 verifies |
| reviewer cannot override | A review hook returning `PASS` with fabricated evidence cannot satisfy the executable gate |
| timeout tree kill | Parent + grandchild processes are terminated on timeout |
| scrubbed env | Secret/token env vars are absent from the child process |
| protected test file | Changing a test file yields `BLOCKED` and no PASS |
| committed tamper | A committed test change that would pass is still `BLOCKED` (baseline, not HEAD) |
| delete/rename | Deleting or renaming a protected test is `BLOCKED` |
| explicit authorization | An allowed protected-file change runs and can PASS |
| evidence location | Execution transcript path is under the data dir, not the workspace |
| candidate binding | Execution row carries the candidate hash and the exact revision id |
| visual functional | BrowserOS `selectorInViewport` fails on the seeded defect and passes on the repair |
| visual golden | Stage crop: scrollbar size mismatch on the defect (or >0.2%), 0 on the repair; actual/full/diff PNGs outside the workspace |
| regression injection | Visual golden passes at ratio 0, but functional/regression fails; gate FAIL, revision rejected, repair verifies |
| worker recovery | Agent child killed; revision returns to PLANNED, mission ACTIVE; DB close/reopen; same revision retries, host gate PASS, VERIFIED_10_10 |
| dashboard isolation | Demo control plane :4791 and dashboard :8792; production :4790/:8790 untouched; proof mission visible |
| BrowserOS session | First `tabs list`, mine-owned page reuse, stale page re-derivation, group refresh after reconnect, 30s bounded runs |
| dashboard capture | 33.5s 480x270 animated GIF (committed) + 1920x1080 source MP4 local + overview/kanban/verified/transcript/diff/observability screenshots; real BrowserOS MCP page captures, no cockpit or personal windows |
| results verification | `bun run benchmarks/v0/verify-results.ts` → 7/7: mission/revision/gate rows, `execution` evidence from `helldesk-gate-runner`, quality-gate references, media metadata, no Playwright; writes `results.json` |

**M1 is done only when all of the above are automated, green, and the outputs are shown.**

---

## Isolation and working-tree discipline

- Production `services/helldesk/local/config.json` is not modified.
- Benchmark daemon config uses a separate `dataDir` and port; the dashboard routing override is M4.
- The in-flight Task Studio / vision changes are not overwritten, staged, or committed.
- No Docker, no SWE-bench, no large downloads.
- No new benchmark-specific branch in production code; the gate runner is a product capability.

---

## What M1 does not claim

- It does not claim a public benchmark result.
- It does not claim the visual demo is complete.
- It does not claim reviewer models are safe; it makes their PASS insufficient without execution.
- It does not claim the existing hardcoded `runTestOracle` is correct; for missions with
  gate commands it is superseded. It remains only as a legacy fallback.
