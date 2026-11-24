# M6 — live multimodal adversarial run

One real mission through the local HELLDESK control plane: a real model mutates a
seeded UI defect, the **host** executes the browser gates (visual golden + click
contract) with BrowserOS, and real A/B reviewers + an adjudicator judge the frozen
evidence. No Playwright, no separate Chrome automation stack.

* Fixture: `benchmarks/v0/visual-fixture` — a pricing card whose CTA is seeded at
  `position: absolute; left: 9999px`, so it is off-card and creates scrollbars.
* Gates (per revision):
  * `functional_correctness` — BrowserOS browser gate: CTA in viewport, click shows
    "Plan selected", screenshot diff against `tests/golden/pricing-card.png`
    (`maxDiffRatio: 0.002`).
  * `regression_checks` — the same browser contract, separate gate.
  * `artifact_provenance` — a host command gate.
* Engine matrix: mutation / review / adjudicate all
  `cyberluke/deepseek-ai--deepseek-v41-flash-1017` through the Kilo runner.

Run A is the live run that **found a real false certification**. Run B is the
post-fix run on the repaired engine. Both use isolated control planes and data
dirs; production (`:4790/:8790`) is never touched.

---

## Run A (`m6a`) — the run that exposed evidence drift

Mission `mis_193cdad4834341dd84d032269baa57f3`, isolated control plane `:4791`,
data `.local/benchmark/m6/live-data`, workspace `.local/benchmark/m6/live-workspace`.

### What the engine actually did

| time (UTC) | event |
|---|---|
| 07:15:48 | mission created; baseline commit `2e8a444` |
| 07:15–07:48 | **revision 1** mutation (real model), gates executed |
| 07:40–07:48 | `functional_correctness` **FAIL** (visual diff ratio 0.0348 > 0.002); reviewers A+B return `FINDINGS`; adjudicator `FINDINGS` → revision **REJECTED** |
| 07:48–08:38 | **revision 2** mutation, all three gates **PASS** (diff ratio 0), reviewers run |
| 08:15–08:28 | review `job_3f9226…` → `INCONCLUSIVE` (A PASS; B FINDINGS: HIGH rejected, LOW accepted; adjudicator: packet lacked the implementation render + test summary) |
| 08:28–08:38 | convergence re-review `job_0036…` → A PASS, B PASS, adjudicator `INCONCLUSIVE` |
| 08:38:46 | the hook's oracle override flips `INCONCLUSIVE → PASS` because every executed gate is PASS → revision **VERIFIED_10_10**, mission **VERIFIED_10_10** |

Real, non-simulated pieces: the model wrote the CSS fix, the host executed the
BrowserOS gates and produced the screenshots/diffs, the reviewers were real model
calls, and revision 1 was rejected on an **executed gate failure**.

### The false certification

The host gates for revision 2 executed candidate tree:

```
6a4a0d0de84eb0e0cae0a7d9f09308b9e69507bd   (tree of commit a40f2f7)
```

At the verification instant (08:38:46Z) the workspace `HEAD` was:

```
875082656254f4a36839cec6264d9744f14dc842
  tree e8bd9b96548e576ee5a3ac64ade11190a66002b1   (committed 08:32:51Z)
```

`e8bd9b96… != 6a4a0d0d…`. The certified tree was never executed by the gates. A
post-verification commit (`bb78cb4`, 09:28:23Z) moved it again.

**Root cause (harness):** the same workspace path was also registered in the
**production** HELLDESK instance, which had its own live mission
`mis_8768947294184e2e9505315f3c7471a4` (`MUTATING`) on it. That mutation agent kept
editing and committing while the benchmark mission was being reviewed/certified.
The benchmark's `prepare` step did not establish exclusive ownership.

**Root cause (engine):** verification was not bound to the frozen gate candidate.
The convergence re-review snapshotted the live workspace instead of the gated
candidate, and the snapshot materializer read the committed blob for a dirty file
(`files/src__styles.css` = `76650228…`) while its own diff contained the dirty
version. A PASS on any snapshot could be bound to stale gate evidence.

### Proof bundle

`evidence/m6a/` is a sanitized, content-addressed export of the DB + every byte
referenced by it:

```
bun run benchmarks/m6/verify-bundle.ts benchmarks/m6/evidence/m6a
# integrity: PASS (58 artifacts, 0 missing)
# certification: INVALID
# exit code 1
```

The bundle records the git reflog, so `head_at_verification = 8750826` is derived
from the run's own timestamps, not from the machine's current state. Open
`evidence/m6a/README.md` for the human summary and `bundle.json` for the record.

> The bundle proves a defect. Its `certification: INVALID` exit code is the
> correct outcome; it is not a release artifact.

---

## The fix

