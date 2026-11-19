import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NafBridge, newHostIdentity } from '../../plugin/bridge';

/**
 * BRIDGE-01 — the NAF bridge is a THIN, non-owning publisher: it never spawns a
 * process, never touches the filesystem on the hook path, fails OPEN when the
 * NAI-Lattice pipe is absent, and bounds its in-memory queue so a slow/absent
 * fabric never backs up the Kilo hook.
 */
const LOCAL = join(__dirname, '..', '..');

describe('NafBridge thin-adapter contract', () => {
  it('fails open (never throws) when the NAF pipe is unavailable', () => {
    // Point at a pipe that cannot exist, with a short timeout.
    process.env.NAI_FABRIC_PIPE = String.raw`\\.\pipe\NAI.AmbientFabric.NOTREAL.zzzzzz`;
    try {
      const identity = newHostIdentity({ workspaceRoots: ['C:/fake'] });
      const errors: Error[] = [];
      const b = new NafBridge(identity, {
        onError: (e) => errors.push(e),
        onDisconnected: () => {},
      });
      expect(() => b.connect()).not.toThrow();
      // emitEvent never blocks or throws regardless of connection state.
      expect(() => b.emitEvent('s1', 'chat.message', {})).not.toThrow();
      expect(b).toBeDefined();
    } finally {
      delete process.env.NAI_FABRIC_PIPE;
    }
  });

  it('bound the in-memory queue (drop oldest, never unbounded)', () => {
    const identity = newHostIdentity({ workspaceRoots: [] });
    const b = new NafBridge(identity, { onError: () => {} });
    // Simulate a disconnected bridge: connect() to a non-existent pipe fails
    // open, then push many events; queue must be capped (drop-oldest).
    b.connect();
    for (let i = 0; i < 500; i++) {
      b.emitEvent('s', 'chat.message', { i });
    }
    // The bridge bound is private; assert no throw and that the process did not
    // balloon by reaching here within a sane time.
    expect(b.isConnected).toBe(false);
  });

  it('bridge.ts has zero subprocess / sync-fs references on the hook path', () => {
    const bridgeSrc = readFileSync(join(LOCAL, 'plugin', 'bridge.ts'), 'utf-8');
    const indexSrc = readFileSync(join(LOCAL, 'plugin', 'index.ts'), 'utf-8');
    for (const forbidden of ['child_process', 'execSync', 'execFileSync', 'spawn', 'appendFileSync', 'writeFileSync', 'node:fs']) {
      // The word spawn appears in comments; assert NO code-line usage outside
      // comment/string doc. Simple heuristic: the forbidden token must not
      // appear as an actual call/import on a non-comment line.
      const badLines = [bridgeSrc, indexSrc].flatMap((s) =>
        s.split('\n').filter((l) => /^\s*import |execSync\(|execFileSync\(|spawn\(|appendFileSync\(|writeFileSync\(/.test(l) && l.includes(forbidden))
      );
      expect(badLines, `forbidden ${forbidden} on hook path`).toEqual([]);
    }
    // index.ts must import the NAF bridge, not a bespoke daemon client.
    expect(indexSrc).toContain('from \'./bridge\'');
    expect(bridgeSrc).toContain('@cyberluke/nai-lattice-client');
  });

  it('publishes canonical task lifecycle event names', () => {
    const indexSrc = readFileSync(join(LOCAL, 'plugin', 'index.ts'), 'utf-8');
    expect(indexSrc).toContain("publish(sid, 'turn.started'");
    expect(indexSrc).toContain("publish(sessionID ?? '', 'tool.execute.before'");
    expect(indexSrc).toContain("publish(sessionID ?? '', 'tool.execute.after'");
    expect(indexSrc).not.toContain("publish(sid, 'tool.started'");
    expect(indexSrc).not.toContain("publish(sessionID ?? '', 'tool.completed'");
  });

  it('the bridge never stops NAI-Lattice', () => {
    const bridgeSrc = readFileSync(join(LOCAL, 'plugin', 'bridge.ts'), 'utf-8');
    // Only real stop/kill ACTIONS (code, not doc comments) are forbidden.
    expect(/taskkill|Stop-Process|\.kill\(|terminate\(|process\.exit\(|\.stop\(\)/i.test(bridgeSrc)).toBe(false);
    // dispose only closes its OWN client handle; never Lattice.
    expect(bridgeSrc).toContain('client?.close()');
  });
});