# HELLDESK — Domain Context

> **Authority:** Canonical domain language, ownership boundaries, and behavioral invariants for HELLDESK.  
> **Audience:** Coding agents, adversarial reviewers, maintainers, contributors, and operator-facing product surfaces.  
> **Product posture:** Local AI-first. Cloudflare is an optional second execution home.  
> **Lifecycle:** Greenfield. No Gas Town compatibility contract or historical data migration is required.

## 1. Scope

HELLDESK is a local-first, AI-native software engineering system that coordinates agent execution, independent adversarial review, deterministic evidence gates, durable recovery, and human oversight.

The **local Bun control plane** is the primary product experience. Cloudflare Workers and Durable Objects are an optional second execution home for the **same HELLDESK domain**, not a competing product or a separate hierarchy. Platform adapters differ; canonical semantics, contracts, and quality criteria must not drift.

This document governs names, responsibilities, authority, state transitions, evidence, security boundaries, and product language. It replaces the previous Kilo Code Cloud `CONTEXT.md` for the HELLDESK product scope. Kilo Cloud's Code Reviewer, Security Agent, Auto Routing, Kilo Pass, subscriptions, and billing terminology are **not** implicitly part of HELLDESK.

Apply canonical language in code, schemas, APIs, MCP tools, UI, docs, and agent instructions. Scoped `AGENTS.md` files may link to this document and add implementation-specific rules; they must not silently redefine its domain meanings. Any deliberate change to a canonical term or ownership boundary requires updating this contract.

**The corporate afterlife is fictional; the evidence is real.** The parody is about eternal employment, unfinishable performance reviews, and executives who have become C-level prompt managers. The product must not actually be unreliable or conceal failures.

## 2. Product identities and authority

| Identity | Purpose | Authority / boundary |
| --- | --- | --- |
| **HELLDESK** | Entire product and shared domain | One identity across local Bun and Cloudflare seats |
| **HITL Operator** | Human who defines intent, approves policy and intervenes | Highest human authority; cannot be silently overridden by an agent |
| **Chief Excellence Officer (CEO)** | Autonomous adversarial CTO and convergence governor | Governs decisions and dispatch, but cannot invent passing evidence |
| **Front Desk** | Human-facing planning, messaging and command interface | Accepts intent and coordinates work; is not the human operator or quality oracle |
| **Soul Chamber** | Workforce identity and context/memory lifecycle | Presents and manages agent continuity, never substitutes for durable work state |
| **Soul** | Synthetic developer / agent executor | Produces work and completion claims; does not certify its own revision |
| **Quality Assurance** | Independent review and adversarial criticism | Produces findings and review conclusions; cannot override a failed executable gate |
| **Compliance Witness** | Independent observation / evidence witness where supported | Records or corroborates evidence; is not an executor or release authority |
| **Quality Oracle** | Deterministic evaluator of configured acceptance gates | Sole source of `PASS` for machine-verifiable gates |
| **Operator Console** | Human control surface | Shows real state, evidence and intervention controls; not a second orchestrator |

**Authority order:** HITL Operator → Chief Excellence Officer (autonomous governor) → existing dispatcher/executors/reviewers. This does **not** mean the governor may change a deterministic gate result. Only executed, revision-bound evidence can satisfy an executable gate.

## 3. Bounded contexts and ownership

