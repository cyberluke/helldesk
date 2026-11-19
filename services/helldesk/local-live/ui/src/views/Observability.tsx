import { useEffect, useState } from 'react'
import { engine, local, short } from '../lib/engine'
import { listColonyMissions, getMissionBoard, type ColonyMission, type MissionTicketCard } from '../lib/engine'
import { Sparkline, fmtAge, pct, type MetricsSnapshot, aggregateMetrics } from '../lib/metrics'

// Observability — SOTA operations console (Palantir-grade). Dense but legible
// telemetry over the REAL control-plane state: KPI cards, mission activity
// timeline with freshness pulse, a quality-gate matrix, rework telemetry, and
// the live engine event stream. No extra backend surface; aggregated client-side.

const STATE_COLOR: Record<string, string> = {
  ACTIVE: 'var(--accent)',
  MUTATING: 'var(--accent3)',
  VERIFYING: 'var(--accent2)',
  PLANNING: '#94a3b8',
  CAPTURING_EVIDENCE: '#a78bfa',
  REPLANNING: '#fbbf24',
  VERIFIED_10_10: 'var(--ok)',
  BLOCKED_EXTERNAL: 'var(--bad)',
  CANCELLED: 'var(--bad)',
  PENDING_VERIFY: '#7dd3fc',
}

