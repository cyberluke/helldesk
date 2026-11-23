'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ShieldCheck, Users, Layers, Bot, Loader2 } from '@/lib/icons';

/**
 * Per-task review controls (the single UI surface for both the Kanban card and
 * the task drawer).
 *
 * Persisted shape: metadata.break_room_controls
 *   { agents, reviewer, reviewerA, reviewerB, excellenceGovernor, review_mode }
 *
 * Semantics (mirrors services/helldesk/local/src/review-controls.ts):
 *   - omitted = ENABLED (backward compatible)
 *   - reviewer=false is the legacy master switch for the A/B layer
 *   - at least one of Governor / Reviewer A / Reviewer B must stay enabled
 *
 * The PUT endpoint updates the local department ticket AND the live local-engine
 * mission (controls_json) so the running task manager honours the toggle at its
 * next review boundary.
 */

export interface TicketControlTarget {
  ticket_id: string;
  metadata?: unknown;
}

type ControlKey = 'excellenceGovernor' | 'reviewerA' | 'reviewerB' | 'agents';

interface ControlFlags {
  excellenceGovernor: boolean;
  reviewerA: boolean;
  reviewerB: boolean;
  agents: boolean;
}

function readBreakRoom(ticket: TicketControlTarget): Record<string, unknown> {
  const meta = ticket.metadata;
  if (!meta || typeof meta !== 'object') return {};
  const breakRoom = (meta as { break_room_controls?: unknown }).break_room_controls;
  return breakRoom && typeof breakRoom === 'object' ? (breakRoom as Record<string, unknown>) : {};
}

function deriveFlags(breakRoom: Record<string, unknown>): ControlFlags {
  const master = breakRoom.reviewer !== false;
  return {
    excellenceGovernor: breakRoom.excellenceGovernor !== false,
    reviewerA: master && breakRoom.reviewerA !== false,
    reviewerB: master && breakRoom.reviewerB !== false,
    agents: breakRoom.agents !== false,
  };
}

function flagsFromResponse(raw: unknown, fallback: ControlFlags): ControlFlags {
  if (!raw || typeof raw !== 'object') return fallback;
  const breakRoom = raw as Record<string, unknown>;
  return deriveFlags(breakRoom);
}

const LABELS: Array<{
  key: ControlKey;
  label: string;
  hint: string;
  icon: typeof ShieldCheck;
}> = [
  {
    key: 'excellenceGovernor',
    label: 'Governor',
    hint: 'Independent ExcellenceGovernor review of each revision',
    icon: ShieldCheck,
  },
  {
    key: 'reviewerA',
    label: 'Reviewer A',
    hint: 'Independent correctness & scope reviewer',
    icon: Users,
  },
  {
    key: 'reviewerB',
    label: 'Reviewer B',
    hint: 'Independent adversarial failure hunter',
    icon: Bot,
  },
  {
    key: 'agents',
    label: 'Agents',
    hint: 'Dispatch the implementer crew for this task',
    icon: Layers,
  },
];