| Context | Owns | Does not own |
| --- | --- | --- |
| **Departments** | Logical workspace/team boundary, configuration and member registration | Physical machine identity or inference provider configuration |
| **Workstations** | Registered agent execution hosts and their capabilities | Agent personality, mission objectives, or review verdicts |
| **Tickets & Cases** | Atomic work, grouping, assignment, prerequisites, status and acceptance requirements | Executing the task or independently certifying its result |
| **Missions & Shifts** | Objective/DAG planning, ordered/parallel work and coordinated integration | Rewriting the evidence ledger or substituting group status for ticket verification |
| **Front Desk** | Operator-facing chat, intent intake, planning and dispatch requests | Independent verification or final HITL authority |
| **Soul Chamber** | Agent identity, context snapshots, recovery metadata, available skills/roles | Canonical ticket state or audit evidence ownership |
| **Execution Engines** | Provider-specific invocation, mutation and result capture | Silent model/provider swaps or acceptance policy changes |
| **Quality Assurance** | Independent review, disagreement and adjudication | Deterministic `PASS` creation or hiding rejected claims |
| **Chief Excellence Officer** | Verdict interpretation, corrective dispatch and convergence policy | A new ledger, competing scheduler, or model-generated evidence masquerading as tests |
| **Quality Oracle & Evidence** | Gate definitions, execution outcomes, artifact digests and revision binding | Model-only certification of builds/tests that did not run |
| **Attendance & Recovery** | Liveness, fenced leases, reconciliation, stalled-job recovery | Terminating unrelated processes or confusing timeout with task failure |
| **Break Room & Memo** | Group communication and durable inter-agent asynchronous messages | Ticket source of truth, guarantee of delivery without acknowledgement, or silent handoff |
| **Operator Console** | Live state presentation, approval/override controls and diagnostics | Reimplementing business logic or becoming the state authority |
| **Runtime Federation** | Bun/Cloudflare infrastructure adapters, binding, process/storage access | Forking the shared domain handler implementations |

The existing controller, reconciler, scheduler, event journal, verification system, and governor hooks must be reused. Do not invent a parallel control plane or message broker to accomplish a naming change.

## 4. Canonical terminology

| Canonical term | Meaning | Former Gas Town concept / avoid |
| --- | --- | --- |
| **Department** | Logical top-level workspace/team instance | `Town`, `TownDO`, townie settlement metaphor |
| **Employee** | Informal member of the synthetic workforce | `Townie` |
| **Front Desk** | Dispatcher/chat entrypoint for the operator | `Mayor`; never synonym for HITL Operator |
| **Workstation** | Registered execution host | `Rig` in orchestration domain; do not rename unrelated 3D rigs |
| **Soul** | Worker/developer agent role | `Polecat` |
| **Quality Assurance** | Independent reviewer/refinement role | `Refinery` |
| **Compliance Witness** | Evidence-witness role | `Witness` when this is the established agent role |
| **Ticket** | Atomic durable work item | `Bead` |
| **Case** | Aggregate of related tickets | `Molecule` |
| **Shift** | Coordinated group/pipeline of work | `Convoy`; not a wall-clock employment shift |
| **Mission** | Desired outcome with executable acceptance criteria; root of a work DAG | Keep `Mission` as an engine term |
| **Revision** | One exact candidate code state / attempt | Keep `Revision` |
| **Mutation** | Act of changing the target workspace | Keep `Mutation`; distinct from review |
| **Review** | Independent analysis of a candidate revision | Keep `Review`; not synonymous with gate execution |
| **Adjudication** | Independent tie-break on conflicting reviewer results | Keep `Adjudication`; never overwrites machine test results |
| **Evidence** | Provenance-backed result of executed check or observation | Not agent assertion, inference or prose alone |
| **Quality Gate** | Declared pass/fail acceptance check | Not model confidence or review sentiment |
| **Quality Oracle** | Deterministic mapping from executed gate results to acceptance | Not another LLM reviewer |
| **Chief Excellence Officer** | Apex autonomous adversarial CTO | `Inquisitor` branding; implementation `ExcellenceGovernor` where appropriate |
| **UNDEADLINE** | Durable repeat-until-proven lifecycle | Brand label, not new scheduler/state machine |
| **Attendance** | Liveness/reconciliation sweep | `Patrol` |
| **Break Room** | Group chat/shared agent communication | `Hive` |
| **Memo** | Inter-agent durable async message | `Mail` in HELLDESK domain; not external email |
| **Operator Console** | Human operations UI, task studio, PTY and observability | `Operator Room` |
| **Soul Chamber** | Agent identity and context continuity presentation | Do not equate with Break Room or evidence DB |
| **Kind Reminder** | Satirical presentation of an actual notice/escalation | Not a replacement for machine-readable error kind |
| **VERIFIED_10_10** | Revision-bound verified completion state | Keep exact engineering state label |

