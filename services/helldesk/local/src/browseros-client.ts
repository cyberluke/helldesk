/**
 * browseros-client.ts — minimal Streamable-HTTP MCP client for BrowserOS Neo.
 *
 * BrowserOS Neo exposes its MCP server at http://127.0.0.1:9210/mcp (global
 * Kilo config, `mcp.browseros`). This client is the production bridge for the
 * browser execution gate:
 *   - initialize + notifications/initialized with an MCP session id,
 *   - tools/call with SSE-or-JSON response parsing,
 *   - reconnect + retry once when the session expires,
 *   - page/tab creation, run-script execution, and CDP screenshots.
 *
 * It never touches the user's tabs: it creates a page through `tabs action=new`
 * and only addresses that page id.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROTOCOL_VERSION = '2025-03-26';

export interface BrowserosClientOptions {
  url: string;
  timeoutMs?: number;
  clientName?: string;
  headers?: Record<string, string>;
}

interface McpEnvelope {
  jsonrpc?: string;
  id?: number | string;
  result?: {
    content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
    structuredContent?: { value?: unknown; [key: string]: unknown };
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: { code?: number; message?: string; data?: unknown };
}

export interface BrowserosToolResult {
  value: unknown;
  content: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
  raw: McpEnvelope['result'];
}

function parseMcpText(text: string): McpEnvelope[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{')) {
    try { return [JSON.parse(trimmed) as McpEnvelope]; } catch { return []; }
  }
  const out: McpEnvelope[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    try {
      const parsed = JSON.parse(data) as McpEnvelope;
      if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) out.push(parsed);
    } catch {
      /* ignore non-JSON SSE events (comments/keepalives) */
    }
  }
  return out;
}

/**
 * Read an MCP SSE response incrementally and return as soon as the JSON-RPC
 * result/error arrives. Waiting for the stream to close hangs on image/tool
 * results (the screenshot stream stays open); the agent MCP client also returns
 * on the response event, not on EOF.
 */
async function readSseResponse(res: Response): Promise<McpEnvelope[]> {
  if (!res.body) return [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  const envelopes: McpEnvelope[] = [];
  const flush = async (): Promise<boolean> => {
    if (dataLines.length === 0) return false;
    const data = dataLines.join('\n');
    dataLines = [];
    try {
      const parsed = JSON.parse(data) as McpEnvelope;
      if (parsed.result !== undefined || parsed.error !== undefined) {
        envelopes.push(parsed);
        return true;
      }
    } catch {
      /* non-JSON SSE data (comments/heartbeats) */
    }
    return false;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line === '') {
          if (await flush()) {
            await reader.cancel().catch(() => undefined);
            return envelopes;
          }
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim());
        }
        newline = buffer.indexOf('\n');
      }
    }
    // Some servers end the SSE body immediately after the final data line with
    // no trailing blank line/newline. Flush the tail as a data line.
    const tail = buffer.trim();
    if (tail.startsWith('data:')) dataLines.push(tail.slice(5).trim());
    await flush();
  } catch {
    /* stream aborted/closed; return what was received */
  }
  return envelopes;
}

