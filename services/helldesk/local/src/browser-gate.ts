/**
 * browser-gate.ts — independent browser execution gate through BrowserOS Neo.
 *
 * Replaces the old Playwright visual gate. The gate runner starts the candidate
 * app with a scrubbed environment, drives the real BrowserOS Neo browser through
 * its MCP server, captures a CDP screenshot, compares it to the protected golden
 * image, and executes functional checks in the same page. All evidence is
 * written outside the candidate workspace.
 *
 * No Playwright, no bundled browser, no separate Chrome automation stack.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { BrowserosClient, resolveBrowserosMcpUrl } from './browseros-client';

export interface BrowserGateCheckSpec {
  type: 'selectorInViewport' | 'selectorExists' | 'textEquals' | 'clickText';
  selector: string;
  text?: string;
  expectSelector?: string;
  expectText?: string;
}

export interface BrowserGateSpec {
  /** Browser page URL. `{port}` is replaced with an allocated free port. */
  url: string;
  /** Optional app server started in the candidate tree. */
  server?: { command: string; url: string; timeoutMs?: number };
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  stageSelector?: string;
  checks: BrowserGateCheckSpec[];
  screenshot?: { golden: string; maxDiffRatio?: number };
  /** Explicit BrowserOS MCP endpoint; otherwise resolve from the Kilo config. */
  mcpUrl?: string;
  mcpTimeoutMs?: number;
  timeoutMs?: number;
}

export interface BrowserGateCheckResult {
  type: string;
  ok: boolean;
  selector?: string;
  expected?: string;
  actual?: string;
  detail?: unknown;
  error?: string;
}

export interface BrowserGateResult {
  status: 'PASS' | 'FAIL' | 'TIMEOUT' | 'ERROR';
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  browser: {
    url: string;
    port: number | null;
    sessionId: string | null;
    pageId: number | null;
    checks: BrowserGateCheckResult[];
    visual: null | {
      ok: boolean;
      golden: string;
      actual: string;
      diff: string | null;
      ratio: number | null;
      threshold: number;
      reason?: string;
      /**
       * Clip-size delta between the actual and golden screenshots. A small
       * sub-pixel/scrollbar rounding delta (<= 2px) is compared over the
       * overlapping region instead of failing the whole gate; the delta stays
       * recorded so the reviewer sees it.
       */
      sizeDelta?: { width: number; height: number; tolerancePx: number };
    };
    serverLog: string;
    error?: string;
  };
}

/** Top-left RGBA crop of a decoded PNG (for bounded clip-size deltas). */
function cropPng(png: { width: number; height: number; data: Buffer }, width: number, height: number): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    png.data.copy(out, y * width * 4, y * png.width * 4, y * png.width * 4 + width * 4);
  }
  return out;
}

/**
 * Compare an actual screenshot to a golden one.
 *
 * Pixel-identical clip dimensions are NOT the contract. A browser can round a
 * screenshot clip 1-2 px differently across reboots (GPU/raster/scrollbar
 * state) while the layout is byte-for-byte identical — M6 run C hit exactly
 * that: 565x565 actual vs 565x566 golden, with a visually identical card.
 *
 * Rule: a size delta within `SIZE_TOLERANCE_PX` is compared over the overlapping
 * region (a real layout shift changes pixels and blows the ratio); a larger
 * delta fails outright. The delta is always reported.
 */
export const SCREENSHOT_SIZE_TOLERANCE_PX = 2;

export interface ScreenshotComparison {
  ok: boolean;
  ratio: number | null;
  width: number;
  height: number;
  threshold: number;
  sizeDelta: { width: number; height: number; tolerancePx: number } | null;
  reason?: string;
  diffPng: Buffer | null;
}

export function compareScreenshotBuffers(actualBytes: Buffer, goldenBytes: Buffer, threshold: number): ScreenshotComparison {
  const actualPng = PNG.sync.read(actualBytes);
  const goldenPng = PNG.sync.read(goldenBytes);
  const dw = actualPng.width - goldenPng.width;
  const dh = actualPng.height - goldenPng.height;
  const sizeDelta = {
    width: dw,
    height: dh,
    tolerancePx: SCREENSHOT_SIZE_TOLERANCE_PX,
  };
  if (Math.abs(dw) > SCREENSHOT_SIZE_TOLERANCE_PX || Math.abs(dh) > SCREENSHOT_SIZE_TOLERANCE_PX) {
    return {
      ok: false,
      ratio: null,
      width: actualPng.width,
      height: actualPng.height,
      threshold,
      sizeDelta,
      reason: `size mismatch actual ${actualPng.width}x${actualPng.height}, golden ${goldenPng.width}x${goldenPng.height} (tolerance ${SCREENSHOT_SIZE_TOLERANCE_PX}px)`,
      diffPng: null,
    };
  }
  const width = Math.min(actualPng.width, goldenPng.width);
  const height = Math.min(actualPng.height, goldenPng.height);
  const actualOverlap = cropPng(actualPng, width, height);
  const goldenOverlap = cropPng(goldenPng, width, height);
  const diff = new PNG({ width, height });
  const mismatched = pixelmatch(actualOverlap, goldenOverlap, diff.data, width, height, { threshold: 0.1 });
  const ratio = mismatched / (width * height);
  return {
    ok: ratio <= threshold,
    ratio,
    width,
    height,
    threshold,
    sizeDelta: dw || dh ? sizeDelta : null,
    ...(dw || dh ? { reason: `clip size delta ${dw}x${dh}px compared over ${width}x${height}` } : {}),
    diffPng: PNG.sync.write(diff),
  };
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}