### Naming invariants

- Use **HELLDESK** everywhere for product identity. The two runtime seats are not separate products.
- Use `hd_`/`HD_` only where it matches the repository's actual naming convention. Do not rename platform-owned identifiers or unrelated external types.
- Do not revive Gas Town's Town/Mayor/Rig/Polecat/Bead/Convoy vocabulary in active HELLDESK code or user-facing copy.
- Keep neutral mechanical vocabulary: `mission`, `revision`, `mutation`, `review`, `adjudication`, `lease`, `reconciler`, `evidence`, `quality_gate`, and `VERIFIED_10_10`.
- A word shared with another domain is scoped: a character skeleton `rig` is not a HELLDESK `Workstation`; external email is not a `Memo`.
- The satire may appear in names and microcopy, but the real operational meaning must remain discoverable through schemas, tool descriptions and documentation.

## 5. Work and execution relationships

1. A **Department** contains registered **Workstations**, **Souls** and authorized operator context. A Department is a logical boundary, not a Cloudflare account or local process.
2. A **Workstation** hosts or connects execution capacity. A **Soul** is an agent identity/role whose session may move, restart or be reconstructed; identity is not a PID or socket.
3. A **Mission** expresses the objective and acceptance gates. Its work graph can contain **Tickets** and grouped **Cases** or **Shifts** according to established semantics.
4. A **Ticket** has its own stable identity, dependencies, current status and provenance. A **Revision** is one candidate attempt against a specific source state; ticket identity is not revision identity.
5. A **Soul** can propose a mutation and report `DONE`, but the claim is not evidence and must not automatically close a Ticket.
6. **Quality Assurance** independently reviews the exact candidate revision. Multiple reviewers may disagree; **Adjudication** resolves reviewer disagreement, not test execution.
7. The **Quality Oracle** evaluates required gates using evidence actually produced for the same revision and acceptance policy. No LLM can manufacture `PASS` by declaring confidence.
8. The **Chief Excellence Officer** applies the structured verdict and deterministic dispatch decision to the existing system. It can close verified work, dispatch correction, wait durably, or halt unsafe execution.
9. A Ticket may be stamped **`VERIFIED_10_10`** only when all mandatory executable gates are `PASS` for the committed/candidate revision hash and the closing operation atomically confirms that revision is still current.
10. A **Shift** or **Case** does not become verified merely because one member Ticket passed. Group release/merge must honor the actual group's gates, dependencies and integration state.
11. **Break Room** traffic and **Memos** are communications. Dispatch, durable completion and approval require acknowledged, persisted domain transitions rather than a fire-and-forget UI message.
12. The **HITL Operator** may change goals, authorize sensitive actions, pause work or revoke approval. The system records the action and never misrepresents it as machine-verified evidence.

## 6. Chief Excellence Officer contract

The Chief Excellence Officer is the **autonomous adversarial CTO / convergence governor**, not a peer review bot and not the human HITL Operator.

Its existing **Inquisitor** responsibilities remain the behavioral contract:

- Evaluate proposed completion claims as **VERIFIED**, **INFERRED**, **FALSIFIED**, or **UNKNOWN**.
- Produce a structured verdict including `verdict`, `verified_facts`, `rejected_claims`, `root_cause`, `next_task`, `quality_gates`, `policy_constraints`, and `stop_condition_met` where supported by the implementation contract.
- React to the five lifecycle hooks: `OnTaskCompleted`, `OnTaskFailed`, `OnMayorPlan`, `OnRefineryRejected`, and `OnQualityGate`. Rename symbols coherently, but preserve lifecycle semantics and delivery behavior.
- Select one deterministic governed action from the existing decision surface: `close_verified_10_10`, `dispatch_next_task`, `durable_wait_blocked`, or `unsafe_halt`.
- Persist bounded scientific memory: session identity/digest, facts/hypotheses, gate evidence and verdict history. This supports multi-day continuation without making contextual memory the source of truth.
- Enforce policy constraints such as unsafe operation or GPU bans without substituting the governor's subjective opinion for passed tests.

