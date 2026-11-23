'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { z } from 'zod';
import { Bot, ChevronDown, Loader2, Send, User, Wrench } from '@/lib/icons';

/**
 * MissionChat — the REAL operator conversation.
 *
 * Rows come from the mission's actual headless Kilo session (captured live by
 * the mutation runner from `client.session.messages`) plus the operator's own
 * messages. The composer POSTs to the control-plane chat route, which stores the
 * message and applies it as non-blocking steering. Markdown is rendered with
 * remark-gfm; tool calls/results are collapsible so the conversation stays
 * readable while every real command remains auditable.
 */
const ChatRowSchema = z.object({
  message_id: z.string(),
  role: z.enum(['user', 'assistant', 'system', 'operator']),
  kind: z.enum(['text', 'reasoning', 'tool_call', 'tool_result']),
  speaker: z.string().nullable().optional(),
  text: z.string().nullable(),
  tool_name: z.string().nullable(),
  tool_input: z.string().nullable(),
  tool_result: z.string().nullable(),
  seq: z.number(),
  created_at: z.string(),
});
const ChatResponseSchema = z.object({ missionId: z.string(), messages: z.array(ChatRowSchema) });
type ChatRow = z.infer<typeof ChatRowSchema>;

const POLL_MS = 2500;

function timeOf(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="prose prose-sm prose-invert prose-headings:text-white/85 prose-p:text-white/75 prose-a:text-[color:oklch(95%_0.15_108)] prose-strong:text-white/90 prose-code:rounded prose-code:bg-white/[0.08] prose-code:px-1 prose-code:py-0.5 prose-code:text-[11px] prose-code:text-white/80 prose-pre:bg-black/40 prose-pre:border prose-pre:border-white/[0.08] prose-li:text-white/75 prose-blockquote:border-l-white/20 prose-blockquote:text-white/60 max-w-none break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function ToolBlock({ label, body, tone }: { label: string; body: string; tone: 'call' | 'result' }) {
  return (
    <details className="group rounded-lg border border-white/[0.08] bg-black/25">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-1.5 text-[11px] text-white/45 hover:text-white/70">
        <Wrench className="size-3" />
        <span className="font-mono">{label}</span>
        <span className={tone === 'result' ? 'text-emerald-300/50' : 'text-white/25'}>{tone === 'result' ? 'result' : 'call'}</span>
        <ChevronDown className="ml-auto size-3 transition-transform group-open:rotate-180" />
      </summary>
      <pre className="max-h-72 overflow-auto border-t border-white/[0.06] px-4 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-white/65">
        {body}
      </pre>
    </details>
  );
}

