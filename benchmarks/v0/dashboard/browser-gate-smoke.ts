/**
 * BrowserOS browser-gate smoke test (no Playwright).
 *
 * Usage:
 *   bun run benchmarks/v0/dashboard/browser-gate-smoke.ts [appUrl]
 *
 * Defaults to the fixed pricing-card workspace on :5274. Creates a private page,
 * sets a 1280x720 viewport, captures a CDP PNG, runs the in-viewport and
 * click-text checks, writes the PNG under .local, and closes the page.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserosClient, resolveBrowserosMcpUrl } from '../../../services/helldesk/local/src/browseros-client';

const appUrl = process.argv[2] ?? 'http://127.0.0.1:5274/';
const client = new BrowserosClient({ url: resolveBrowserosMcpUrl(), clientName: 'helldesk-browser-gate-smoke' });
await client.connect();
await client.nameSession('helldesk gate');
const pageId = await client.newPage(appUrl);
try {
  await client.bringToFront(pageId);
  const ready = await client.waitForSelector(pageId, '[data-testid=stage]', 15_000);
  if (!ready) throw new Error('stage did not appear within 15s');
  const result = await client.captureAndCheck({
    pageId,
    url: appUrl,
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    stageSelector: '[data-testid=stage]',
    checks: [
      { type: 'selectorInViewport', selector: '[data-testid=cta]' },
      { type: 'clickText', selector: '[data-testid=cta]', expectSelector: '[data-testid=toast]', expectText: 'Plan selected' },
    ],
  });
  const outDir = join(process.cwd(), '.local', 'benchmark', 'v0', 'dashboard', 'smoke');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, 'browser-gate-smoke.png');
  const bytes = Buffer.from(result.screenshot, 'base64');
  writeFileSync(out, bytes);
  console.log(`page ${result.pageId}`);
  console.log(`checks ${JSON.stringify(result.checks)}`);
  console.log(`screenshot ${out} (${bytes.length} bytes)`);
  const ok = result.checks.every((c) => c.ok);
  console.log(ok ? 'BROWSER GATE SMOKE PASSED' : 'BROWSER GATE SMOKE FAILED');
  if (!ok) process.exitCode = 1;
} finally {
  await client.closePage(pageId);
}