Committed as `ef92981d` (`fix(helldesk): bind verification to the exact gated
candidate tree`).

* **Candidate identity.** `workspaceTreeIdentity()` recomputes the same temp-index
  git tree hash the gate runner binds to (read-only, `.gitignore` respected).
* **Fail-closed drift guard.** Before a review, between convergence attempts, and
  after the review, the controller compares the workspace tree to the gate
  candidate. A mismatch discards the verdict and re-enters verification so the 4a
  sweep re-executes the gates against the current tree. Bounded: after 3 drifts the
  revision is rejected and replanned — a writer that never quiesces cannot spin.
* **Snapshot bytes.** `git-dirty` snapshots now materialize the **working-tree**
  bytes for tracked edits and untracked files, and list untracked files as review
  subject. A snapshot may no longer pin the HEAD blob while diffing the worktree.
* **Evidence refresh.** Each review recaptures changed files (idempotent per hash),
  so the reviewer's evidence manifest matches the snapshot bytes.
* **Quiescence.** A bounded wait (only when executable gates exist) reduces wasted
  gate/review cycles without weakening the hard check.
* **Cross-instance isolation.** `prepare-run.ps1` refuses to prepare a run while
  another known HELLDESK instance has a non-terminal benchmark mission.

Regression tests: `workspaceTreeIdentity` (clean/dirty/ignored), git-dirty snapshot
bytes, and a controller test where a writer edits during review → the PASS is
discarded, then a clean second tick certifies the re-gated tree.

---

## Run B (`m6b`) — post-fix run

Prepared with `prepare-run.ps1 -RunId m6b` (fresh fixture copy, own git history,
own data dir, control plane `:4793`, dashboard `:8792`).

* Mission: `mis_d8774ff2f7154c42965e073eebf8adb8`
* Workspace: `ws_af6a82463050359d`, baseline commit `ffee957`
* Result: recorded in `evidence/m6b/` once the run reaches a terminal state.

A run B certification is only exported as `VALID` when
`tree_at_verification === gate_candidate` for the verified revision; otherwise the
bundle is exported as a finding (exit 1), never as a success.

---

## Files

| File | Purpose |
|---|---|
| `mission.json` | Mission template (workspace id / screenshot path are rewritten per run). |
| `prepare-run.ps1` | Materializes an isolated workspace + config; refuses cross-instance collisions. |
| `capture-broken.ts` | Captures the seeded broken screenshot through BrowserOS (text/metadata driven). |
| `export-evidence.ts` | Exports a run DB + artifacts into a sanitized content-addressed bundle. |
| `verify-bundle.ts` | Audits a bundle offline: artifact hashes + certification claim. |
| `evidence/m6a/` | Run A finding bundle (integrity PASS, certification INVALID). |
| `evidence/m6b/` | Run B bundle (post-fix), when complete. |

## Reproduce

```powershell
# 1. Prepare an isolated run (fails if another instance owns a benchmark mission)
pwsh -File benchmarks/m6/prepare-run.ps1 -RunId m6c -Port 4795

# 2. Start the isolated control plane + dashboard (two terminals)
bun run services/helldesk/local/src/main.ts --config .local/benchmark/m6c/live.config.json
$env:HELLDESK_CONTROL_CONFIG="$PWD\.local\benchmark\m6c\live.config.json"
$env:HELLDESK_PORT="8793"
$env:HELLDESK_DATA_ROOT="$PWD\.local\benchmark\m6c\local-live"
bun run services/helldesk/local-live/src/entry.ts

# 3. Register the workspace and create the mission
#    POST http://127.0.0.1:8793/api/v1/workspaces/register  { "path": "<workspace>" }
#    POST http://127.0.0.1:8793/api/v1/missions             (body from .local/benchmark/m6c/mission.request.json)

# 4. Export + audit
bun run benchmarks/m6/export-evidence.ts --db .local/benchmark/m6c/live-data/helldesk.db `
  --run-id m6c --workspace .local/benchmark/m6c/live-workspace --out benchmarks/m6/evidence/m6c
bun run benchmarks/m6/verify-bundle.ts benchmarks/m6/evidence/m6c
```

## Honest gaps

* The demo media is a real-browser page-capture, not native 4K/HDR/60 fps.
* `artifact_provenance` is a host command gate; it does not by itself prove the
  candidate tree is a git worktree (the browser gates run in a materialized copy).
* The Kilo mutation runner's exported model can keep working after its prompt
  resolves; the candidate-binding guard now catches the resulting drift, but the
  writer itself is not yet fenced at the process level.
* Run A's `INCONCLUSIVE` reviews show the adjudication packet did not include the
  implementation render + executed test summary. That packet gap remains a
  reviewer-quality issue separate from the certification fix.
