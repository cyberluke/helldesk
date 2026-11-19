import { useEffect, useState } from 'react'
import { engine, local, short } from '../lib/engine'

// Observability — live event stream + activity feed from local-live REST, plus
// an engine health pulse. Mirrors the original HELLDESK observability page.
export default function Observability() {
  const [events, setEvents] = useState<any[]>([])
  const [health, setHealth] = useState<boolean | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      const [evs, h] = await Promise.all([local.events('default'), engine.health()])
      if (alive) { setEvents(evs.slice(-40).reverse()); setHealth(h) }
    }
    load()
    const t = setInterval(load, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  return (
    <div>
      <div className="section-title" style={{ margin: '0 0 12px' }}>📈 Observability</div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', marginBottom: 16 }}>
        <div className="card"><h3>Engine</h3><div className="stat" style={{ fontSize: 18, color: health ? 'var(--ok)' : 'var(--bad)' }}>{health === null ? '…' : health ? 'ONLINE' : 'OFFLINE'}</div></div>
        <div className="card"><h3>Event stream</h3><div className="stat" style={{ fontSize: 18 }}>{events.length}</div></div>
      </div>
      <div className="card">
        <div className="section-title" style={{ margin: '0 0 10px' }}>Activity</div>
        <div className="log">
          {events.length === 0 ? <span className="t">waiting for engine events…</span> :
            events.map((ev, i) => (
              <div key={i}>
                <span className="t">{short(String(ev.created_at ?? `ev${i}`), 12)}</span> <span className="ev">›</span>{' '}
                {ev.event_type || ev.event || 'event'} <span className="t">ticket {short(ev.ticket_id, 8)}</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}