/**
 * BrowserOS Neo session recipe for the M4 dashboard demo.
 *
 * This file is the repo-owned source for the run script used through the
 * `browseros` MCP tool. It is not executed by Node; the agent passes
 * `dashboardRunCode()` to `tools.browseros.run({ code })` (or the saved
 * `/neo-helldesk-dashboard-demo` skill).
 *
 * Session rules:
 *  - On every new MCP connection call `tabs action="list"` FIRST and record the
 *    group id for pages on 127.0.0.1:8792.
 *  - Reuse an `ownership === "mine"` page by URL; never trust a page id from an
 *    earlier call. Re-derive it with `browser.pages.list()`.
 *  - If the page is gone, use `tabs action="new"` with the remembered groupId;
 *    if the group closed with its last tab, open a fresh tab, create a new group,
 *    and update the remembered id.
 *  - Each `run` is capped at 30s. Split longer demos; on timeout re-list tabs,
 *    re-derive the page, and retry once.
 *  - Activate the tab for window capture with `page.cdp("Page.bringToFront", "{}")`.
 */
export const DASHBOARD_ORIGIN = 'http://127.0.0.1:8792';
export const DASHBOARD_URL = `${DASHBOARD_ORIGIN}/helldesk/#/helldesk/default`;
export const TRANSCRIPT_URL = `${DASHBOARD_ORIGIN}/helldesk/#/helldesk/default/transcript`;
export const OBSERVABILITY_URL = `${DASHBOARD_ORIGIN}/helldesk/#/helldesk/default/observability`;

/** Ephemeral: the group id observed during the recorded M4 run. It is NOT
 *  durable; re-read it from `tabs action="list"` after every reconnect. */
export const OBSERVED_GROUP_ID = 'FD41F0200E72C7C9DBA6B0FD587DDF73';

export const SESSION_RULES = [
  'tabs action="list" first on a new connection; record the 8792 group id.',
  'Reuse ownership="mine" pages by URL; re-derive page ids with browser.pages.list().',
  'If the page is gone, tabs action="new" with the remembered groupId; if the group is gone, create a new one and update the id.',
  'Keep each run under 30s; on timeout re-list, re-derive by URL, retry once.',
  'Never act on ownership="user" or "other-agent" tabs.',
  'Use page.cdp("Page.bringToFront", "{}") before screen capture.',
];

/**
 * Open/reuse the demo dashboard and return the live page id. This is a safe
 * single-step run; larger sequences should reuse the returned page id within
 * the same run, not across calls.
 */
export function dashboardRunCode(url: string = TRANSCRIPT_URL): string {
  return `
const mine = (await browser.pages.list()).filter((p) => p.ownership === 'mine');
let handle = null;
const existing = mine.find((p) => String(p.url).includes('127.0.0.1:8792'));
if (existing) {
  try { handle = browser.page(existing.pageId); } catch (e) { handle = null; }
}
if (!handle) handle = await browser.open(${JSON.stringify(url)});
const ready = await handle.waitForSelector('body', { timeout: 10000 });
if (!ready.matched) {
  await handle.reload();
  await handle.waitForSelector('body', { timeout: 10000 });
}
try { await handle.cdp('Page.bringToFront', '{}'); } catch (e) {}
await handle.waitForTime(800);
return { pageId: handle.id, url: ${JSON.stringify(url)} };
`;
}

/**
 * The recorded M4 sequence. The page handle from a previous run may be stale;
 * the first step re-derives it by URL.
 */
export function transcriptTourCode(): string {
  return `
const mine = (await browser.pages.list()).filter((p) => p.ownership === 'mine');
let page = mine.find((p) => String(p.url).includes('127.0.0.1:8792'));
if (page) { try { page = browser.page(page.pageId); } catch (e) { page = null; } }
if (!page) page = await browser.open(${JSON.stringify(TRANSCRIPT_URL)});
await page.waitForSelector('body', { timeout: 10000 });
try { await page.cdp('Page.bringToFront', '{}'); } catch (e) {}
await page.waitForTime(2000);
await page.evaluate(() => { const el = document.querySelector('.log'); if (el) el.scrollTop = Math.floor(el.scrollHeight * 0.55); });
await page.waitForTime(4000);
await page.evaluate(() => { const el = document.querySelector('.log'); if (el) el.scrollTop = el.scrollHeight; });
await page.waitForTime(4000);
return { pageId: page.id };
`;
}

export const M4_PROOF = {
  demoUrl: DASHBOARD_ORIGIN,
  daemonPort: 4791,
  missionId: 'mis_5077579244fb46c4a4763e249af60729',
  proofRun: '.local/benchmark/v0/m3-regression-proof/2026-11-23T22-12-18-227Z',
  video: 'benchmarks/v0/dashboard/media/dashboard-demo.mp4',
  screenshots: [
    'benchmarks/v0/dashboard/media/dashboard-overview.png',
    'benchmarks/v0/dashboard/media/dashboard-transcript.png',
    'benchmarks/v0/dashboard/media/dashboard-diff.png',
    'benchmarks/v0/dashboard/media/dashboard-verified.png',
  ],
} as const;
