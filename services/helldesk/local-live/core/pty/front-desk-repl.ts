#!/usr/bin/env bun
/**
 * front-desk-repl — the real, interactive local FrontDesk REPL.
 *
 * Full-parity replacement for the cloud FrontDesk container shell: a genuine
 * interactive program that runs INSIDE a native PTY. It listens for a mission
 * from the user (type it, press Enter) and asks the canonical NAI-Lattice
 * engine to decompose it into a shift + primary tickets via
 * `helldesk.orto.front_desk_request`. The result is printed back to the terminal.
 *
 * It talks to the engine over the same loopback JSON-RPC + control token the
 * dashboard uses (never logs the token). Loopback-only.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync } from 'node:fs';

const ENGINE_HOST = process.env.NAI_LATTICE_HOST ?? '127.0.0.1';
const ENGINE_PORT = Number(process.env.NAI_LATTICE_PORT ?? 8787);
const ENGINE_URL = `http://${ENGINE_HOST}:${ENGINE_PORT}/project`;
const CONTROL_TOKEN_PATH = () =>
  (process.env.LOCALAPPDATA ?? '') +
  '\\NAI\\HELLDESK\\control.token';

function engineToken(): string {
  try {
    return readFileSync(CONTROL_TOKEN_PATH(), 'utf-8').trim();
  } catch {
    return '';
  }
}

/** Call the canonical engine JSON-RPC dispatcher on /project. */
async function engineRpc(method: string, args: Record<string, unknown>): Promise<unknown> {
  const token = engineToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(ENGINE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ method, args }),
  });
  const txt = await res.text();
  try {
    return JSON.parse(txt);
  } catch {
    return { raw: txt, status: res.status };
  }
}

function formatResult(r: unknown): string {
  if (!r) return '(no response)';
  if (typeof r === 'object' && r !== null) {
    const rec = r as Record<string, unknown>;
    if (rec.error) return `engine said: ${String(rec.error)}`;
    if (rec.decomposed) {
      const d = rec.decomposed as Record<string, unknown>;
      const action = d.action ?? 'decomposed';
      const summary = rec.first_tick ? `tick applied=${(rec.first_tick as Record<string, unknown>).applied ?? '?'}` : '';
      return `[${action}] ${summary}\n${JSON.stringify(r, null, 2)}`;
    }
  }
  return JSON.stringify(r, null, 2);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const departmentIdx = args.indexOf('--department');
  const agentIdx = args.indexOf('--agent');
  const departmentId = departmentIdx !== -1 && args[departmentIdx + 1] ? args[departmentIdx + 1] : 'default';
  const agentId = agentIdx !== -1 && args[agentIdx + 1] ? args[agentIdx + 1] : 'frontDesk';
  const workstationIdEnv = process.env.HELLDESK_WORKSTATION_ID ?? 'workstation-local';

  stdout.write(
    `\x1b[1;33m═══ Local HELLDESK FrontDesk · ${departmentId}/${agentId} ═══\x1b[0m\r\n` +
      `Delegate a mission (e.g. "add a /status endpoint, then a cache toggle, then verify").\r\n` +
      `The FrontDesk will decompose it into a shift + primary tickets on the engine.\r\n` +
      `Type a mission and press Enter. Type /exit to quit.\r\n\r\n` +
      `\x1b[1;35mmayor ${agentId}@${departmentId} \x1b[0m> `
  );

  const rl = createInterface({ input: stdin, output: stdout, terminal: true });

  try {
    for await (const line of rl) {
      const text = line.trim();
      if (!text) {
        stdout.write(`\x1b[1;35mmayor ${agentId}@${departmentId} \x1b[0m> `);
        continue;
      }
      if (text === '/exit') break;
      stdout.write('\x1b[2m… asking engine to decompose…\x1b[0m\r\n');
      const started = Date.now();
      const res = await engineRpc('helldesk.orto.front_desk_request', {
        request: text,
        department_id: departmentId,
        workstation_id: process.env.HELLDESK_WORKSTATION_ID ?? workstationIdEnv,
      });
      const ms = Date.now() - started;
      stdout.write(formatResult(res));
      stdout.write('\r\n');
      stdout.write(`\x1b[2m(${ms}ms)\x1b[0m\r\n`);
      stdout.write(`\x1b[1;35mmayor ${agentId}@${departmentId} \x1b[0m> `);
    }
  } finally {
    rl.close();
  }

  stdout.write('\r\n\x1b[0m[frontDesk session ended]\r\n');
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((err) => {
    console.error(String(err));
    process.exit(1);
  });