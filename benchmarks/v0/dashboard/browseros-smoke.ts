/**
 * BrowserOS MCP client smoke test.
 *
 * Run from the repository root:
 *   bun run benchmarks/v0/dashboard/browseros-smoke.ts
 *
 * Creates a private gate page, verifies title/evaluate/screenshot through the
 * production client, writes a PNG under .local, and closes the page. It never
 * touches user tabs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserosClient, resolveBrowserosMcpUrl } from '../../../services/helldesk/local/src/browseros-client';

const url = resolveBrowserosMcpUrl();
const client = new BrowserosClient({ url, timeoutMs: 60_000, clientName: 'helldesk-browser-gate-smoke' });
console.log(`MCP ${url}`);
await client.connect();
console.log(`session ${client.session}`);
await client.nameSession('helldesk gate');

const pageId = await client.newPage('http://127.0.0.1:8792/helldesk/#/helldesk/default/transcript');
console.log(`page ${pageId}`);
try {
  const result = await client.run(`
const page = browser.page(${pageId});
await page.cdp('Emulation.setDeviceMetricsOverride', JSON.stringify({ width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }));
await page.goto('http://127.0.0.1:8792/helldesk/#/helldesk/default/transcript');
const ready = await page.waitForSelector('body', { timeout: 10000 });
const title = await page.evaluate('return document.title');
const shot = await page.cdp('Page.captureScreenshot', JSON.stringify({ format: 'png', fromSurface: true }));
return { pageId: page.id, ready: ready && ready.matched, title, screenshot: shot.data };
`);
  const value = result as { pageId?: number; ready?: boolean; title?: string; screenshot?: string };
  if (!value?.screenshot) throw new Error('no screenshot returned');
  const outDir = join(process.cwd(), '.local', 'benchmark', 'v0', 'dashboard', 'smoke');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, 'browseros-smoke.png');
  writeFileSync(out, Buffer.from(value.screenshot, 'base64'));
  console.log(`title ${value.title}`);
  console.log(`ready ${value.ready}`);
  console.log(`screenshot ${out} (${Buffer.from(value.screenshot, 'base64').length} bytes)`);
} finally {
  await client.closePage(pageId);
}
console.log('BROWSEROS SMOKE PASSED');
