'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Check,
  CheckCircle,
  Clock,
  FileText,
  GitBranch,
  Hash,
  Loader2,
  RefreshCw,
  Scale,
  ShieldCheck,
  X,
} from '@/lib/icons';
import {
  getMissionReport,
  requestMissionReReview,
  submitMissionAcceptance,
  updateMissionTicketSize,
  type MissionReport,
} from '@/lib/mission-client';

const TSHIRT_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'] as const;

/**
 * The durable mission completion record + the human acceptance gate.
 *
 * Machine VERIFIED_10_10 is not acceptance. Until the operator decides, the card
 * stays in review and this panel shows Accept / Request changes. The same panel
 * shows the review policy that actually ran (Governor / Reviewer A / Reviewer B),
 * per-role models + tokens, gates, evidence, commits and the acceptance history.
 */
export function MissionReportPanel({
  missionId,
  onUpdated,
}: {
  missionId: string;
  onUpdated?: () => void;
}) {
  const reportQuery = useQuery({
    queryKey: ['mission-report', missionId],
    queryFn: () => getMissionReport(missionId),
    refetchInterval: 15000,
  });
  const report = reportQuery.data ?? null;
  const [decision, setDecision] = useState<'accepted' | 'changes_requested' | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [reReviewBusy, setReReviewBusy] = useState(false);
  const [sizeBusy, setSizeBusy] = useState<string | null>(null);

  if (reportQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 px-5 py-4 text-[11px] text-white/30">
        <Loader2 className="size-3.5 animate-spin" /> Loading mission report…
      </div>
    );
  }
  if (!report) {
    return (
      <div className="px-5 py-4 text-[11px] text-white/30">
        Mission report unavailable — is the local engine running?
      </div>
    );
  }

  const review = report.review;
  const reviewInFlight = ['REVIEWING_A_B', 'ADJUDICATING', 'RUNNING'].includes(review.state ?? '');
  const reviewQueued = ['DISCOVERED', 'SNAPSHOTTED', 'QUEUED'].includes(review.state ?? '');
  const revisionReviewable = ['EVIDENCE_CAPTURED', 'VERIFYING'].includes(
    report.tickets.find(t => t.ticketId === review.ticketId)?.revisionState ?? '',
  );
  const canReReview =
    report.mission.state !== 'CANCELLED' &&
    report.mission.state !== 'VERIFIED_10_10' &&
    !reviewInFlight &&
    (reviewQueued || revisionReviewable);

  const decide = async (choice: 'accepted' | 'changes_requested') => {
    if (choice === 'changes_requested' && !note.trim()) {
      toast.error('Describe the change you want before requesting changes.');
      return;
    }
    setBusy(true);
    try {
      const result = await submitMissionAcceptance(missionId, choice, note.trim() || undefined);
      toast.success(
        choice === 'accepted' ? 'Mission accepted and closed.' : 'Change request recorded — the mission is reopened.',
        { description: choice === 'accepted' ? 'Human acceptance is now part of the durable record.' : 'A follow-up ticket carries your note.' },
      );
      setDecision(null);
      setNote('');
      await reportQuery.refetch();
      onUpdated?.();
      return result;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Acceptance failed');
    } finally {
      setBusy(false);
    }
  };

  const setTicketSize = async (ticketId: string, tshirt: string) => {
    setSizeBusy(ticketId);
    try {
      const result = await updateMissionTicketSize(ticketId, tshirt);
      toast.success(`Task sized ${tshirt} · ${result.storyPoints} pts`);
      await reportQuery.refetch();
      onUpdated?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update the task size');
    } finally {
      setSizeBusy(null);
    }
  };

  const reReview = async () => {
    setReReviewBusy(true);
    try {
      const result = await requestMissionReReview(missionId);
      toast.success(
        result.action === 'executed' ? 'Queued review started now.' : 'Re-review queued on the same snapshot.',
        { description: 'The current review policy is applied; the previous verdict remains in the audit trail.' },
      );
      await reportQuery.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Re-review failed');
    } finally {
      setReReviewBusy(false);
    }
  };

  return (
    <div className="border-b border-white/[0.06] px-5 py-4">
      <div className="mb-3 flex items-center gap-2">
        <FileText className="size-3.5 text-white/30" />
        <span className="text-[10px] font-medium tracking-wide text-white/40 uppercase">Mission Report</span>
        <span className="ml-auto rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide bg-white/[0.04] text-white/40">
          {report.mission.state}
        </span>
      </div>

      {/* Acceptance gate / completion state */}
      {report.mission.awaitingHumanAcceptance ? (
        <div className="mb-3 rounded-lg border border-amber-300/20 bg-amber-300/[0.06] p-3">
          <div className="flex items-center gap-2 text-[11px] font-semibold text-amber-100/90">
            <ShieldCheck className="size-3.5" />
            Awaiting your acceptance
          </div>
          <p className="mt-1 text-[10px] leading-snug text-amber-100/50">
            Machine verification passed. Nothing closes until you accept — or tell the team what to change.
          </p>
          {decision === null ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setDecision('accepted')}
                className="inline-flex items-center gap-1.5 rounded-md border border-teal-300/25 bg-teal-300/10 px-2.5 py-1.5 text-[10px] font-semibold text-teal-100/90 hover:bg-teal-300/15"
              >
                <Check className="size-3" /> Accept & close
              </button>
              <button
                type="button"
                onClick={() => setDecision('changes_requested')}
                className="inline-flex items-center gap-1.5 rounded-md border border-amber-300/20 bg-amber-300/[0.06] px-2.5 py-1.5 text-[10px] font-semibold text-amber-100/80 hover:bg-amber-300/10"
              >
                <X className="size-3" /> Request changes
              </button>
            </div>
          ) : (
            <div className="mt-3">
              <textarea
                value={note}
                onChange={event => setNote(event.target.value)}
                rows={3}
                autoFocus
                placeholder={
                  decision === 'accepted'
                    ? 'Optional acceptance note (what you verified / any residual risk)'
                    : 'What must change? This becomes the follow-up ticket objective.'
                }
                className="w-full resize-y rounded-md border border-white/[0.08] bg-black/20 px-2.5 py-2 text-[11px] text-white/80 placeholder:text-white/20 focus:border-teal-300/30 focus:outline-none"
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide(decision)}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[10px] font-semibold disabled:opacity-50 ${
                    decision === 'accepted'
                      ? 'border border-teal-300/25 bg-teal-300/10 text-teal-100/90 hover:bg-teal-300/15'
                      : 'border border-amber-300/20 bg-amber-300/10 text-amber-100/80 hover:bg-amber-300/15'
                  }`}
                >
                  {busy ? <Loader2 className="size-3 animate-spin" /> : decision === 'accepted' ? <Check className="size-3" /> : <X className="size-3" />}
                  {decision === 'accepted' ? 'Confirm acceptance' : 'Send change request'}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => { setDecision(null); setNote(''); }}
                  className="text-[10px] text-white/30 hover:text-white/60"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ) : report.mission.humanAcceptance === 'accepted' ? (
        <div className="mb-3 rounded-lg border border-teal-300/15 bg-teal-300/[0.05] p-3 text-[11px] text-teal-100/80">
          <div className="flex items-center gap-2 font-semibold">
            <CheckCircle className="size-3.5" /> HUMAN ACCEPTED
          </div>
          <div className="mt-1 text-[10px] text-teal-100/50">
            {report.mission.humanAcceptedBy ?? 'operator'} · {formatDate(report.mission.humanAcceptedAt)}
          </div>
          {report.mission.humanAcceptanceNote ? (
            <p className="mt-1 text-[10px] leading-snug text-teal-100/60">{report.mission.humanAcceptanceNote}</p>
          ) : null}
        </div>
      ) : report.mission.humanAcceptance === 'changes_requested' ? (
        <div className="mb-3 rounded-lg border border-amber-300/15 bg-amber-300/[0.05] p-3 text-[11px] text-amber-100/80">
          <div className="flex items-center gap-2 font-semibold">
            <X className="size-3.5" /> CHANGES REQUESTED
          </div>
          {report.mission.humanAcceptanceNote ? (
            <p className="mt-1 text-[10px] leading-snug text-amber-100/60">{report.mission.humanAcceptanceNote}</p>
          ) : null}
        </div>
      ) : null}

      {/* Verdict + policy audit */}
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
          <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wide text-white/30">
            <Scale className="size-3" /> Final review
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className={`text-[12px] font-semibold ${review.result === 'PASS' ? 'text-teal-100/90' : 'text-amber-100/90'}`}>
              {review.result ?? '—'}
            </span>
            <span className="text-[9px] text-white/25">{review.state ?? 'no review job'}</span>
          </div>
          <div className="mt-1 text-[9px] text-white/30">
            job {review.jobId ? `${review.jobId.slice(0, 18)}…` : '—'} · rev {review.revisionNo ?? '—'}
          </div>
          <div className="mt-1 flex items-center gap-1 text-[9px] text-white/30">
            <Clock className="size-2.5" /> {formatDate(review.completedAt)}
          </div>
        </div>
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
          <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wide text-white/30">
            <ShieldCheck className="size-3" /> Review policy
          </div>
          <div className="mt-1 text-[11px] leading-snug text-white/70">{review.policy?.summary ?? 'No review policy recorded'}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {review.policy ? (
              <>
                <PolicyChip label="A" on={review.policy.reviewerA} />
                <PolicyChip label="B" on={review.policy.reviewerB} />
                <PolicyChip label="GOV" on={review.policy.governor} />
              </>
            ) : null}
          </div>
        </div>
      </div>

      {/* Tokens / roles */}
      {review.roles.length > 0 ? (
        <div className="mt-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
          <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wide text-white/30">
            <Hash className="size-3" /> Roles & usage
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-white/50">
            {review.roles.map((role, index) => (
              <span key={`${role.role}-${index}`}>
                <b className="text-white/70">{role.role}</b>{' '}
                {role.modelID ? `· ${role.modelID}` : ''}{' '}
                {role.tokensIn != null || role.tokensOut != null
                  ? `· in ${(role.tokensIn ?? 0).toLocaleString()} / out ${(role.tokensOut ?? 0).toLocaleString()}`
                  : ''}{' '}
                {role.cost != null ? (
                  <span title={role.costRule ?? undefined} className="text-teal-100/60">
                    · {formatUsd(role.cost)}
                  </span>
                ) : null}
              </span>
            ))}
          </div>
          <div className="mt-1 text-[9px] text-white/30">
            input {review.tokens.input.toLocaleString()} · output {review.tokens.output.toLocaleString()} · total{' '}
            {review.tokens.total.toLocaleString()} tokens
            {review.tokens.cost != null
              ? ` · cost ${formatUsd(review.tokens.cost)}${review.tokens.costPartial ? ' (partial)' : ''}`
              : ' · cost not priced — add provider/runner rates in Settings'}
          </div>
        </div>
      ) : null}

      {/* Gates */}
      {report.gates.length > 0 ? (
        <div className="mt-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
          <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wide text-white/30">
            <CheckCircle className="size-3" /> Gates
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {report.gates.map(gate => (
              <span
                key={gate.gateKey}
                className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${
                  gate.status === 'PASS'
                    ? 'bg-teal-300/10 text-teal-100/80'
                    : gate.status === 'FAIL'
                      ? 'bg-red-300/10 text-red-100/80'
                      : 'bg-white/[0.04] text-white/40'
                }`}
                title={gate.checkedAt}
              >
                {gate.gateKey} · {gate.status}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {/* Task sizes (LLM T-shirt at creation; operator override here) */}
      {report.tickets.length > 0 ? (
        <div className="mt-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wide text-white/30">
              <Scale className="size-3" /> Task sizes
            </div>
            <span className="text-[9px] text-white/25">
              {report.tickets.filter(ticket => ticket.storyPoints != null).length}/{report.tickets.length} sized
            </span>
          </div>
          <div className="mt-1 space-y-1">
            {report.tickets.map(ticket => (
              <div key={ticket.ticketId} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[10px] text-white/55" title={ticket.title}>
                  {ticket.title}
                </span>
                <select
                  value={ticket.tshirtSize ?? ''}
                  disabled={sizeBusy === ticket.ticketId}
                  onChange={event => {
                    if (event.target.value) void setTicketSize(ticket.ticketId, event.target.value);
                  }}
                  className="rounded border border-white/[0.08] bg-black/20 px-1.5 py-0.5 text-[9px] text-white/65 focus:border-teal-300/30 focus:outline-none disabled:opacity-50"
                  title={ticket.sizeRationale ?? undefined}
                >
                  <option value="">{ticket.storyPoints == null ? 'size…' : 'override…'}</option>
                  {TSHIRT_SIZES.map(size => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
                <span className="w-14 text-right font-mono text-[10px] text-white/50">
                  {ticket.storyPoints ?? '—'} pts
                </span>
              </div>
            ))}
          </div>
          <p className="mt-1 text-[9px] leading-snug text-white/25">
            Auto-sized at creation with a strict JSON probe; manual override wins.
          </p>
        </div>
      ) : null}

      {/* Findings */}
      {review.findings.length > 0 ? (
        <div className="mt-2 rounded-lg border border-red-300/10 bg-red-300/[0.03] p-3">
          <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wide text-red-100/40">
            <AlertTriangle className="size-3" /> Findings ({review.findings.length})
          </div>
          <ul className="mt-1 space-y-1">
            {review.findings.slice(0, 6).map((finding, index) => (
              <li key={`${finding.title}-${index}`} className="text-[10px] leading-snug text-white/55">
                <span className="font-semibold text-red-100/70">[{finding.severity}]</span> {finding.title}
                {finding.file ? <span className="text-white/25"> · {finding.file}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Commits + evidence */}
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
          <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wide text-white/30">
            <GitBranch className="size-3" /> Commits
          </div>
          <div className="mt-1 font-mono text-[9px] leading-relaxed text-white/40">
            base {shortSha(report.commits.baseHash)}<br />
            head {shortSha(report.commits.headHash)}
          </div>
        </div>
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
          <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wide text-white/30">
            <FileText className="size-3" /> Evidence
          </div>
          <div className="mt-1 text-[10px] text-white/50">
            {report.evidence.length} artifact{report.evidence.length === 1 ? '' : 's'} ·{' '}
            {report.evidence.reduce((sum, item) => sum + item.bytes, 0).toLocaleString()} bytes
          </div>
          <div className="mt-0.5 text-[9px] text-white/25">
            {report.evidence.slice(0, 2).map(item => item.kind).join(' · ') || 'no artifacts bound'}
          </div>
        </div>
      </div>

      {/* Re-review now */}
      {canReReview ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={reReviewBusy}
            onClick={() => void reReview()}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-[10px] font-semibold text-white/60 hover:bg-white/[0.06] disabled:opacity-50"
          >
            {reReviewBusy ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
            {reviewQueued ? 'Run queued review now' : 'Re-review now with this policy'}
          </button>
          <span className="text-[9px] text-white/25">Same immutable snapshot; previous verdict is kept.</span>
        </div>
      ) : reviewInFlight ? (
        <div className="mt-2 text-[9px] text-white/25">
          Review in flight — policy changes apply at the next review boundary.
        </div>
      ) : null}

      {/* Acceptance history */}
      {report.acceptanceHistory.length > 0 ? (
        <div className="mt-2 border-t border-white/[0.05] pt-2">
          <div className="text-[9px] uppercase tracking-wide text-white/25">Acceptance history</div>
          <ul className="mt-1 space-y-0.5">
            {report.acceptanceHistory.map(event => (
              <li key={event.event_id} className="text-[9px] text-white/35">
                <b className={event.decision === 'accepted' ? 'text-teal-100/60' : 'text-amber-100/60'}>
                  {event.decision === 'accepted' ? 'accepted' : 'changes requested'}
                </b>{' '}
                · {event.actor ?? 'operator'} · {formatDate(event.created_at)}
                {event.note ? ` — ${event.note}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function PolicyChip({ label, on }: { label: string; on: boolean }) {
  return (
    <span
      className={`rounded px-1 py-0.5 text-[8px] font-bold tracking-wide uppercase ${
        on ? 'bg-teal-300/15 text-teal-100/80' : 'bg-white/[0.04] text-white/25 line-through'
      }`}
    >
      {label}
    </span>
  );
}

function shortSha(value: string | null): string {
  if (!value) return '—';
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'not priced';
  if (value === 0) return '$0.0000';
  if (Math.abs(value) < 0.0001) return `$${value.toExponential(2)}`;
  return `$${value.toFixed(4)}`;
}
