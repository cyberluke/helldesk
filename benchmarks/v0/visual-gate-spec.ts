import type { BrowserGateSpec } from '../../services/helldesk/local/src/browser-gate';

/**
 * The M2/M3 visual acceptance gate. Hosted here (not inside the candidate
 * fixture) so the candidate cannot change its own gate definition.
 *
 * The gate builds the candidate and serves the production preview, then
 * BrowserOS Neo drives it: the visual screenshot is a stage crop compared to
 * the protected golden, and the functional checks are the CTA viewport and
 * click-to-confirm behavior.
 */
export const VISUAL_BROWSER_GATE: BrowserGateSpec = {
  url: 'http://127.0.0.1:{port}/',
  server: {
    command: 'bun run build && bun run preview -- --host 127.0.0.1 --port {port} --strictPort',
    url: 'http://127.0.0.1:{port}/',
    timeoutMs: 120_000,
  },
  viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  stageSelector: '[data-testid=stage]',
  checks: [
    { type: 'selectorInViewport', selector: '[data-testid=cta]' },
    { type: 'clickText', selector: '[data-testid=cta]', expectSelector: '[data-testid=toast]', expectText: 'Plan selected' },
  ],
  screenshot: { golden: 'tests/golden/pricing-card.png', maxDiffRatio: 0.002 },
  timeoutMs: 180_000,
};
