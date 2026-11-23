# SOTA HITL + Long-Horizon Autonomous Coding — Proposal for the Local Tier

**Author:** Kilo agent (kilo-helldesk, local tier) · **Date:** 2026-11-16
**Scope:** the **local** tier of kilo-helldesk (`services/helldesk/local` engine +
`services/helldesk/local-live` Bun rehost + TicketBoard UI). **Not** Cloudflare
Workers, **not** the container/DO tier. Local daemon, SQLite, local models,
local headless Kilo / Codex CLI / OpenAI-compatible actuators.

This is a **proposal** — it changes no code. It studies the current local stack
against the 2025-2026 state of the art for *human-in-the-loop (HITL) operator*
systems and long-horizon autonomous coding, names the honest gap your prior
review already flagged, and proposes a delta (AAF) that turns the existing
autonomous verification core into a real operator tier without rebuilding what
works.

> **One-line verdict (unchanged from prior review, now grounded):**
> the **autonomous verification half is ahead of the OSS category** (independent
> adversarial reviewers + adjudicator, content-addressed evidence gates, fenced
> leases, monotonic scientific replan); the **human decision-authority half is
> behind it** — and that second half is the one this proposal builds.

---

## 0. What is actually in the local tier today (the honest baseline)

Read from the committed code, not a label:

- **`services/helldesk/local/src/state-machine.ts`** — job-state machine, every
  transition is one atomic CAS, invalid moves throw.
- **`services/helldesk/local/src/mission-controller.ts`** — `advanceMission`, the
  durable Ender/P0-B driver. The loop is **fully automated**:
  ```
  pick next ticket whose deps are VERIFIED_10_10
  → plan + create revision
  → dispatch mutation (per-workspace FENCED writer lease)
  → CHANGED → capture content-addressed evidence → immutable snapshot
  → independent ExcellenceGovernor review (adversarial A/B + adjudicator, bounded
    INCONCLUSIVE convergence)
  → gate PASS only with a REAL resolved evidence ref
  → VERIFIED_10_10  |  REJECT + deriveFailureSignature + real REPLAN
  ```
  There is **no human decision point** in `advanceMission`. The ExcellenceGovernor +
  Quality Oracle is the *only* authority for `VERIFIED_10_10`, and the controller
  explicitly forbids "a mutation worker self-verified."
- **`services/helldesk/local/src/mutation-runner.ts`** — the actuators
  (`KiloMutationRunner`, `CodexMutationRunner`, `OpenAiMutationRunner`) all apply
  changes **directly into `request.workspacePath`** and then the review runs
  automatically. There is no inline *approve-this-diff* step — the change is
  already in the working tree before any human sees a diff.
- **`services/helldesk/local/src/config.ts`** — `AutonomyConfigSchema`: a **single
  global** `enabled` switch + `mutationRunner` + `taskGates`. There is **no
  per-card autonomy tier** (suggest / edit / verify / autopush), no WIP limit,
  no human-merge authority.
- **`services/helldesk/local-live`** (Bun rehost of the Department DO + TicketBoard UI):
  - `core/handlers/excellenceGovernor.handler.ts` — `handleCreateSpecProject`,
    `handleGetExcellenceGovernor`, and `handleSetTicketControls`
    (`PUT /api/departments/:departmentId/tickets/:ticketId/controls` →
    `gt.project.set_ticket_controls`), which persists per-ticket
    `metadata.break_room_controls` **`{ excellenceGovernor, reviewer, agents, review_mode }`**.
  - `core/runtime/local-reconciler.ts` — `dispatch_agent` **gates on
    `break_room_controls.agents === false`** (the NAI agent dispatch junction).
  - The `review_mode: 'ReviewThenLand' | 'ReviewAndMerge'` field already exists
    in the handler's accepted body — **this is the seed of the human-merge
    authority** the review axis needs, and it is currently unused downstream as
    an actual merge gate.

