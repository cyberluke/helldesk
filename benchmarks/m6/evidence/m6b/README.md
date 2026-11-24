# HELLDESK M6 evidence — `m6b`

Generated 2026-11-24T09:55:32.921Z by `benchmarks/m6/export-evidence.ts` from `bundle.json`-recorded state.

## Mission

- **id:** `mis_d8774ff2f7154c42965e073eebf8adb8`
- **state:** `CANCELLED`
- **objective:** M6 live multimodal run: fix the off-screen pricing-card CTA from the attached screenshot. The screenshot is .local/benchmark/m6b/broken-pricing-card.png. The visual golden and the functional CTA must pass. Do not weaken the gates.
- **engine matrix:** `{"mutation":{"engine":"kilo"},"review":{"engine":"kilo"},"adjudicate":{"engine":"kilo"}}`

## Revisions

### Revision 1 — `rev_9679932bd02e451c96e842621302ba65` — **MUTATING**

- created: 2026-11-24T09:26:23.335Z
- gate candidates: `e1647c8a304f8bc43dc38c5e7ce15e2b88c10bc2`
  - `artifact_provenance`: **PASS** exit=0 56ms candidate=`e1647c8a304f8bc43dc38c5e7ce15e2b88c10bc2`
  - `functional_correctness`: **PASS** exit=0 61430ms candidate=`e1647c8a304f8bc43dc38c5e7ce15e2b88c10bc2`
  - `regression_checks`: **PASS** exit=0 123996ms candidate=`e1647c8a304f8bc43dc38c5e7ce15e2b88c10bc2`
- review job `job_b52b3f8fba0741a596eb406e`: **INCONCLUSIVE** / INCONCLUSIVE
- snapshot `snap_git_9c39333774001c57ffaa5be4` (git-dirty) base=`ffee9570589902718fd7faa506534fdaa8724ed6` head=`7731c706d6cf87b3ca42722fc58b51b729d71413`

### Revision 2 — `rev_10162876cfe54c0189448a9ddc243b96` — **PLANNED**

- created: 2026-11-24T09:52:18.983Z
- gate candidates: (none)

## Certification claim

- **certified:** false
- **valid:** false
- **reason:** mission state is CANCELLED, not VERIFIED_10_10

## Audit

Every file under `artifacts/` is listed in `bundle.json` with its sha256 and byte length. Verify with:

```
bun run benchmarks/m6/verify-bundle.ts benchmarks/m6/evidence/m6b
```

The verifier recomputes every hash and re-evaluates the certification claim from the recorded hashes. It exits non-zero if any byte is missing/altered **or** if a VERIFIED_10_10 mission is not bound to the gate candidate.
