/**
 * Capture the broken pricing-card fixture for the M6 live multimodal run.
 * The M6 Task Studio ticket receives this exact screenshot.
 */
import { writeFileSync } from 'node:fs';
import { BrowserosClient, resolveBrowserosMcpUrl } from '../../services/helldesk/local/src/browseros-client';

const out = '.local/benchmark/m6/broken-pricing-card.png';
const client = new BrowserosClient({ url: resolveBrowserosMcpUrl(), clientName: 'helldesk-m6-broken' });
await client.connect();
await client.nameSession('helldesk m6 broken');
const pageId = await client.newPage('http://127.0.0.1:5274/');
await client.bringToFront(pageId);
await client.waitForSelector(pageId, '[data-testid="pricing-card"]', 15_000);
await new Promise((resolve) => setTimeout(resolve, 1_000));
const png = await client.screenshot(pageId);
writeFileSync(out, Buffer.from(png, 'base64'));
await client.closePage(pageId);
console.log(`BROKEN_SCREENSHOT=${out}`);
