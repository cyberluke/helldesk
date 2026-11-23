import { useEffect, useMemo, useRef, useState } from 'react'
import { Send, Wrench, Bot, User, Pause, RefreshCw, XOctagon, Activity } from '@/lib/icons'
import { useParams } from 'react-router-dom'
import { z } from 'zod'
import { operatorRequest, readOperatorRoom, roomAgentId, short, isAgentWorking, listColonyMissions, type RoomAgent, type RoomState, type ColonyMission } from '../lib/engine'
import { missionTaskName } from '../lib/mission-title'
import { MissionChat } from '@/components/helldesk/MissionChat'

const chatSchema = z.object({
  type: z.literal('chat'),
  chat: z.object({
    event_id: z.string(), producer_id: z.string().optional(), origin: z.string(), event_timestamp_utc_ms: z.number().optional(),
    payload: z.object({ role: z.string().optional(), kind: z.string().optional(), text: z.string().optional(), tool_name: z.string().optional(), ts: z.number().optional() }).passthrough(),
  }).passthrough(),
})
type Row = z.infer<typeof chatSchema>['chat']

// ── Colony runtime event stream (`/events-ws`) — the "not only for breakRoom" half.
// The shared breakRoom chat (chatSchema) is one curated channel; the colony activity
// stream carries the party's actual work: ticket lifecycle, agent dispatch/mission,
// reviews, invariants, analytics. This view merges BOTH into one observable feed.
const runtimeEventSchema = z.object({
  type: z.literal('runtime'),
  departmentId: z.string().optional(),
  event: z.object({
    type: z.enum(['ticket', 'analytics', 'invariant']),
    departmentId: z.string().optional(),
    ticketId: z.string().optional(),
    violations: z.array(z.any()).optional(),
    payload: z.record(z.any()).optional(),
  }).passthrough(),
})
type RuntimeMsg = z.infer<typeof runtimeEventSchema>

/** A normalized unit in the unified observability feed (chat OR colony activity). */
type FeedItem =
  | { source: 'chat'; chat: Row }
  | { source: 'activity'; event: RuntimeMsg['event'] }
  | { source: 'history'; history: HistoryRow }

/** A durable ticket-event history row from the department ledger (`/api/departments/:id/events`). */
type HistoryRow = {
  ticket_event_id?: string
  ticket_id?: string | null
  agent_id?: string | null
  event_type?: string
  old_value?: unknown
  new_value?: unknown
  metadata?: Record<string, unknown>
  created_at?: string | null
}

type SeekInfo = { state?: string; updated_at?: string | null; verified_at?: string | null; mission_id?: string }
type SteerKind = 'interrupt' | 'force-review' | 'disapprove'
type Notice = { ok: boolean; text: string }
type Filter = 'all' | 'conversation' | 'activity' | 'tools'
const EMPTY_ROOM: RoomState = { agents: [], tickets: [], workstations: [] }
const STEERS = [
  { kind: 'interrupt' as const, label: 'Steer direction', icon: Pause, hint: 'Send guidance without pausing work' },
  { kind: 'force-review' as const, label: 'Challenge it', icon: RefreshCw, hint: 'Ask for another adversarial review' },
  { kind: 'disapprove' as const, label: 'Needs more work', icon: XOctagon, hint: 'Record a correction for the next pass' },
]

