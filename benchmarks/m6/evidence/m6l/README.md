# HELLDESK M6 evidence — `m6l`

Generated 2026-11-24T16:52:12.947Z by `benchmarks/m6/export-evidence.ts` from `bundle.json`-recorded state.

## Mission

- **id:** `mis_8432c46cb14641cb8cb93145b0dcef65`
- **state:** `VERIFIED_10_10`
- **objective:** M6 live multimodal run: fix the off-screen pricing-card CTA from the attached screenshot. The screenshot is ${HOME}\AppData\Local\HELLDESK\bench\m6l\broken-pricing-card.png. The visual golden and the functional CTA must pass. Do not weaken the gates.
- **engine matrix:** `{"mutation":{"engine":"kilo","providerID":"cyberluke","modelID":"deepseek-ai--deepseek-v41-flash-1017"},"review":{"engine":"kilo","providerID":"cyberluke","modelID":"deepseek-ai--deepseek-v41-flash-1017"},"adjudicate":{"engine":"kilo","providerID":"cyberluke","modelID":"deepseek-ai--deepseek-v41-flash-1017"}}`

## Revisions

### Revision 1 — `rev_9533cc06b1244e6bb6c84864b41d5f7d` — **VERIFIED_10_10**

- created: 2026-11-24T16:43:08.630Z, completed: 2026-11-24T16:47:09.182Z
- gate candidates: `0a70b277985722eba695dad12f088acaa5f55317`
  - `artifact_provenance`: **PASS** exit=0 143ms candidate=`0a70b277985722eba695dad12f088acaa5f55317`
  - `functional_correctness`: **PASS** exit=0 2968ms candidate=`0a70b277985722eba695dad12f088acaa5f55317`
  - `regression_checks`: **PASS** exit=0 2733ms candidate=`0a70b277985722eba695dad12f088acaa5f55317`
- review job `job_455e883953d04ec282226c02`: **COMPLETED_PASS** / PASS
- snapshot `snap_git_37800b8d5cfa3cd222e02067` (git-dirty) base=`4d7fddde2585b5fa9e72a6a3ea5e9d4f42cc3808` head=`189304b00e7556009e5581353f79ef315ca73787`

## Certification claim

- **certified:** true
- **valid:** true
- **reason:** ok

| revision | gate candidate | head at verification | tree at verification | tree@export | valid |
|---|---|---|---|---|---|
| `rev_9533cc06b1244e6bb6c84864b41d5f7d` | `0a70b277985722eba695dad12f088acaa5f55317` | `189304b00e7556009e5581353f79ef315ca73787` | `0a70b277985722eba695dad12f088acaa5f55317` | `0a70b277985722eba695dad12f088acaa5f55317` | true |

## Audit

Every file under `artifacts/` is listed in `bundle.json` with its sha256 and byte length. Verify with:

```
bun run benchmarks/m6/verify-bundle.ts benchmarks/m6/evidence/m6l
```

The verifier recomputes every hash and re-evaluates the certification claim from the recorded hashes. It exits non-zero if any byte is missing/altered **or** if a VERIFIED_10_10 mission is not bound to the gate candidate.