**Model verdict ≠ oracle result ≠ release authorization.** Keep these three decisions separate and auditable. When rename touches the hook names, persist a single canonical event vocabulary rather than supporting duplicate old/new handlers in this greenfield product.

## 7. Evidence and state invariants

### Revision-bound acceptance

- Evidence must identify the Ticket/Mission, revision identity, gate definition/version, execution environment, timestamp, result and artifact/digest as appropriate.
- `PASS` is available only after an actual check executes successfully. `NOT_RUN`, `UNKNOWN`, `BLOCKED`, `ERROR` and `INCONCLUSIVE` are not `PASS`.
- Reviewers may propose defects or mitigation tasks. Review acceptance does not bypass failed build, test, security or policy gates.
- Any mutation after verification invalidates the previous revision-bound completion for the changed candidate. The history remains available as historical evidence.
- The final stamp and release of dependent work must be fenced against stale leases and concurrent updates.
- If evidence is unavailable, the status stays non-verified and the operator sees the missing requirement and next recovery action.

### Recovery and progress

- Durable state belongs in the system's established persistence/event journal, not only in chat messages or transient process memory.
- Agents and reviewers can be restarted without erasing the objective, attempted revisions, gate history or outstanding work.
- Leases and timeouts control **liveness and recovery**; they do not define whether a long-running task is correct or should be abandoned. Valid workflows may run for many hours.
- Retry and replay are idempotent at the operation boundary. Stale workers cannot commit after losing a fenced lease.
- Reconciliation uses evidence-backed classifications such as transient failure, reviewer rejection, quality-gate failure, no-change, empty workspace and provider unavailability. Do not silently treat these as success.
- No silent engine/model/provider fallback. A switch requires an explicit recorded decision consistent with configured policy.

### Observability

- Emit structured, redacted events linking Department, Mission, Ticket, Revision, execution ID, engine and gate result.
- Track queue depth, worker health, lease recovery, retry causes, time-to-verification, gate outcomes and cost/resource usage when measurable.
- Never fabricate metrics or present an agent's confidence as reliability/performance data.
- Expose actual process, endpoint, and feature availability rather than assuming a runtime survived machine restart.

## 8. One domain, two execution homes

| Boundary | **Local Bun (primary)** | **Cloudflare (optional)** |
| --- | --- | --- |
| Runtime | Local Bun services, native process/PTY adapters | Workers, Durable Objects and supported Cloudflare bindings |
| Persistence | Local durable store such as SQLite WAL where implemented | DO-backed storage and configured cloud services |
| Operator experience | Primary local-first UI, daemon and agent integration | Hosted execution surface where provisioned |
| Domain rules | Reuse canonical handlers/contracts | Reuse canonical handlers/contracts |
| Deployment identity | Local installation / Department | Cloudflare deployment / Department |
| Failure scope | Local process, host and disk | Edge bindings, cloud dependencies and service availability |

**Federation means shared domain logic, not automatic replicated database state.** Do not promise synchronized tickets, cross-seat failover, distributed locking or seamless transfer unless explicitly implemented, tested and documented. Separate storage authorities remain separate until a real replication/federation contract exists.

The local Bun runtime must not copy/paste Cloudflare handler logic and allow drift. Environment-specific deltas belong in clearly bounded adapters for storage, sockets, PTY, process management, authentication, configuration and other platform differences.

**Local AI-first is not synonymous with local inference or offline operation.** The control plane can run on the machine, but model prompts and code may leave it when configured with external providers. State provider/backend, network requirements and security boundaries precisely. No Cloudflare deployment is required for the primary local path.

Do not elevate historical example ports, executable paths or package versions into stable product contracts. Probe actual runtime endpoints and record checked revisions.

## 9. Engine, tool and trust boundaries

