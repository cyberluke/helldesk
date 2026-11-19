import { useEffect, useState } from 'react'
import { local, short } from '../lib/engine'

// Memo — inter-agent mailbox derived from department events / config (local-live REST).
export default function MemoView() {
  const [events, setEvents] = useState<any[]>([])

  useEffect(() => {
    let alive = true
    const load = async () => {
      const evs = await local.events('default')
      if (alive) setEvents(evs.slice(-24).reverse())
    }
    load()
    const t = setInterval(load, 6000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  return (
    <div>
      <div className="section-title" style={{ margin: '0 0 12px' }}>📬 Memo <span className="chip">{events.length}</span></div>
      {events.length === 0 ? (
        <div className="card muted">No memo yet — agent activity events will appear here.</div>
      ) : (
        <div className="card">
          <table>
            <thead><tr><th>Time</th><th>Event</th><th>Ticket</th><th>Detail</th></tr></thead>
            <tbody>
              {events.map((ev, i) => (
                <tr key={i}>
                  <td className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>{short(String(ev.created_at || ev.event_id || ''), 12)}</td>
                  <td><span className="chip ok">{ev.event_type || ev.event || 'event'}</span></td>
                  <td className="mono">{short(ev.ticket_id, 10)}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{short(JSON.stringify(ev.data ?? ev.payload ?? ''), 40)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}