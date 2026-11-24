# HELLDESK M6 evidence — `m6a`

Generated 2026-11-24T09:36:50.808Z by `benchmarks/m6/export-evidence.ts` from `bundle.json`-recorded state.

## Mission

- **id:** `mis_193cdad4834341dd84d032269baa57f3`
- **state:** `VERIFIED_10_10`
- **objective:** M6 live multimodal run: fix the off-screen pricing-card CTA from the attached screenshot. The screenshot is .local/benchmark/m6/broken-pricing-card.png. The visual golden and the functional CTA must pass. Do not weaken the gates.
- **engine matrix:** `{"mutation":{"engine":"kilo","providerID":"cyberluke","modelID":"deepseek-ai--deepseek-v41-flash-1017"},"review":{"engine":"kilo","providerID":"cyberluke","modelID":"deepseek-ai--deepseek-v41-flash-1017"},"adjudicate":{"engine":"kilo","providerID":"cyberluke","modelID":"deepseek-ai--deepseek-v41-flash-1017"}}`

## Revisions

### Revision 1 — `rev_338165ad478e4a46bc80c5a1c90286dc` — **REJECTED**

- created: 2026-11-24T07:15:50.385Z
- gate candidates: `ddc3550bfd2bc4c7e8f38aec092f1db81f6ed293`
  - `artifact_provenance`: **PASS** exit=0 462ms candidate=`ddc3550bfd2bc4c7e8f38aec092f1db81f6ed293`
  - `functional_correctness`: **FAIL** exit=1 66173ms candidate=`ddc3550bfd2bc4c7e8f38aec092f1db81f6ed293`
  - `regression_checks`: **PASS** exit=0 120472ms candidate=`ddc3550bfd2bc4c7e8f38aec092f1db81f6ed293`
- review job `job_6efa75a183a24ac9be5d524f`: **COMPLETED_FINDINGS** / FINDINGS
- snapshot `snap_git_08ae010fd0c53e1926ead950` (git-dirty) base=`2e8a4441b603e92cdd0a4104fbe570ff8e259903` head=`14c7e33207315061deea2b904f9aa2084959f980`

### Revision 2 — `rev_c41f7280031d468983ef842f16d3cbcf` — **VERIFIED_10_10**

- created: 2026-11-24T07:48:33.663Z, completed: 2026-11-24T08:38:46.801Z
- gate candidates: `6a4a0d0de84eb0e0cae0a7d9f09308b9e69507bd`
  - `artifact_provenance`: **PASS** exit=0 237ms candidate=`6a4a0d0de84eb0e0cae0a7d9f09308b9e69507bd`
  - `functional_correctness`: **PASS** exit=0 49718ms candidate=`6a4a0d0de84eb0e0cae0a7d9f09308b9e69507bd`
  - `regression_checks`: **PASS** exit=0 82983ms candidate=`6a4a0d0de84eb0e0cae0a7d9f09308b9e69507bd`
- review job `job_0036a12b3fc54922a48f1de6`: **INCONCLUSIVE** / INCONCLUSIVE
- snapshot `snap_git_b7eb58c2982d5ff0507e1847` (git-dirty) base=`14c7e33207315061deea2b904f9aa2084959f980` head=`a40f2f7cfc72b5b13fc9b6c7f784a90bc7202aa8`

## Certification claim

- **certified:** true
- **valid:** false
- **reason:** verified revision rev_c41f7280031d468983ef842f16d3cbcf gate candidate 6a4a0d0de84eb0e0cae0a7d9f09308b9e69507bd != the tree at verification (head 875082656254f4a36839cec6264d9744f14dc842 tree=e8bd9b96548e576ee5a3ac64ade11190a66002b1; head@export tree=aeb910069ea283629bc1a030c757ef16bc262dcf, worktree@export=43b4ad1e4bcbf210f0960e764f642b56996db767)

| revision | gate candidate | head at verification | tree at verification | tree@export | valid |
|---|---|---|---|---|---|
| `rev_c41f7280031d468983ef842f16d3cbcf` | `6a4a0d0de84eb0e0cae0a7d9f09308b9e69507bd` | `875082656254f4a36839cec6264d9744f14dc842` | `e8bd9b96548e576ee5a3ac64ade11190a66002b1` | `43b4ad1e4bcbf210f0960e764f642b56996db767` | false |

## Audit

Every file under `artifacts/` is listed in `bundle.json` with its sha256 and byte length. Verify with:

```
bun run benchmarks/m6/verify-bundle.ts benchmarks/m6/evidence/m6a
```

The verifier recomputes every hash and re-evaluates the certification claim from the recorded hashes. It exits non-zero if any byte is missing/altered **or** if a VERIFIED_10_10 mission is not bound to the gate candidate.
