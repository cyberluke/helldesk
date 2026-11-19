import { useEffect, useState } from 'react'
import { engine, short } from '../lib/engine'

// Merges — review/merge lane: primary tickets + the merge_request MrTickets that
// track them (from projectView's shifts, which carry tickets + blocks edges).
export default function Merges() {
  const [mrs, setMrs] = useState<any[]>([])

  useEffect(() => {
    const load = async () => {
      const d = await engine.dashboard()
      const out: any[] = []
      for (const p of d.projects || []) {
        if (!p?.project_id) continue
        const v = await engine.projectView(p.project_id)
        ;(v.shifts || []).forEach(c =>
          (c.tickets || []).forEach(b => {
            if (b.ticket_type === 'merge-request' || (b.labels || []).includes('gt:merge-request')) out.push(b)
          })
        )
      }
      setMrs(out)
    }
    load()
    const t = setInterval(load, 6000)
    return () => clearInterval(t)
  }, [])

  return (
    <div>
      <div className="section-title" style={{ margin: '0 0 12px' }}>🔀 Merges / review <span className="chip">{mrs.length}</span></div>
      {mrs.length === 0 ? (
        <div className="card muted">No merge-request tickets yet — reviewed MRs appear here.</div>
      ) : (
        <div className="card">
          <table>
            <thead><tr><th>MR</th><th>Status</th><th>Source</th><th>Dispatch</th></tr></thead>
            <tbody>
              {mrs.map(mr => (
                <tr key={mr.ticket_id}>
                  <td>{mr.title || short(mr.ticket_id, 14)}</td>
                  <td><span className={'chip ' + (mr.status === 'closed' ? 'ok' : mr.status === 'in_review' ? 'warn' : '')}>{mr.status}</span></td>
                  <td className="mono">{short(mr.parent_ticket_id, 10)}</td>
                  <td className="mono">{mr.dispatch_attempts ?? 0}x</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}