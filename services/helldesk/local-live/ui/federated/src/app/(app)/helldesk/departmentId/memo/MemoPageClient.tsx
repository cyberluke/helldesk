'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/Button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Memo, Plus, Trash2 } from '@/lib/icons';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

type MemoTicket = {
  ticket_id: string;
  title: string;
  body: string | null;
  status: string;
  metadata?: Record<string, unknown>;
  created_by?: string | null;
  created_at: string;
  closed_at?: string | null;
};

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as { success?: boolean; data?: T; error?: string };
  if (!response.ok || body.success === false) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body.data as T;
}

export function MemoPageClient({ departmentId }: { departmentId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [composerOpen, setComposerOpen] = useState(false);
  const [editing, setEditing] = useState<MemoTicket | null>(null);
  const [recipient, setRecipient] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  const workstationsQuery = useQuery(trpc.helldesk.listWorkstations.queryOptions({ departmentId }));
  const workstations = workstationsQuery.data ?? [];
  const agentQueries = useQueries({
    queries: workstations.map(workstation => ({
      ...trpc.helldesk.listAgents.queryOptions({ departmentId, workstationId: workstation.id }),
      refetchInterval: 5_000,
    })),
  });

  const agents = useMemo(
    () => agentQueries.flatMap(query => query.data ?? []),
    [agentQueries.map(query => query.data)]
  );

  const memosQuery = useQuery({
    queryKey: ['helldesk', 'memos', departmentId],
    queryFn: async () => readJson<MemoTicket[]>(await fetch(`/api/departments/${encodeURIComponent(departmentId)}/memos`)),
    refetchInterval: 5_000,
  });

  const memos = (memosQuery.data ?? []).slice().sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));

  useEffect(() => {
    if (!recipient && agents[0]?.id) setRecipient(agents[0].id);
  }, [agents, recipient]);

  const createMemo = useMutation({
    mutationFn: async () => readJson<{ sent: true }>(await fetch(`/api/departments/${encodeURIComponent(departmentId)}/memos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_agent_id: 'operator', to_agent_id: recipient, subject: subject.trim(), body: body.trim() }),
    })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['helldesk', 'memos', departmentId] });
      toast.success('Memo sent');
      setComposerOpen(false);
      setSubject('');
      setBody('');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const updateMemo = useMutation({
    mutationFn: async (memo: MemoTicket) => readJson<MemoTicket>(await fetch(
      `/api/departments/${encodeURIComponent(departmentId)}/memos/${encodeURIComponent(memo.ticket_id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: subject.trim(), body: body.trim() }),
      },
    )),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['helldesk', 'memos', departmentId] });
      toast.success('Memo updated');
      setEditing(null);
      setSubject('');
      setBody('');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const deleteMemo = useMutation({
    mutationFn: async (memo: MemoTicket) => readJson<{ deleted: true }>(await fetch(
      `/api/departments/${encodeURIComponent(departmentId)}/memos/${encodeURIComponent(memo.ticket_id)}`,
      { method: 'DELETE' },
    )),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['helldesk', 'memos', departmentId] });
      toast.success('Memo deleted');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const openEdit = (memo: MemoTicket) => {
    setEditing(memo);
    setSubject(memo.title);
    setBody(memo.body ?? '');
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-6 py-3.5">
        <div>
          <div className="flex items-center gap-2">
            <Memo className="size-4 text-teal-200/70" />
            <h1 className="text-lg font-semibold tracking-[-0.025em] text-white/90">Memo</h1>
            <span className="ml-1 font-mono text-xs text-white/30">{memos.length}</span>
          </div>
          <p className="mt-1 text-[11px] text-white/30">Durable agent mailbox. Memos survive sessions and are delivered when an agent primes.</p>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            setEditing(null);
            setSubject('');
            setBody('');
            setComposerOpen(true);
          }}
          disabled={agents.length === 0}
          className="gap-1.5 bg-[linear-gradient(135deg,rgba(94,234,212,.92),rgba(167,139,250,.92))] text-[#07110f]"
        >
          <Plus className="size-3.5" />
          New memo
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {memos.length === 0 && !memosQuery.isLoading && (
          <div className="flex h-full min-h-[320px] flex-col items-center justify-center text-center">
            <Memo className="mb-4 size-9 text-white/10" />
            <p className="text-sm text-white/35">No durable memos yet.</p>
            <p className="mt-1 max-w-md text-xs leading-5 text-white/20">Use memos for asynchronous agent-to-agent or operator-to-agent context that must survive restarts.</p>
          </div>
        )}

        {memos.map(memo => {
          const to = typeof memo.metadata?.to_agent_id === 'string' ? memo.metadata.to_agent_id : '';
          const from = typeof memo.metadata?.from_agent_id === 'string' ? memo.metadata.from_agent_id : (memo.created_by ?? '');
          const recipientAgent = agents.find(agent => agent.id === to);
          return (
            <article key={memo.ticket_id} className="group flex items-start gap-4 border-b border-white/[0.045] px-6 py-4 transition-colors hover:bg-white/[0.018]">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-violet-300/10 bg-violet-300/[0.045]">
                <Memo className="size-3.5 text-violet-100/60" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-sm font-semibold tracking-[-0.01em] text-white/82">{memo.title}</h2>
                  <span className="rounded-md border border-white/[0.06] bg-white/[0.025] px-1.5 py-0.5 text-[9px] uppercase tracking-[.08em] text-white/30">{memo.status}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[9px] text-white/25">
                  <span>{from || 'operator'} → {recipientAgent?.name ?? to.slice(0, 12) || 'agent'}</span>
                  <span>·</span>
                  <span>{formatDistanceToNow(new Date(memo.created_at), { addSuffix: true })}</span>
                  <span>·</span>
                  <span>{memo.ticket_id.slice(0, 8)}</span>
                </div>
                {memo.body && <p className="mt-2 max-w-4xl whitespace-pre-wrap text-xs leading-5 text-white/50">{memo.body}</p>}
              </div>
              <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                {memo.status === 'open' && (
                  <button type="button" onClick={() => openEdit(memo)} className="rounded-lg border border-white/[0.06] px-2 py-1 text-[10px] text-white/35 hover:bg-white/[0.04] hover:text-white/70">Edit</button>
                )}
                <button
                  type="button"
                  aria-label="Delete memo"
                  onClick={() => deleteMemo.mutate(memo)}
                  className="rounded-lg border border-white/[0.06] p-1.5 text-white/25 hover:border-red-300/15 hover:bg-red-300/[0.06] hover:text-red-200"
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            </article>
          );
        })}
      </div>

      <Dialog open={composerOpen} onOpenChange={setComposerOpen}>
        <DialogContent className="border-white/[0.08] bg-[#0c1118]">
          <DialogHeader><DialogTitle>New memo</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[.08em] text-white/35">To</label>
              <Select value={recipient} onValueChange={setRecipient}>
                <SelectTrigger className="border-white/[0.08] bg-white/[0.03]"><SelectValue placeholder="Choose agent" /></SelectTrigger>
                <SelectContent>
                  {agents.map(agent => <SelectItem key={agent.id} value={agent.id}>{agent.name} · {agent.role}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Input value={subject} onChange={event => setSubject(event.target.value)} placeholder="Subject" className="border-white/[0.08] bg-white/[0.03]" />
            <Textarea value={body} onChange={event => setBody(event.target.value)} placeholder="Context that must survive the current chat/session…" rows={8} className="border-white/[0.08] bg-white/[0.03]" />
          </div>
          <DialogFooter>
            <Button variant="secondary" size="md" onClick={() => setComposerOpen(false)}>Cancel</Button>
            <Button variant="primary" size="md" onClick={() => createMemo.mutate()} disabled={!recipient || !subject.trim() || !body.trim() || createMemo.isPending}>
              {createMemo.isPending ? 'Sending…' : 'Send memo'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editing)} onOpenChange={open => !open && setEditing(null)}>
        <DialogContent className="border-white/[0.08] bg-[#0c1118]">
          <DialogHeader><DialogTitle>Edit undelivered memo</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <Input value={subject} onChange={event => setSubject(event.target.value)} placeholder="Subject" className="border-white/[0.08] bg-white/[0.03]" />
            <Textarea value={body} onChange={event => setBody(event.target.value)} rows={8} className="border-white/[0.08] bg-white/[0.03]" />
          </div>
          <DialogFooter>
            <Button variant="secondary" size="md" onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" size="md" onClick={() => editing && updateMemo.mutate(editing)} disabled={!editing || !subject.trim() || !body.trim() || updateMemo.isPending}>
              {updateMemo.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
