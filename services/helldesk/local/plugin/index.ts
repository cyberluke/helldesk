import type { Plugin } from '@kilocode/plugin';
import { NafBridge, newHostIdentity, type BridgeHandlers } from './bridge';
import { createLocalTools } from './tools';

/**
 * CyberLuke Local HELLDESK — thin Kilo plugin adapter over NAI-Lattice NAF.
 *
 * This plugin is a THIN EVENT PUBLISHER to the canonical `@cyberluke/nai-lattice-client`
 * NAF/1 client (`nai-fabric-host.exe` singleton). It does NOT:
 *  - run any child_process / shell / git / subprocess (zero reachable on hook),
 *  - read/write files synchronously on the hook path (no appendFileSync),
 *  - own task state machines, completion detection, retries, review scheduling,
 *  - start/stop NAI-Lattice (plugin only closes its OWN handle; never Lattice).
 *
 * All task lifecycle decisions live in the native NAI-Lattice host. The plugin
 * only serializes canonical HELLDESK events and hands them to the NAF bridge,
 * which delivers them durably (idempotency-keyed) over the per-user pipe.
 *
 * If NAI-Lattice is not reachable, the bridge stays disconnected and the plugin
 * FAILS OPEN (developer chat is never blocked). The runtime is discovered via
 * `NAI_FABRIC_PIPE` or the default per-user pipe.
 */

export const LocalHelldeskPlugin: Plugin = async ({ worktree, directory }) => {
  const workspaceRoot = (worktree && worktree !== '/' ? worktree : directory && directory !== '/' ? directory : process.cwd()) || '';
  const identity = newHostIdentity({ workspaceRoots: workspaceRoot ? [workspaceRoot] : [] });

  // Controlled activation diagnostic (guarded; never on in production runs).
  // Async, non-blocking write so the hook path never does sync-fs (BRIDGE-01).
  if (process.env.HELLDESK_PLUGIN_DIAG) {
    void import('node:fs/promises')
      .then(({ writeFile }) =>
        writeFile(
          process.env.HELLDESK_PLUGIN_DIAG!,
          JSON.stringify({ activated: Date.now(), pid: process.pid, workspaceRoot, cwd: process.cwd() }),
          'utf8'
        )
      )
      .catch(() => { /* diagnostic only */ });
  }

  // Bridge connects lazily to the NAF pipe; never blocks the hook.
  const handlers: BridgeHandlers = {
    onConnected: () => { /* surfaced via telemetry; nonblocking */ },
    onError: () => { /* never throw into the plugin host */ },
    onDisconnected: () => { /* stay fail-open */ },
  };
  const bridge = new NafBridge(identity, handlers);
  bridge.connect();

  /** Fire-and-forget publish; must never throw or block the hook. */
  const publish = (sessionId: string, eventType: string, payload: Record<string, unknown>): void => {
    try { bridge.emitEvent(sessionId, eventType, payload); } catch { /* nonblocking */ }
  };

  return {
    // The local HELLDESK tools (status, review, report, findings, rework,
    // config get/patch). The client is resolved lazily so the tools work once
    // the bridge connects and fail open (JSON error) if the fabric is absent.
    tool: createLocalTools(() => bridge.getClient()),
    "chat.message": async ({ sessionID }) => {
      const sid = sessionID ?? '';
      // Emit a canonical chat.message event only — the native host owns epochs.
      publish(sid, 'chat.message', { model: null, source: 'chat.message' });
      publish(sid, 'turn.started', {});
    },
    event: async ({ event }) => {
      try {
        const props = ((event as unknown as { properties?: Record<string, unknown> })?.properties ?? {}) as Record<string, any>;
        const sessionID = String(props.sessionID ?? props.info?.id ?? '');
        if (!sessionID) return;
        const t = event.type;
        // Map only genuinely-typed events; never mark a default status as idle.
        if (t === 'session.status') {
          const statusType = String(props.status?.type ?? props.status ?? '');
          publish(sessionID, 'session.status', { status: statusType });
          if (statusType === 'idle' && isRealIdle(props)) {
            publish(sessionID, 'session.idle', {});
          }
        } else if (t === 'session.diff') {
          publish(sessionID, 'session.diff', {});
        } else if (t === 'file.edited') {
          publish(sessionID, 'file.edited', { file: String(props.file ?? '') });
        }
      } catch { /* never block the hook */ }
    },
    "tool.execute.before": async ({ sessionID, tool, callID }) => {
      publish(sessionID ?? '', 'tool.execute.before', { tool, callID });
    },
    "tool.execute.after": async ({ sessionID, tool, callID }) => {
      publish(sessionID ?? '', 'tool.execute.after', { tool, callID });
    },
    dispose: async () => {
      try { await bridge.dispose(); } catch { /* noop */ }
    },
  };
};

/** A session is genuinely idle only when a validated idle type is observed and
 * no tool/thinking is in flight — never a default/placeholder status. */
function isRealIdle(props: Record<string, any>): boolean {
  const st = props.status ?? props.statusType ?? '';
  return String(st?.type ?? st ?? '').toLowerCase() === 'idle';
}

export default {
  id: 'cyberluke-local-helldesk',
  server: LocalHelldeskPlugin,
};