/**
 * Capture the protected visual golden with BrowserOS Neo (no Playwright).
 *
 * Copies the fixture to a throwaway workspace, applies the known-correct CTA
 * layout, starts Vite, captures a 1280x720 CDP screenshot through the
 * production BrowserOS client, and writes it to
 * benchmarks/v0/visual-fixture/tests/golden/pricing-card.png.
 *
 * Run from the repository root:
 *   bun run benchmarks/v0/visual-fixture/scripts/capture-golden.ts
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserosClient, resolveBrowserosMcpUrl } from '../../../../services/helldesk/local/src/browseros-client';
import { cropStageScreenshot, freePort, startAppServer, waitForHttp } from '../../../../services/helldesk/local/src/browser-gate';

const repoRoot = process.cwd();
const fixture = join(repoRoot, 'benchmarks', 'v0', 'visual-fixture');
const runRoot = join(repoRoot, '.local', 'benchmark', 'v0', 'golden');
const workspace = join(runRoot, 'workspace');
const goldenPath = join(fixture, 'tests', 'golden', 'pricing-card.png');

const CSS_FIX = '\n.pricing-card__cta {\n  position: static;\n  left: auto;\n  top: auto;\n}\n';

rmSync(runRoot, { recursive: true, force: true });
mkdirSync(runRoot, { recursive: true });
cpSync(fixture, workspace, {
  recursive: true,
  filter: (src) => {
    const rel = src.replace(/\\/g, '/').slice(fixture.replace(/\\/g, '/').length);
    return !/\/(node_modules|dist|test-results|\.vite)(\/|$)/.test(rel);
  },
});
symlinkSync(join(fixture, 'node_modules'), join(workspace, 'node_modules'), 'junction');
const cssPath = join(workspace, 'src', 'styles.css');
writeFileSync(cssPath, `${readFileSync(cssPath, 'utf8')}${CSS_FIX}`, 'utf8');

const port = await freePort();
const url = `http://127.0.0.1:${port}/`;
const server = startAppServer({
  // Test the production build, not the HMR dev server: deterministic layout,
  // deterministic assets, and no cold dependency-optimization stall.
  command: `bun run build && bun run preview -- --host 127.0.0.1 --port ${port} --strictPort`,
  cwd: workspace,
  env: process.env as Record<string, string>,
});
const client = new BrowserosClient({ url: resolveBrowserosMcpUrl(), clientName: 'helldesk-golden' });
let pageId: number | null = null;
try {
  const ready = await waitForHttp(url, 60_000);
  if (!ready) throw new Error(`vite did not start\n${server.logs().slice(-2000)}`);
  await client.connect();
  await client.nameSession('helldesk golden');
  pageId = await client.newPage(url);
  await client.focusForCapture(pageId);
  const stageReady = await client.waitForSelector(pageId, '[data-testid=stage]', 15_000);
  if (!stageReady) throw new Error('stage did not appear within 15s');
  // Use the same capture path as the gate: set the 1280x720 viewport and
  // CDP-capture the stage before any interaction.
  const value = await client.captureAndCheck({
    pageId,
    url,
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    stageSelector: '[data-testid=stage]',
    checks: [],
  });
  if (!value?.screenshot || !value.stageRect) throw new Error('BrowserOS returned no screenshot/stageRect');
  mkdirSync(join(fixture, 'tests', 'golden'), { recursive: true });
  const bytes = cropStageScreenshot(value.screenshot, value.stageRect, value.viewport);
  writeFileSync(goldenPath, bytes);
  console.log(`GOLDEN=${goldenPath}`);
  console.log(`BYTES=${bytes.length}`);
  console.log(`WORKSPACE=${workspace}`);
} finally {
  if (pageId !== null) await client.closePage(pageId).catch(() => undefined);
  server.stop();
}

if (!existsSync(goldenPath)) throw new Error('golden was not written');
