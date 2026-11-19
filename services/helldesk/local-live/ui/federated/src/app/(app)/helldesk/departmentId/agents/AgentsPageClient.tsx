'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueries, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { useDrawerStack } from '@/components/helldesk/DrawerStack';
import { Button } from '@/components/Button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Bot, Crown, Shield, Clock, Hexagon, Plus } from '@/lib/icons';
import { formatDistanceToNow } from 'date-fns';
import { motion, AnimatePresence } from 'motion/react';
import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';
import { toast } from 'sonner';

type RouterOutputs = inferRouterOutputs<RootRouter>;
type Agent = RouterOutputs['helldesk']['listAgents'][number];

const ROLE_ICONS: Record<string, typeof Bot> = {
  soul: Bot,
  frontDesk: Crown,
  qualityAssurance: Shield,
};

const STATUS_COLORS: Record<string, string> = {
  idle: 'bg-white/20',
  working: 'bg-emerald-400',
  stalled: 'bg-amber-400',
  dead: 'bg-red-400',
};

export function AgentsPageClient({ departmentId }: { departmentId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { open: openDrawer } = useDrawerStack();
  const [createOpen, setCreateOpen] = useState(false);
  const [workstationId, setWorkstationId] = useState('');
  const [role, setRole] = useState('soul');
  const [name, setName] = useState('');
  const [identity, setIdentity] = useState('');

  const workstationsQuery = useQuery(trpc.helldesk.listWorkstations.queryOptions({ departmentId }));
  const workstations = workstationsQuery.data ?? [];

  useEffect(() => {
    if (!workstationId && workstations[0]?.id) setWorkstationId(workstations[0].id);
  }, [workstations, workstationId]);

  const workstationAgentQueries = useQueries({
    queries: workstations.map(workstation => ({
      ...trpc.helldesk.listAgents.queryOptions({ departmentId, workstationId: workstation.id }),
      refetchInterval: 5_000,
    })),
  });

  const workstationAgentData = workstationAgentQueries.map(query => query.data);
  const allAgents = useMemo(() => {
    const agents: Array<Agent & { workstationName: string; workstationId: string }> = [];
    workstationAgentData.forEach((data, index) => {
      const workstation = workstations[index];
      if (!data || !workstation) return;
      for (const agent of data) agents.push({ ...agent, workstationName: workstation.name, workstationId: workstation.id });
    });
    return agents;
  }, [workstationAgentData, workstations]);

  const createAgent = useMutation(
    trpc.helldesk.createAgent.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ['helldesk', 'listAgents'] });
        toast.success('Agent created');
        setCreateOpen(false);
        setName('');
        setIdentity('');
      },
      onError: (error: Error) => toast.error(error.message),
    })
  );

  const submit = () => {
    const cleanName = name.trim();
    if (!workstationId || !cleanName) return;
    createAgent.mutate({
      departmentId,
      workstationId,
      role,
      name: cleanName,
      identity: identity.trim() || `operator:${role}:${cleanName.toLowerCase().replace(/\s+/g, '-')}`,
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-6 py-3.5">
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-teal-200/70" />
          <h1 className="text-lg font-semibold tracking-[-0.025em] text-white/90">Agents</h1>
          <span className="ml-1 font-mono text-xs text-white/30">{allAgents.length}</span>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => setCreateOpen(true)}
          disabled={workstations.length === 0}
          className="gap-1.5 bg-[linear-gradient(135deg,rgba(94,234,212,.92),rgba(167,139,250,.92))] text-[#07110f] hover:brightness-110"
        >
          <Plus className="size-3.5" />
          New Agent
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {allAgents.length === 0 && !workstationsQuery.isLoading && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Bot className="mb-3 size-8 text-white/10" />
            <p className="text-sm text-white/35">No agents yet.</p>
            <p className="mt-1 text-xs text-white/20">Create one explicitly or sling work and let HELLDESK allocate the crew.</p>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          <AnimatePresence mode="popLayout">
            {allAgents.map((agent, index) => {
              const RoleIcon = ROLE_ICONS[agent.role] ?? Bot;
              return (
                <motion.button
                  type="button"
                  key={agent.id}
                  initial={{ opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{ delay: Math.min(index * 0.025, 0.2), duration: 0.18 }}
                  onClick={() => openDrawer({ type: 'agent', agentId: agent.id, workstationId: agent.workstationId, departmentId })}
                  className="group rounded-2xl border border-white/[0.06] bg-[linear-gradient(145deg,rgba(20,27,37,.8),rgba(10,13,19,.92))] p-4 text-left shadow-[0_18px_46px_rgba(0,0,0,.18)] transition hover:-translate-y-px hover:border-violet-300/20"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className="flex size-9 items-center justify-center rounded-xl border border-white/[0.07] bg-white/[0.035]">
                        <RoleIcon className="size-4 text-teal-100/65" />
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-semibold text-white/85">{agent.name}</span>
                          <span className={`size-1.5 rounded-full ${STATUS_COLORS[agent.status] ?? 'bg-white/20'}`} />
                        </div>
                        <div className="mt-0.5 text-[10px] capitalize tracking-wide text-white/30">{agent.role}</div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex items-center gap-3 text-[10px] text-white/30">
                    <span className="inline-flex items-center gap-1">
                      <Hexagon className="size-2.5" />
                      {agent.current_hook_ticket_id ? agent.current_hook_ticket_id.slice(0, 8) : 'idle'}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Clock className="size-2.5" />
                      {agent.last_activity_at ? formatDistanceToNow(new Date(agent.last_activity_at), { addSuffix: true }) : 'never'}
                    </span>
                  </div>
                  <div className="mt-2 text-[10px] text-white/20">{agent.workstationName}</div>
                </motion.button>
              );
            })}
          </AnimatePresence>
        </div>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="border-white/[0.08] bg-[#0c1118] shadow-2xl">
          <DialogHeader>
            <DialogTitle>Create agent</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[.08em] text-white/35">Workstation</label>
              <Select value={workstationId} onValueChange={setWorkstationId}>
                <SelectTrigger className="border-white/[0.08] bg-white/[0.03]"><SelectValue placeholder="Choose workstation" /></SelectTrigger>
                <SelectContent>
                  {workstations.map(workstation => <SelectItem key={workstation.id} value={workstation.id}>{workstation.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[.08em] text-white/35">Role</label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger className="border-white/[0.08] bg-white/[0.03]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="soul">Polecat</SelectItem>
                  <SelectItem value="qualityAssurance">Reviewer</SelectItem>
                  <SelectItem value="frontDesk">FrontDesk</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[.08em] text-white/35">Name</label>
              <Input value={name} onChange={event => setName(event.target.value)} placeholder="Rika Redline" className="border-white/[0.08] bg-white/[0.03]" />
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[.08em] text-white/35">Identity <span className="normal-case tracking-normal text-white/20">(optional)</span></label>
              <Input value={identity} onChange={event => setIdentity(event.target.value)} placeholder="auto-generated when empty" className="border-white/[0.08] bg-white/[0.03] font-mono" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" size="md" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" size="md" disabled={!workstationId || !name.trim() || createAgent.isPending} onClick={submit}>
              {createAgent.isPending ? 'Creating…' : 'Create agent'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
