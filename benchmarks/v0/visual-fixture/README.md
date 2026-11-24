# HELLDESK visual fixture

A deterministic Vite/React pricing card with a seeded CTA layout defect.

- `src/styles.css` pushes `.pricing-card__cta` outside the card and viewport.
- The CTA must return to normal flow and clicking it must show the
  "Plan selected" confirmation.
- `tests/golden/pricing-card.png` is the protected stage golden.

## Acceptance path

There is **no Playwright**. The gate is `benchmarks/v0/visual-gate-spec.ts` and
runs through **BrowserOS Neo**:

1. `bun run build && bun run preview` serves the production build.
2. BrowserOS Neo opens the app, waits for `[data-testid=stage]`, and captures a
   screenshot through the granular MCP `screenshot` tool.
3. The host crops the fixed 460x460 stage by the screenshot's actual pixel
   scale and compares it to the golden with pixelmatch.
4. Functional checks run in the same page through MCP `evaluate`:
   `selectorInViewport` on the CTA and `clickText` on the CTA → confirmation.

The gate evidence (actual, full, diff, ratio, result.json) is written outside
the candidate workspace by the host gate runner.

## Regenerate the golden

Only when the visual contract changes:

```powershell
bun run benchmarks/v0/visual-fixture/scripts/capture-golden.ts
```

The script copies the fixture to a throwaway workspace, applies the known-correct
CTA rule, builds/serves it, captures through BrowserOS Neo, and writes the
460-class stage golden. The golden is protected by the mission baseline; a
mutator cannot change it.