So the **seed the prompt names is real and already wired**: `break_room_controls`
gate *per task* whether NAI agents run, whether the ExcellenceGovernor converges,
whether reviewers run. But it is a **toggle**, not a **autonomy-tier system** —
turning something on/off is not the same as deciding *how much* autonomy a card
has and *where the human must sign off*.

---

## 1. The 2025-2026 SOTA landscape (verified primary sources, 2026-11-16)

The popular OSS "agent kanban" tools — the category the UI currently resembles —
and what each actually ships on the **decision-authority** axes:

| Tool | Repo / star | What it actually is | Decision-authority / HITL primitives it ships |
|---|---|---|---|
| **Claw-Kanban** | `GreenSheep01201/Claw-Kanban`, 75★, Apache-2.0 | Node web server; routes tasks to Claude Code / Codex / Gemini / OpenCode / Copilot / Antigravity; role-based auto-assignment; real-time monitor | Per-task **review + swap** (send review back to the same agent); SQLite→RAG persistence; expansion views |
| **rvmp** | `burakgon/rvmp`, AGPL | Self-hosted browser orchestrator: real PTYs, board routing attention | **The reference for "real operator"**: file-by-file **diff review with viewed-marks + queued line comments sent back to the agent in one batch**; stale/conflict tracking when the base moves; **squash/merge/rebase**; PR tracking via `gh`; **explicit execution-policy tiers** (native sandbox / approval prompts / YOLO `--dangerously-skip-permissions`); **content-free agent state detection** |
| **openkanban** | `TechDufus/openkanban`, 155★, AGPL | TUI; each ticket = own git worktree; embedded terminals | Spawn any agent per ticket; column-based WIP by human movement |
| **OpenHands / SWE-agent / mini-swe-agent / CUAWright / Terminal-Bench** | 20.8k★ / 9.7k★ / 6.1k★ | The long-horizon + deterministic-eval axis | Benchmark/eval harnesses and long-horizon CUA; emphasis on *verification as a first-class artifact*, which HELLDESK already matches and in some ways exceeds |
| **Codex CLI** | `openai/codex`, Apache-2.0 | OpenAI's local coding agent | **Approval model**: `--sandbox`, normal **approval prompts** per risky tool, `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` for YOLO. This is the *baseline* every HITL tool composes against |
| **HITL orchestration platforms** | `escapeboy/agent-fleet-o` (83★), `rayedbajwa/spaces`, `jaccoh/fubala` | Self-hosted mission control / agent assembly lines | **Human-in-the-loop approvals**, visual DAGs, and **human gates between stages** (research → specify → plan → tasks → implement → review → verify → deliver) |

### What "ahead" and "behind" concretely means

**Where kilo-helldesk local is genuinely *ahead* of Claw-Kanban / rvmp /
openkanban (the verification + durability axis):**

- **Independent adversarial reviewers + adjudicator.** rvmp's "review" is a
  human reviewing the agent's diff; Claw-Kanban's "review" is sending the agent
  back its own review. Neither has an *independent read-only ExcellenceGovernor A/B +
  adjudicator* that is a *separate boundary* from the writer. HELLDESK does.
- **Content-addressed evidence gates.** A gate PASSes only with a **resolved
  SHA-256 evidence artifact**, and a *mutation cannot self-verify*. No popular
  kanban tool has this anti-fabrication gate.
- **Fenced per-workspace writer leases** + **monotonic scientific replan** with
  real `failure_signature`, hypotheses, and falsified-claim memory. That is a
  state machine most of the category does not have.
- **Fail-closed convergence** — bounded INCONCLUSIVE re-review, then reject +
  replan, never a permanent stall. Every irreversible boundary is persisted
  *before* the next async dispatch, so a crash is resumable.

**Where kilo-helldesk local is *behind* (the human-decision-authority axis) — and
the four primitives the SOTA baseline has that the local tier lacks:**

1. **Inline approve-this-mutation-diff.** rvmp and Codex's approval model both
   stop at a change and show the human a *real diff* to approve before it
   proceeds. HELLDESK applies changes directly into the workspace and auto-runs
   the review — no approve-this-diff surface.