export function MissionChat({ missionId, speakerFilter, className = '' }: { missionId: string; speakerFilter?: string; className?: string }) {
  const [rows, setRows] = useState<ChatRow[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  // Optional role filter: Reviewer A/B or the Adjudicator read the SAME mission
  // transcript, filtered to their own verdict rows.
  const visibleRows = speakerFilter ? rows.filter((row) => row.speaker === speakerFilter) : rows;
  const logRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastSeq = 0;
    let first = true;
    const mergeRows = (prev: ChatRow[], incoming: ChatRow[]): ChatRow[] => {
      const byId = new Map(prev.map((row) => [row.message_id, row]));
      for (const row of incoming) byId.set(row.message_id, row);
      const merged = [...byId.values()].sort((a, b) => a.seq - b.seq);
      return merged.length > 800 ? merged.slice(-800) : merged;
    };
    const load = async () => {
      try {
        // First paint opens on the NEWEST messages (tail); later polls fetch only
        // new rows (since). Fetching the first 800 rows made a long mission look
        // frozen at its earliest messages.
        const url = first
          ? `/api/missions/${encodeURIComponent(missionId)}/chat?tail=400`
          : `/api/missions/${encodeURIComponent(missionId)}/chat?since=${lastSeq}&limit=500`;
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = ChatResponseSchema.safeParse(await res.json());
        if (!parsed.success) throw new Error('unexpected chat response shape');
        const incoming = parsed.data.messages;
        if (incoming.length) lastSeq = Math.max(lastSeq, ...incoming.map((row) => row.seq));
        if (!disposed) {
          if (first) {
            setRows(incoming);
            first = false;
          } else if (incoming.length) {
            setRows((prev) => mergeRows(prev, incoming));
          }
          setLive(true);
          setError(null);
        }
      } catch (e) {
        if (!disposed) {
          setLive(false);
          setError(e instanceof Error ? e.message : String(e));
        }
      }
      if (!disposed) timer = setTimeout(load, POLL_MS);
    };
    setRows([]);
    setError(null);
    setLive(false);
    void load();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [missionId]);

  useEffect(() => {
    if (followRef.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [rows]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !body?.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setDraft('');
      followRef.current = true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <section className={`flex min-h-0 flex-col ${className}`}>
      <div className="mb-2 flex items-center gap-2">
        <Bot className="size-3.5 text-teal-200/70" />
        <span className="text-[10px] font-medium tracking-wide text-white/35 uppercase">Conversation</span>
        <span className="font-mono text-[10px] text-white/20">{missionId}</span>
        <span className={`ml-auto flex items-center gap-1 text-[10px] ${live ? 'text-emerald-300/70' : 'text-amber-300/70'}`}>
          <span className={`size-1.5 rounded-full ${live ? 'bg-emerald-400' : 'bg-amber-400'}`} />
          {live ? 'live' : 'reconnecting'}
        </span>
      </div>

      <div
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="h-[22rem] min-h-0 space-y-2.5 overflow-y-auto rounded-xl border border-white/[0.06] bg-white/[0.015] p-3"
      >
        {visibleRows.length === 0 && !error && (
          <div className="flex h-full items-center justify-center text-center text-xs text-white/25">
            {speakerFilter ? `No messages from ${speakerFilter} yet.` : 'No messages yet. The mission posts its real Kilo session here as it works.'}
          </div>
        )}
        {visibleRows.map((row) => {
          if (row.kind === 'tool_call' || row.kind === 'tool_result') {
            const body = row.kind === 'tool_call' ? row.tool_input ?? '' : row.tool_result ?? '';
            if (!body) return null;
            return <ToolBlock key={row.message_id} label={row.tool_name ?? 'tool'} body={body} tone={row.kind === 'tool_call' ? 'call' : 'result'} />;
          }
          if (row.kind === 'reasoning') {
            if (!row.text) return null;
            return <ToolBlock key={row.message_id} label="reasoning" body={row.text} tone="result" />;
          }
          const isOperator = row.role === 'operator';
          const isSystem = row.role === 'system';
          const isReview = row.role === 'assistant' && !!row.speaker && row.speaker !== 'soul';
          const speakerLabel = isOperator
            ? 'You'
            : row.speaker === 'reviewer-a'
              ? 'Reviewer A'
              : row.speaker === 'reviewer-b'
                ? 'Reviewer B'
                : row.speaker === 'adjudicator'
                  ? 'Adjudicator'
                  : row.role === 'user'
                    ? 'Mission brief'
                    : 'Soul';
          if (isSystem) {
            return (
              <div key={row.message_id} className="text-center text-[11px] text-white/30">
                {row.text}
              </div>
            );
          }
          return (
            <div key={row.message_id} className={`flex gap-2 ${isOperator ? 'flex-row-reverse' : ''}`}>
              <div
                className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${
                  isOperator
                    ? 'bg-teal-300/15 text-teal-200/80'
                    : isReview
                      ? 'bg-indigo-300/15 text-indigo-200/80'
                      : 'bg-white/[0.06] text-white/50'
                }`}
              >
                {isOperator ? <User className="size-3" /> : <Bot className="size-3" />}
              </div>
              <div
                className={`min-w-0 max-w-[86%] rounded-xl px-3.5 py-2 ${
                  isOperator ? 'bg-teal-300/10' : isReview ? 'bg-indigo-300/[0.07]' : 'bg-white/[0.04]'
                }`}
              >
                <div className="mb-1 flex items-center gap-2 text-[10px] text-white/30">
                  <span className="font-medium text-white/50">{speakerLabel}</span>
                  <span className="font-mono">{timeOf(row.created_at)}</span>
                </div>
                <Markdown text={row.text ?? ''} />
              </div>
            </div>
          );
        })}
      </div>

      {error && <div className="mt-1.5 text-[11px] text-amber-300/80">{error}</div>}

      <div className="mt-2 flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder="Steer the mission… (Enter to send, Shift+Enter for a new line)"
          className="min-h-[2.5rem] flex-1 resize-none rounded-lg border border-white/[0.08] bg-black/25 px-3 py-2 text-xs text-white/80 placeholder:text-white/25 focus:border-teal-300/30 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending || draft.trim().length === 0}
          className="flex h-9 items-center gap-1.5 rounded-lg bg-[linear-gradient(135deg,rgba(94,234,212,.9),rgba(167,139,250,.9))] px-3 text-xs font-medium text-[#07110f] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          Send
        </button>
      </div>
    </section>
  );
}
