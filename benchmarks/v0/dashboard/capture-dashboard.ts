/**
 * Capture the M4 dashboard pages through BrowserOS Neo.
 *
 * The BrowserOS OS window is the cockpit, not the page; capturing the screen
 * picks up whatever window is in front. Instead we capture the REAL dashboard
 * page through the granular MCP screenshot tool at each demo state, then
 * assemble the video from those page captures.
 *
 * Run from the repository root with the isolated demo dashboard on :8792:
 *   bun run benchmarks/v0/dashboard/capture-dashboard.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserosClient, resolveBrowserosMcpUrl } from '../../../services/helldesk/local/src/browseros-client';

const base = 'http://127.0.0.1:8792/helldesk/#/helldesk/default';
const outDir = join(process.cwd(), 'benchmarks', 'v0', 'dashboard', 'media');
mkdirSync(outDir, { recursive: true });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const client = new BrowserosClient({ url: resolveBrowserosMcpUrl(), clientName: 'helldesk-dashboard-capture' });
await client.connect();
await client.nameSession('helldesk dashboard');
const pageId = await client.newPage(base);
await client.bringToFront(pageId);
await client.waitForSelector(pageId, 'body', 15_000);
await sleep(1_500);

async function navigate(path: string): Promise<void> {
  await client.evaluate(pageId, `location.hash = '#/helldesk/default/${path}'; return true;`);
  await sleep(2_000);
}

async function capture(name: string): Promise<void> {
  const png = await client.screenshot(pageId);
  const bytes = Buffer.from(png, 'base64');
  writeFileSync(join(outDir, name), bytes);
  console.log(`${name} ${bytes.length} bytes`);
}

try {
  await capture('dashboard-overview.png');
  await navigate('tickets');
  await capture('dashboard-kanban.png');
  await navigate('transcript');
  await capture('dashboard-verified.png');
  await client.evaluate(pageId, `const el = document.querySelector('.log'); if (el) el.scrollTop = Math.floor(el.scrollHeight * 0.55); return true;`);
  await sleep(1_000);
  await capture('dashboard-transcript.png');
  await client.evaluate(pageId, `const el = document.querySelector('.log'); if (el) el.scrollTop = el.scrollHeight; return true;`);
  await sleep(1_000);
  await capture('dashboard-diff.png');
  await navigate('observability');
  await capture('dashboard-observability.png');
} finally {
  await client.closePage(pageId);
}
console.log('DASHBOARD CAPTURE PASSED');