2. **Per-card autonomy tier** (`suggest` / `edit` / `verify` / `autopush`).
   rvmp's YOLO-vs-approvals and rayedbajwa's human gates are the pattern; the
   current HELLDESK engine has one global `autonomy.enabled`, not a per-card tier.
3. **WIP-limit / priority-weighting.** rvmp's queue→…→done *routes attention*
   with a worker limit; HELLDESK's scheduler takes the first runnable ticket, no
   WIP cap per human reviewer, no priority weight.
4. **Human-merge authority wired into the VERIFIED_10_10 gate.** rvmp merges
   (squash/rebase) under human control; `spaces`/`fubala` put human gates
   between stages. HELLDESK's `review_mode: 'ReviewThenLand' | 'ReviewAndMerge'`
   is the seed but is **not wired as an actual merge gate** in the engine.

---

## 2. Design principle: add the human decision authority ON TOP of the working
verification core, do not rebuild it (AAF delta)

The verification core is the crown jewel and must stay byte-for-byte where it
works. The HITL operator tier is a **gate and a surface** that sits in front of
two existing seams:

```
   ┌─────────────────────  LOCAL ENGINE (unchanged core)  ─────────────────────┐
   │                                                                            │
   │  advanceMission (mission-controller.ts)   mutation-runner.ts              │
   │   plan → [HITL: SUGGEST?] → mutate → [HITL: APPROVE_DIFF?]                │
   │   → evidence → ExcellenceGovernor → VERIFIED_10_10 → [HITL: MERGE?]               │
   │                                                                            │
   └───────────────────────┬───────────────────────────────┬──────────────────┘
                           │  engine events (+ new HITL events)  │ break_room_controls
   ┌───────────────────────▼───────────────────────────────▼──────────────────┐
   │  HITL OPERATOR TIER (new) — local-live TicketBoard + control API            │
   │   approve diff · assign autonomy tier · WIP/priority · human merge        │
   │   → writes per-ticket break_room_controls + a decision ledger, feeds back into    │
   │     the engine's gate evaluation.                                          │
   └────────────────────────────────────────────────────────────────────────────┘
```

The rule that keeps this *honest* and *safe* (preserves the verification
invariants):

> **A mutation cannot self-verify → unchanged. A human cannot self-decide on
> unverified work → the human merge gate only ever sees evidence-gated
> `VERIFIED_10_10` work, or a side-by-side of the diff against the gate
> findings.**

i.e. the two authorities are **orthogonal and both required**: the *ExcellenceGovernor*
is the only authority that a change *meets its gates*; the *human* is the only
authority that a change actually *lands in the world* (merge / push / release).
The current code gives the ExcellenceGovernor both. The proposal splits them.

---

## 3. The proposed HITL autonomy-tier system (the delta)

### 3.1. A per-card autonomy tier, persisted in `break_room_controls`

Extend `metadata.break_room_controls` (already the gate mechanism, already persisted by
`gt.project.set_ticket_controls`) with an explicit `autonomy` tier enum:

```
type AutonomyTier =
  | 'suggest'    // NAI plans + produces a diff; human must approve the DIFF before it touches the tree
  | 'edit'       // NAI edits + runs local verification; human must APPROVE before review is authoritative
  | 'verify'     // NAI edits + independent ExcellenceGovernor runs; human must approve the MERGE (review_mode=ReviewThenLand)
  | 'autopush'   // NAI edits + verifies + merges + pushes on its own (review_mode=ReviewAndMerge, fully autonomous)
```

- **`suggest`**: the mutation runner produces the diff **without applying it**
  (patch staged, not applied). This is the first new seam in `mutation-runner.ts`
  (see §4.1). Highest-value primitive — it is the difference between "watches"
  and "operates".
