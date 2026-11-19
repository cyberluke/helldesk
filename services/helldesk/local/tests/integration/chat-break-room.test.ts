import { describe, it, expect } from 'bun:test';
import { decodeChatFromArgs } from '../../plugin/bridge';

/**
 * Cross-peer break-room-mind contract test: proves that the exact `event.append` args
 * shape the HELLDESK `ChatFabric` publishes is decodable by the VSIX extension
 * bridge (and vice versa) WITHOUT needing the engine fabric up. The two sides
 * agree on the shared session id + chat event wire contract.
 */
describe('HELLDESK ↔ VSIX break-room-mind wire contract', () => {
  it('decodes a HELLDESK-published user message into a mirrored extension event', () => {
    // shape mirrors services/helldesk/local-live/core/fabric/ChatFabric.helldeskEventArgs
    const gasDepartmentArgs = {
      schema_version: 1,
      namespace: 'helldesk',
      session_id: 'department:default',
      event_type: 'chat.user_message',
      producer_id: 'helldesk.dashboard-123',
      producer_epoch: 1,
      producer_sequence: 7,
      event_id: 'evt-user-1',
      event_timestamp_utc_ms: 1794658724041,
      payload: { role: 'user', kind: 'text', text: 'hello from helldesk', ts: 1794658724041 },
      origin: 'helldesk',
    };

    const chat = decodeChatFromArgs(gasDepartmentArgs);
    expect(chat).not.toBeNull();
    expect(chat?.session_id).toBe('department:default');
    expect(chat?.event_type).toBe('chat.user_message');
    expect(chat?.origin).toBe('helldesk');
    expect(chat?.payload.role).toBe('user');
    expect(chat?.payload.text).toBe('hello from helldesk');
  });

  it('decodes a HELLDESK-published tool call', () => {
    const gasDepartmentArgs = {
      schema_version: 1,
      namespace: 'helldesk',
      session_id: 'department:default',
      event_type: 'chat.tool_call',
      producer_id: 'helldesk.dashboard-123',
      event_id: 'evt-tool-1',
      event_timestamp_utc_ms: 1794658724041,
      payload: { role: 'assistant', kind: 'tool_call', tool_name: 'read_file', tool_input: { path: 'x' }, ts: 1794658724041 },
      origin: 'helldesk',
    };
    const chat = decodeChatFromArgs(gasDepartmentArgs);
    expect(chat?.event_type).toBe('chat.tool_call');
    expect(chat?.payload.kind).toBe('tool_call');
    expect(chat?.payload.tool_name).toBe('read_file');
  });

  it('ignores non-chat event.append args', () => {
    const args = { event_type: 'helldesk.review.finished', session_id: 'x', producer_id: 'y', payload: {} };
    expect(decodeChatFromArgs(args)).toBeNull();
    const noType = { session_id: 'x' };
    expect(decodeChatFromArgs(noType as Record<string, unknown>)).toBeNull();
  });
});