function Steering({ departmentId, room, selectedAgent }: { departmentId: string; room: RoomState; selectedAgent?: RoomAgent }) {
  const [ticketId, setTicketId] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const target = selectedAgent?.current_hook_ticket_id || ticketId
  const steer = async (kind: SteerKind) => {
    if (!target || busy) return
    setBusy(true); setNotice(null)
    const task = room.tickets.find(ticket => ticket.ticket_id === target)
    const result = await operatorRequest(`/api/departments/${encodeURIComponent(departmentId)}/breakRoom/steer`, {
      kind, ticketId: target, agentId: selectedAgent ? roomAgentId(selectedAgent) : task?.assignee_agent_ticket_id || undefined,
      note: note.trim() || undefined,
    })
    setNotice({ ok: result.success, text: result.success ? 'Steering accepted by the server. The crew keeps working; review the activity stream for its response.' : result.error || 'Steering was not accepted. Your note is retained.' })
    setBusy(false)
  }
  return <section className="operator-steering">
    <div className="operator-section-heading"><span>Change the direction, not the momentum</span><span className="operator-chip">ASYNC STEERING</span></div>
    <div className="operator-steer-fields">
      <select aria-label="Task to steer" value={target} onChange={e => setTicketId(e.target.value)} disabled={!!selectedAgent?.current_hook_ticket_id}>
        <option value="">Choose a task to steer</option>
        {room.tickets.map(ticket => <option key={ticket.ticket_id} value={ticket.ticket_id}>{ticket.title} · {ticket.status}</option>)}
      </select>
      <input aria-label="Steering note" value={note} onChange={e => setNote(e.target.value)} placeholder="More glitter. Different architecture. Harvest this repo…" maxLength={16000} />
    </div>
    <div className="operator-steer-actions">
      {STEERS.map(({ kind, label, icon: Icon, hint }) => <button key={kind} onClick={() => steer(kind)} disabled={!target || busy} title={hint}><Icon size={15} />{label}</button>)}
      <span>ExcellenceGovernor challenges. You set the direction.</span>
    </div>
    {notice && <p role="status" className={'operator-notice ' + (notice.ok ? 'positive' : 'negative')}>{notice.text}</p>}
  </section>
}