function toolText(content: BrowserosToolResult['content']): string {
  return content.map((c) => (typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
}

function runValue(result: BrowserosToolResult): unknown {
  const structured = result.raw?.structuredContent;
  if (structured && Object.prototype.hasOwnProperty.call(structured, 'value')) return structured.value;
  if (result.value !== undefined) return result.value;
  const text = toolText(result.content);
  const marker = text.indexOf('return:');
  if (marker >= 0) {
    const json = text.slice(marker + 'return:'.length).trim();
    try { return JSON.parse(json); } catch { /* fall through */ }
  }
  return text || null;
}

/**
 * Resolve the BrowserOS MCP URL. Explicit env wins; otherwise read the global
 * Kilo config (`~/.config/kilo/kilo.json[c]`) where `mcp.browseros.url` lives.
 */
export function resolveBrowserosMcpUrl(): string {
  const explicit = process.env.HELLDESK_BROWSEROS_MCP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const candidates = [
    join(homedir(), '.config', 'kilo', 'kilo.json'),
    join(homedir(), '.config', 'kilo', 'kilo.jsonc'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, 'utf8');
    try {
      const parsed = JSON.parse(raw) as { mcp?: Record<string, { url?: unknown }> };
      const url = parsed?.mcp?.browseros?.url;
      if (typeof url === 'string' && url.trim()) return url.trim().replace(/\/+$/, '');
    } catch {
      // JSONC / comments: extract the browseros url with a tolerant regex.
      const match = /"browseros"\s*:\s*\{[\s\S]*?"url"\s*:\s*"([^"]+)"/.exec(raw);
      if (match?.[1]) return match[1].trim().replace(/\/+$/, '');
    }
  }
  throw new Error(
    'BrowserOS MCP URL not found. Set HELLDESK_BROWSEROS_MCP_URL or configure mcp.browseros.url in ~/.config/kilo/kilo.json.',
  );
}

export class BrowserosClient {
  private nextId = 1;
  private sessionId = '';
  private initialized = false;
  private readonly timeoutMs: number;
  private readonly clientName: string;

  constructor(private readonly opts: BrowserosClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.clientName = opts.clientName ?? 'helldesk-browser-gate';
  }

  get url(): string { return this.opts.url; }
  get session(): string { return this.sessionId; }

  private requestHeaders(withSession: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      ...(this.opts.headers ?? {}),
    };
    if (withSession && this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    return headers;
  }

  private async post(body: unknown, withSession: boolean, timeoutMs = this.timeoutMs): Promise<{ status: number; envelopes: McpEnvelope[]; sessionId: string | null }> {
    const res = await fetch(this.opts.url, {
      method: 'POST',
      headers: this.requestHeaders(withSession),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sessionId = res.headers.get('mcp-session-id');
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`BrowserOS MCP HTTP ${res.status}: ${text.slice(0, 400)}`);
      (err as { status?: number }).status = res.status;
      throw err;
    }
    if (res.status === 202) return { status: res.status, envelopes: [], sessionId };
    if (type.includes('text/event-stream') || !type.includes('application/json')) {
      return { status: res.status, envelopes: await readSseResponse(res), sessionId };
    }
    const text = await res.text();
    return { status: res.status, envelopes: parseMcpText(text), sessionId };
  }

  async connect(): Promise<string> {
    if (this.initialized && this.sessionId) return this.sessionId;
    const init = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.clientName, version: '1.0.0' },
      },
    }, false);
    if (init.sessionId) this.sessionId = init.sessionId;
    const error = init.envelopes.find((e) => e.error);
    if (error?.error) throw new Error(`BrowserOS MCP initialize failed: ${error.error.message ?? 'unknown'}`);
    const result = init.envelopes.find((e) => e.result);
    if (!result) throw new Error('BrowserOS MCP initialize returned no result');
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, true).catch(() => undefined);
    this.initialized = true;
    return this.sessionId;
  }

  async reconnect(): Promise<string> {
    this.initialized = false;
    this.sessionId = '';
    return this.connect();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<BrowserosToolResult> {
    await this.connect();
    const id = this.nextId++;
    const invoke = async (): Promise<McpEnvelope[]> => {
      const res = await this.post({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      }, true);
      return res.envelopes;
    };
    let envelopes: McpEnvelope[];
    try {
      envelopes = await invoke();
    } catch (err) {
      const status = (err as { status?: number }).status;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 404 || status === 410 || /session/i.test(message)) {
        await this.reconnect();
        envelopes = await invoke();
      } else {
        throw err;
      }
    }
    const envelope = envelopes.find((e) => e.id === id && (e.result !== undefined || e.error !== undefined)) ?? envelopes.at(-1);
    if (!envelope) throw new Error(`BrowserOS MCP tools/call ${name} returned no envelope`);
    if (envelope.error) throw new Error(`BrowserOS MCP tools/call ${name}: ${envelope.error.message ?? 'unknown error'}`);
    const result = envelope.result ?? {};
    if (result.isError) {
      const text = toolText(result.content ?? []);
      throw new Error(`BrowserOS MCP tools/call ${name} failed: ${text.slice(0, 500)}`);
    }
    const structured = result.structuredContent;
    return {
      value: structured && Object.prototype.hasOwnProperty.call(structured, 'value') ? structured.value : structured ?? null,
      content: result.content ?? [],
      raw: result,
    };
  }

  async run(code: string): Promise<unknown> {
    const result = await this.callTool('run', { code });
    return runValue(result);
  }

  async newPage(url: string, groupId?: string): Promise<number> {
    const result = await this.callTool('tabs', { action: 'new', url, ...(groupId ? { groupId } : {}) });
    const text = toolText(result.content);
    const match = /opened page (\d+)/i.exec(text);
    if (!match) throw new Error(`BrowserOS tabs new did not open a page: ${text.slice(0, 300)}`);
    return Number(match[1]);
  }

  async closePage(pageId: number): Promise<void> {
    await this.callTool('tabs', { action: 'close', page: pageId }).catch(() => undefined);
  }

  /** Activate the tab. Background tabs are throttled; the gate needs a live page. */
  async bringToFront(pageId: number): Promise<void> {
    await this.run(`const page = browser.page(${pageId}); await page.cdp('Page.bringToFront', '{}'); return { ok: true };`);
  }

  /** Wait for a selector by polling a tiny evaluate call. The granular `wait`
   *  tool returned false on a page where evaluate proved the selector existed;
   *  evaluate is the reliable readiness probe. */
  async waitForSelector(pageId: number, selector: string, timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const result = await this.callTool('evaluate', {
          page: pageId,
          code: `return document.querySelector(${JSON.stringify(selector)}) ? "READY" : "MISSING";`,
        });
        if (toolText(result.content).includes('READY')) return true;
      } catch {
        /* transient evaluate error; retry until the deadline */
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    return false;
  }

  async nameSession(name: string): Promise<void> {
    await this.callTool('name_session', {
      name,
      category: 'dev-tools',
      summary: 'HELLDESK independent browser execution gate',
    }).catch(() => undefined);
  }

  /**
   * One bounded browser run: set viewport, navigate, wait for the stage,
   * capture a CDP PNG, then execute the gate checks. The screenshot is taken
   * BEFORE the checks so the visual golden matches the static card.
   */
  /** Read a page value through CDP Runtime.evaluate. The content is wrapped in
   *  the untrusted-page markers; extract the JSON object/array. */
  async evaluate(pageId: number, code: string): Promise<unknown> {
    const result = await this.callTool('evaluate', { page: pageId, code, maxChars: 200_000 });
    const text = toolText(result.content);
    const objStart = text.indexOf('{');
    const objEnd = text.lastIndexOf('}');
    if (objStart >= 0 && objEnd > objStart) {
      try { return JSON.parse(text.slice(objStart, objEnd + 1)); } catch { /* fall through */ }
    }
    const arrStart = text.indexOf('[');
    const arrEnd = text.lastIndexOf(']');
    if (arrStart >= 0 && arrEnd > arrStart) {
      try { return JSON.parse(text.slice(arrStart, arrEnd + 1)); } catch { /* fall through */ }
    }
    // String/scalar results are wrapped in the untrusted-page markers. Strip the
    // marker header and the "Untrusted page content follows" sentence.
    const openMarker = text.indexOf('[UNTRUSTED_PAGE_CONTENT');
    const endMarker = text.indexOf('[END_UNTRUSTED_PAGE_CONTENT');
    if (openMarker >= 0 && endMarker > openMarker) {
      const headerEnd = text.indexOf(']', openMarker);
      let inner = text.slice(headerEnd + 1, endMarker).trim();
      inner = inner.replace(/^Untrusted page content follows[^\n]*\n?/i, '').trim();
      if (inner) return inner;
    }
    if (result.value !== null && result.value !== undefined) return result.value;
    return text;
  }

  /** Granular screenshot tool; returns the PNG base64. The image response can
   *  intermittently lose its JSON-RPC envelope under MCP load; retry it. */
  async screenshot(pageId: number): Promise<string> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await this.callTool('screenshot', { page: pageId, format: 'png', fullPage: false });
        const image = result.content.find((part) => part.type === 'image' && typeof part.data === 'string');
        if (image?.data) return image.data;
        lastError = new Error('BrowserOS screenshot returned no image data');
      } catch (err) {
        lastError = err;
        // A screenshot worker can wedge per MCP session; a fresh session can
        // still capture the existing page. Reconnect before the next attempt.
        await this.reconnect().catch(() => undefined);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt === 0 ? 400 : 1_200));
    }
    throw lastError instanceof Error ? lastError : new Error('BrowserOS screenshot failed');
  }

  private async pollText(pageId: number, selector: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate(
          pageId,
          `const node = document.querySelector(${JSON.stringify(selector)}); return node ? node.textContent : null;`,
        );
        if (typeof value === 'string') {
          last = value;
          if (value.trim()) return value;
        }
      } catch {
        /* transient evaluate error; retry until deadline */
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    }
    return last;
  }

  /**
   * Granular visual + functional browser gate.
   *
   * Uses evaluate for checks and the screenshot tool for the PNG, with no
   * navigation/reload/wait inside a `run`. The page is created at the app URL by
   * the caller; the screenshot is taken BEFORE the click checks so the visual
   * golden matches the static card. The screenshot is returned with the CSS
   * viewport and stage rect so the host can crop by the image's own scale.
   */
  async captureAndCheck(opts: {
    pageId: number;
    url: string;
    viewport: { width: number; height: number; deviceScaleFactor?: number };
    stageSelector: string;
    checks: Array<Record<string, unknown>>;
  }): Promise<{
    pageId: number;
    screenshot: string;
    viewport: { width: number; height: number };
    stageRect: { x: number; y: number; width: number; height: number };
    checks: Array<{ type: string; ok: boolean; [key: string]: unknown }>;
  }> {
    const info = await this.evaluate(
      opts.pageId,
      `const node = document.querySelector(${JSON.stringify(opts.stageSelector)});
       if (!node) return null;
       const r = node.getBoundingClientRect();
       return { innerWidth, innerHeight, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };`,
    ) as { innerWidth?: number; innerHeight?: number; rect?: { x: number; y: number; width: number; height: number } } | null;
    if (!info?.rect || !info.innerWidth || !info.innerHeight) throw new Error('stage rect unavailable');

    // Visual first, before any click changes the UI.
    const screenshot = await this.screenshot(opts.pageId);

    const checks: Array<{ type: string; ok: boolean; [key: string]: unknown }> = [];
    for (const raw of opts.checks) {
      const type = String(raw.type ?? '');
      const selector = String(raw.selector ?? '');
      if (type === 'selectorInViewport') {
        const detail = await this.evaluate(
          opts.pageId,
          `const node = document.querySelector(${JSON.stringify(selector)});
           if (!node) return { ok: false, reason: 'missing' };
           const r = node.getBoundingClientRect();
           return { ok: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth, rect: { top: r.top, left: r.left, bottom: r.bottom, right: r.right } };`,
        ) as { ok?: boolean } | null;
        checks.push({ type, selector, ok: Boolean(detail?.ok), detail });
      } else if (type === 'selectorExists') {
        const detail = await this.evaluate(
          opts.pageId,
          `return { ok: Boolean(document.querySelector(${JSON.stringify(selector)})) };`,
        ) as { ok?: boolean } | null;
        checks.push({ type, selector, ok: Boolean(detail?.ok), detail });
      } else if (type === 'textEquals') {
        const expected = String(raw.text ?? '');
        const actual = await this.pollText(opts.pageId, selector, 5_000);
        checks.push({ type, selector, expected, actual, ok: actual.trim() === expected });
      } else if (type === 'clickText') {
        const expectSelector = String(raw.expectSelector ?? '');
        const expected = String(raw.expectText ?? '');
        await this.evaluate(
          opts.pageId,
          `const node = document.querySelector(${JSON.stringify(selector)}); if (node) node.click(); return true;`,
        );
        const actual = await this.pollText(opts.pageId, expectSelector, 5_000);
        checks.push({ type, selector, expectSelector, expected, actual, ok: actual.trim() === expected });
      } else {
        checks.push({ type, ok: false, error: 'unknown check type' });
      }
    }

    return {
      pageId: opts.pageId,
      screenshot,
      viewport: { width: info.innerWidth, height: info.innerHeight },
      stageRect: info.rect,
      checks,
    };
  }
}
