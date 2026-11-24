/**
 * Granular BrowserOS capture smoke: tabs/evaluate/screenshot only, no run.
 * Verifies the gate can obtain the viewport, stage rect, and PNG without the
 * `run` tool.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserosClient, resolveBrowserosMcpUrl } from '../../../services/helldesk/local/src/browseros-client';

const url = process.argv[2] ?? 'http://127.0.0.1:5277/';
const client = new BrowserosClient({ url: resolveBrowserosMcpUrl(), clientName: 'helldesk-granular-smoke' });
await client.connect();
await client.nameSession('helldesk granular');
const groupId = process.env.HELLDESK_BROWSEROS_GROUP_ID;
const pageId = await client.newPage(url, groupId);
try {
  const ready = await client.waitForSelector(pageId, '[data-testid=stage]', 15_000);
  if (!ready) throw new Error('stage not ready');
  await client.bringToFront(pageId);
  const info = await client.callTool('evaluate', {
    page: pageId,
    code: 'const r = document.querySelector("[data-testid=stage]").getBoundingClientRect(); return { innerWidth, innerHeight, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };',
  });
  console.log('info:', JSON.stringify(info.content));
  const shot = await client.callTool('screenshot', {
    page: pageId,
    format: 'png',
    fullPage: false,
  });
  const image = shot.content.find((part) => part.type === 'image');
  if (!image?.data) throw new Error('no screenshot image');
  const outDir = join(process.cwd(), '.local', 'benchmark', 'v0', 'dashboard', 'smoke');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, 'browseros-granular.png');
  const bytes = Buffer.from(image.data, 'base64');
  writeFileSync(out, bytes);
  console.log(`screenshot ${out} (${bytes.length} bytes)`);
} finally {
  await client.closePage(pageId);
}
console.log('GRANULAR SMOKE PASSED');
