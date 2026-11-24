# HELLDESK M6 evidence — `m6c`

Generated 2026-11-24T14:41:11.303Z by `benchmarks/m6/export-evidence.ts` from `bundle.json`-recorded state.

## Mission

- **id:** `mis_f32d708eaaa748c69221eedc599fde24`
- **state:** `CANCELLED`
- **objective:** M6 live multimodal run: fix the off-screen pricing-card CTA from the attached screenshot. The screenshot is .local/benchmark/m6c/broken-pricing-card.png. The visual golden and the functional CTA must pass. Do not weaken the gates.
- **engine matrix:** `{"mutation":{"engine":"kilo"},"review":{"engine":"kilo"},"adjudicate":{"engine":"kilo"}}`

## Revisions

### Revision 1 — `rev_0f8946edb2204eb5aceacc0a1a04d83c` — **REJECTED**

- created: 2026-11-24T09:56:33.958Z
- gate candidates: `db73d6a911bcce9adc5b39d78ffd123b139e47d6`
  - `artifact_provenance`: **PASS** exit=0 63ms candidate=`db73d6a911bcce9adc5b39d78ffd123b139e47d6`
  - `functional_correctness`: **FAIL** exit=1 61469ms candidate=`db73d6a911bcce9adc5b39d78ffd123b139e47d6`
  - `regression_checks`: **FAIL** exit=1 124440ms candidate=`db73d6a911bcce9adc5b39d78ffd123b139e47d6`
- review job `job_e6615b7f95ab4c489991f66f`: **COMPLETED_FINDINGS** / FINDINGS
- snapshot `snap_git_3a48b4d7c8766bab799a756e` (git-dirty) base=`-` head=`a222420e1f088e833431199aaed72913efe28ce0`

### Revision 2 — `rev_bdaae306c1144dc49865482984a1916b` — **REJECTED**

- created: 2026-11-24T12:23:21.701Z
- gate candidates: `47ba7769af4220a6602d28f5868278eaae6b14af`
  - `artifact_provenance`: **PASS** exit=0 59ms candidate=`47ba7769af4220a6602d28f5868278eaae6b14af`
  - `functional_correctness`: **PASS** exit=0 1499ms candidate=`47ba7769af4220a6602d28f5868278eaae6b14af`
  - `regression_checks`: **PASS** exit=0 1449ms candidate=`47ba7769af4220a6602d28f5868278eaae6b14af`
- review job `job_bffd22842b0c4aa7ac257b41`: **COMPLETED_FINDINGS** / FINDINGS
- snapshot `snap_git_be3c35eee713f46ce921ce2e` (git-dirty) base=`-` head=`a222420e1f088e833431199aaed72913efe28ce0`

### Revision 3 — `rev_262be2e935e14fe0a382b1ec837c8a3f` — **REJECTED**

- created: 2026-11-24T13:18:04.390Z
- gate candidates: `8bdcfe8dee04334008261a7f6a2c0ac6b5cb3896`
  - `artifact_provenance`: **PASS** exit=0 75ms candidate=`8bdcfe8dee04334008261a7f6a2c0ac6b5cb3896`
  - `functional_correctness`: **FAIL** exit=1 4271ms candidate=`8bdcfe8dee04334008261a7f6a2c0ac6b5cb3896`
  - `regression_checks`: **FAIL** exit=1 1507ms candidate=`8bdcfe8dee04334008261a7f6a2c0ac6b5cb3896`
- review job `job_16f61883f14245a2a8f73acf`: **COMPLETED_FINDINGS** / FINDINGS
- snapshot `snap_git_69305037d1dde3c5cdbcf335` (git-dirty) base=`a222420e1f088e833431199aaed72913efe28ce0` head=`1b30fe90e7920020e84fae01821af2bbc6124710`

### Revision 4 — `rev_ea329da5520f4882a4a372e1f7323122` — **MUTATING**

- created: 2026-11-24T14:17:07.168Z
- gate candidates: (none)

## Certification claim

- **certified:** false
- **valid:** false
- **reason:** mission state is CANCELLED, not VERIFIED_10_10

## Audit

Every file under `artifacts/` is listed in `bundle.json` with its sha256 and byte length. Verify with:

```
bun run benchmarks/m6/verify-bundle.ts benchmarks/m6/evidence/m6c
```

The verifier recomputes every hash and re-evaluates the certification claim from the recorded hashes. It exits non-zero if any byte is missing/altered **or** if a VERIFIED_10_10 mission is not bound to the gate candidate.