function withPort(template: string, port: number): string {
  return template.replace(/\{port\}/g, String(port));
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

interface AppServer {
  stop(): void;
  logs(): string;
  pid: number | undefined;
}

function startAppServer(opts: { command: string; cwd: string; env: Record<string, string> }): AppServer {
  const isWin = process.platform === 'win32';
  const shell = isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
  const args = isWin ? ['/d', '/s', '/c', opts.command] : ['-c', opts.command];
  const child = spawn(shell, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: !isWin,
  });
  let output = '';
  const append = (chunk: Buffer): void => {
    if (output.length > 2 * 1024 * 1024) return;
    output += chunk.toString('utf8');
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  let stopped = false;
  return {
    pid: child.pid,
    logs: () => output,
    stop: () => {
      if (stopped) return;
      stopped = true;
      killTree(child.pid);
    },
  };
}

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.status < 500) return true;
    } catch {
      /* not ready */
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  return false;
}

function filePaths(evidenceDir: string, name: string): string {
  return join(evidenceDir, name);
}

/** Crop the fixed-size stage out of a full-page screenshot. The stage content is
 *  viewport-independent, so the golden is stable even if the browser window
 *  changes between the golden capture and the gate run. */
export function cropStageScreenshot(
  pngBase64: string,
  rect: { x: number; y: number; width: number; height: number },
  viewport?: { width: number; height: number },
): Buffer {
  const full = PNG.sync.read(Buffer.from(pngBase64, 'base64'));
  const scaleX = viewport && viewport.width > 0 ? full.width / viewport.width : 1;
  const scaleY = viewport && viewport.height > 0 ? full.height / viewport.height : 1;
  const sx = Math.round(rect.x * scaleX);
  const sy = Math.round(rect.y * scaleY);
  const sw = Math.round(rect.width * scaleX);
  const sh = Math.round(rect.height * scaleY);
  const x = Math.max(0, Math.min(full.width - 1, sx));
  const y = Math.max(0, Math.min(full.height - 1, sy));
  const width = Math.max(1, Math.min(full.width - x, sw));
  const height = Math.max(1, Math.min(full.height - y, sh));
  const stage = new PNG({ width, height });
  PNG.bitblt(full, stage, x, y, width, height, 0, 0);
  return PNG.sync.write(stage);
}

