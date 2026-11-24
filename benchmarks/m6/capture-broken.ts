/**
 * Capture the seeded (broken) pricing-card stage through the production
 * BrowserOS path, at the SAME 1280x720 / DPR-1 geometry as the gate and the
 * golden. Output is the 460x460 stage, directly comparable to the golden.
 *
 * Prerequisites:
 *   - BrowserOS Neo running (MCP at 127.0.0.1:9210, or HELDESK_BROWSEROS_MCP_URL)
 *   - the broken fixture served, e.g.:
 *       cd benchmarks/v0/visual-fixture
 *       bun run dev -- --host 127.0.0.1 --port 5274 --strictPort
 *
 * Usage:
 *   bun run benchmarks/m6/capture-broken.ts
 *   bun run benchmarks/m6/capture-broken.ts --url http://127.0.0.1:5274/ \
 *     --out benchmarks/m6/media/broken-stage.png
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { BrowserosClient, resolveBrowserosMcpUrl } from '../../services/helldesk/local/src/browseros-client';
import { cropStageScreenshot } from '../../services/helldesk/local/src/browser-gate';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const url = arg('--url', 'http://127.0.0.1:5274/');
const out = resolve(arg('--out', 'benchmarks/m6/media/broken-stage.png'));
const stageSelector = arg('--stage', '[data-testid=stage]');

const client = new BrowserosClient({ url: resolveBrowserosMcpUrl(), clientName: 'helldesk-m6-broken' });
let pageId: number | null = null;
try {
  await client.connect();
  await client.nameSession('helldesk m6 broken');
  pageId = await client.newPage(url);
  // Focus-free: never maximizes or steals the operator's desktop.
  await client.focusForCapture(pageId);
  const ready = await client.waitForSelector(pageId, stageSelector, 15_000);
  if (!ready) throw new Error(`stage ${stageSelector} did not appear within 15s at ${url}`);

  const shot = await client.captureAndCheck({
    pageId,
    url,
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    stageSelector,
    checks: [],
  });
  if (!shot?.screenshot || !shot.stageRect) throw new Error('BrowserOS returned no screenshot/stageRect');

  const bytes = cropStageScreenshot(shot.screenshot, shot.stageRect, shot.viewport);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  console.log(`BROKEN_STAGE=${out}`);
  console.log(`BYTES=${bytes.length}`);
} finally {
  if (pageId !== null) await client.closePage(pageId).catch(() => undefined);
}
