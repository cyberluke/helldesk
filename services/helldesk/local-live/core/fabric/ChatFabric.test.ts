import { describe, it, expect } from 'bun:test';
import { ChatFabric, decodeChatEvent } from './ChatFabric';
import { chatSessionId, type ChatEvent } from './chat-envelope';

/**
 * break-room-mind bridge unit tests.
 *
 * These prove the HELLDESK ↔ VSIX sync LOGIC (envelope build, publish, decode,
 * local fan-out to a subscriber) without needing the engine fabric to be up.
 * Live cross-peer fan-out requires the NAF fabric (engine) reachable — that
 * path is exercised in an integration test once the engine is healthy.
 */
describe('ChatFabric (HELLDESK break-room-mind bridge)', () => {
  it('uses the shared canonical chat session id for a department', () => {
    expect(chatSessionId('default')).toBe('department:default');
    expect(chatSessionId('t1')).toBe('department:t1');
  });

  it('publishes a user message and delivers it to a local subscriber (helldesk origin)', () => {
    const fabric = new ChatFabric({ departmentId: 'default', producerId: 'test.helldesk' });
    const received: ChatEvent[] = [];
    fabric.onChat((e) => received.push(e));

    fabric.publish({ role: 'user', kind: 'text', text: 'hello from helldesk', origin: 'helldesk' });
    fabric.publish({ role: 'user', kind: 'text', text: 'second msg', origin: 'helldesk' });

    expect(received).toHaveLength(2);
    expect(received[0].session_id).toBe('department:default');
    expect(received[0].event_type).toBe('chat.user_message');
    expect(received[0].payload.role).toBe('user');
    expect(received[0].payload.text).toBe('hello from helldesk');
    expect(received[0].origin).toBe('helldesk');
    fabric.close();
  });

  it('publishes tool call + assistant message with the correct event types', () => {
    const fabric = new ChatFabric({ departmentId: 'default' });
    const received: ChatEvent[] = [];
    fabric.onChat((e) => received.push(e));

    fabric.publish({ role: 'assistant', kind: 'tool_call', toolName: 'read_file', toolInput: { path: 'x' }, origin: 'helldesk' });
    fabric.publish({ role: 'assistant', kind: 'text', text: 'here is the summary', origin: 'helldesk' });

    expect(received).toHaveLength(2);
    expect(received[0].event_type).toBe('chat.tool_call');
    expect(received[0].payload.tool_name).toBe('read_file');
    expect(received[1].event_type).toBe('chat.assistant_message');
    fabric.close();
  });

  it('decodes a NAF Event envelope that carries the chat payload (kilocode → helldesk)', () => {
    const originMsg: ChatEvent = {
      schema_version: 1,
      namespace: 'helldesk',
      session_id: 'department:default',
      event_type: 'chat.user_message',
      producer_id: 'kilocode.extension',
      event_id: 'e1',
      event_timestamp_utc_ms: 1234567890,
      origin: 'kilocode',
      payload: { role: 'user', kind: 'text', text: 'typed in the extension', ts: 1234567890 },
    };
    // Fabric delivers Event envelopes; payload = JSON of the chat event.
    const envelope = {
      kindType: 13, // KindType.Event
      payload: new TextEncoder().encode(JSON.stringify(originMsg)),
    } as never;

    const decoded = decodeChatEvent(envelope);
    expect(decoded).not.toBeNull();
    expect(decoded?.origin).toBe('kilocode');
    expect(decoded?.payload.text).toBe('typed in the extension');
    expect(decoded?.session_id).toBe('department:default');
  });

  it('also decodes the publish-frame shape ({ payload: ChatEvent }) so local fan-out matches fabric frame', () => {
    const inner: ChatEvent = {
      schema_version: 1,
      namespace: 'helldesk',
      session_id: 'department:default',
      event_type: 'chat.assistant_message',
      producer_id: 'x',
      event_id: 'e2',
      event_timestamp_utc_ms: 1,
      origin: 'kilocode',
      payload: { role: 'assistant', kind: 'text', text: 'answer reflected back', ts: 1 },
    };
    const envelope = {
      kindType: 13,
      payload: new TextEncoder().encode(JSON.stringify({ payload: inner })),
    } as never;
    const decoded = decodeChatEvent(envelope);
    expect(decoded?.payload.text).toBe('answer reflected back');
    expect(decoded?.event_type).toBe('chat.assistant_message');
  });

  it('ignores non-chat events (returns null)', () => {
    const envelope = { kindType: 12, payload: new TextEncoder().encode('{}') } as never;
    expect(decodeChatEvent(envelope)).toBeNull();
    const nonChat = { kindType: 13, payload: new TextEncoder().encode(JSON.stringify({ event_type: 'helldesk.review.finished' })) } as never;
    expect(decodeChatEvent(nonChat)).toBeNull();
  });

  it('decodes the flat event.append args shape published by the VSIX extension', () => {
    const args = {
      schema_version: 1,
      namespace: 'helldesk',
      session_id: 'department:default',
      event_type: 'chat.tool_call',
      producer_id: 'kilocode.extension',
      event_id: 'e-tool',
      event_timestamp_utc_ms: 1700000000000,
      origin: 'kilocode',
      payload: { role: 'assistant', kind: 'tool_call', tool_name: 'read_file', tool_input: { path: 'y' }, ts: 1700000000000 },
    };
    const envelope = { kindType: 13, payload: new TextEncoder().encode(JSON.stringify(args)) } as never;
    const decoded = decodeChatEvent(envelope);
    expect(decoded).not.toBeNull();
    expect(decoded?.origin).toBe('kilocode');
    expect(decoded?.event_type).toBe('chat.tool_call');
    expect(decoded?.payload.tool_name).toBe('read_file');
    expect(decoded?.session_id).toBe('department:default');
  });

  it('decodes the read_range-record shape (event fields flat, session inferred)', async () => {
    // This is exactly what ChatFabric.decodeLedgerEvent builds from an
    // event.read_range record (which has no session_id/origin of its own).
    const { decodeChatEventArgs } = await import('./ChatFabric');
    const decoded = decodeChatEventArgs({
      event_type: 'chat.tool_call',
      session_id: 'department:default',
      producer_id: 'helldesk.host-1001',
      event_id: '01a1dbd7-cb5b-7135-b017-7559xxxx',
      origin: 'kilocode',
      payload: { kind: 'tool_call', role: 'assistant', tool_name: 'read_file', tool_input: { path: '/tmp/x' }, ts: 1794689758928 },
    }, 'kilocode');
    expect(decoded).not.toBeNull();
    expect(decoded?.event_type).toBe('chat.tool_call');
    expect(decoded?.origin).toBe('kilocode');
    expect(decoded?.payload.tool_name).toBe('read_file');
    expect(decoded?.session_id).toBe('department:default');
  });
});