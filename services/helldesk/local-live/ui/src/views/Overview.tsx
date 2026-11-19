import { useEffect, useState } from 'react'
import { Play } from '@/lib/icons'
import { engine, short, type Project } from '../lib/engine'

export default function Overview() {
  const [projects, setProjects] = useState<Project[]>([])
  const [tickets, setTickets] = useState<any[]>([])
  const [taskText, setTaskText] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  useEffect(() => {
    engine.dashboard().then(d => {
      setProjects(d.projects || [])
      setTickets(d.all_primaries || [])
    })
  }, [])

  const dispatch = async () => {
    const text = taskText.trim()
    if (!text) return
    setBusy(true); setNote('dispatched to canonical engine…')
    const r = await engine.projectCreate('adhoc/' + Date.now(), undefined)
    if (r?.project_id) {
      const a = await engine.projectAddPrimary(r.project_id, text)
      setNote(a?.ok ? 'primary ticket queued — see Ticket Board' : 'task queued')
      setTaskText('')
    } else {
      setNote('create failed')
    }
    setBusy(false)
    const d = await engine.dashboard()
    setProjects(d.projects || []); setTickets(d.all_primaries || [])
  }

  const open = tickets.filter(b => b.status === 'open').length
  const inProg = tickets.filter(b => b.status === 'in_progress' || b.status === 'in_review').length
  const done = tickets.filter(b => b.status === 'closed').length

  return (
    <div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', marginBottom: 18 }}>
        <div className="card"><h3>🏛 Projects</h3><p className="muted">missive missions on NAI-Lattice</p><div className="stat">{projects.length}</div></div>
        <div className="card"><h3>📌 Primary tickets</h3><p className="muted">serial primary tasks</p><div className="stat">{tickets.length}</div></div>
        <div className="card"><h3>🟢 Open</h3><p className="muted">queued + active</p><div className="stat">{open + inProg}</div></div>
        <div className="card"><h3>✅ Verified</h3><p className="muted">closed / landed</p><div className="stat">{done}</div></div>
      </div>

      <div className="section-title" style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '20px 0 10px' }}>⚡ Quick dispatch</div>
      <div className="card" style={{ maxWidth: 700 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: 1, minWidth: 260 }}>
            <label>What should HELLDESK build / verify?</label>
            <input value={taskText} onChange={e => setTaskText(e.target.value)}
              placeholder="e.g. add a /status endpoint and verify it with a real test"
              onKeyDown={e => e.key === 'Enter' && dispatch()} />
          </div>
          <button className="primary" onClick={dispatch} disabled={busy}><Play size={14} style={{ verticalAlign: '-2px', marginRight: 5 }} />Dispatch</button>
        </div>
        {note && <div className="muted mono" style={{ marginTop: 10 }}>{note}</div>}
      </div>

      {projects.length > 0 && (
        <div style={{ marginTop: 22 }}>
          <div className="section-title" style={{ marginBottom: 10 }}>Projects</div>
          <div className="grid">
            {projects.map(p => (
              <div className="card" key={p.project_id}>
                <h3>{p.name || short(p.project_id)}</h3>
                <p className="muted mono">{p.repo_path || 'no repo'}</p>
                <div className="meta" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                  <span className="chip">{p.shift_ids?.length ?? 0} shifts</span>
                  <span className="chip warn">{p.active_ticket_id ? 'active' : 'idle'}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}