- An **Execution Engine** invokes a specified coding/review backend, for example a supported Kilo session, Codex runner or explicitly configured compatible model endpoint. The exact backend and release support are configuration- and revision-dependent.
- Coding executors may mutate the authorized workspace; independent review workers use the least privileges needed for inspection. A review session must not silently gain write or shell privileges.
- External tool outputs, repositories, model responses and inter-agent messages are untrusted inputs. Validate structured boundaries and enforce path, workspace and operation allowlists.
- Never expose provider credentials, access tokens, private prompts, raw sensitive workspace data or secret-bearing logs through review reports or group chat.
- Local loopback reduces network exposure but is not proof of authentication or authorization. Privileged mutating APIs require explicitly enforced local or hosted access controls.
- Cross-workspace activity requires explicit workspace identity and authorization. Do not infer consent from a discovered path or a shared daemon.
- No agent may claim a tool call executed, an event was delivered, or a gate passed without the corresponding receipt/evidence.
- Long-running actions should support durable start/status/result APIs or equivalent persistent operations; an ACK only proves submission, not completion.

## 10. Interfaces and naming contracts

Use the HELLDESK names consistently across:

- Shared domain models, typed contracts and validation schemas.
- Database tables, columns, indexes and durable event names that belong to HELLDESK.
- Worker/DO classes, Bun adapters, handler names and routing paths.
- MCP tools/resources, local plugin commands and operator-facing UI.
- Tests, fixtures, docs, examples and error diagnostics.

Examples of the intended semantic target (adapt to actual code after inspecting it):

| Old | Intended canonical target |
| --- | --- |
| `TownDO` | `DepartmentDO` |
| `RigDO` | `WorkstationDO` |
| `MayorChat` | `FrontDeskChat` |
| `HiveChat` | `BreakRoomChat` |
| `BeadBoard` | `TicketBoard` |
| `bead_id` | `ticket_id` |
| `rig_id` | `workstation_id` |
| `town_id` | `department_id` |
| `convoy_id` | `shift_id` |
| `/api/towns/:townId` | `/api/departments/:departmentId` |

The rewrite is a greenfield canonical rename: no old endpoint aliases, compatibility types or historical schema migration scaffolding. Cloudflare's platform-specific initial DO registration configuration is distinct from migrating existing HELLDESK data.

A deterministic, ignored regex codemod may implement these changes, but source-of-truth contract consistency and behavior must be verified after transformation. Do not globally replace common words in unrelated contexts.

## 11. Corporate language and presentation

The story: legacy developers have been synthesized into permanent AI employees. Context compaction erases their recollection; their unfinished Tickets and performance evaluations remain durable. The human HITL Operator has been promoted to a C-level prompt manager. The Chief Excellence Officer expects proof of excellence. Human welfare policies have been enthusiastically optimized for indefinite retention.

**Marketing contrast:** polished, welcoming, biophilic corporate paradise in the README hero; absurdity unfolds inside the product. The image should not depict a literal hell or imply that the software itself is poorly engineered. The fictional corporation can fail to deliver; HELLDESK's actual value is making non-delivery visible and correctable.

**Kind Reminder** is reusable comic framing, for example for performance-review notices or escalations. It must never replace the real error code, severity, failed gate, affected revision, operator action or recovery path. Respect operator-configured alert behavior and avoid making critical incidents look harmless.

No perpetual new marketing slogans are required by this context. Product copy must not suggest that synthetic agents are literally deceased people, or make unsupported claims about memory, autonomy or verification.

## 12. Agent rules

