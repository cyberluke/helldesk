import { useEffect, useState } from 'react'
import { getMissionBoard, short, type MissionTicketCard } from '../lib/engine'

const COLS = ['open', 'in_progress', 'in_review', 'closed'] as const

// Mission/ticket board — kanban of the CONTROL-PLANE engine missions (the real
// work: mis_* → ticket_*), read through the proxied /api/v1/missions so the
// operator sees exactly what the autonomous agent is doing. No local store.

export default function TicketBoard() {
  const [tickets, setTickets] = useState<MissionTicketCard[]>([])

  useEffect(() => {
    const load = async () => {
      const cards = await getMissionBoard()
      setTickets(cards)
    }
    load()
    const t = setInterval(load, 6000)
    return () => clearInterval(t)
  }, [])

  const cols: Record<string, MissionTicketCard[]> = { open: [], in_progress: [], in_review: [], closed: [] }
  tickets.forEach(b => { const k = COLS.includes(b.status) ? b.status : 'open'; cols[k].push(b) })

  return (
    <div>
      <div className="section-title" style={{ margin: '0 0 4px' }}>🗃 Mission board <span className="chip">{tickets.length}</span></div>
      <div style={{ height: 1, background: 'linear-gradient(90deg, transparent, var(--line), transparent)', margin: '0 0 14px' }} />
      <div className="board">
        {COLS.map(col => (
          <div className="board-col" key={col}>
            <div className="board-title">{col.replace('_', ' ')} <span className="chip">{cols[col].length}</span></div>
            <div className="board-cards">
              {cols[col].length === 0 ? <div className="muted" style={{ fontSize: 11 }}>empty</div> :
                cols[col].map(b => (
                  <div className="bcard" key={b.ticketId}>
                    <div className="bt">{b.title || '(untitled)'}</div>
                    <div className="bm">
                      <span className="chip ok">{b.status}</span>
                      <span className="mono">{short(b.ticketId, 8)}</span>
                      {b.verificationState && <span className="chip" style={b.verificationState.includes('REJECTED') ? { background: 'var(--bad)' } : undefined}>{b.verificationState.replace(/_/g, ' ')}</span>}
                      {b.missionState && <span className="chip">{b.missionState.replace(/_/g, ' ')}</span>}
                    </div>
                    {b.objective && <div className="muted" style={{ marginTop: 4, fontSize: 11 }}>{String(b.objective).slice(0, 72)}</div>}
                    {b.quality && b.quality.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                        {b.quality.slice(0, 6).map((g) => (
                          <span key={g.gate_key} className="mono" style={{
                            fontSize: 9, padding: '1px 5px', borderRadius: 4,
                            background: g.status === 'PASS' ? 'var(--glass)' : g.status === 'FAIL' ? 'rgba(248,113,113,.18)' : 'var(--glass)',
                            border: `1px solid ${g.status === 'PASS' ? 'var(--ok)' : g.status === 'FAIL' ? 'var(--bad)' : 'var(--line)'}`,
                            color: g.status === 'PASS' ? 'var(--ok)' : g.status === 'FAIL' ? 'var(--bad)' : 'var(--fg)',
                          }}><span style={{ opacity: 0.7 }}>✓</span> {short(g.gate_key, 14)}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}