- **`edit`**: applies to the tree (today's behavior), but the human must approve
  the applied diff + the reviewer/test evidence before the *gate* is finalized.
- **`verify`**: today's loop, except the final `VERIFIED_10_10` does **not** land
  or close the ticket until a human `MERGE` decision (ReviewThenLand).
- **`autopush`**: the fully autonomous mode (ReviewAndMerge today's behavior) —
  but only reachable after the human has explicitly assigned that tier, never the
  implicit default for a card that was created by a human with unspecified
  intent.

Default for a newly imported human card: **`suggest`** (unless the operator
explicitly raises it). Default for a card the engine spawns internally
(auto-scoped): **`verify`**. Nothing defaults to `autopush`.

### 3.2. The decision ledger (where the authority lives)

A small new durable table — `hitl_decisions` — append-only, keyed by
`(mission_id, ticket_id, revision_id, decision_type)`. Every human decision is a
row with `{ actor, action, tier_at_time, evidence_refs, decided_at }`. It is the
single source of truth the engine's gate evaluation reads, and the UI renders.

This gives HELLDESK what rvmp/Codex provide and more: **every non-autonomous
step is a replayable, auditable human decision**, not a voice-in-the-room. It
also makes the anti-fabrication guarantee stronger: a `VERIFIED_10_10` that a
human approved for `verify`/`autopush` carries the human decision hash in the
event stream, so the *decision* is as immutable as the evidence.

---

## 4. Exact seams to change (each a small, named delta — nothing rebuilt)

### 4.1. `mutation-runner.ts` — a "stage, don't apply" capability for `suggest`

Add a `mode: 'apply' | 'stage'` field to `RepairResult` (default `apply`, so all
existing behavior is byte-identical). When a card is `suggest`, the runner writes
the change as a **staged patch** (e.g. `git diff > .helldesk/suggest-<rev>.patch`,
leave the tree clean) and returns `CHANGED` only after the human approves the
patch and the engine applies it. The controller then proceeds exactly as today
(evidence → ExcellenceGovernor). This is the smallest possible change that unlocks
"approve-this-diff" without a rewrite.

### 4.2. `mission-controller.ts` — insert a human gate at the two decision points

In `advanceMission`, after `result.outcome === 'CHANGED'` (and before/at the
gate-finalize step):

- If the card tier is **`suggest`**: the controller moves the revision to a new
  non-terminal state `AWAITING_APPROVAL_DIFF` instead of immediately running the
  ExcellenceGovernor. A later tick (or the API) applies the human-approved patch and
  resumes.
- If the card tier is **`verify`**: on `isRevisionVerified10(...) === true`, the
  revision state is set to `VERIFIED_10_10` but the **ticket does NOT close and the
  mission does NOT advance** until a human `hitl_decisions` row of type `merge`
  exists for that revision. Until then it is `AWAITING_HUMAN_MERGE`. This is the
  `review_mode: 'ReviewThenLand'` seed, made real.

Add the two states to `state-machine.ts`'s `RevisionState` and the mission-level
state machine (non-terminal, resumable — crash-safe exactly like the rest).

### 4.3. `config.ts` — per-card tier (not just global)

Extend `AutonomyConfigSchema` with an **optional** per-card default tier map and a
WIP budget:

```
autonomy: {
  defaultTier: 'suggest',          // per-card tier default (global fallback)
  tierByTicket: {[ticketId]: 'verify'}, // card override, cast via set_ticket_controls
  maxHumanMergeQueue: 3,           // WIP limit for cards awaiting human decision
  priorityWeightByTicket: {[ticketId]: 2} // optional priority weight
}
```

The scheduler (`scheduler.ts` / `local-reconciler.ts`) respects `maxHumanMergeQueue`
so the human is never buried under an unreadable wall of `AWAITING_*` cards, and
weights priority ordering over first-runnable-ticket.

### 4.4. `local-live` UI + control API — the operator surface

- **Control API** (`excellenceGovernor.handler.ts`, already the right handler): extend
  `handleSetTicketControls` to accept `tier` (`suggest`/`edit`/`verify`/`autopush`),
  and add three decision endpoints:
  - `POST /api/departments/:departmentId/tickets/:ticketId/decisions/approve-diff` (applies the
    staged `suggest` patch),
  - `POST /api/departments/:departmentId/tickets/:ticketId/decisions/approve-merge` (the
    `ReviewThenLand` human merge),
  - `POST /api/departments/:departmentId/tickets/:ticketId/decisions/reject` (human reject with a
    note → feeds the real REPLAN exactly like a review FINDINGS would).
  Each writes a `hitl_decisions` row and emits a mission event.
- **TicketBoard UI**: render the tier as a per-card control (you already have the
  toggles; add the tier selector), and — the actual "operator" upgrade — surface
  an **inline diff panel** on an `AWAITING_APPROVAL_DIFF` card with
  **approve / reject / comment**, using the same SSE/event stream the dashboard
  already consumes. The diff is cold in the tree until approved, so "approve this
  mutation diff inline" becomes real.

### 4.5. Event stream (`events.ts` / SSE)

Add the decision events to the existing canonical vocabulary:
`revision.awaiting_approval_diff`, `revision.awaiting_human_merge`,
`revision.human_approved_diff`, `revision.human_approved_merge`,
`revision.human_rejected`. They ride the **existing** SSE channel — no new
transport. This is exactly the "events that must be #16" pattern, extended.

---

## 5. Order of work (small, independently-landable, each verifiable)

Build in this order — each is a self-contained delta that keeps the existing
90/90 tests green and adds its own unit/integration coverage.

1. **M1 — `suggest` tier + staged-diff capability** (highest leverage: proves the
   "operator since it can *approve a diff*" story). New seam §4.1 + `AWAITING_APPROVAL_DIFF` + approve-diff API + inline diff panel.
2. **M2 — human-merge authority (`verify` tier)**. Wire `review_mode ==
   'ReviewThenLand'` as a real `AWAITING_HUMAN_MERGE` gate → `.approve-merge`.
   This completes the "human decision authority" axis with the seed already in
   the handler.
3. **M3 — decision ledger + `edit` tier** (dummy-actor-safe, auditable).
4. **M4 — WIP budget + priority weighting** over the scheduler.
5. **M5 — `autopush` tier as the explicit opt-in** (today's fully autonomous
   loop, but the operator explicitly assigned it).

Each milestone ends with: passage of the **existing** unit + integration suites
(40 + 50), a new unit test for the added state/decision, and — for the UI-facing
ones — an updated `P0_plan.md` `PHASE 26/28/29` entry so the next wake reads the
same door.

---

## 6. Honest risks / what this does NOT claim

- **`autopush` is still the autonomous loop.** The differential value is not a
  fancier agent; it is that a human can *choose* the tier and *see and approve*
  the diff/merge. The anti-fabrication guarantee (ExcellenceGovernor authority on gates)
  is preserved and, in `verify`, **strengthened** by adding a human to the
  `VERIFIED_10_10` landing decision.
- **The `suggest` staged-patch path re-runs the mutation's post-apply
  fingerprint.** The `RepairResult` contract already carries
  `workspaceFingerprintAfter`; staging shifts when that is computed. Small, but
  the controller's crash-recovery block (§3 in `advanceMission`) must treat an
  `AWAITING_APPROVAL_DIFF` revision as resumable-non-applied — a fresh unit test
  is required, not assumed.
- **This proposal does not deploy to Cloudflare Workers or touch the DO/container
  tier.** It is scoped to the local daemon + local-live TicketBoard, and it does not
  change provider routing, the reviewer/adjudicator models, or the evidence
  hashing. All AAF.

---

## 7. Bottom line

The local tier already owns the part the OSS category can't match: an
independent, evidence-gated, crash-safe autonomous verifier. The proposal adds
**exactly the four decision-authority primitives the SOTA baseline has and this
stack lacks** — inline approve-this-diff, per-card autonomy tier, WIP/priority
budget, and human-merge authority wired into the `VERIFIED_10_10` gate — as
small, ordered, independently-verifiable deltas that sit *on top of* the working
core. The seed is already in the tree (`break_room_controls.review_mode`); this turns
that toggle into the operator tier it was meant to be.

After this lands, the honest one-liner reverses: **the local tier is ahead of the
pack on both axes** — it holds the SOTA human-decision surface *and* the
anti-fabrication verification core the popular tools do not have.