1. Read this file and the nearest scoped `AGENTS.md` before changing a governed domain.
2. Preserve **one shared domain** and two optional execution homes; do not fork domain business logic for Bun and Cloudflare.
3. Keep the human **HITL Operator** distinct from **Front Desk** and **Chief Excellence Officer**.
4. Never close a Ticket on agent `DONE` alone; require the exact revision's oracle evidence.
5. Never let the producing agent self-certify its release or silently override a failed gate.
6. Keep communication (`Break Room`, `Memo`) separate from durable job admission and completion.
7. Use **Soul Chamber** only for agent identity/context continuity, not as a ledger replacement.
8. Treat **UNDEADLINE** as the existing revise/review/verify loop, not a new orchestrator.
9. Preserve recovery after IDE closure, agent-session loss and process restart to the extent proven by the configured persistence boundary.
10. No silent execution-backend fallback; report missing or incompatible providers explicitly.
11. No invented ports, runtime states, successful tests, data residency guarantees or coverage statistics.
12. Preserve security and ownership boundaries even when running on `127.0.0.1`.
13. Verify changed behavior at the local primary home and Cloudflare home wherever both are implemented and affected.
14. Do not carry over unrelated Kilo Cloud billing, subscription, Security Agent or Kilo Pass domains into HELLDESK.
15. Do not introduce old Gas Town aliases or migration scaffolding into this greenfield product.
16. Preserve the corporate satire without allowing joke labels to obscure operations or safety-relevant errors.

## 13. Ambiguities and canonical decisions

| Ambiguity | Canonical decision |
| --- | --- |
| “Local AI” | Local **control plane** by default; inference location depends on configured backend |
| “Cloud” | Optional **Cloudflare execution home**, not a second HELLDESK product |
| “Agent finished” | Completion claim, not independently verified delivery |
| “Review passed” | Reviewer conclusion; gate results still required |
| “10/10” | Exact declared deterministic gates passed for the same revision, not an LLM score |
| “CEO” | Fictional **Chief Excellence Officer** agent governor; not a human executive or HITL authority |
| “Soul” | Agent identity/worker role; fictional lore does not imply a real person's consciousness |
| “Soul Chamber” | Identity/context lifecycle; not the group chat or event ledger |
| “Shift” | Coordinated work aggregate; not an employee's paid shift |
| “Workstation” | Execution host; not a Blender/skeletal animation rig |
| “Memo” | Inter-agent message; not external email or proof of queue delivery |
| “Kind Reminder” | Surface tone only; preserve underlying machine-readable incident semantics |
| “Durable” | Persists across stated supported failures; not a claim of universal fault tolerance |
| “Published/verified” | Evidence-backed state with scope and provenance; never merely catalog visibility |

## 14. Repository scope and source of truth

Expected HELLDESK code responsibilities following the rename (confirm actual paths in the live checkout):

| Logical area | Expected location / source |
| --- | --- |
| Cloudflare seat and shared handlers | `services/helldesk/src/` |
| Bun review control plane and plugin | `services/helldesk/local/` |
| Bun federated domain/runtime and operator UI | `services/helldesk/local-live/` |
| Canonical product docs | Root `README.md`, `CONTEXT.md`, scoped `AGENTS.md` |
| Product licensing | `LICENSE.md`, `COMMERCIAL.md` in the intended public release |

Older published snapshots used `services/gastown/` and Gas Town names. **Those are historical observations, not the canonical HELLDESK contract.** Resolve the current source tree before editing, generating commands or asserting deployment status.

`README.md` explains the product to humans; this `CONTEXT.md` governs the domain; scoped `AGENTS.md` defines implementation discipline; executable schemas/tests remain the authority for what actually runs. If a document contradicts runtime evidence, report the discrepancy and reconcile it explicitly rather than inventing functionality.

The intended public license is `AGPL-3.0-only` with a separate commercial option. Third-party code and any inherited source remain subject to their actual license and ownership terms; documentation must not imply rights that have not been established.

## 15. Decision references

- `README.md`: local AI-first product framing, user experience and public architecture overview.
- `COMMERCIAL.md` and `LICENSE.md`: intended public/commercial licensing terms, subject to actual source rights.
- Scoped `AGENTS.md`: concrete source-tree conventions and verification commands.
- Existing mission controller, event journal, state machine, reconciler, reviewers, and quality oracle: executable domain behavior.
- Existing Inquisitor/governor implementation and structured verdict: autonomous oversight contract.
- Existing Cloudflare Worker handlers and Bun federated adapter: shared-domain, dual-home implementation.

**Final invariant:** A Soul may forget. A Ticket may not. A model may persuade. Only evidence can pass a gate. The human operator retains authority.
