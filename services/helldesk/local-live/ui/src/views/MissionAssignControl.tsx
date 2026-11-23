import { useEffect, useState } from 'react'

/**
 * MissionAssignControl — let the operator dispatch a mission ticket to a CHOSEN
 * idle agent (Toast) and SEE the assigned agent on the mission row.
 *
 * Calls the engine's operator dispatch override:
 *   POST /api/v1/missions/:missionId/tickets/:ticketId/assign { agentId }
 * (engine migration 0011 + mission-repository assignTicketToAgent + api assign
 * route). Recording the chosen agent is a first-class operator ownership signal;
 * the mission's engine_matrix (Toast's engine and effective model route) remains the
 * runner. Prints a visible success/failure — never a silent bounce.
 */
export function MissionAssignControl(props: {
  missionId: string
  ticketId: string
  currentAssigneeId?: string | null
}) {
  const { missionId, ticketId, currentAssigneeId } = props
  const [agents, setAgents] = useState<Array<{ id: string; name: string; status: string; role?: string }>>([])
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [done, setDone] = useState(currentAssigneeId ?? '')

  useEffect(() => {
    let active = true
    fetch('/api/departments/default/agents', { signal: AbortSignal.timeout(8000) })
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((j) => {
        if (!active) return
        const list = (j.data ?? []) as Array<Record<string, unknown>>
        setAgents(
          list.map((a) => ({
            id: String(a.id ?? a.agent_id ?? ''),
            name: String(a.name ?? a.id ?? 'agent'),
            status: String(a.status ?? 'unknown'),
            role: String(a.role ?? ''),
          })),
        )
        // pre-select the current assignee if present in the roster
        if (currentAssigneeId && !pick) setPick(currentAssigneeId)
      })
      .catch(() => { /* roster unavailable — leave the control inert but visible */ })
    return () => { active = false }
  }, [currentAssigneeId]) // eslint-disable-line react-hooks/exhaustive-deps

  const assignee = agents.find((a) => a.id === done) ?? (done ? { id: done, name: done.slice(0, 12), status: 'assigned' } : null)

  const assign = async () => {
    if (!pick) return
    setBusy(true); setMessage('')
    try {
      const res = await fetch(`/api/v1/missions/${encodeURIComponent(missionId)}/tickets/${encodeURIComponent(ticketId)}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: pick }),
      })
      const j = await res.json().catch(() => null)
      if (res.ok && j?.ok) {
        setDone(pick)
        const name = agents.find((a) => a.id === pick)?.name ?? pick.slice(0, 12)
        setMessage(`Assigned to ${name}`)
      } else {
        setMessage((j?.error) ? `Assign failed: ${j.error}` : (j?.delivery ? `Assigned: ${j.delivery}` : `Assign failed (${res.status})`))
      }
    } catch {
      setMessage('Assign failed — engine unreachable')
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="mission-assign" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
      <span className={`t ${assignee ? '' : 'muted'}`} style={{ minWidth: 60 }}>
        {assignee ? assignee.name : 'Unassigned'}
      </span>
      <select
        aria-label="Assign to agent"
        value={pick}
        onChange={(e) => setPick(e.target.value)}
        disabled={busy}
        style={{ fontSize: 10, background: 'var(--glass)', border: '1px solid var(--line)', color: 'inherit', borderRadius: 6, padding: '1px 4px', maxWidth: 90 }}
      >
        <option value="">assign…</option>
        {agents.filter((a) => a.status === 'idle' || a.status === 'working').map((a) => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={assign}
        disabled={busy || !pick}
        style={{ fontSize: 10, padding: '1px 6px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--glass)', cursor: busy ? 'wait' : 'pointer' }}
      >
        {busy ? '…' : 'Assign'}
      </button>
      {message && <span className="t muted" style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{message}</span>}
    </span>
  )
}