export async function runBrowserGate(opts: {
  spec: BrowserGateSpec;
  candidateRoot: string;
  evidenceDir: string;
  env: Record<string, string>;
}): Promise<BrowserGateResult> {
  const started = Date.now();
  const spec = opts.spec;
  let port: number | null = null;
  let pageId: number | null = null;
  let client: BrowserosClient | null = null;
  let server: AppServer | null = null;
  let warmupPageId: number | null = null;
  let serverLog = '';
  const checks: BrowserGateCheckResult[] = [];
  let visual: BrowserGateResult['browser']['visual'] = null;

  const fail = (
    status: BrowserGateResult['status'],
    message: string,
    exitCode: number | null = status === 'FAIL' ? 1 : null,
  ): BrowserGateResult => ({
    status,
    exitCode,
    durationMs: Date.now() - started,
    stdout: JSON.stringify({ checks, visual }, null, 2),
    stderr: message,
    browser: {
      url: port ? withPort(spec.url, port) : spec.url,
      port,
      sessionId: client?.session ?? null,
      pageId,
      checks,
      visual,
      serverLog: serverLog.slice(-4000),
      error: status === 'PASS' ? undefined : message,
    },
  });

  try {
    port = await freePort();
    const url = withPort(spec.url, port);
    if (spec.server) {
      server = startAppServer({
        command: withPort(spec.server.command, port),
        cwd: opts.candidateRoot,
        env: { ...opts.env, PORT: String(port) },
      });
      const ready = await waitForHttp(withPort(spec.server.url, port), spec.server.timeoutMs ?? 60_000);
      if (!ready) {
        serverLog = server.logs();
        server.stop();
        return fail('TIMEOUT', `app server did not become ready at ${withPort(spec.server.url, port)}\n${serverLog.slice(-2000)}`);
      }
    }

    client = new BrowserosClient({
      url: spec.mcpUrl ?? resolveBrowserosMcpUrl(),
      timeoutMs: spec.mcpTimeoutMs ?? 60_000,
      clientName: 'helldesk-browser-gate',
    });
    await client.connect();
    await client.nameSession('helldesk gate');
    // Warm the app once, then open the gate page at the same URL. The second
    // load is served from cache/static preview and the viewport change reflows
    // reliably without a run-time navigation.
    warmupPageId = await client.newPage(url);
    pageId = await client.newPage(url);
    await client.bringToFront(pageId);
    const stageReady = await client.waitForSelector(pageId, spec.stageSelector ?? 'body', 15_000);
    if (!stageReady) throw new Error('stage selector did not appear within 15s');
    const viewport = spec.viewport ?? { width: 1280, height: 720, deviceScaleFactor: 1 };
    const run = await client.captureAndCheck({
      pageId,
      url,
      viewport,
      stageSelector: spec.stageSelector ?? 'body',
      checks: spec.checks as unknown as Array<Record<string, unknown>>,
    });
    checks.push(...(run.checks as BrowserGateCheckResult[]));

    const fullPath = filePaths(opts.evidenceDir, 'full.png');
    writeFileSync(fullPath, Buffer.from(run.screenshot, 'base64'));
    const actualBytes = spec.screenshot
      ? cropStageScreenshot(run.screenshot, run.stageRect, run.viewport)
      : Buffer.from(run.screenshot, 'base64');
    const actualPath = filePaths(opts.evidenceDir, 'actual.png');
    writeFileSync(actualPath, actualBytes);

    if (spec.screenshot) {
      const goldenPath = isAbsolute(spec.screenshot.golden)
        ? spec.screenshot.golden
        : resolve(opts.candidateRoot, spec.screenshot.golden);
      if (!isWithin(opts.candidateRoot, goldenPath)) {
        return fail('ERROR', `golden screenshot escapes the candidate tree: ${spec.screenshot.golden}`);
      }
      if (!existsSync(goldenPath)) {
        return fail('ERROR', `golden screenshot is missing: ${spec.screenshot.golden}`);
      }
      const threshold = spec.screenshot.maxDiffRatio ?? 0.002;
      const comparison = compareScreenshotBuffers(actualBytes, readFileSync(goldenPath), threshold);
      if (comparison.diffPng) {
        const diffPath = filePaths(opts.evidenceDir, 'diff.png');
        writeFileSync(diffPath, comparison.diffPng);
        writeFileSync(filePaths(opts.evidenceDir, 'ratio.txt'), String(comparison.ratio), 'utf8');
        visual = {
          ok: comparison.ok,
          golden: goldenPath,
          actual: actualPath,
          diff: diffPath,
          ratio: comparison.ratio,
          threshold,
          ...(comparison.reason ? { reason: comparison.reason } : {}),
          ...(comparison.sizeDelta ? { sizeDelta: comparison.sizeDelta } : {}),
        };
      } else {
        visual = {
          ok: false,
          golden: goldenPath,
          actual: actualPath,
          diff: null,
          ratio: null,
          threshold,
          reason: comparison.reason ?? 'visual comparison failed',
          ...(comparison.sizeDelta ? { sizeDelta: comparison.sizeDelta } : {}),
        };
      }
    }

    const checksOk = checks.every((check) => check.ok);
    const visualOk = visual ? visual.ok : true;
    const failures = [
      ...checks.filter((check) => !check.ok).map((check) => `${check.type} ${check.selector ?? ''} failed${check.actual !== undefined ? `: ${check.actual}` : ''}`),
      ...(visual && !visual.ok ? [`visual diff ${visual.ratio ?? 'size-mismatch'} > ${visual.threshold}`] : []),
    ];
    const status: BrowserGateResult['status'] = checksOk && visualOk ? 'PASS' : 'FAIL';
    const result: BrowserGateResult = {
      status,
      exitCode: status === 'PASS' ? 0 : 1,
      durationMs: Date.now() - started,
      stdout: JSON.stringify({ url, checks, visual }, null, 2),
      stderr: failures.join('\n'),
      browser: {
        url,
        port,
        sessionId: client.session,
        pageId,
        checks,
        visual,
        serverLog: server ? server.logs().slice(-4000) : '',
        error: status === 'PASS' ? undefined : failures.join('\n') || undefined,
      },
    };
    if (pageId !== null) await client.closePage(pageId);
    pageId = null;
    if (warmupPageId !== null) await client.closePage(warmupPageId);
    warmupPageId = null;
    if (server) server.stop();
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status: BrowserGateResult['status'] = /timeout|timed out|aborted/i.test(message) ? 'TIMEOUT' : 'ERROR';
    if (server) serverLog = server.logs();
    if (client && pageId !== null) await client.closePage(pageId).catch(() => undefined);
    if (client && warmupPageId !== null) await client.closePage(warmupPageId).catch(() => undefined);
    if (server) server.stop();
    return fail(status, message);
  } finally {
    if (server) server.stop();
  }
}

export { freePort, waitForHttp, startAppServer };
