# HELLDESK M6 evidence — `m6e`

Generated 2026-11-24T15:17:40.142Z by `benchmarks/m6/export-evidence.ts` from `bundle.json`-recorded state.

## Mission

- **id:** `mis_442c6eed93f849f1b55b657a4b4b13ae`
- **state:** `CANCELLED`
- **objective:** M6 live multimodal run: fix the off-screen pricing-card CTA from the attached screenshot. The screenshot is .local/benchmark/m6e/broken-pricing-card.png. The visual golden and the functional CTA must pass. Do not weaken the gates.
- **engine matrix:** `{"mutation":{"engine":"kilo","providerID":"cyberluke","modelID":"deepseek-ai--deepseek-v41-flash-1017"},"review":{"engine":"kilo","providerID":"cyberluke","modelID":"deepseek-ai--deepseek-v41-flash-1017"},"adjudicate":{"engine":"kilo","providerID":"cyberluke","modelID":"deepseek-ai--deepseek-v41-flash-1017"}}`

## Revisions

### Revision 1 — `rev_0e95f589cf774cdf9d82a7687eadca92` — **EVIDENCE_CAPTURED**

- created: 2026-11-24T15:08:23.546Z
- gate candidates: `e1647c8a304f8bc43dc38c5e7ce15e2b88c10bc2`
  - `artifact_provenance`: **PASS** exit=0 234ms candidate=`e1647c8a304f8bc43dc38c5e7ce15e2b88c10bc2`
  - `functional_correctness`: **FAIL** exit=1 1800ms candidate=`e1647c8a304f8bc43dc38c5e7ce15e2b88c10bc2`
  - `regression_checks`: **FAIL** exit=1 2696ms candidate=`e1647c8a304f8bc43dc38c5e7ce15e2b88c10bc2`
- review job `job_efeedab270ba4846b2b24bec`: **ADJUDICATING** / -

## Certification claim

- **certified:** false
- **valid:** false
- **reason:** mission state is CANCELLED, not VERIFIED_10_10

## Audit

Every file under `artifacts/` is listed in `bundle.json` with its sha256 and byte length. Verify with:

```
bun run benchmarks/m6/verify-bundle.ts benchmarks/m6/evidence/m6e
```

The verifier recomputes every hash and re-evaluates the certification claim from the recorded hashes. It exits non-zero if any byte is missing/altered **or** if a VERIFIED_10_10 mission is not bound to the gate candidate.
