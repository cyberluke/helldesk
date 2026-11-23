import { useEffect, useState } from 'react'
import { engine, short } from '../lib/engine'

// Shift timeline — visual step lanes per shift drawn from the canonical engine.
export default function Shift() {
  const [rows, setRows] = useState<{ id: string; tickets: any[]; done: number; total: number }[]>([])

  useEffect(() => {
    const load = async () => {
      const d = await engine.dashboard()
      const convos: any[] = []
      for (const p of d.projects || []) {
        if (!p?.project_id) continue
        const v = await engine.projectView(p.project_id)
        ;(v.shifts || []).forEach(c => convos.push(c))
      }
      setRows(convos.map(c => {
        const tickets: any[] = c.tickets || []
        const done = tickets.filter(b => b.status === 'closed').length
        const total = tickets.length
        return { id: c.shift_id, tickets, done, total }
      }))
    }
    load()
    const t = setInterval(load, 6000)
    return () => clearInterval(t)
  }, [])

  return (
    <div>
      <div className="section-title" style={{ margin: '0 0 12px' }}>🚚 Shift timeline</div>
      {rows.length === 0 ? (
        <div className="card muted">No shifts yet. Dispatch a mission from Overview.</div>
      ) : (
        <div className="timeline">
          {rows.map(r => {
            const pct = r.total ? Math.round(100 * r.done / r.total) : 0
            const lanes = Array.from({ length: Math.max(3, r.total) }, (_, i) => i < r.done)
            return (
              <div className="tl-row" key={r.id}>
                <span className="mono" style={{ minWidth: 96, fontSize: 11, color: 'var(--muted)' }}>{short(r.id, 12)}</span>
                {lanes.map((done, i) => <span key={i} className={'tl-step' + (done ? ' done' : '')}>{done ? '✓' : i + 1}</span>)}
                <div className="bar"><div style={{ width: pct + '%' }} /></div>
                <span className="mono" style={{ minWidth: 42, fontSize: 11 }}>{pct}%</span>
              </div>
            )
          })}
        </div>
      )}
      {rows.filter(r => r.total > 0).length > 0 && (
        <div className="native-grid" style={{ marginTop: 16 }}>
          {rows.filter(r => r.total > 0).map(r => (
            <div className="card" key={r.id}>
              <h3>{short(r.id, 14)}</h3>
              <p className="muted">{r.done}/{r.total} tickets landed · {r.total ? Math.round(100 * r.done / r.total) : 0}%</p>
              <div className="meta" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {r.tickets.slice(0, 6).map(b => <span key={b.ticket_id} className={'chip ' + (b.status === 'closed' ? 'ok' : 'warn')}>{short(b.ticket_id, 6)}</span>)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}