function KPI({ label, value, delta, ok, sub }: { label: string; value: string; delta?: string; ok?: boolean; sub?: string }) {
  return (
    <div className="card kpi" style={{ padding: 14, minWidth: 170 }}>
      <div className="muted" style={{ fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase', color: ok === false ? 'var(--bad)' : ok ? 'var(--ok)' : undefined }}>{label}</div>
      <div className="stat" style={{ fontSize: 24, lineHeight: 1.1 }}>{value}</div>
      {delta && <div className="muted" style={{ fontSize: 12, color: 'var(--accent2)' }}>{delta}</div>}
      {sub && <div className="muted" style={{ fontSize: 11, opacity: 0.7 }}>{sub}</div>}
    </div>
  )
}

export default function Observability() {
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null)
  const [health, setHealth] = useState<boolean | 'unknown'>('unknown')
  const [missions, setMissions] = useState<ColonyMission[]>([])
  const [board, setBoard] = useState<MissionTicketCard[]>([])
  const [events, setEvents] = useState<any[]>([])
  const [spark, setSpark] = useState<number[]>([])
  const [updatedAgo, setUpdatedAgo] = useState<number | null>(null)

  const refresh = async () => {
    const h = await engine.health()
    const [boardRes, missionsRes, evs] = await Promise.all([getMissionBoard(), listColonyMissions(), local.events('default')])
    setHealth(h)
    setBoard(boardRes)
    setMissions(missionsRes)
    setEvents(evs.slice(-32).reverse())
    setMetrics(aggregateMetrics(boardRes, missionsRes, h))
    setUpdatedAgo(Date.now())
    setSpark((prev) => {
      const n = missionsRes.length
      const next = prev.length >= 24 ? prev.slice(1) : prev
      return [...next, boardRes.filter((t) => t.status === 'in_progress' || t.status === 'in_review').length || n]
    })
  }

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 6000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const m = metrics

  return (
    <div className="observability">
      <div className="section-title" style={{ margin: '0 0 14px' }}>⚡ Operations Console</div>

      {/* Top KPI strip */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', marginBottom: 16 }}>
        <KPI label="Engine" value={m ? (m.health === 'unknown' ? '…' : m.health ? 'ONLINE' : 'OFFLINE') : '…'} ok={m?.health !== false} sub={m ? `updates ${fmtAge(m.updatedAgoMs)} ago` : undefined} />
        <KPI label="Active missions" value={String(m?.missions.active ?? 0)} delta={`${m?.missions.total ?? 0} total`} ok={m ? m.missions.active > 0 : undefined} />
        <KPI label="Tickets in motion" value={String((m?.tickets.inProgress ?? 0) + (m?.tickets.inReview ?? 0))} delta={`${m?.tickets.open ?? 0} open / ${m?.tickets.closed ?? 0} closed`} />
        <KPI label="Gate pass-rate" value={m ? pct(m.gates.passRate) : '…'} delta={`${m?.gates.pass ?? 0} pass / ${m?.gates.fail ?? 0} fail`} ok={m ? m.gates.passRate >= 0.8 : undefined} />
        <KPI label="Rework fraction" value={m ? pct(m.rework.reworkFraction) : '…'} delta={`${m?.rework.rejected ?? 0} rejected`} ok={m ? m.rework.reworkFraction <= 0.4 : undefined} />
        <KPI label="Blocked" value={String(m?.missions.blocked ?? 0)} ok={m ? (m.missions.blocked ?? 0) === 0 : undefined} sub={m?.missions.replanning ? `${m.missions.replanning} replanning` : undefined} />
        <KPI label="Time to verify" value={m ? fmtAge(m.cycle.verifiedAgeMs) : '…'} ok={m ? (m.cycle.verifiedAgeMs ?? Infinity) < 3_600_000 : undefined} sub={m?.cycle.oldestActiveMs != null ? `stalest active ${fmtAge(m.cycle.oldestActiveMs)}` : undefined} />
        <KPI label="Gate cost / ticket" value={m ? m.cycle.avgTicketGates.toFixed(1) : '…'} delta={`${m?.gates.pass ?? 0} pass · ${m?.gates.fail ?? 0} fail · ${m?.gates.unverified ?? 0} pend`} />
      </div>

      {/* Middle row: mission timeline + gate/rework */}
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)', marginBottom: 16, alignItems: 'start' }}>
        <div className="card">
          <div className="section-title" style={{ margin: '0 0 10px' }}>Mission activity</div>
          {missions.length === 0 ? (
            <span className="muted">no missions yet — create one in Task Studio</span>
          ) : (
            <div className="mission-list" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {missions.slice(0, 12).map((mi) => (
                <div key={mi.mission_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', borderRadius: 8, background: 'var(--glass)', border: '1px solid var(--line)' }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: STATE_COLOR[mi.state ?? ''] || 'var(--line)', boxShadow: `0 0 8px ${STATE_COLOR[mi.state ?? ''] || 'transparent'}` }} />
                  <span style={{ flex: 1, fontSize: 12, fontFamily: 'var(--mono)' }}>{short(mi.objective ?? mi.mission_id, 34)}</span>
                  <span className="t" style={{ fontSize: 11, color: STATE_COLOR[mi.state ?? ''] || undefined }}>
                    {(mi.state || 'idle').toLowerCase().replace(/_/g, ' ')}
                  </span>
                  <span className="t muted" style={{ fontSize: 10, minWidth: 46, textAlign: 'right' }}>
                    {fmtAge(missionsUpdatedAgo(mi))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="section-title" style={{ margin: '0 0 10px' }}>Throughput (tickets in motion)</div>
          <Sparkline points={spark.length ? spark : [0, 1]} w={200} h={56} color="var(--accent)" />
          <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            <MiniPct label="Open" v={m?.tickets.open ?? 0} t={m?.tickets.total ?? 0} color="var(--accent)" />
            <MiniPct label="In motion" v={(m?.tickets.inProgress ?? 0) + (m?.tickets.inReview ?? 0)} t={m?.tickets.total ?? 0} color="var(--accent3)" />
            <MiniPct label="Closed" v={m?.tickets.closed ?? 0} t={m?.tickets.total ?? 0} color="var(--ok)" />
          </div>
        </div>
      </div>

      {/* Bottom row: quality matrix + rework + event stream */}
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.4fr) 1.4fr', marginBottom: 0, alignItems: 'start' }}>
        <QualityPanel m={m} />
        <ReworkPanel m={m} />
        <MissionStateBars missions={missions} />
        <div className="card" style={{ minHeight: 210, maxHeight: 260, overflow: 'auto' }}>
          <div className="section-title" style={{ margin: '0 0 8px' }}>Live event stream</div>
          <div className="log">
            {events.length === 0 ? (
              <span className="t">waiting for engine events…</span>
            ) : (
              events.map((ev, i) => (
                <div key={i} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  <span className="t">{short(String(ev.created_at ?? `ev${i}`), 14)}</span>{' '}
                  <span style={{ color: ev.event_type?.includes('failed') || ev.event_type?.includes('blocked') ? 'var(--bad)' : 'var(--accent2)' }}>›</span>{' '}
                  {ev.event_type || ev.event || 'event'}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function missionsUpdatedAgo(mi: ColonyMission): number | null {
  const at = mi.updated_at ?? mi.verified_at
  if (!at) return null
  const t = new Date(at).getTime()
  return Number.isFinite(t) ? Date.now() - t : null
}

function MiniPct({ label, v, t, color }: { label: string; v: number; t: number; color: string }) {
  const frac = t ? v / t : 0
  return (
    <div>
      <div className="muted" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ flex: 1, height: 6, borderRadius: 4, background: 'var(--glass)', overflow: 'hidden' }}>
          <div style={{ width: pct(frac), height: '100%', background: color, borderRadius: 4 }} />
        </div>
        <span className="stat" style={{ fontSize: 13 }}>{v}</span>
      </div>
    </div>
  )
}

function QualityPanel({ m }: { m: MetricsSnapshot | null }) {
  return (
    <div className="card">
      <div className="section-title" style={{ margin: '0 0 10px' }}>Quality gates</div>
      {m ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Donut pass={m.gates.pass} fail={m.gates.fail} unverified={m.gates.unverified} />
            <div>
              <div className="stat" style={{ fontSize: 22 }}>{pct(m.gates.passRate)}</div>
              <div className="muted" style={{ fontSize: 11 }}>pass rate</div>
            </div>
          </div>
          <div className="muted" style={{ marginTop: 8, fontSize: 11 }}>{m.gates.pass} pass · {m.gates.fail} fail · {m.gates.unverified} unverified</div>
        </>
      ) : <span className="muted">…</span>}
    </div>
  )
}

function Donut({ pass, fail, unverified }: { pass: number; fail: number; unverified: number }) {
  const total = pass + fail + unverified || 1
  const p = ((pass / total) * 100).toFixed(1)
  const f = ((fail / total) * 100).toFixed(1)
  const u = ((unverified / total) * 100).toFixed(1)
  return (
    <svg width={64} height={64} viewBox="0 0 42 42" aria-hidden>
      <circle cx="21" cy="21" r="15.9" fill="none" stroke="var(--glass)" strokeWidth="5" />
      <circle cx="21" cy="21" r="15.9" fill="none" stroke="var(--ok)" strokeWidth="5" strokeDasharray={`${Number(p) * 0.629} ${100 - Number(p) * 0.629}`} strokeDashoffset="25" strokeLinecap="round" transform="rotate(-90 21 21)" />
      <circle cx="21" cy="21" r="15.9" fill="none" stroke="var(--bad)" strokeWidth="5" strokeDasharray={`${Number(f) * 0.629} ${100 - Number(f) * 0.629}`} strokeDashoffset={`${25 - Number(p) * 0.629}`} transform="rotate(-90 21 21)" />
      <circle cx="21" cy="21" r="15.9" fill="none" stroke="var(--line)" strokeWidth="5" strokeDasharray={`${Number(u) * 0.629} ${100 - Number(u) * 0.629}`} strokeDashoffset={`${25 - (Number(p) + Number(f)) * 0.629}`} transform="rotate(-90 21 21)" />
    </svg>
  )
}

function ReworkPanel({ m }: { m: MetricsSnapshot | null }) {
  const frac = m?.rework.reworkFraction ?? 0
  return (
    <div className="card">
      <div className="section-title" style={{ margin: '0 0 10px' }}>Rework</div>
      {m ? (
        <>
          <div className="stat" style={{ fontSize: 22, color: frac <= 0.4 ? 'var(--ok)' : 'var(--accent3)' }}>{pct(frac)}</div>
          <div className="muted" style={{ fontSize: 11 }}>rejected revisions</div>
          <div style={{ marginTop: 10, height: 7, borderRadius: 4, background: 'var(--glass)', overflow: 'hidden' }}>
            <div style={{ width: pct(frac), height: '100%', background: frac <= 0.4 ? 'var(--ok)' : 'var(--accent3)' }} />
          </div>
          <div className="muted" style={{ marginTop: 8, fontSize: 11 }}>{m.rework.rejected} rejected / {m.rework.totalRevisions} observed revisions</div>
        </>
      ) : <span className="muted">…</span>}
    </div>
  )
}

function MissionStateBars({ missions }: { missions: ColonyMission[] }) {
  const counts: Record<string, number> = {}
  for (const m of missions) counts[m.state ?? 'idle'] = (counts[m.state ?? 'idle'] ?? 0) + 1
  const order = ['ACTIVE', 'MUTATING', 'VERIFYING', 'PENDING_VERIFY', 'REPLANNING', 'VERIFIED_10_10', 'BLOCKED_EXTERNAL', 'CANCELLED', 'PLANNING', 'CAPTURING_EVIDENCE']
  const max = Math.max(...Object.values(counts), 1)
  return (
    <div className="card">
      <div className="section-title" style={{ margin: '0 0 10px' }}>Mission states</div>
      {Object.keys(counts).length === 0 ? <span className="muted">no missions</span> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {order.filter((s) => counts[s]).map((s) => (
            <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 74, fontSize: 11, fontFamily: 'var(--mono)', color: STATE_COLOR[s] || undefined }}>{s.toLowerCase().replace(/_/g, ' ')}</span>
              <div style={{ flex: 1, height: 9, borderRadius: 4, background: 'var(--glass)', overflow: 'hidden' }}>
                <div style={{ width: `${(counts[s] / max) * 100}%`, height: '100%', background: STATE_COLOR[s] || 'var(--line)', borderRadius: 4 }} />
              </div>
              <span className="t" style={{ fontSize: 11 }}>{counts[s]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}