function EventRow({ row }: { row: Row }) {
  const tool = row.payload.kind === 'tool_call' || row.payload.kind === 'tool_result'
  const human = row.payload.role === 'user'
  const Icon = tool ? Wrench : human ? User : Bot
  const rawTime = row.payload.ts || row.event_timestamp_utc_ms
  const time = rawTime && Number.isFinite(new Date(rawTime).getTime()) ? rawTime : undefined
  return <article className={'operator-message ' + (human ? 'from-human' : '')}>
    <div className="operator-avatar"><Icon size={17} /></div>
    <div className="operator-message-body">
      <header><strong>{human ? 'Operator' : row.producer_id || row.origin}</strong><span>{row.payload.role || 'assistant'}</span>{time && <time dateTime={new Date(time).toISOString()}>{new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}</header>
      {tool ? <details><summary>{row.payload.kind === 'tool_call' ? 'Using' : 'Completed'} {row.payload.tool_name || 'tool'}</summary><p>{row.payload.text || 'No additional detail was published.'}</p></details> : <p>{row.payload.text || 'Activity received.'}</p>}
    </div>
  </article>
}

// ── Colony activity label + icon ────────────────────────────────────────────
const ACTIVITY_ICON: Record<string, typeof Bot> = {
  'ticket.created': Bot, 'ticket.status': Bot, 'ticket.closed': Bot,
  'agent.spawned': Bot, 'agent.dispatch_failed': Wrench, 'agent_exited': Wrench,
  'mission.unavailable': Wrench, 'review': Bot, 'dispatch': Bot,
}
const ACTIVITY_COLOR: Record<string, string> = {
  'ticket.created': 'var(--accent)',
  'ticket.status': 'var(--accent2)',
  'ticket.closed': 'var(--ok)',
  'agent.spawned': 'var(--accent3)',
  'agent.dispatch_failed': 'var(--bad)',
  'agent_exited': 'var(--bad)',
  'mission.unavailable': 'var(--bad)',
  invariant: 'var(--bad)',
}

/** Event name for an analytics payload (it carries `.event`) or falls back to `.type`. */
function activityEventName(evt: RuntimeMsg['event']): string {
  const p = (evt.payload ?? {}) as { event?: unknown }
  if (typeof p.event === 'string') return p.event
  if (evt.type === 'invariant') return `invariant (${(evt.violations ?? []).length} violation${(evt.violations ?? []).length === 1 ? '' : 's'})`
  return evt.type
}

/** A short human summary for a colony activity event. */
function activitySummary(evt: RuntimeMsg['event']): string {
  const p = (evt.payload ?? {}) as Record<string, unknown>
  const name = activityEventName(evt)
  const ticket = typeof evt.ticketId === 'string' && evt.ticketId ? short(evt.ticketId) : typeof p.ticketId === 'string' && p.ticketId ? short(p.ticketId as string) : ''
  const agent = typeof p.agentId === 'string' && p.agentId ? short(p.agentId as string) : typeof p.agent === 'string' && p.agent ? short(p.agent as string) : ''
  const role = typeof p.role === 'string' && p.role ? String(p.role) : ''
  const to = typeof p.to === 'string' && p.to ? String(p.to) : ''
  const reason = typeof p.reason === 'string' && p.reason ? String(p.reason) : ''
  const msg = evt.type === 'ticket' ? typeof p.message === 'string' ? String(p.message) : '' : ''
  const parts: string[] = []
  if (agent) parts.push(`${role ? role + ' ' : ''}${agent}`)
  if (ticket) parts.push(`ticket ${ticket}`)
  if (to) parts.push(`→ ${to}`)
  if (reason) parts.push(reason)
  if (msg) parts.push(msg)
  return `${name}${parts.length ? ' — ' + parts.join(' · ') : ''}`
}

/** Render one unified observability row (conversation OR colony activity). */
function FeedRow({ item }: { item: FeedItem }) {
  if (item.source === 'chat') return <EventRow row={item.chat} />
  if (item.source === 'history') {
    const h = item.history
    const name = h.event_type || 'ticket.event'
    const Icon = ACTIVITY_ICON[name] ?? Activity
    const color = ACTIVITY_COLOR[name] ?? 'var(--muted)'
    const agent = typeof h.agent_id === 'string' && h.agent_id ? h.agent_id === 'mission-dispatch' ? 'mission-controller' : short(h.agent_id) : ''
    const ticket = h.ticket_id ? short(h.ticket_id) : ''
    const val = typeof h.new_value === 'string' ? String(h.new_value) : ''
    const meta = h.metadata ?? {}
    const extra = typeof meta.error === 'string' ? meta.error : typeof meta.missionId === 'string' ? `mission ${short(meta.missionId as string)}` : ''
    const when = h.created_at && Number.isFinite(new Date(h.created_at).getTime()) ? new Date(h.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : undefined
    return <article className={'operator-message operator-activity'}>
      <div className="operator-avatar" style={{ color }}><Icon size={17} /></div>
      <div className="operator-message-body">
        <header><strong style={{ color }}>{name}</strong><span>history{agent ? ' · ' + agent : ''}{ticket ? ' · ' + ticket : ''}</span>{when && <time dateTime={new Date(h.created_at as string).toISOString()}>{when}</time>}</header>
        <p>{[val, extra].filter(Boolean).join(' — ') || name}</p>
      </div>
    </article>
  }
  const evt = item.event
  const name = activityEventName(evt)
  const Icon = ACTIVITY_ICON[name] ?? Activity
  const color = ACTIVITY_COLOR[name] ?? ACTIVITY_COLOR[evt.type] ?? 'var(--muted)'
  const summary = activitySummary(evt)
  const p = (evt.payload ?? {}) as { ts?: unknown; event_timestamp_utc_ms?: unknown }
  const rawTime = typeof p.ts === 'number' ? p.ts : typeof p.event_timestamp_utc_ms === 'number' ? p.event_timestamp_utc_ms : undefined
  const time = rawTime && Number.isFinite(new Date(rawTime).getTime()) ? new Date(Number(rawTime)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : undefined
  return <article className={'operator-message operator-activity'}>
    <div className="operator-avatar" style={{ color }}><Icon size={17} /></div>
    <div className="operator-message-body">
      <header><strong style={{ color }}>{name}</strong><span>colony</span>{time && <time dateTime={new Date(Number(rawTime)).toISOString()}>{time}</time>}</header>
      <p>{summary || (evt.type === 'invariant' ? 'Invariant gate active — see the violation list.' : 'Colony activity.')}</p>
    </div>
  </article>
}

/** Sort/filter timestamp for a unified feed item (epoch ms). */
function tsOf(item: FeedItem): number {
  if (item.source === 'chat') {
    const t = item.chat.payload.ts || item.chat.event_timestamp_utc_ms
    return typeof t === 'number' && t ? t : 0
  }
  const p = item.event.payload ?? {}
  const t = typeof p.ts === 'number' ? p.ts : typeof p.event_timestamp_utc_ms === 'number' ? p.event_timestamp_utc_ms : 0
  return typeof t === 'number' && t ? t : 0
}

/** Dedupe key for an activity event. */
function activityKey(evt: RuntimeMsg['event']): string {
  const t = tsOf({ source: 'activity', event: evt })
  return `${evt.type}:${activityEventName(evt)}:${evt.ticketId ?? ''}:${t}`
}

export default function BreakRoomChat() {
  const { departmentId = '' } = useParams()
  const [room, setRoom] = useState<RoomState>(EMPTY_ROOM)
  const [roomError, setRoomError] = useState('')
  const [feed, setFeed] = useState<FeedItem[]>([])
  const [draft, setDraft] = useState('')
  const [targetId, setTargetId] = useState('')
  const [workstationFilter, setWorkstationFilter] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [connection, setConnection] = useState<'connecting' | 'online' | 'reconnecting'>('connecting')
  const [activityLive, setActivityLive] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [sending, setSending] = useState(false)
  const [agentMission, setAgentMission] = useState<ColonyMission | undefined>(undefined)
  const wsRef = useRef<WebSocket | null>(null)
  const evtWsRef = useRef<WebSocket | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)
  const followRef = useRef(true)
  const selectedAgent = room.agents.find(agent => roomAgentId(agent) === targetId)
  const workingCount = room.agents.filter(isAgentWorking).length
  const workstationOptions = room.workstations
    .map(workstation => ({
      id: workstation.id || workstation.workstation_id || '',
      name: workstation.name || workstation.id || workstation.workstation_id || '',
    }))
    .filter(workstation => workstation.id)
  const filteredAgents = useMemo(
    () => room.agents.filter(agent => !workstationFilter || agent.workstation_id === workstationFilter),
    [room.agents, workstationFilter],
  )
  const agentMissionId = agentMission?.missionId
  // The header speaks in human terms: a task name, not a mis_… handle.
  const taskName = agentMission ? missionTaskName(agentMission.objective, agentMission.missionId) : ''
  const missionState = agentMission?.state ?? ''
  const missionRevisionState = agentMission?.revisionState ?? agentMission?.revision_state ?? ''
  const missionReviewState = agentMission?.reviewJobState ?? agentMission?.review_job_state ?? ''
  const missionActive = Boolean(agentMission) && !['VERIFIED_10_10', 'CANCELLED', 'CLOSED'].includes(missionState)
  const missionInReview = ['ADJUDICATING', 'VERIFYING'].includes(missionReviewState) || ['EVIDENCE_CAPTURED'].includes(missionRevisionState)
  const missionUpdated = agentMission?.updatedAt ?? agentMission?.updated_at ?? null

  // ── REAL per-agent conversation ──────────────────────────────────────────
  // The room feed is SHARED. Selecting an agent must show THAT agent's real
  // session: the soul and the reviewers all act on the same mission, so we load
  // the mission transcript (real Kilo parts + mirrored review verdicts) and
  // filter by speaker for reviewers. No more "everyone shows the same text".
  const selectedName = (selectedAgent?.name ?? '').toLowerCase()
  const selectedRole = (selectedAgent?.role ?? '').toLowerCase()
  const reviewerSpeaker =
    selectedName.startsWith('reviewer-a') ? 'reviewer-a'
      : selectedName.startsWith('reviewer-b') ? 'reviewer-b'
        : selectedName.startsWith('adjudicator') ? 'adjudicator'
          : undefined
  const isSoulAgent = selectedRole === 'soul' || selectedName.startsWith('mutation@') || selectedName === 'soul' || roomAgentId(selectedAgent ?? {}) === 'role:soul'
  const showAgentChat = !!selectedAgent && !!agentMissionId && (isSoulAgent || !!reviewerSpeaker)

  // ── The live mission: ONE source for the header task name + the real chat ──
  // The newest non-terminal control-plane mission is the work the crew is
  // producing. Read-only projection; polled so a mission change never needs a
  // page reload, and an unreachable control plane never blanks the header.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const missions = await listColonyMissions()
        if (cancelled || !missions.length) return
        const active = missions
          .filter((m) => !['VERIFIED_10_10', 'CANCELLED', 'CLOSED'].includes(String(m.state ?? '').toUpperCase()))
          .sort((a, b) => String(b.updatedAt ?? b.updated_at ?? '').localeCompare(String(a.updatedAt ?? a.updated_at ?? '')))
        setAgentMission(active[0] ?? missions[0])
      } catch { /* control plane unavailable — the room still works, the header omits the task */ }
    }
    void load()
    const timer = setInterval(load, 15000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  useEffect(() => {
    let active = true
    setRoom(EMPTY_ROOM); setRoomError('')
    const load = async () => {
      try { const next = await readOperatorRoom(departmentId); if (active) { setRoom(next); setRoomError('') } }
      catch (error) { if (active) setRoomError(error instanceof Error ? error.message : 'Crew status unavailable.') }
    }
    void load()
    const timer = setInterval(load, 6000)
    return () => { active = false; clearInterval(timer) }
  }, [departmentId])

  // Shared breakRoom chat stream (`/chat-ws`).
  useEffect(() => {
    let disposed = false, retry = 0, timer: ReturnType<typeof setTimeout> | undefined
    setFeed([]); setTargetId(''); setDraft(''); setNotice(null); setConnection('connecting')
    const connect = () => {
      if (disposed) return
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/departments/${encodeURIComponent(departmentId)}/chat-ws`)
      wsRef.current = ws
      ws.onopen = () => { if (!disposed) { retry = 0; setConnection('online') } }
      ws.onmessage = event => {
        if (disposed || typeof event.data !== 'string' || event.data.length > 1024 * 1024) return
        let value: unknown
        try { value = JSON.parse(event.data) } catch { return }
        const parsed = chatSchema.safeParse(value)
        if (!parsed.success) return
        const chat: Row = parsed.data.chat
        setFeed(current => current.some(item => item.source === 'chat' && item.chat.event_id === chat.event_id) ? current : [...current, { source: 'chat', chat } as FeedItem].slice(-800))
      }
      ws.onerror = () => ws.close()
      ws.onclose = () => {
        if (disposed) return
        setConnection('reconnecting')
        timer = setTimeout(connect, Math.min(15000, 1000 * 2 ** Math.min(retry++, 4)))
      }
    }
    connect()
    return () => { disposed = true; clearTimeout(timer); wsRef.current?.close(); wsRef.current = null }
  }, [departmentId])

  // Colony runtime event stream (`/events-ws`) — the party's work, not just the
  // shared room: ticket lifecycle, agent dispatch/mission, invariants, analytics.
  useEffect(() => {
    let disposed = false, retry = 0, timer: ReturnType<typeof setTimeout> | undefined
    const connect = () => {
      if (disposed) return
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/departments/${encodeURIComponent(departmentId)}/events-ws`)
      evtWsRef.current = ws
      ws.onopen = () => { if (!disposed) { retry = 0; setActivityLive(true) } }
      ws.onmessage = event => {
        if (disposed || typeof event.data !== 'string' || event.data.length > 1024 * 1024) return
        let value: unknown
        try { value = JSON.parse(event.data) } catch { return }
        const parsed = runtimeEventSchema.safeParse(value)
        if (!parsed.success) return
        const evt = parsed.data.event
        const dedupeKey = `${evt.type}:${activityEventName(evt)}:${typeof evt.ticketId === 'string' ? evt.ticketId : ''}:${typeof (evt.payload as any)?.ts === 'number' ? (evt.payload as any).ts : Date.now()}`
        setFeed(current => current.some(item => item.source === 'activity' && activityKey(item.event) === dedupeKey) ? current : [...current, { source: 'activity', event: evt }].slice(-800))
      }
      ws.onclose = () => {
        if (disposed) return
        setActivityLive(false)
        timer = setTimeout(connect, Math.min(15000, 1000 * 2 ** Math.min(retry++, 4)))
      }
    }
    connect()
    return () => { disposed = true; clearTimeout(timer); evtWsRef.current?.close(); evtWsRef.current = null }
  }, [departmentId])

  const visibleFeed = useMemo(() => {
    const sorted = [...feed].sort((a, b) => tsOf(a) - tsOf(b))
    return sorted.filter(item => {
      if (filter === 'all') return true
      if (filter === 'conversation') return item.source === 'chat'
      if (filter === 'activity') return item.source === 'activity'
      // tools: chat tool rows + activity dispatch/tool-like events
      if (item.source === 'chat') return ['tool_call', 'tool_result'].includes(item.chat.payload.kind || '')
      return item.source === 'activity'
    })
  }, [feed, filter])
  useEffect(() => { if (followRef.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [visibleFeed])

  const send = async () => {
    const text = draft.trim()
    if (!text || sending) return
    setNotice(null)
    if (targetId) {
      if (!selectedAgent?.workstation_id) { setNotice({ ok: false, text: 'This participant has no addressable workstation. Choose another agent or share with the room.' }); return }
      setSending(true)
      const result = await operatorRequest(`/api/departments/${encodeURIComponent(departmentId)}/workstations/${encodeURIComponent(selectedAgent.workstation_id)}/agents/${encodeURIComponent(targetId)}/nudges`, { target_agent_id: targetId, message: text, mode: 'queue' })
      setSending(false)
      if (result.success) setDraft('')
      setNotice({ ok: result.success, text: result.success ? `Queued for ${selectedAgent.name || short(targetId)}. The agent receives it asynchronously; this is not a delivery acknowledgement.` : result.error || 'Message was not queued. Your draft is retained.' })
      return
    }
    if (wsRef.current?.readyState !== WebSocket.OPEN) { setNotice({ ok: false, text: 'The room is reconnecting. Your draft is safe here.' }); return }
    try {
      wsRef.current.send(JSON.stringify({ action: 'publish', payload: { role: 'user', kind: 'text', text, origin: 'helldesk', ts: Date.now() } }))
      setDraft(''); setNotice({ ok: true, text: 'Sent to the room. Its appearance in the stream confirms the ledger echo.' })
    } catch { setNotice({ ok: false, text: 'Could not send. Your draft is retained.' }) }
  }

  return <div className="operator-page operator-console">
    <header className="operator-hero"><div><div className="operator-eyebrow">HELLDESK / LIVE OPERATIONS</div><h1 className="operator-title">The Operator-console<span className="operator-title-dot">.</span></h1><p>Drop in. Challenge the crew. Add a little glitter. Work carries on.</p>{taskName && <p className="operator-hero-task" title={agentMissionId ? `mission ${agentMissionId}` : undefined}><span className="operator-eyebrow">ACTIVE TASK</span><strong>{taskName}</strong>{agentMission?.state ? <span className="operator-mission-state">{agentMission.state}</span> : null}</p>}</div><div className={'operator-connection ' + connection}><span />{connection === 'online' ? 'Room connected' : connection === 'connecting' ? 'Connecting' : 'Reconnecting'}</div></header>
    <div className="operator-layout">
      <aside className="operator-crew"><div className="operator-section-heading"><span>Your crew</span><span className="operator-chip">{filteredAgents.length}</span></div>
        <select
          className="operator-workstation-filter"
          value={workstationFilter}
          onChange={event => { setWorkstationFilter(event.target.value); setTargetId('') }}
          aria-label="Filter crew by workstation"
        >
          <option value="">All workstations</option>
          {workstationOptions.map(workstation => <option key={workstation.id} value={workstation.id}>{workstation.name}</option>)}
        </select>
        <button className={'operator-person ' + (!targetId ? 'selected' : '')} onClick={() => setTargetId('')}><span className="operator-avatar"><User size={18} /></span><span><strong>Everyone</strong><small>The shared conversation</small></span></button>
        {filteredAgents.map(agent => { const id = roomAgentId(agent); return <button key={id} className={'operator-person ' + (targetId === id ? 'selected' : '')} onClick={() => setTargetId(id)}><span className="operator-avatar"><Bot size={18} /></span><span><strong>{agent.name || short(id)}</strong><small>{agent.role || 'agent'} · {agent.status || 'unknown'}</small></span></button> })}
        {!filteredAgents.length && !roomError && <p className="operator-empty-note">{workstationFilter ? 'No agents are registered on this workstation.' : 'Your crew will appear here when agents register. Start a task in Task Studio.'}</p>}
        {roomError && <p role="status" className="operator-notice negative">Crew status unavailable: {roomError}</p>}
        <div className="operator-contract"><span className="operator-eyebrow">YOUR SEAT AT THE TABLE</span><p>Agents build. ExcellenceGovernor reviews. You steer when you want—and decide what meets your standard.</p></div>
      </aside>
      <main className="operator-conversation">
        <div className="operator-conversation-heading"><div><h2>{selectedAgent ? selectedAgent.name || short(targetId) : 'AI Party Room'}</h2><p>{showAgentChat ? `Real Kilo session${reviewerSpeaker ? ' · this reviewer' : ''} on ${taskName || 'the active mission'}. Messages here steer that mission.` : selectedAgent ? 'Select the soul or a reviewer to see its real session; the shared room stays in Everyone.' : 'One unified feed: the shared conversation AND every colony move (dispatch, missions, reviews, invariants).'}</p></div>{!showAgentChat && <div className="operator-tabs" aria-label="Activity filter">{(['all', 'conversation', 'activity', 'tools'] as const).map(value => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value}</button>)}</div>}</div>
        {showAgentChat && agentMission && missionActive && (
          <div className="operator-agent-working" role="status">
            <span className="operator-working-dot" />
            <span>
              {missionInReview
                ? `ExcellenceGovernor is reviewing the completed build${missionReviewState ? ` · ${missionReviewState.toLowerCase()}` : ''}.`
                : `${selectedAgent?.name || 'The agent'} is working${missionRevisionState ? ` · ${missionRevisionState.toLowerCase()}` : ''}.`}
              {missionUpdated ? ` Last update ${new Date(missionUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : ''}
              {' '}The full turn appears here when it finishes; the workspace commits as it goes.
            </span>
          </div>
        )}
        <div className="operator-party-status">
          <span className={'operator-dot ' + (connection === 'online' ? '' : 'warn')} /> chat {connection}
          <span className="operator-sep">·</span>
          <span className={'operator-dot ' + (activityLive ? '' : 'warn')} /> colony {activityLive ? 'live' : 'reconnecting'}
          <span className="operator-sep">·</span>
          <span title="A crew member counts as working when its status is 'working' or its engine checkpoint is running"><strong>{workingCount}</strong> working</span>
          {room.agents.filter(a => (a as { current_hook_ticket_id?: string | null }).current_hook_ticket_id).slice(0, 2).map(a => (
            <span key={a.id || a.ticket_id || a.agent_id} className="operator-party-chip" title="hooked to a ticket">{a.name || short(a.id || a.ticket_id || a.agent_id)} → {(a as { current_hook_ticket_id?: string | null }).current_hook_ticket_id ? short((a as { current_hook_ticket_id: string }).current_hook_ticket_id) : ''}</span>
          ))}
        </div>
        {showAgentChat ? (
          <div className="operator-stream" role="log" aria-label="Agent live session">
            <MissionChat missionId={agentMissionId!} speakerFilter={reviewerSpeaker} />
          </div>
        ) : (
          <div ref={logRef} className="operator-stream" role="log" aria-label="Crew activity" onScroll={event => { const node = event.currentTarget; followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80 }}>
            {!visibleFeed.length && <div className="operator-empty"><Bot size={32} /><h3>Room for your next big idea.</h3><p>Messages and agent activity arrive here live. The crew does not need you to keep this page open.</p></div>}
            {visibleFeed.map(item => <FeedRow key={item.source === 'chat' ? 'chat:' + item.chat.event_id : 'act:' + activityKey(item.event)} item={item} />)}
          </div>
        )}
        {!showAgentChat && (
          <div className="operator-compose"><textarea aria-label={selectedAgent ? 'Message selected agent' : 'Message the room'} value={draft} maxLength={16000} onChange={event => setDraft(event.target.value)} placeholder={selectedAgent ? `A note for ${selectedAgent.name || 'this agent'}…` : 'What if we made it extraordinary…'} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} /><div className="operator-compose-footer"><span>Enter to send · Shift + Enter for a new line</span><button onClick={send} disabled={sending || !draft.trim() || (!targetId && connection !== 'online')}><Send size={16} />{sending ? 'Queueing…' : selectedAgent ? 'Queue to agent' : 'Share with room'}</button></div>{notice && <p role="status" className={'operator-notice ' + (notice.ok ? 'positive' : 'negative')}>{notice.text}</p>}</div>
        )}
        {!showAgentChat && (
          <Steering key={departmentId} departmentId={departmentId} room={room} selectedAgent={selectedAgent} />
        )}
      </main>
    </div>
  </div>
}
