/**
 * ws-pty-bridge — bidirectional bridge between a Bun ServerWebSocket and a
 * PtyManager session. This is the local wire path the frontDesk/agent terminal
 * panes connect to: the browser sends PTY input as WS messages, and PTY
 * output streams back as WS messages (binary chunks).
 *
 * One WS maps to one detachable PtySubscription. On WS close, the caller must
 * call detachSub() to remove this socket's subscribers (fixing the leak where
 * output was duplicated to every previously-attached socket).
 */
import type { PtyManager, PtySubscription } from './PtyManager';

export interface WsPtyBridgeOptions {
  departmentId: string;
  agentId: string;
  ptyId: string;
  pty: PtyManager;
}

export interface WsPtyConnection {
  /** Detach this socket's PTY subscribers (call on WS close/error). */
  detachSub(): void;
}

export function openConnection(
  ws: import('bun').ServerWebSocket<any>,
  opts: WsPtyBridgeOptions
): WsPtyConnection | null {
  const { departmentId, agentId, ptyId, pty } = opts;

  const attached = pty.attachOutput(departmentId, agentId, ptyId, {
    send: (data) => {
      try {
        ws.send(data);
      } catch {
        /* socket gone */
      }
    },
    readyState: ws.readyState,
    close: (code, reason) => {
      try {
        ws.close(code ?? 1000, reason);
      } catch {
        /* ignore */
      }
    },
  });

  if (!attached) {
    ws.send(JSON.stringify({ type: 'error', message: 'pty session not running' }));
    try { ws.close(1011, 'no pty'); } catch { /* ignore */ }
    return null;
  }

  return { detachSub: () => attached.detach() };
}