export function TicketControls({
  departmentId,
  ticket,
  variant = 'compact',
  onUpdated,
}: {
  departmentId?: string;
  ticket: TicketControlTarget;
  variant?: 'compact' | 'panel';
  onUpdated?: () => void;
}) {
  const breakRoom = useMemo(() => readBreakRoom(ticket), [ticket]);
  const derived = useMemo(() => deriveFlags(breakRoom), [breakRoom]);
  const signature = useMemo(
    () => JSON.stringify([ticket.ticket_id, derived.excellenceGovernor, derived.reviewerA, derived.reviewerB, derived.agents]),
    [ticket.ticket_id, derived],
  );
  const lastSignature = useRef(signature);
  const [optimistic, setOptimistic] = useState<ControlFlags | null>(null);
  const [busy, setBusy] = useState<ControlKey | null>(null);

  // The server is authoritative: clear the optimistic overlay whenever the
  // incoming ticket metadata actually changes (refetch/WebSocket update).
  useEffect(() => {
    if (signature !== lastSignature.current) {
      lastSignature.current = signature;
      setOptimistic(null);
    }
  }, [signature]);

  const flags = optimistic ?? derived;

  const toggle = async (key: ControlKey) => {
    if (!departmentId || busy) return;
    const next = !flags[key];
    const previous = flags;
    setBusy(key);
    setOptimistic({ ...flags, [key]: next });

    // Turning a reviewer ON while the legacy master switch is off must also
    // re-enable the master, otherwise the flag would be silently ineffective.
    const patch: Record<string, boolean> = { [key]: next };
    if ((key === 'reviewerA' || key === 'reviewerB') && next) patch.reviewer = true;

    try {
      const response = await fetch(
        `/api/departments/${encodeURIComponent(departmentId)}/tickets/${encodeURIComponent(ticket.ticket_id)}/controls`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        },
      );
      const body = (await response.json().catch(() => null)) as
        | { success?: boolean; error?: string; data?: { break_room_controls?: unknown } }
        | null;
      if (!response.ok || body?.success !== true) {
        throw new Error(body?.error ?? `HTTP ${response.status}`);
      }
      const confirmed = flagsFromResponse(body?.data?.break_room_controls, { ...previous, [key]: next });
      setOptimistic(confirmed);
      onUpdated?.();
    } catch (error) {
      setOptimistic(previous);
      toast.error(error instanceof Error ? error.message : 'Could not update task controls');
    } finally {
      setBusy(null);
    }
  };

  if (!departmentId) {
    return variant === 'panel' ? (
      <div className="text-[11px] text-white/30">Task controls unavailable without a department context.</div>
    ) : null;
  }

  if (variant === 'panel') {
    return (
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2">
          {LABELS.map(item => {
            const on = flags[item.key];
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                title={item.hint}
                disabled={busy === item.key}
                onClick={() => void toggle(item.key)}
                className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-60 ${
                  on
                    ? 'border-teal-300/20 bg-teal-300/[0.08] text-teal-100/85 hover:bg-teal-300/[0.13]'
                    : 'border-white/[0.06] bg-white/[0.02] text-white/40 hover:bg-white/[0.05]'
                }`}
              >
                <span className="mt-0.5 shrink-0">
                  {busy === item.key ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold">
                    {item.label}
                    <span
                      className={`rounded px-1 py-0.5 text-[8px] font-bold tracking-wide uppercase ${
                        on ? 'bg-teal-300/15 text-teal-100/80' : 'bg-white/[0.04] text-white/30'
                      }`}
                    >
                      {on ? 'on' : 'off'}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-[9px] leading-snug text-white/30">{item.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
        <p className="text-[9px] leading-snug text-white/25">
          Changes apply live at the next review boundary. A task must keep at least one of Governor / Reviewer A /
          Reviewer B enabled.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1" onClick={event => event.stopPropagation()}>
      {LABELS.map(item => {
        const on = flags[item.key];
        const Icon = item.icon;
        const shortLabel = item.key === 'excellenceGovernor' ? 'Governor' : item.key === 'reviewerA' ? 'Rev A' : item.key === 'reviewerB' ? 'Rev B' : 'Agents';
        return (
          <button
            key={item.key}
            type="button"
            title={`${on ? 'Disable' : 'Enable'} ${item.label} — ${item.hint}`}
            disabled={busy === item.key}
            onClick={() => void toggle(item.key)}
            className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-1 text-[9px] font-semibold transition-colors disabled:opacity-60 ${
              on
                ? 'border-teal-300/15 bg-teal-300/[0.07] text-teal-100/80 hover:bg-teal-300/[0.12]'
                : 'border-white/[0.05] bg-white/[0.02] text-white/25 hover:bg-white/[0.05]'
            }`}
          >
            {busy === item.key ? <Loader2 className="size-2.5 animate-spin" /> : <Icon className="size-2.5" />}
            {shortLabel}
          </button>
        );
      })}
    </div>
  );
}
